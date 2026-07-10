// Command pb is the Proofbench CLI: readiness manifests, substrate
// bring-up, verification runs, and evidence bundles.
//
// This file is FINAL for the scaffold phase: builder agents implement the
// package stubs it calls, but do not modify this dispatch (CONTRACTS.md).
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/0prodigy/proofbench/internal/agentruntime"
	"github.com/0prodigy/proofbench/internal/evidence"
	"github.com/0prodigy/proofbench/internal/honesty"
	"github.com/0prodigy/proofbench/internal/manifest"
	"github.com/0prodigy/proofbench/internal/report"
	"github.com/0prodigy/proofbench/internal/substrate"
	"github.com/0prodigy/proofbench/internal/verify"
)

var version = "0.1.0-dev"

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
  pb lint   [--manifest ready.yaml]
  pb pin    [--manifest ready.yaml]
  pb up     [--substrate local|compose|k8s-attach] [--manifest ready.yaml]
  pb ready  [--substrate local|compose|k8s-attach] [--manifest ready.yaml]
  pb seed   [--substrate local|compose|k8s-attach] [--manifest ready.yaml]
  pb down   [--substrate local|compose|k8s-attach] [--manifest ready.yaml]
  pb verify [--ticket T] [--claim C] [--evidence-root DIR] [--only a,b]
            [--substrate local|compose|k8s-attach] [--manifest ready.yaml]
            [--pairs-with RUNID] [--kind before|after]
  pb explore [--manifest ready.yaml] [--out DIR] [--runtime claude-code] [--max-turns N]
             (experimental: requires PB_EXPERIMENTAL=1; proposes checks only, never a verdict)
  pb report BUNDLE_DIR
  pb hub    [--root DIR] [--out FILE]
  pb version

Exit codes: "pb evidence run" exits with the wrapped command's real exit
code; "pb evidence assert" exits 1 when the predicate fails, 2 on
evaluation error; "pb lint" exits 1 with the named validation error; "pb
explore" exits 2 when PB_EXPERIMENTAL is not set to "1", 3 when the round
did not run (not-run), 4 when it ran but produced no proposal
(inconclusive); every other command exits nonzero on failure.

Run "pb help <command>" for details and an example of any command.
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
	case "lint":
		return cmdLint(args[1:])
	case "pin":
		return cmdPin(args[1:])
	case "up", "ready", "seed", "down":
		return cmdSubstrate(args[0], args[1:])
	case "verify":
		return cmdVerify(args[1:])
	case "explore":
		return cmdExplore(args[1:])
	case "report":
		return cmdReport(args[1:])
	case "hub":
		return cmdHub(args[1:])
	case "version", "--version", "-v":
		if len(args) > 1 && (args[1] == "-h" || args[1] == "--help") {
			return printCmdHelp("version", nil)
		}
		fmt.Println("pb version " + version)
		return 0
	case "help":
		if len(args) > 1 {
			return run(append([]string{args[1]}, "--help"))
		}
		fmt.Print(rootUsage)
		return 0
	case "-h", "--help":
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

// yamlTypeName matches the "in type manifest.Xxx" / "into type manifest.Xxx"
// suffix yaml.v3 embeds in strict-decode errors, so it can be stripped
// without losing the yaml line info that precedes it.
var yamlTypeName = regexp.MustCompile(` (?:in|into) type \S+`)

// manifestErr turns a manifest.Load failure into a CLI-friendly message: a
// missing manifest file points at "pb init", and a yaml decode failure drops
// the Go type name yaml.v3 embeds while keeping the line info. Any other
// error (e.g. manifest.Validate failures) is already CLI-friendly and passes
// through to fail unchanged.
func manifestErr(err error) int {
	if errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "no such file") {
		fmt.Fprintln(os.Stderr, "pb: no ready.yaml found in this directory — run 'pb init' to generate one, or pass --manifest PATH")
		return 1
	}
	if strings.Contains(err.Error(), "manifest.Load: parse error in") {
		msg := err.Error()
		if u := errors.Unwrap(err); u != nil {
			msg = u.Error()
		}
		msg = yamlTypeName.ReplaceAllString(msg, "")
		fmt.Fprintln(os.Stderr, "pb: ready.yaml is invalid: "+msg)
		return 1
	}
	return fail(err)
}

