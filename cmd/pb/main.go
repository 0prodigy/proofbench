// Command pb is the Proofbench CLI: readiness manifests, substrate
// bring-up, verification runs, and evidence bundles.
//
// This file is FINAL for the scaffold phase: builder agents implement the
// package stubs it calls, but do not modify this dispatch (CONTRACTS.md).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/launchwings/proofbench/internal/evidence"
	"github.com/launchwings/proofbench/internal/manifest"
	"github.com/launchwings/proofbench/internal/report"
	"github.com/launchwings/proofbench/internal/substrate"
	"github.com/launchwings/proofbench/internal/verify"
)

const version = "0.1.0-dev"

const rootUsage = `pb — prove agent changes work, end-to-end, on any setup

Usage:
  pb evidence new     --claim C --phase P [--root DIR] [--ticket T] [--kind K] [--pairs-with RUNID] [--surface k=v ...]
  pb evidence run     --bundle DIR --name NAME [--shell] [--] CMD [ARGS...]
  pb evidence add     --bundle DIR [--type TYPE] [--name NAME] [--meta k=v ...] SRC_PATH
  pb evidence link    --bundle DIR EXECUTION_ID URL
  pb evidence assert  --bundle DIR EXPR
  pb evidence seal    --bundle DIR
  pb evidence verdict --bundle DIR [--note NOTE] pass|fail|inconclusive
  pb evidence validate BUNDLE_DIR
  pb evidence show     BUNDLE_DIR
  pb init   [--out FILE|-] [--force] [DIR]
  pb up     [--substrate local|compose] [--manifest ready.yaml]
  pb ready  [--substrate local|compose] [--manifest ready.yaml]
  pb seed   [--substrate local|compose] [--manifest ready.yaml]
  pb down   [--substrate local|compose] [--manifest ready.yaml]
  pb verify [--ticket T] [--claim C] [--evidence-root DIR] [--only a,b] [--substrate local|compose] [--manifest ready.yaml]
  pb report BUNDLE_DIR
  pb hub    [--root DIR] [--out FILE]
  pb version

Exit codes: "pb evidence run" exits with the wrapped command's real exit
code; "pb evidence assert" exits 1 when the predicate fails, 2 on
evaluation error; every other command exits nonzero on failure.
`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, rootUsage)
		return 2
	}
	switch args[0] {
	case "evidence":
		return cmdEvidence(args[1:])
	case "init":
		return cmdInit(args[1:])
	case "up", "ready", "seed", "down":
		return cmdSubstrate(args[0], args[1:])
	case "verify":
		return cmdVerify(args[1:])
	case "report":
		return cmdReport(args[1:])
	case "hub":
		return cmdHub(args[1:])
	case "version":
		fmt.Println("pb version " + version)
		return 0
	case "help", "-h", "--help":
		fmt.Print(rootUsage)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "pb: unknown command %q\n\n%s", args[0], rootUsage)
		return 2
	}
}

// kvFlag is a repeatable key=value flag collected into a map.
type kvFlag map[string]string

func (m kvFlag) String() string {
	parts := make([]string, 0, len(m))
	for k, v := range m {
		parts = append(parts, k+"="+v)
	}
	return strings.Join(parts, ",")
}

func (m kvFlag) Set(s string) error {
	k, v, ok := strings.Cut(s, "=")
	if !ok || k == "" {
		return fmt.Errorf("expected key=value, got %q", s)
	}
	m[k] = v
	return nil
}

func fail(err error) int {
	fmt.Fprintln(os.Stderr, "pb:", err)
	return 1
}

func failf(format string, a ...any) int {
	fmt.Fprintf(os.Stderr, "pb: "+format+"\n", a...)
	return 1
}

// ---------------------------------------------------------------- evidence

func cmdEvidence(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, rootUsage)
		return 2
	}
	switch args[0] {
	case "new":
		return evidenceNew(args[1:])
	case "run":
		return evidenceRun(args[1:])
	case "add":
		return evidenceAdd(args[1:])
	case "link":
		return evidenceLink(args[1:])
	case "assert":
		return evidenceAssert(args[1:])
	case "seal":
		return evidenceSeal(args[1:])
	case "verdict":
		return evidenceVerdict(args[1:])
	case "validate":
		return evidenceValidate(args[1:])
	case "show":
		return evidenceShow(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "pb: unknown evidence subcommand %q\n\n%s", args[0], rootUsage)
		return 2
	}
}

