// Package verify orchestrates a full verification run: bring the target up
// on the chosen substrate, exercise the manifest's declared checks, and
// capture everything into an evidence bundle.
package verify

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/launchwings/proofbench/internal/checkdriver"
	"github.com/launchwings/proofbench/internal/evidence"
	"github.com/launchwings/proofbench/internal/manifest"
	"github.com/launchwings/proofbench/internal/substrate"
)

// Opts configures a verification run.
type Opts struct {
	EvidenceRoot string   // root directory for evidence bundles
	Ticket       string   // optional ticket key recorded in the bundle
	Claim        string   // the claim under verification
	Substrate    string   // substrate kind (local|compose|k8s-attach)
	Dir          string   // repo dir containing the manifest; "" = "."
	Only         []string // restrict to these check names; empty = all
	PairsWith    string   // runId of the paired bundle; plumbed into the bundle's manifest.pairsWith
	Kind         string   // before|after; plumbed into the bundle's manifest.kind
}

// Summary is the machine-readable result of a verification run.
type Summary struct {
	ProofLevel string           // highest proof-ladder rung reached (L0–L5)
	Checks     []evidence.Check // tri-state result per declared check
	Verdict    string           // pass|fail|inconclusive
}

// bundleOps is the slice of *evidence.Bundle behavior verify needs; it lets
// the check loop be tested without a finished evidence implementation.
type bundleOps interface {
	Run(name string, argv []string, shell bool) (int, error)
	Assert(expr string) (observed string, ok bool, err error)
}

// Run evaluates the manifest's declared checks' expect predicates, records
// tri-state results and artifacts into a new evidence bundle, sets the
// verdict last, and returns the sealed bundle plus a summary.
//
// Substrate bring-up (up + ready + seed) is the CLI's job (pb up runs
// first); Run only validates the substrate kind and records it in the
// bundle's surface — an unknown kind fails the run fast rather than silently
// degrading to a substrate-blind local exec (see substrate.New).
func Run(r *manifest.Ready, o Opts) (*evidence.Bundle, *Summary, error) {
	root := o.EvidenceRoot
	if root == "" {
		root = "./evidence"
	}
	dir := o.Dir
	if dir == "" {
		dir = "."
	}
	s, err := substrate.New(o.Substrate, dir)
	if err != nil {
		return nil, nil, fmt.Errorf("verify.Run: %w", err)
	}
	no := evidence.NewOpts{Ticket: o.Ticket, Claim: o.Claim, Phase: evidence.PhaseVerify, PairsWith: o.PairsWith, Kind: o.Kind}
	if o.Substrate != "" {
		no.Surface = map[string]string{"substrate": o.Substrate}
	}
	b, err := evidence.New(root, no)
	if err != nil {
		return nil, nil, err
	}
	if pins := resolvePins(dir, s); len(pins) > 0 {
		b.M.Pins = pins
	}
	endpoints := resolveEndpoints(r, s)
	checks := runChecks(r, o, b, endpoints, unattached(r, s, endpoints))
	b.M.Checks = append(b.M.Checks, checks...)
	level := proofLevel(checks)
	b.M.ProofLevel = level
	v, note := verdict(checks)
	if err := b.SetVerdict(v, note); err != nil {
		return nil, nil, err
	}
	// The bundle manifest's proofLevel stays "" (omitted; spec/v0's enum has
	// no "none" value) when nothing passed, but the CLI-facing Summary must
	// never render a blank "proof:" line.
	summaryLevel := level
	if summaryLevel == "" {
		summaryLevel = "none"
	}
	return b, &Summary{ProofLevel: summaryLevel, Checks: checks, Verdict: v}, nil
}

// resolvePins collects run-pinning identifiers (PLAN §5: "run pinning — SHAs
// /versions of everything exercised") into the bundle's manifest: the repo
// under test's git commit, plus whatever the substrate's optional Pinner
// capability reports (image digests, cluster context/namespace, ...). Either
// source is omitted, never fabricated, when it can't be resolved — a
// Pinner error is not fatal to the run, since pins are provenance, not a
// check.
func resolvePins(dir string, s substrate.Substrate) map[string]string {
	out := map[string]string{}
	if sha, ok := repoPin(dir); ok {
		out["repo"] = sha
	}
	if pinner, ok := s.(substrate.Pinner); ok {
		if sp, err := pinner.Pins(); err == nil {
			for k, v := range sp {
				out[k] = v
			}
		}
	}
	return out
}