// cmdHelp is the per-command help text shown by "pb help <cmd>" and
// "pb <cmd> --help"/"-h": a one-paragraph description plus one realistic
// example invocation. Flags are rendered separately from the command's own
// flag.FlagSet (flags differ per invocation, e.g. up/ready/seed/down share a
// flag set but not a description).
type cmdHelp struct {
	desc    string
	example string
}

var cmdHelpTable = map[string]cmdHelp{
	"evidence": {
		desc:    "Low-level evidence-bundle primitives (new, run, add, link, assert, seal, verdict, validate, show) for building a bundle by hand. \"pb verify\" drives these automatically for a full run.",
		example: `pb evidence new --claim "orders endpoint returns totals" --phase verify`,
	},
	"init": {
		desc:    "Detects the project's run/ready/seed shape and writes a starter ready.yaml manifest.",
		example: "pb init .",
	},
	"lint": {
		desc:    "Parses and validates a ready.yaml manifest without bringing anything up.",
		example: "pb lint --manifest ready.yaml",
	},
	"pin": {
		desc:    "Content-hash-pins and signs the manifest's check set into ready.lock (ADR-0015 R1), so verify refuses any check whose definition drifts or is unsigned. Under CI OIDC (GitHub Actions, id-token: write) it signs KEYLESS via cosign — the workflow identity the agent cannot assume, which lets `pb verify --expected-identity` clear the self-attested L3 cap. Locally it uses the self-held ed25519 key (PB_SIGNING_KEY, default .pb/signing.key; principal PB_SIGNER), an honest self-attested lock.",
		example: "PB_SIGNER=ci-oracle pb pin --manifest ready.yaml",
	},
	"up": {
		desc:    "Brings the service up on the chosen substrate (local process, docker compose, or an attached k8s workload).",
		example: "pb up --manifest ready.yaml",
	},
	"ready": {
		desc:    "Waits for and checks the service's readiness probe (http, tcp, or exec) on the chosen substrate.",
		example: "pb ready --manifest ready.yaml",
	},
	"seed": {
		desc:    "Runs the manifest's declared seed steps against the running service.",
		example: "pb seed --manifest ready.yaml",
	},
	"down": {
		desc:    "Tears the service down on the chosen substrate.",
		example: "pb down --manifest ready.yaml",
	},
	"verify": {
		desc:    "Brings up the substrate, runs the manifest's checks, and produces an evidence bundle with a tri-state verdict (pass/fail/inconclusive). Pass --expected-identity to verify the lock's Sigstore keyless anchor (ADR-0015, unlocks L4/L5); pass --owner/--signer-workflow to verify the deployed image's build attestation (ADR-0016 R4). Absent tooling or a mismatch degrades honestly — never a fake pass.",
		example: `pb verify --manifest ready.yaml --claim "orders endpoint returns totals" --ticket ENG-123`,
	},
	"explore": {
		desc:    "Experimental: runs one agent-driven exploration round that proposes checks for ready.yaml. Never produces a verdict and never edits the manifest. Requires PB_EXPERIMENTAL=1.",
		example: "PB_EXPERIMENTAL=1 pb explore --manifest ready.yaml",
	},
	"report": {
		desc:    "Renders a Markdown report for a sealed evidence bundle.",
		example: "pb report evidence/ENG-123/repro-01",
	},
	"hub": {
		desc:    "Writes a static HTML index over every evidence bundle under a root directory.",
		example: "pb hub --root evidence --out .pb/hub/index.html",
	},
	"version": {
		desc:    "Prints the pb version.",
		example: "pb version",
	},
}