func evidenceNew(args []string) int {
	fs := flag.NewFlagSet("pb evidence new", flag.ContinueOnError)
	root := fs.String("root", "evidence", "root directory for evidence bundles")
	ticket := fs.String("ticket", "", "ticket key (e.g. ENG-20190)")
	claim := fs.String("claim", "", "claim under verification (required)")
	phase := fs.String("phase", "", "repro|verify|reverify|fix|report (required)")
	kind := fs.String("kind", "", "bundle kind (e.g. before|after)")
	pairsWith := fs.String("pairs-with", "", "runId of the paired bundle")
	surface := kvFlag{}
	fs.Var(surface, "surface", "surface key=value (repeatable, e.g. substrate=local)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *claim == "" || *phase == "" {
		return failf("evidence new: --claim and --phase are required")
	}
	b, err := evidence.New(*root, evidence.NewOpts{
		Ticket:    *ticket,
		Claim:     *claim,
		Phase:     *phase,
		Kind:      *kind,
		PairsWith: *pairsWith,
		Surface:   surface,
	})
	if err != nil {
		return fail(err)
	}
	fmt.Println(b.Dir)
	return 0
}

func evidenceRun(args []string) int {
	fs := flag.NewFlagSet("pb evidence run", flag.ContinueOnError)
	bundle := fs.String("bundle", "", "bundle directory (required)")
	name := fs.String("name", "", "artifact name for the command log (required)")
	shell := fs.Bool("shell", false, "run the command line via bash -lc")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	argv := fs.Args()
	if *bundle == "" || *name == "" || len(argv) == 0 {
		return failf("evidence run: --bundle, --name and a command are required")
	}
	b, err := evidence.Open(*bundle)
	if err != nil {
		return fail(err)
	}
	code, err := b.Run(*name, argv, *shell)
	if err != nil {
		return fail(err)
	}
	return code // propagate the wrapped command's real exit code
}

func evidenceAdd(args []string) int {
	fs := flag.NewFlagSet("pb evidence add", flag.ContinueOnError)
	bundle := fs.String("bundle", "", "bundle directory (required)")
	typ := fs.String("type", evidence.ArtifactLog, "command|snapshot|screenshot|log|recording|link")
	name := fs.String("name", "", "artifact name (default: source file basename)")
	meta := kvFlag{}
	fs.Var(meta, "meta", "meta key=value (repeatable)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *bundle == "" || fs.NArg() != 1 {
		return failf("evidence add: --bundle and exactly one SRC_PATH are required")
	}
	src := fs.Arg(0)
	artName := *name
	if artName == "" {
		artName = filepath.Base(src)
	}
	var m map[string]any
	if len(meta) > 0 {
		m = make(map[string]any, len(meta))
		for k, v := range meta {
			m[k] = v
		}
	}
	b, err := evidence.Open(*bundle)
	if err != nil {
		return fail(err)
	}
	if err := b.Add(src, *typ, artName, m); err != nil {
		return fail(err)
	}
	return 0
}

func evidenceLink(args []string) int {
	fs := flag.NewFlagSet("pb evidence link", flag.ContinueOnError)
	bundle := fs.String("bundle", "", "bundle directory (required)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *bundle == "" || fs.NArg() != 2 {
		return failf("evidence link: --bundle, EXECUTION_ID and URL are required")
	}
	b, err := evidence.Open(*bundle)
	if err != nil {
		return fail(err)
	}
	if err := b.Link(fs.Arg(0), fs.Arg(1)); err != nil {
		return fail(err)
	}
	return 0
}

func evidenceAssert(args []string) int {
	fs := flag.NewFlagSet("pb evidence assert", flag.ContinueOnError)
	bundle := fs.String("bundle", "", "bundle directory (required)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *bundle == "" || fs.NArg() != 1 {
		return failf("evidence assert: --bundle and exactly one EXPR are required")
	}
	b, err := evidence.Open(*bundle)
	if err != nil {
		return fail(err)
	}
	observed, ok, err := b.Assert(fs.Arg(0))
	if err != nil {
		fmt.Fprintln(os.Stderr, "pb:", err)
		return 2
	}
	fmt.Println(observed)
	if !ok {
		return 1
	}
	return 0
}

func evidenceSeal(args []string) int {
	fs := flag.NewFlagSet("pb evidence seal", flag.ContinueOnError)
	bundle := fs.String("bundle", "", "bundle directory (required)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *bundle == "" {
		return failf("evidence seal: --bundle is required")
	}
	b, err := evidence.Open(*bundle)
	if err != nil {
		return fail(err)
	}
	if err := b.Seal(); err != nil {
		return fail(err)
	}
	return 0
}

func evidenceVerdict(args []string) int {
	fs := flag.NewFlagSet("pb evidence verdict", flag.ContinueOnError)
	bundle := fs.String("bundle", "", "bundle directory (required)")
	note := fs.String("note", "", "verdict note")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *bundle == "" || fs.NArg() != 1 {
		return failf("evidence verdict: --bundle and exactly one of pass|fail|inconclusive are required")
	}
	b, err := evidence.Open(*bundle)
	if err != nil {
		return fail(err)
	}
	if err := b.SetVerdict(fs.Arg(0), *note); err != nil {
		return fail(err)
	}
	return 0
}