// repoPin resolves the git commit the repo under test is pinned to via
// `git -C dir rev-parse HEAD`, suffixed "-dirty" when `git status --porcelain`
// reports uncommitted changes. Absent git (dir isn't a checkout, or git isn't
// installed) omits the pin entirely — never a fabricated value.
func repoPin(dir string) (string, bool) {
	out, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		return "", false
	}
	sha := strings.TrimSpace(string(out))
	if sha == "" {
		return "", false
	}
	if statusOut, err := exec.Command("git", "-C", dir, "status", "--porcelain").Output(); err == nil && strings.TrimSpace(string(statusOut)) != "" {
		sha += "-dirty"
	}
	return sha, true
}

// runChecks executes every declared check independently — one failure never
// aborts the rest — and returns one tri-state result per CheckSpec, in order.
// endpoints (resource/service name -> host:port, resolved via the substrate's
// optional Endpoints capability) are substituted into exercise strings so the
// drive verbs stay substrate-blind (they always dial localhost). A check
// declaring env inputs it requires (spec.Requires) that are unset in the
// process environment at verify time records not-run rather than hard-failing
// — the operator-supplied ids these checks need (e.g. an execution ID) are
// documented on the check itself, not just in a fixture comment.
func runChecks(r *manifest.Ready, o Opts, ops bundleOps, endpoints map[string]string, notAttached bool) []evidence.Check {
	out := make([]evidence.Check, 0, len(r.Checks))
	for _, spec := range r.Checks {
		c := evidence.Check{
			Name:   spec.Name,
			Level:  spec.Level,
			Expect: strings.Join(spec.Expect, " && "),
		}
		if len(o.Only) > 0 && !slices.Contains(o.Only, spec.Name) {
			c.State = evidence.CheckNotRun
			c.Reason = "filtered"
			out = append(out, c)
			continue
		}
		if g, gated := gateFor(r, spec); gated {
			c.State = evidence.CheckNotRun
			c.Reason = "gated: " + g.Reason
			out = append(out, c)
			continue
		}
		if name, missing := missingRequires(spec.Requires); missing {
			c.State = evidence.CheckNotRun
			c.Reason = fmt.Sprintf("required input %s unset", name)
			out = append(out, c)
			continue
		}
		// An Endpoints-substrate that never attached (no forwards / cluster
		// unreachable) cannot exercise a check that needs the service up:
		// L3 (up+healthy) and above per the proof ladder. Fail those
		// gracefully with a clear reason instead of shelling out a command
		// against a service that is not reachable. L0–L2 (static/build/unit)
		// need no service, so they still run.
		if notAttached && needsService(spec.Level) {
			c.State = evidence.CheckFail
			c.Reason = unattachedReason(o.Substrate, nil)
			out = append(out, c)
			continue
		}
		out = append(out, runCheck(r, spec, o, ops, endpoints, c))
	}
	return out
}

// missingRequires reports the first name in requires whose environment
// variable is unset or empty in the current process, if any — the honest-
// gating signal for a check that declares operator-supplied env inputs it
// needs (PLAN §3.7-style: never a hardcoded assumption they're set).
func missingRequires(requires []string) (name string, missing bool) {
	for _, n := range requires {
		if os.Getenv(n) == "" {
			return n, true
		}
	}
	return "", false
}

// gateFor reports the manifest gate (PLAN §3.7 "human gates as schema")
// matching spec, if any: a gates[].on naming either the check's resolved
// drive verb (its exercise's "drive.<verb>" indirection) or the check's own
// name. Manifests with no gates — the vast majority, and every manifest
// written before this feature — always report no match, so behavior is
// unchanged for them.
func gateFor(r *manifest.Ready, spec manifest.CheckSpec) (manifest.Gate, bool) {
	if len(r.Gates) == 0 {
		return manifest.Gate{}, false
	}
	verb, _ := strings.CutPrefix(spec.Exercise, "drive.")
	for _, g := range r.Gates {
		if g.On == spec.Name || (verb != "" && g.On == verb) {
			return g, true
		}
	}
	return manifest.Gate{}, false
}