// wantsHelp reports whether args requests this command's own help via a
// bare -h/--help flag, stopping at the first "--" (which ends flag parsing —
// e.g. "evidence run"'s wrapped command line may itself contain "--help").
func wantsHelp(args []string) bool {
	for _, a := range args {
		if a == "--" {
			return false
		}
		if a == "-h" || a == "--help" {
			return true
		}
	}
	return false
}

// printCmdHelp prints cmd's one-paragraph description, its flag set's
// defaults (if any), and one example invocation, then returns exit 0. fs may
// be nil for commands with no flags of their own (e.g. "evidence").
func printCmdHelp(cmd string, fs *flag.FlagSet) int {
	h, ok := cmdHelpTable[cmd]
	if !ok {
		fmt.Print(rootUsage)
		return 0
	}
	fmt.Println(h.desc)
	if fs != nil {
		var hasFlags bool
		fs.VisitAll(func(*flag.Flag) { hasFlags = true })
		if hasFlags {
			fmt.Println("\nFlags:")
			fs.SetOutput(os.Stdout)
			fs.PrintDefaults()
		}
	}
	fmt.Println("\nExample:")
	fmt.Println("  " + h.example)
	return 0
}

// ---------------------------------------------------------------- evidence

func cmdEvidence(args []string) int {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, rootUsage)
		return 2
	}
	if args[0] == "-h" || args[0] == "--help" {
		return printCmdHelp("evidence", nil)
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
	// ADR-0015: require the verdict seal (manifest.sig) to be a Sigstore keyless
	// signature verifying against a VERIFIER-SUPPLIED expected Fulcio identity
	// (never one read from the bundle). When set, an absent seal — or a self-held-
	// key seal — is INVALID.
	expIdentity := fs.String("expected-identity", "", "require the manifest seal to be a Sigstore keyless signature verifying against this Fulcio cert identity (an absent or self-held-key seal is then INVALID)")
	oidcIssuer := fs.String("oidc-issuer", honesty.DefaultOIDCIssuer, "expected OIDC issuer on the Fulcio cert (with --expected-identity)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		return failf("evidence validate: exactly one BUNDLE_DIR is required")
	}
	opts := evidence.ValidateOpts{ExpectedIdentity: *expIdentity, OIDCIssuer: *oidcIssuer}
	if err := evidence.ValidateWithAnchor(fs.Arg(0), opts); err != nil {
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
	if wantsHelp(args) {
		return printCmdHelp("init", fs)
	}
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
	data, err := manifest.MarshalProposal(r)
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
	fmt.Printf(`next steps:
  1. edit %s — set start:, ready:, and a checks: block
  2. pb lint          # validate the manifest
  3. pb verify        # bring up, exercise, produce an evidence bundle
`, *out)
	return 0
}

// -------------------------------------------------------------------- lint

// cmdLint validates a ready.yaml without bringing anything up: manifest.Load
// already runs (*Ready).Validate, so lint just surfaces that result as an
// exit code, one named error at a time (manifest.Validate returns its first
// failure, not a list).
func cmdLint(args []string) int {
	fs := flag.NewFlagSet("pb lint", flag.ContinueOnError)
	manifestPath := fs.String("manifest", "ready.yaml", "path to ready.yaml")
	if wantsHelp(args) {
		return printCmdHelp("lint", fs)
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		return failf("lint: unexpected argument %q (use --manifest to specify the manifest path)", fs.Arg(0))
	}
	if _, err := manifest.Load(*manifestPath); err != nil {
		return manifestErr(err)
	}
	fmt.Println("ok")
	return 0
}

// --------------------------------------------------------------------- pin

// cmdPin content-hash-pins and signs the manifest's check set into ready.lock
// (ADR-0015 R1): the generation phase distinct from execution. The signing
// key is loaded from PB_SIGNING_KEY (default .pb/signing.key next to the
// manifest), generated on first use; the signing principal id is PB_SIGNER
// (default: the OS user). verify then refuses any check whose assertion-hash
// drifted or whose lock is missing/unsigned/invalid.
func cmdPin(args []string) int {
	fs := flag.NewFlagSet("pb pin", flag.ContinueOnError)
	manifestPath := fs.String("manifest", "ready.yaml", "path to ready.yaml")
	if wantsHelp(args) {
		return printCmdHelp("pin", fs)
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		return failf("pin: unexpected argument %q (use --manifest to specify the manifest path)", fs.Arg(0))
	}
	r, err := manifest.Load(*manifestPath)
	if err != nil {
		return manifestErr(err)
	}
	if len(r.Checks) == 0 {
		return failf("pin: %s declares no checks to pin (add a checks: block)", *manifestPath)
	}
	dir := filepath.Dir(*manifestPath)
	// Under CI OIDC (GitHub Actions with id-token: write) sign the lock KEYLESS
	// via cosign (ADR-0015 R2): the workflow identity, which the agent's own
	// runtime cannot assume, is what lets `pb verify --expected-identity` clear
	// the self-attested L3 cap. Local (no OIDC) keeps the self-held-key path,
	// unchanged — an honest self-attested lock.
	if honesty.InCIOIDC() {
		lock, err := honesty.SignLockKeyless(r, dir, nil)
		if err != nil {
			return fail(err)
		}
		if err := honesty.WriteLock(dir, lock); err != nil {
			return fail(err)
		}
		fmt.Printf("pinned %d check(s), Sigstore keyless (identity %q)\n", len(lock.CheckHashes), lock.Anchor.Identity)
		fmt.Printf("lock:  %s\n", filepath.Join(dir, honesty.LockFile))
		return 0
	}
	signer, err := honesty.LoadSigner(dir, true)
	if err != nil {
		return fail(err)
	}
	lock, err := honesty.SignLock(r, dir, signer)
	if err != nil {
		return fail(err)
	}
	if err := honesty.WriteLock(dir, lock); err != nil {
		return fail(err)
	}
	fmt.Printf("pinned %d check(s) as signer %q\n", len(lock.CheckHashes), signer.ID)
	fmt.Printf("lock:  %s\n", filepath.Join(dir, honesty.LockFile))
	fmt.Printf("key:   %s\n", honesty.KeyPath(dir))
	return 0
}

// -------------------------------------------------- up / ready / seed / down

func cmdSubstrate(verb string, args []string) int {
	fs := flag.NewFlagSet("pb "+verb, flag.ContinueOnError)
	kind := fs.String("substrate", substrate.KindLocal, "local|compose|k8s-attach")
	manifestPath := fs.String("manifest", "ready.yaml", "path to ready.yaml")
	if wantsHelp(args) {
		return printCmdHelp(verb, fs)
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	r, err := manifest.Load(*manifestPath)
	if err != nil {
		return manifestErr(err)
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
	// Quickstart promises output on success; up/ready used to print nothing,
	// which two cold-onboarding e2e runs flagged as "did it even work?".
	// Keep it to one line each — k8s-attach forward details are printed by
	// the substrate itself, not here.
	switch verb {
	case "up":
		fmt.Printf("up: %s (%s)\n", r.Service, *kind)
	case "ready":
		fmt.Printf("ready: %s ok\n", probeSummary(r.Run.Ready))
	case "seed":
		if len(r.Seed) == 0 {
			fmt.Println("seed: no seed steps declared")
		} else {
			fmt.Printf("seed: done (%d steps)\n", len(r.Seed))
		}
	}
	return 0
}

// probeSummary renders a manifest's readiness probe as a short one-line
// description for "pb ready"'s success line.
func probeSummary(p manifest.Probe) string {
	switch {
	case p.HTTP != "":
		return "http " + p.HTTP
	case p.TCP != "":
		return "tcp " + p.TCP
	case p.Exec != "":
		return "exec " + p.Exec
	default:
		return "no probe declared"
	}
}

// ------------------------------------------------------------------ verify

func cmdVerify(args []string) int {
	fs := flag.NewFlagSet("pb verify", flag.ContinueOnError)
	ticket := fs.String("ticket", "", "ticket key recorded in the bundle")
	claim := fs.String("claim", "", "claim under verification")
	evidenceRoot := fs.String("evidence-root", "evidence", "root directory for evidence bundles")
	only := fs.String("only", "", "comma-separated check names to run (default: all)")
	substrateKind := fs.String("substrate", substrate.KindLocal, "local|compose|k8s-attach")
	manifestPath := fs.String("manifest", "ready.yaml", "path to ready.yaml")
	pairsWith := fs.String("pairs-with", "", "runId of the paired bundle (before/after pairing)")
	bundleKind := fs.String("kind", "", "before|after (this bundle's role in a paired run)")
	// ADR-0015 R1 external anchor: verify the lock's Sigstore keyless signature
	// against a VERIFIER-SUPPLIED expected Fulcio identity (never one read from
	// the lock). Supplying either identity flag installs the cosign anchor; a
	// match clears the self-attested L3 cap and unlocks L4/L5.
	expIdentity := fs.String("expected-identity", "", "exact Fulcio cert SAN the lock signer must match (unlocks L4/L5)")
	expIdentityRe := fs.String("expected-identity-regexp", "", "regexp alternative to --expected-identity")
	oidcIssuer := fs.String("oidc-issuer", honesty.DefaultOIDCIssuer, "expected OIDC issuer on the Fulcio cert")
	insecureIgnoreTlog := fs.Bool("insecure-ignore-tlog", false, "verify the offline Fulcio-cert identity binding only, skipping the Rekor tlog inclusion proof (reduced assurance, stamped into the bundle)")
	// ADR-0016 R4: verify the deployed image's build-provenance attestation.
	owner := fs.String("owner", "", "GitHub owner of the signing identity (gh attestation verify --owner)")
	signerWorkflow := fs.String("signer-workflow", "", "expected build workflow ref the attestation must be signed by (unlocks R4)")
	image := fs.String("image", "", "OCI image ref to verify (default: the run's resolved image digest pin)")
	if wantsHelp(args) {
		return printCmdHelp("verify", fs)
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *bundleKind != "" && *bundleKind != "before" && *bundleKind != "after" {
		return failf("verify: --kind: %q is not a valid pairing kind (allowed: before|after)", *bundleKind)
	}
	if *expIdentity != "" || *expIdentityRe != "" {
		ca := &honesty.CosignAnchor{OIDCIssuer: *oidcIssuer, IgnoreTlog: *insecureIgnoreTlog}
		if *expIdentityRe != "" {
			ca.ExpectedIdentity, ca.IdentityRegexp = *expIdentityRe, true
		} else {
			ca.ExpectedIdentity = *expIdentity
		}
		honesty.SetAnchorVerifier(ca)
		defer honesty.SetAnchorVerifier(nil)
	}
	r, err := manifest.Load(*manifestPath)
	if err != nil {
		return manifestErr(err)
	}
	opts := verify.Opts{
		EvidenceRoot: *evidenceRoot,
		Ticket:       *ticket,
		Claim:        *claim,
		Substrate:    *substrateKind,
		Dir:          filepath.Dir(*manifestPath),
		PairsWith:    *pairsWith,
		Kind:         *bundleKind,
		Provenance:   verify.ProvenanceOpts{Owner: *owner, SignerWorkflow: *signerWorkflow, Image: *image},
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
	if sum.SelfAttested {
		fmt.Println("proof:   self-attested (no externally-anchored signer) — capped at L3 until an anchored lock accepts it (ADR-0015)")
	}
	if sum.AnchorReason != "" {
		fmt.Printf("anchor:  %s\n", sum.AnchorReason)
	}
	if sum.ProvenanceRung != "" {
		fmt.Printf("provenance: %s\n", sum.ProvenanceReason)
	}
	fmt.Printf("verdict: %s\n", sum.Verdict)
	if sum.Note != "" {
		fmt.Printf("note:    %s\n", sum.Note)
	}
	for _, line := range sum.Lines {
		fmt.Printf("  %s\n", line)
	}
	if sum.Verdict != evidence.VerdictPass {
		return 1
	}
	return 0
}

// ----------------------------------------------------------------- explore

// cmdExplore runs one pb-explore round via the AgentRuntime family
// (agentruntime.Explore). It is experimental (backlog #17): gated behind
// PB_EXPERIMENTAL=1, and it only ever proposes checks — never a verdict, and
// it never edits ready.yaml.
func cmdExplore(args []string) int {
	if os.Getenv("PB_EXPERIMENTAL") != "1" {
		fmt.Fprintln(os.Stderr, "pb: explore is experimental; set PB_EXPERIMENTAL=1")
		return 2
	}
	fs := flag.NewFlagSet("pb explore", flag.ContinueOnError)
	manifestPath := fs.String("manifest", "ready.yaml", "path to ready.yaml")
	out := fs.String("out", filepath.Join(".proofbench", "explore"), "output directory for round artifacts")
	runtimeKind := fs.String("runtime", agentruntime.KindClaudeCode, "agent runtime kind")
	maxTurns := fs.Int("max-turns", 30, "agent turn budget")
	if wantsHelp(args) {
		return printCmdHelp("explore", fs)
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	r, err := manifest.Load(*manifestPath)
	if err != nil {
		return manifestErr(err)
	}
	res, err := agentruntime.Explore(r, filepath.Dir(*manifestPath), *out, *runtimeKind, *maxTurns)
	if err != nil {
		return fail(err)
	}
	fmt.Printf("status: %s\n", res.Status)
	if res.Reason != "" {
		fmt.Printf("reason: %s\n", res.Reason)
	}
	switch res.Status {
	case agentruntime.StatusProposed:
		fmt.Printf("proposal: %s\n", filepath.Join(*out, "proposed-checks.json"))
		return 0
	case agentruntime.StatusNotRun:
		return 3
	case agentruntime.StatusInconclusive:
		return 4
	default:
		return 1
	}
}

// ------------------------------------------------------------ report / hub

func cmdReport(args []string) int {
	fs := flag.NewFlagSet("pb report", flag.ContinueOnError)
	// ADR-0015: mirror `evidence validate` — a verdict is only rendered TRUSTED
	// when its seal verifies against a VERIFIER-SUPPLIED Sigstore identity; absent
	// that pin, the report stamps the verdict/proof level UNVERIFIED.
	expIdentity := fs.String("expected-identity", "", "require the bundle's manifest seal to verify against this Fulcio cert identity; unset renders the verdict UNVERIFIED")
	oidcIssuer := fs.String("oidc-issuer", honesty.DefaultOIDCIssuer, "expected OIDC issuer on the Fulcio cert (with --expected-identity)")
	if wantsHelp(args) {
		return printCmdHelp("report", fs)
	}
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
	opts := evidence.ValidateOpts{ExpectedIdentity: *expIdentity, OIDCIssuer: *oidcIssuer}
	sealVerified, sealDetail := evidence.SealStatus(fs.Arg(0), opts)
	md, err := report.Markdown(b, sealVerified, sealDetail)
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
	workspace := fs.String("workspace", "", "optional workspace.yaml: its service list distinguishes projects from shared infra in the Projects section")
	// ADR-0015: as with `pb report`, a verdict is stamped UNVERIFIED unless its
	// seal verifies against the verifier-supplied Sigstore identity.
	expIdentity := fs.String("expected-identity", "", "require each bundle's manifest seal to verify against this Fulcio cert identity; unset stamps verdicts UNVERIFIED")
	oidcIssuer := fs.String("oidc-issuer", honesty.DefaultOIDCIssuer, "expected OIDC issuer on the Fulcio cert (with --expected-identity)")
	if wantsHelp(args) {
		return printCmdHelp("hub", fs)
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	opts := evidence.ValidateOpts{ExpectedIdentity: *expIdentity, OIDCIssuer: *oidcIssuer}
	if err := report.WriteHubWithWorkspace(*root, *out, *workspace, opts); err != nil {
		return fail(err)
	}
	fmt.Println(*out)
	return 0
}