func evidenceValidate(args []string) int {
	fs := flag.NewFlagSet("pb evidence validate", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		return failf("evidence validate: exactly one BUNDLE_DIR is required")
	}
	if err := evidence.Validate(fs.Arg(0)); err != nil {
		return fail(err)
	}
	fmt.Println("ok")
	return 0
}

func evidenceShow(args []string) int {
	fs := flag.NewFlagSet("pb evidence show", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		return failf("evidence show: exactly one BUNDLE_DIR is required")
	}
	b, err := evidence.Open(fs.Arg(0))
	if err != nil {
		return fail(err)
	}
	out, err := json.MarshalIndent(b.M, "", "  ")
	if err != nil {
		return fail(err)
	}
	fmt.Println(string(out))
	return 0
}

// -------------------------------------------------------------------- init

func cmdInit(args []string) int {
	fs := flag.NewFlagSet("pb init", flag.ContinueOnError)
	out := fs.String("out", "ready.yaml", "output path for the generated manifest ('-' for stdout)")
	force := fs.Bool("force", false, "overwrite an existing output file")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	dir := "."
	if fs.NArg() > 0 {
		dir = fs.Arg(0)
	}
	r, err := manifest.Detect(dir)
	if err != nil {
		return fail(err)
	}
	data, err := yaml.Marshal(r)
	if err != nil {
		return fail(err)
	}
	if *out == "-" {
		fmt.Print(string(data))
		return 0
	}
	if !*force {
		if _, statErr := os.Stat(*out); statErr == nil {
			return failf("init: %s already exists (use --force to overwrite)", *out)
		}
	}
	if err := os.WriteFile(*out, data, 0o644); err != nil {
		return fail(err)
	}
	fmt.Println(*out)
	return 0
}

// -------------------------------------------------- up / ready / seed / down

func cmdSubstrate(verb string, args []string) int {
	fs := flag.NewFlagSet("pb "+verb, flag.ContinueOnError)
	kind := fs.String("substrate", substrate.KindLocal, "local|compose")
	manifestPath := fs.String("manifest", "ready.yaml", "path to ready.yaml")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	r, err := manifest.Load(*manifestPath)
	if err != nil {
		return fail(err)
	}
	s, err := substrate.New(*kind, filepath.Dir(*manifestPath))
	if err != nil {
		return fail(err)
	}
	switch verb {
	case "up":
		err = s.Up(r)
	case "ready":
		err = s.Ready(r)
	case "seed":
		err = s.Seed(r)
	case "down":
		err = s.Down(r)
	}
	if err != nil {
		return fail(err)
	}
	return 0
}

// ------------------------------------------------------------------ verify

func cmdVerify(args []string) int {
	fs := flag.NewFlagSet("pb verify", flag.ContinueOnError)
	ticket := fs.String("ticket", "", "ticket key recorded in the bundle")
	claim := fs.String("claim", "", "claim under verification")
	evidenceRoot := fs.String("evidence-root", "evidence", "root directory for evidence bundles")
	only := fs.String("only", "", "comma-separated check names to run (default: all)")
	kind := fs.String("substrate", substrate.KindLocal, "local|compose")
	manifestPath := fs.String("manifest", "ready.yaml", "path to ready.yaml")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	r, err := manifest.Load(*manifestPath)
	if err != nil {
		return fail(err)
	}
	opts := verify.Opts{
		EvidenceRoot: *evidenceRoot,
		Ticket:       *ticket,
		Claim:        *claim,
		Substrate:    *kind,
	}
	if *only != "" {
		opts.Only = strings.Split(*only, ",")
	}
	b, sum, err := verify.Run(r, opts)
	if err != nil {
		return fail(err)
	}
	fmt.Printf("bundle:  %s\n", b.Dir)
	fmt.Printf("proof:   %s\n", sum.ProofLevel)
	fmt.Printf("verdict: %s\n", sum.Verdict)
	for _, c := range sum.Checks {
		fmt.Printf("  [%s] %s\n", c.State, c.Name)
	}
	if sum.Verdict != evidence.VerdictPass {
		return 1
	}
	return 0
}

// ------------------------------------------------------------ report / hub

func cmdReport(args []string) int {
	fs := flag.NewFlagSet("pb report", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		return failf("report: exactly one BUNDLE_DIR is required")
	}
	b, err := evidence.Open(fs.Arg(0))
	if err != nil {
		return fail(err)
	}
	md, err := report.Markdown(b)
	if err != nil {
		return fail(err)
	}
	fmt.Print(md)
	return 0
}

func cmdHub(args []string) int {
	fs := flag.NewFlagSet("pb hub", flag.ContinueOnError)
	root := fs.String("root", "evidence", "root directory to scan for bundles")
	out := fs.String("out", filepath.Join(".pb", "hub", "index.html"), "output file for the hub index")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if err := report.WriteHub(*root, *out); err != nil {
		return fail(err)
	}
	fmt.Println(*out)
	return 0
}