// resolveExercise turns a CheckSpec exercise into a shell command:
// "drive.<name>" means the named drive verb's run string; anything else is
// already a raw shell command. Endpoint placeholders (${resources.<n>.host},
// ${resources.<n>.port}, ${endpoints.<n>}) are substituted last so drivers
// dial localhost regardless of substrate.
func resolveExercise(r *manifest.Ready, exercise string, endpoints map[string]string) (string, error) {
	name, isDrive := strings.CutPrefix(exercise, "drive.")
	if !isDrive {
		return checkdriver.SubstituteEndpoints(exercise, endpoints), nil
	}
	v, ok := r.Drive[name]
	if !ok {
		return "", fmt.Errorf("unknown drive verb %q", name)
	}
	return checkdriver.SubstituteEndpoints(v.Run, endpoints), nil
}

// unattachedReason explains why a check could not run: its exercise still
// carries endpoint placeholders the substrate never resolved, meaning the
// substrate is not attached (its Up never ran, or the cluster is unreachable).
// The message is generic across substrates; for k8s-attach it names the
// concrete recovery so a QA/devops caller sees "cluster unreachable / not
// attached" rather than a shell "bad substitution" crash.
func unattachedReason(kind string, unresolved []string) string {
	target := "the service"
	if len(unresolved) > 0 {
		target = strings.Join(unresolved, ", ")
	}
	if kind == substrate.KindK8sAttach {
		return fmt.Sprintf(
			"cluster unreachable / not attached: no forwarded endpoint for %s "+
				"(run `pb up --substrate k8s-attach` against a reachable cluster first)",
			target)
	}
	return fmt.Sprintf(
		"substrate %q reported no endpoint for %s (bring it up with `pb up --substrate %s` first)",
		kind, target, kind)
}

// needsService reports whether a proof-ladder rung requires the service to be
// up and reachable: L3 (up+healthy) and above per spec/v0/ready.schema.json.
// L0 (static), L1 (build), L2 (unit) and any unparseable level do not.
func needsService(level string) bool {
	n, ok := levelNum(level)
	return ok && n >= 3
}

// unattached reports whether the selected substrate needs an attachment it does
// not currently have: it implements the optional Endpoints capability and the
// manifest declares resources reachable only via that capability, yet no
// endpoint resolved (Up never ran, or the cluster is unreachable). local and
// compose — which don't implement Endpoints — are never "unattached" here.
// s is the substrate Run already constructed and validated; unattached never
// re-resolves the kind, so an invalid kind can't silently read as "attached".
func unattached(r *manifest.Ready, s substrate.Substrate, endpoints map[string]string) bool {
	if _, ok := s.(substrate.Endpoints); !ok {
		return false
	}
	return len(endpoints) == 0 && declaresAttachTargets(r)
}

// declaresAttachTargets reports whether the manifest names anything an
// Endpoints-substrate would forward: a sources.k8s locator or any resource with
// a via.k8s locator. Without such a target there is nothing to attach, so an
// empty endpoint map is expected, not a failure.
func declaresAttachTargets(r *manifest.Ready) bool {
	if r.Sources["k8s"] != "" {
		return true
	}
	for _, res := range r.Resources {
		if res.Via["k8s"] != "" {
			return true
		}
	}
	return false
}

// resolveEndpoints fills a name -> host:port map for every resource (and the
// service) the substrate can report through its optional Endpoints capability.
// local/compose (which don't implement Endpoints) yield an empty map — their
// locators are already local, so placeholders resolve to themselves via the
// manifest's own env. A per-resource resolution failure is skipped, not fatal:
// an unresolved placeholder surfaces as a runtime error in the exercise. s is
// the substrate Run already constructed and validated; resolveEndpoints never
// re-resolves the kind, so an invalid kind can't silently yield an empty map.
func resolveEndpoints(r *manifest.Ready, s substrate.Substrate) map[string]string {
	ep, ok := s.(substrate.Endpoints)
	if !ok {
		return nil
	}
	out := map[string]string{}
	names := make([]string, 0, len(r.Resources)+1)
	for name := range r.Resources {
		names = append(names, name)
	}
	if r.Service != "" {
		names = append(names, r.Service)
	}
	for _, name := range names {
		if hostport, err := ep.Endpoint(name); err == nil {
			out[name] = hostport
		}
	}
	return out
}

// runCheck exercises one check through its CheckDriver — exec (the default,
// checkdriver.execDriver) or a named driver like playwright — dispatched the
// same way via checkdriver.New in both cases, so execDriver is the single
// exec implementation (no inline duplicate). Preflight failure records
// not-run (ADR-0012); the driver emits its artifacts via the bundle's
// Capture seam. verify still owns tri-state: expect predicates evaluate
// afterward via evaluateExpects, same for every driver.
func runCheck(r *manifest.Ready, spec manifest.CheckSpec, o Opts, ops bundleOps, endpoints map[string]string, c evidence.Check) evidence.Check {
	capture, ok := ops.(evidence.Capture)
	if !ok {
		c.State = evidence.CheckFail
		c.Reason = fmt.Sprintf("driver %q needs a capture-capable bundle", spec.Driver)
		return c
	}
	dir := o.Dir
	if dir == "" {
		dir = "."
	}
	d, err := checkdriver.New(spec.Driver, dir)
	if err != nil {
		c.State = evidence.CheckFail
		c.Reason = err.Error()
		return c
	}
	if err := d.Preflight(); err != nil {
		c.State = evidence.CheckNotRun
		c.Reason = err.Error()
		return c
	}
	// The exec driver's exercise is a shell command that may still be a
	// "drive.<verb>" indirection into the manifest's drive verbs; every other
	// driver's exercise (a spec file, ...) is only endpoint-substituted.
	var exercise string
	if spec.Driver == "" || spec.Driver == checkdriver.KindExec {
		resolved, err := resolveExercise(r, spec.Exercise, endpoints)
		if err != nil {
			c.State = evidence.CheckFail
			c.Reason = err.Error()
			return c
		}
		exercise = resolved
	} else {
		exercise = checkdriver.SubstituteEndpoints(spec.Exercise, endpoints)
	}
	if unresolved := checkdriver.UnresolvedEndpoints(exercise); len(unresolved) > 0 {
		c.State = evidence.CheckFail
		c.Reason = unattachedReason(o.Substrate, unresolved)
		return c
	}
	// A missing exercise input (the driver would shell out against a file
	// that isn't there) is a preflight-class problem (ADR-0012), not a
	// verdict-poisoning failure: not-run with a reason naming the path.
	if path, ok := exerciseFilePath(spec.Driver, exercise); ok {
		full := path
		if !filepath.IsAbs(full) {
			full = filepath.Join(dir, full)
		}
		if _, statErr := os.Stat(full); statErr != nil {
			c.State = evidence.CheckNotRun
			c.Reason = fmt.Sprintf("exercise file not found: %s", path)
			return c
		}
	}
	spec.Exercise = exercise // already resolved; the driver's own substitution becomes a no-op
	env := checkdriver.Env{Dir: dir, Endpoints: endpoints}
	if _, err := d.Exercise(spec, env, capture); err != nil {
		c.State = evidence.CheckFail
		c.Reason = "exercise: " + err.Error()
		return c
	}
	return evaluateExpects(ops, spec.Expect, c)
}

// exerciseFilePath reports whether exercise (already endpoint-resolved) is
// unambiguously a bare file reference, and if so, the path — a
// preflight-class check (ADR-0012), never a heuristic that risks running an
// ordinary shell command. The playwright driver's exercise IS a spec file
// path by construction, so it always qualifies. The exec driver's exercise
// only qualifies when it is a single whitespace-free token free of shell
// metacharacters that also looks like a path (a "/" or a recognized
// script/spec extension) — an ambiguous shell string ("npm test", "curl ...")
// is left alone and still runs, matching or failing on its own merits.
func exerciseFilePath(driver, exercise string) (string, bool) {
	trimmed := strings.TrimSpace(exercise)
	if trimmed == "" {
		return "", false
	}
	if driver == checkdriver.KindPlaywright {
		return trimmed, true
	}
	if driver != "" && driver != checkdriver.KindExec {
		return "", false
	}
	if strings.ContainsAny(trimmed, " \t\n|&;()<>$`\\*?[]{}'\"#~") {
		return "", false
	}
	if strings.Contains(trimmed, "/") || hasScriptExt(trimmed) {
		return trimmed, true
	}
	return "", false
}

// hasScriptExt reports whether s ends in a common test/script extension —
// part of exerciseFilePath's "clear file reference" heuristic.
func hasScriptExt(s string) bool {
	for _, ext := range []string{".spec.ts", ".spec.js", ".test.ts", ".test.js", ".sh", ".py", ".js", ".ts"} {
		if strings.HasSuffix(s, ext) {
			return true
		}
	}
	return false
}

// evaluateExpects runs each expect predicate via ops.Assert, recording every
// observed value and downgrading c to fail on the first failing/erroring
// predicate (without stopping early) — a nonzero exit is only a failure if an
// expect says so (exitCode(...)==0); a check with zero expects passes
// vacuously. Shared by every CheckDriver dispatch in runCheck.
func evaluateExpects(ops bundleOps, exprs []string, c evidence.Check) evidence.Check {
	c.State = evidence.CheckPass
	observed := make([]string, 0, len(exprs))
	for _, expr := range exprs {
		obs, ok, err := ops.Assert(expr)
		if err != nil {
			c.State = evidence.CheckFail
			if c.Reason == "" {
				c.Reason = expr + ": " + err.Error()
			}
			observed = append(observed, "error: "+err.Error())
			continue
		}
		observed = append(observed, obs)
		if !ok {
			c.State = evidence.CheckFail
			if c.Reason == "" {
				c.Reason = "expect failed: " + expr
			}
		}
	}
	c.Observed = strings.Join(observed, "; ")
	return c
}

// proofLevel returns the highest Ln such that at least one check at Ln
// passed and no check with level <= Ln that ran failed; "" if none passed.
func proofLevel(checks []evidence.Check) string {
	var passed [6]bool
	minFailed := 6 // lowest failed rung; 6 = none
	for _, c := range checks {
		n, ok := levelNum(c.Level)
		if !ok {
			// Checks without a parseable L0-L5 level neither advance nor
			// block the ladder.
			continue
		}
		switch c.State {
		case evidence.CheckPass:
			passed[n] = true
		case evidence.CheckFail:
			if n < minFailed {
				minFailed = n
			}
		}
	}
	best := ""
	for n := 0; n < minFailed && n <= 5; n++ {
		if passed[n] {
			best = fmt.Sprintf("L%d", n)
		}
	}
	return best
}

// levelNum parses a proof-ladder rung "L0".."L5" into its number.
func levelNum(s string) (int, bool) {
	if len(s) != 2 || s[0] != 'L' || s[1] < '0' || s[1] > '5' {
		return 0, false
	}
	return int(s[1] - '0'), true
}

// verdict derives the bundle verdict plus a counts note from the check
// results: pass iff no check failed, at least one passed, and no check was
// skipped for being gated (PLAN §3.7: a gated skip must read as inconclusive,
// never as a fake pass); fail if any failed (naming them); else inconclusive.
func verdict(checks []evidence.Check) (string, string) {
	var pass, fail, notRun int
	var failedNames []string
	gated := false
	for _, c := range checks {
		switch c.State {
		case evidence.CheckPass:
			pass++
		case evidence.CheckFail:
			fail++
			failedNames = append(failedNames, c.Name)
		default:
			notRun++
			if strings.HasPrefix(c.Reason, "gated: ") {
				gated = true
			}
		}
	}
	if fail > 0 {
		note := fmt.Sprintf("%d pass, %d fail (%s), %d not-run",
			pass, fail, strings.Join(failedNames, ", "), notRun)
		return evidence.VerdictFail, note
	}
	note := fmt.Sprintf("%d pass, %d fail, %d not-run", pass, fail, notRun)
	if pass > 0 && !gated {
		return evidence.VerdictPass, note
	}
	return evidence.VerdictInconclusive, note
}
