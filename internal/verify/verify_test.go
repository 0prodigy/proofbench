package verify

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/launchwings/proofbench/internal/evidence"
	"github.com/launchwings/proofbench/internal/manifest"
)

// fakeOps executes exercises for real (bash -lc, echo-based) and supports the
// exitCode(<name>)==<int> predicate, standing in for *evidence.Bundle until
// the evidence slice lands.
type fakeOps struct {
	exit     map[string]int   // exit code per run name
	ran      []string         // run names in order
	spawnErr map[string]error // forced spawn failures per run name
}

func newFakeOps() *fakeOps {
	return &fakeOps{exit: map[string]int{}}
}

func (f *fakeOps) Run(name string, argv []string, shell bool) (int, error) {
	if !shell || len(argv) != 1 {
		return -1, errors.New("fake run: verify must pass shell=true with one command string")
	}
	if err := f.spawnErr[name]; err != nil {
		return -1, err
	}
	cmd := exec.Command("bash", "-lc", argv[0])
	err := cmd.Run()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		return -1, err
	}
	f.exit[name] = code
	f.ran = append(f.ran, name)
	return code, nil
}

// Exec satisfies evidence.Capture by delegating to Run: runCheck dispatches
// every driver (exec included) through checkdriver.New, which needs a
// capture-capable bundle, so the test double must present one too.
func (f *fakeOps) Exec(name string, argv []string, shell bool) (int, error) {
	return f.Run(name, argv, shell)
}

// File satisfies evidence.Capture; no verify test drives a driver that
// claims a driver-produced file.
func (f *fakeOps) File(_, _, _ string, _ map[string]any) error {
	return nil
}

// BundleDir satisfies evidence.Capture; no verify test drives a driver that
// reads it.
func (f *fakeOps) BundleDir() string { return "" }

func (f *fakeOps) Assert(expr string) (string, bool, error) {
	rest, isExit := strings.CutPrefix(expr, "exitCode(")
	if !isExit {
		return "", false, errors.New("fake assert: unsupported " + expr)
	}
	name, wantStr, ok := strings.Cut(rest, ")==")
	if !ok {
		return "", false, errors.New("fake assert: bad " + expr)
	}
	got, ranOK := f.exit[name]
	if !ranOK {
		return "", false, errors.New("fake assert: no run named " + name)
	}
	want, err := strconv.Atoi(wantStr)
	if err != nil {
		return "", false, err
	}
	return strconv.Itoa(got), got == want, nil
}

func ready(checks ...manifest.CheckSpec) *manifest.Ready {
	return &manifest.Ready{
		Drive:  map[string]manifest.DriveVerb{"fire": {Run: "echo fired"}},
		Checks: checks,
	}
}

func TestRunChecksAllPass(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "a", Level: "L2", Exercise: "echo hi", Expect: []string{"exitCode(a)==0"}},
		manifest.CheckSpec{Name: "b", Level: "L4", Exercise: "drive.fire", Expect: []string{"exitCode(b)==0"}},
	)
	ops := newFakeOps()
	checks := runChecks(r, Opts{}, ops, nil, false)
	if len(checks) != 2 {
		t.Fatalf("got %d checks, want 2", len(checks))
	}
	for _, c := range checks {
		if c.State != evidence.CheckPass {
			t.Errorf("check %s: state %q reason %q, want pass", c.Name, c.State, c.Reason)
		}
	}
	if checks[1].Observed != "0" {
		t.Errorf("drive check observed %q, want 0", checks[1].Observed)
	}
	if strings.Join(ops.ran, ",") != "a,b" {
		t.Errorf("ran %v, want [a b] in order", ops.ran)
	}
	v, note := verdict(checks)
	if v != evidence.VerdictPass || note != "2 pass, 0 fail, 0 not-run" {
		t.Errorf("verdict %q note %q", v, note)
	}
	if got := proofLevel(checks); got != "L4" {
		t.Errorf("proofLevel %q, want L4", got)
	}
}

func TestRunChecksOneFailNeverAbortsRest(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "bad", Level: "L2", Exercise: "exit 3", Expect: []string{"exitCode(bad)==0"}},
		manifest.CheckSpec{Name: "good", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(good)==0"}},
	)
	ops := newFakeOps()
	checks := runChecks(r, Opts{}, ops, nil, false)
	if checks[0].State != evidence.CheckFail {
		t.Errorf("bad: state %q, want fail", checks[0].State)
	}
	if checks[0].Observed != "3" {
		t.Errorf("bad: observed %q, want 3", checks[0].Observed)
	}
	if !strings.Contains(checks[0].Reason, "exitCode(bad)==0") {
		t.Errorf("bad: reason %q should name the failed expect", checks[0].Reason)
	}
	if checks[1].State != evidence.CheckPass {
		t.Errorf("good: state %q, want pass — a failure must not abort later checks", checks[1].State)
	}
	v, note := verdict(checks)
	if v != evidence.VerdictFail || note != "1 pass, 1 fail (bad), 0 not-run" {
		t.Errorf("verdict %q note %q, want fail with counts naming the failed check", v, note)
	}
	// fail at L2 blocks the L4 pass
	if got := proofLevel(checks); got != "" {
		t.Errorf("proofLevel %q, want empty", got)
	}
}

func TestRunChecksOnlyFilter(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "a", Level: "L1", Exercise: "echo a", Expect: []string{"exitCode(a)==0"}},
		manifest.CheckSpec{Name: "b", Level: "L3", Exercise: "echo b", Expect: []string{"exitCode(b)==0"}},
	)
	ops := newFakeOps()
	checks := runChecks(r, Opts{Only: []string{"b"}}, ops, nil, false)
	if checks[0].State != evidence.CheckNotRun || checks[0].Reason != "filtered" {
		t.Errorf("a: state %q reason %q, want not-run/filtered", checks[0].State, checks[0].Reason)
	}
	if checks[1].State != evidence.CheckPass {
		t.Errorf("b: state %q, want pass", checks[1].State)
	}
	if strings.Join(ops.ran, ",") != "b" {
		t.Errorf("ran %v — a filtered check must not execute", ops.ran)
	}
	v, note := verdict(checks)
	if v != evidence.VerdictPass || note != "1 pass, 0 fail, 1 not-run" {
		t.Errorf("verdict %q note %q", v, note)
	}
}

func TestRunChecksUnknownDriveVerb(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "x", Level: "L4", Exercise: "drive.nope"},
		manifest.CheckSpec{Name: "y", Level: "L2", Exercise: "echo y", Expect: []string{"exitCode(y)==0"}},
	)
	ops := newFakeOps()
	checks := runChecks(r, Opts{}, ops, nil, false)
	if checks[0].State != evidence.CheckFail || !strings.Contains(checks[0].Reason, "nope") {
		t.Errorf("x: state %q reason %q, want fail naming the verb", checks[0].State, checks[0].Reason)
	}
	if checks[1].State != evidence.CheckPass {
		t.Errorf("y: state %q, want pass", checks[1].State)
	}
}

func TestRunChecksSpawnFailure(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "x", Level: "L3", Exercise: "echo hi", Expect: []string{"exitCode(x)==0"}},
	)
	ops := newFakeOps()
	ops.spawnErr = map[string]error{"x": errors.New("no such binary")}
	checks := runChecks(r, Opts{}, ops, nil, false)
	if checks[0].State != evidence.CheckFail || !strings.Contains(checks[0].Reason, "no such binary") {
		t.Errorf("x: state %q reason %q, want fail with spawn reason", checks[0].State, checks[0].Reason)
	}
}

func TestRunChecksExpectError(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "x", Level: "L3", Exercise: "echo hi", Expect: []string{"bogus predicate"}},
	)
	checks := runChecks(r, Opts{}, newFakeOps(), nil, false)
	if checks[0].State != evidence.CheckFail || !strings.Contains(checks[0].Reason, "bogus predicate") {
		t.Errorf("x: state %q reason %q, want fail naming the erroring expect", checks[0].State, checks[0].Reason)
	}
}

func TestRunChecksNoExpectsPassesVacuously(t *testing.T) {
	r := ready(manifest.CheckSpec{Name: "x", Level: "L1", Exercise: "exit 7"})
	checks := runChecks(r, Opts{}, newFakeOps(), nil, false)
	if checks[0].State != evidence.CheckPass {
		t.Errorf("x: state %q, want pass (no expects, exercise spawned)", checks[0].State)
	}
}

// TestRunChecksUnattachedGatesServiceRungs proves an Endpoints-substrate that
// never attached fails L3+ checks gracefully (clear reason, no shell-out) while
// L0–L2 checks still run.
func TestRunChecksUnattachedGatesServiceRungs(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "unit", Level: "L2", Exercise: "echo ok", Expect: []string{"exitCode(unit)==0"}},
		manifest.CheckSpec{Name: "health", Level: "L3", Exercise: "curl http://example/x", Expect: []string{"exitCode(health)==0"}},
		manifest.CheckSpec{Name: "effect", Level: "L4", Exercise: "drive.fire", Expect: []string{"exitCode(effect)==0"}},
	)
	ops := newFakeOps()
	checks := runChecks(r, Opts{Substrate: "k8s-attach"}, ops, nil, true)
	if checks[0].State != evidence.CheckPass {
		t.Errorf("unit (L2): state %q, want pass — a no-service rung must still run", checks[0].State)
	}
	for _, c := range checks[1:] {
		if c.State != evidence.CheckFail {
			t.Errorf("%s (%s): state %q, want fail", c.Name, c.Level, c.State)
		}
		if !strings.Contains(c.Reason, "not attached") {
			t.Errorf("%s: reason %q should say not attached", c.Name, c.Reason)
		}
	}
	if strings.Join(ops.ran, ",") != "unit" {
		t.Errorf("ran %v — an unattached L3+ check must not shell out", ops.ran)
	}
}

// TestRunChecksUnresolvedPlaceholderNeverShellsOut proves a check whose
// exercise still carries an endpoint placeholder (substrate reported no
// locator) fails gracefully rather than running a half-substituted command.
func TestRunChecksUnresolvedPlaceholderNeverShellsOut(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "health", Level: "L3",
			Exercise: "curl http://${resources.appservice.host}:${resources.appservice.port}/x",
			Expect:   []string{"exitCode(health)==0"}},
	)
	ops := newFakeOps()
	checks := runChecks(r, Opts{Substrate: "k8s-attach"}, ops, nil, false)
	if checks[0].State != evidence.CheckFail {
		t.Fatalf("health: state %q, want fail", checks[0].State)
	}
	if !strings.Contains(checks[0].Reason, "not attached") {
		t.Errorf("health: reason %q should say not attached", checks[0].Reason)
	}
	if len(ops.ran) != 0 {
		t.Errorf("ran %v — must not shell out a command with an unresolved endpoint", ops.ran)
	}
}

func TestProofLevel(t *testing.T) {
	c := func(level, state string) evidence.Check { return evidence.Check{Level: level, State: state} }
	tests := []struct {
		name   string
		checks []evidence.Check
		want   string
	}{
		{"none passed", []evidence.Check{c("L2", evidence.CheckFail)}, ""},
		{"empty", nil, ""},
		{"single pass", []evidence.Check{c("L2", evidence.CheckPass)}, "L2"},
		{"highest of two passes", []evidence.Check{c("L2", evidence.CheckPass), c("L4", evidence.CheckPass)}, "L4"},
		{"lower fail blocks higher pass", []evidence.Check{c("L2", evidence.CheckFail), c("L4", evidence.CheckPass)}, ""},
		{"pass below the failed rung survives", []evidence.Check{c("L1", evidence.CheckPass), c("L3", evidence.CheckFail), c("L4", evidence.CheckPass)}, "L1"},
		{"fail at same rung as pass blocks it", []evidence.Check{c("L3", evidence.CheckPass), c("L3", evidence.CheckFail)}, ""},
		{"not-run never blocks", []evidence.Check{c("L2", evidence.CheckNotRun), c("L4", evidence.CheckPass)}, "L4"},
		{"L0 and L5 bounds", []evidence.Check{c("L0", evidence.CheckPass), c("L5", evidence.CheckPass)}, "L5"},
		{"unparseable level ignored", []evidence.Check{c("weird", evidence.CheckPass)}, ""},
		{"unparseable fail does not block", []evidence.Check{c("weird", evidence.CheckFail), c("L2", evidence.CheckPass)}, "L2"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := proofLevel(tt.checks); got != tt.want {
				t.Errorf("proofLevel = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestVerdict(t *testing.T) {
	c := func(name, state string) evidence.Check { return evidence.Check{Name: name, State: state} }
	tests := []struct {
		name     string
		checks   []evidence.Check
		want     string
		wantNote string
	}{
		{"all pass", []evidence.Check{c("a", evidence.CheckPass)}, evidence.VerdictPass, "1 pass, 0 fail, 0 not-run"},
		{"any fail", []evidence.Check{c("a", evidence.CheckPass), c("b", evidence.CheckFail)}, evidence.VerdictFail, "1 pass, 1 fail (b), 0 not-run"},
		{"two fails named", []evidence.Check{c("a", evidence.CheckFail), c("b", evidence.CheckFail)}, evidence.VerdictFail, "0 pass, 2 fail (a, b), 0 not-run"},
		{"all not-run", []evidence.Check{c("a", evidence.CheckNotRun)}, evidence.VerdictInconclusive, "0 pass, 0 fail, 1 not-run"},
		{"no checks", nil, evidence.VerdictInconclusive, noChecksDeclaredNote},
		{"pass plus not-run", []evidence.Check{c("a", evidence.CheckPass), c("b", evidence.CheckNotRun)}, evidence.VerdictPass, "1 pass, 0 fail, 1 not-run"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v, note := verdict(tt.checks)
			if v != tt.want || note != tt.wantNote {
				t.Errorf("verdict = %q %q, want %q %q", v, note, tt.want, tt.wantNote)
			}
		})
	}
}

// TestRunUnknownSubstrateFailsFast proves Run rejects an unknown substrate
// kind up front rather than silently degrading to a substrate-blind local
// exec: no bundle is created and no check runs.
func TestRunUnknownSubstrateFailsFast(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "a", Level: "L2", Exercise: "echo hi", Expect: []string{"exitCode(a)==0"}},
	)
	root := t.TempDir()
	b, sum, err := Run(r, Opts{EvidenceRoot: root, Claim: "bogus substrate", Substrate: "bogus"})
	if err == nil {
		t.Fatal("Run(substrate=bogus) expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "bogus") {
		t.Errorf("Run error %q should name the bad substrate kind", err.Error())
	}
	if b != nil || sum != nil {
		t.Errorf("Run(substrate=bogus) returned bundle %v summary %v, want nil, nil", b, sum)
	}
	entries, rerr := os.ReadDir(root)
	if rerr != nil {
		t.Fatalf("read evidence root: %v", rerr)
	}
	if len(entries) != 0 {
		t.Errorf("Run(substrate=bogus) created %d bundle dir(s), want none", len(entries))
	}
}

// TestRunEndToEnd exercises the exported Run against the real evidence
// package; it skips while the evidence slice is still stubbed.
func TestRunEndToEnd(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "a", Level: "L2", Exercise: "echo hi", Expect: []string{"exitCode(a)==0"}},
	)
	b, sum, err := Run(r, Opts{EvidenceRoot: t.TempDir(), Claim: "echo works", Substrate: "local"})
	if err != nil {
		if strings.Contains(err.Error(), "not implemented") {
			t.Skipf("evidence slice not implemented yet: %v", err)
		}
		t.Fatalf("Run: %v", err)
	}
	if b == nil || b.M == nil {
		t.Fatal("Run returned nil bundle")
	}
	if b.M.Surface["substrate"] != "local" {
		t.Errorf("surface %v, want substrate=local", b.M.Surface)
	}
	if sum.Verdict != evidence.VerdictPass || sum.ProofLevel != "L2" {
		t.Errorf("summary verdict %q proof %q, want pass/L2", sum.Verdict, sum.ProofLevel)
	}
	if len(b.M.Checks) != 1 || b.M.Checks[0].State != evidence.CheckPass {
		t.Errorf("manifest checks %+v, want one passing check", b.M.Checks)
	}
	if b.M.ProofLevel != "L2" {
		t.Errorf("manifest proofLevel %q, want L2", b.M.ProofLevel)
	}
}

// TestRunPairingFieldsLandInManifest proves --pairs-with/--kind (plumbed via
// Opts.PairsWith/Opts.Kind) reach the sealed bundle's manifest.json, reading
// it back from disk (not just the in-memory Bundle) to prove the round trip.
func TestRunPairingFieldsLandInManifest(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "a", Level: "L2", Exercise: "echo hi", Expect: []string{"exitCode(a)==0"}},
	)
	b, _, err := Run(r, Opts{
		EvidenceRoot: t.TempDir(),
		Claim:        "paired run",
		Substrate:    "local",
		PairsWith:    "20260101-120000-verify",
		Kind:         "after",
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if b.M.PairsWith != "20260101-120000-verify" {
		t.Errorf("manifest pairsWith %q, want 20260101-120000-verify", b.M.PairsWith)
	}
	if b.M.Kind != "after" {
		t.Errorf("manifest kind %q, want after", b.M.Kind)
	}

	reopened, err := evidence.Open(b.Dir)
	if err != nil {
		t.Fatalf("evidence.Open: %v", err)
	}
	if reopened.M.PairsWith != "20260101-120000-verify" || reopened.M.Kind != "after" {
		t.Errorf("reopened manifest pairsWith=%q kind=%q, want 20260101-120000-verify/after",
			reopened.M.PairsWith, reopened.M.Kind)
	}
}

// ------------------------------------------------------------------- pins

// runGit runs `git -C dir <args>`, failing the test on error.
func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

// initGitRepo creates a git-init'd, one-commit repo at dir.
func initGitRepo(t *testing.T, dir string) {
	t.Helper()
	runGit(t, dir, "init", "--quiet")
	runGit(t, dir, "config", "user.email", "pb@example.com")
	runGit(t, dir, "config", "user.name", "pb")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "f.txt")
	runGit(t, dir, "commit", "--quiet", "-m", "init")
}

// TestRunPinsRepoSHA proves Run pins the git commit of the repo under test,
// suffixing "-dirty" once the tree has uncommitted changes, and that the pin
// round-trips through the sealed bundle on disk.
func TestRunPinsRepoSHA(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not in PATH")
	}
	dir := t.TempDir()
	initGitRepo(t, dir)

	r := ready(manifest.CheckSpec{Name: "a", Level: "L2", Exercise: "echo hi", Expect: []string{"exitCode(a)==0"}})
	b, _, err := Run(r, Opts{EvidenceRoot: t.TempDir(), Claim: "pins", Substrate: "local", Dir: dir})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	sha := b.M.Pins["repo"]
	if len(sha) < 7 || strings.HasSuffix(sha, "-dirty") {
		t.Fatalf("pins[repo] = %q, want a clean git sha", sha)
	}

	reopened, err := evidence.Open(b.Dir)
	if err != nil {
		t.Fatalf("evidence.Open: %v", err)
	}
	if reopened.M.Pins["repo"] != sha {
		t.Errorf("reopened pins[repo] = %q, want %q (round trip)", reopened.M.Pins["repo"], sha)
	}

	// Dirty the tree; the next run's pin must record it.
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}
	b2, _, err := Run(r, Opts{EvidenceRoot: t.TempDir(), Claim: "pins dirty", Substrate: "local", Dir: dir})
	if err != nil {
		t.Fatalf("Run (dirty): %v", err)
	}
	if !strings.HasSuffix(b2.M.Pins["repo"], "-dirty") {
		t.Errorf("dirty repo pin = %q, want -dirty suffix", b2.M.Pins["repo"])
	}
	if strings.TrimSuffix(b2.M.Pins["repo"], "-dirty") != sha {
		t.Errorf("dirty pin sha %q, want same commit %q", b2.M.Pins["repo"], sha)
	}
}

// TestRunPinsOmittedWithoutGit proves an absent git checkout omits the repo
// pin entirely rather than fabricating one.
func TestRunPinsOmittedWithoutGit(t *testing.T) {
	dir := t.TempDir() // no git init
	r := ready(manifest.CheckSpec{Name: "a", Level: "L2", Exercise: "echo hi", Expect: []string{"exitCode(a)==0"}})
	b, _, err := Run(r, Opts{EvidenceRoot: t.TempDir(), Claim: "no git", Substrate: "local", Dir: dir})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if sha, ok := b.M.Pins["repo"]; ok {
		t.Errorf("pins[repo] = %q, want absent (no git checkout)", sha)
	}
}

// ------------------------------------------------------------- legible summary lines

// TestCheckLine proves a fail/not-run summary line carries a short, one-line,
// trimmed reason, while a pass stays bare — the illegible-failures fix.
func TestCheckLine(t *testing.T) {
	tests := []struct {
		name string
		c    evidence.Check
		want string
	}{
		{"pass has no reason suffix", evidence.Check{Name: "up", State: evidence.CheckPass}, "[pass] up"},
		{"pass ignores a stray reason", evidence.Check{Name: "up", State: evidence.CheckPass, Reason: "ignored"}, "[pass] up"},
		{
			"fail carries its reason",
			evidence.Check{Name: "appservice-up", State: evidence.CheckFail, Reason: "http :8391/healthz: connection refused"},
			"[fail] appservice-up — http :8391/healthz: connection refused",
		},
		{
			"not-run carries its reason",
			evidence.Check{Name: "stage-progress", State: evidence.CheckNotRun, Reason: "required input PB_EXECUTION_ID unset"},
			"[not-run] stage-progress — required input PB_EXECUTION_ID unset",
		},
		{"fail with no reason falls back to name only", evidence.Check{Name: "x", State: evidence.CheckFail}, "[fail] x"},
		{
			"multi-line reason collapses to one line",
			evidence.Check{Name: "x", State: evidence.CheckFail, Reason: "line one\nline two"},
			"[fail] x — line one line two",
		},
		{
			"long reason trimmed to ~90 chars",
			evidence.Check{Name: "x", State: evidence.CheckFail, Reason: strings.Repeat("a", 200)},
			"[fail] x — " + strings.Repeat("a", maxReasonLen-1) + "…",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := checkLine(tt.c); got != tt.want {
				t.Errorf("checkLine = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestRunSummaryLinesCarryReasons proves the exported Run threads each
// check's reason into Summary.Lines, so a failing CLI run is diagnosable
// from the summary alone.
func TestRunSummaryLinesCarryReasons(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "a", Level: "L2", Exercise: "exit 1", Expect: []string{"exitCode(a)==0"}},
	)
	_, sum, err := Run(r, Opts{EvidenceRoot: t.TempDir(), Claim: "illegible fail", Substrate: "local"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(sum.Lines) != 1 {
		t.Fatalf("Summary.Lines = %v, want 1 line", sum.Lines)
	}
	if !strings.HasPrefix(sum.Lines[0], "[fail] a — ") {
		t.Errorf("Summary.Lines[0] = %q, want a legible fail line with a reason", sum.Lines[0])
	}
}

// ---------------------------------------------------------- empty checks: block

// TestVerdictNoChecksDeclaredHasExplicitNote proves an empty checks list
// (a manifest with no checks: block at all, not merely all not-run) stays
// honestly inconclusive but gets a note explaining why, instead of a
// content-free "0 pass, 0 fail, 0 not-run".
func TestVerdictNoChecksDeclaredHasExplicitNote(t *testing.T) {
	v, note := verdict(nil)
	if v != evidence.VerdictInconclusive {
		t.Errorf("verdict = %q, want inconclusive", v)
	}
	if note != noChecksDeclaredNote {
		t.Errorf("note = %q, want %q", note, noChecksDeclaredNote)
	}
}

// TestRunNoChecksDeclaredSurfacesNote proves the exported Run surfaces the
// same explicit note through Summary.Note and the sealed bundle's manifest
// note, for a manifest that declares zero checks.
func TestRunNoChecksDeclaredSurfacesNote(t *testing.T) {
	r := &manifest.Ready{}
	b, sum, err := Run(r, Opts{EvidenceRoot: t.TempDir(), Claim: "empty checks", Substrate: "local"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if sum.Verdict != evidence.VerdictInconclusive {
		t.Errorf("Summary.Verdict = %q, want inconclusive", sum.Verdict)
	}
	if sum.Note != noChecksDeclaredNote {
		t.Errorf("Summary.Note = %q, want %q", sum.Note, noChecksDeclaredNote)
	}
	if b.M.Note != noChecksDeclaredNote {
		t.Errorf("bundle manifest note = %q, want %q", b.M.Note, noChecksDeclaredNote)
	}
}

// --------------------------------------------------------------- --only typo

// TestValidateOnly proves --only fails fast on any name the manifest never
// declared, naming the bad check and every declared one.
func TestValidateOnly(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "a"},
		manifest.CheckSpec{Name: "b"},
		manifest.CheckSpec{Name: "c"},
	)
	tests := []struct {
		name    string
		only    []string
		wantErr string
	}{
		{"empty only is always fine", nil, ""},
		{"all known", []string{"a", "c"}, ""},
		{"one typo", []string{"a", "nosuchcheck"}, `verify: unknown check "nosuchcheck" (declared: a, b, c)`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateOnly(r, tt.only)
			if tt.wantErr == "" {
				if err != nil {
					t.Errorf("validateOnly = %v, want nil", err)
				}
				return
			}
			if err == nil || err.Error() != tt.wantErr {
				t.Errorf("validateOnly = %v, want %q", err, tt.wantErr)
			}
		})
	}
}

// TestRunOnlyUnknownCheckFailsFast proves Run rejects an --only typo before
// any bring-up: no bundle directory is created, mirroring the unknown-
// substrate fail-fast behavior above.
func TestRunOnlyUnknownCheckFailsFast(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "a", Level: "L2", Exercise: "echo hi", Expect: []string{"exitCode(a)==0"}},
		manifest.CheckSpec{Name: "b", Level: "L2", Exercise: "echo hi", Expect: []string{"exitCode(b)==0"}},
	)
	root := t.TempDir()
	b, sum, err := Run(r, Opts{EvidenceRoot: root, Claim: "only typo", Substrate: "local", Only: []string{"nosuchcheck"}})
	if err == nil {
		t.Fatal("Run(--only nosuchcheck) expected an error, got nil")
	}
	wantErr := `verify: unknown check "nosuchcheck" (declared: a, b)`
	if err.Error() != wantErr {
		t.Errorf("Run error = %q, want %q", err.Error(), wantErr)
	}
	if b != nil || sum != nil {
		t.Errorf("Run(--only typo) returned bundle %v summary %v, want nil, nil", b, sum)
	}
	entries, rerr := os.ReadDir(root)
	if rerr != nil {
		t.Fatalf("read evidence root: %v", rerr)
	}
	if len(entries) != 0 {
		t.Errorf("Run(--only typo) created %d bundle dir(s), want none", len(entries))
	}
}

// ------------------------------------------------------------------- proof level "none"

// TestRunSummaryProofLevelNoneWhenNothingPassed proves the CLI-facing Summary
// reports "none" (never a blank string) when no rung passed, while the
// bundle manifest's proofLevel stays omitted (its enum has no "none" value).
func TestRunSummaryProofLevelNoneWhenNothingPassed(t *testing.T) {
	r := ready(manifest.CheckSpec{Name: "a", Level: "L2", Exercise: "exit 1", Expect: []string{"exitCode(a)==0"}})
	b, sum, err := Run(r, Opts{EvidenceRoot: t.TempDir(), Claim: "always fails", Substrate: "local"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if sum.ProofLevel != "none" {
		t.Errorf("Summary.ProofLevel = %q, want \"none\"", sum.ProofLevel)
	}
	if b.M.ProofLevel != "" {
		t.Errorf("manifest proofLevel = %q, want omitted", b.M.ProofLevel)
	}
}

// ------------------------------------------------------------------- gates

func TestGateForMatchesDriveVerbOrCheckName(t *testing.T) {
	r := &manifest.Ready{
		Checks: []manifest.CheckSpec{
			{Name: "release", Exercise: "drive.deploy"},
			{Name: "prod-write", Exercise: "curl -X POST http://x/y"},
			{Name: "unit", Exercise: "echo ok"},
		},
		Gates: []manifest.Gate{
			{On: "deploy", Reason: "cluster release is irreversible"},
			{On: "prod-write", Reason: "manual approval required"},
		},
	}
	if g, ok := gateFor(r, r.Checks[0]); !ok || g.Reason != "cluster release is irreversible" {
		t.Errorf("release: gateFor = %+v, %v", g, ok)
	}
	if g, ok := gateFor(r, r.Checks[1]); !ok || g.Reason != "manual approval required" {
		t.Errorf("prod-write: gateFor = %+v, %v", g, ok)
	}
	if _, ok := gateFor(r, r.Checks[2]); ok {
		t.Errorf("unit: gateFor should not match, no gate names it")
	}
}

func TestGateForNoGatesIsZeroBehaviorChange(t *testing.T) {
	r := ready(manifest.CheckSpec{Name: "a", Exercise: "drive.deploy"})
	if _, ok := gateFor(r, r.Checks[0]); ok {
		t.Error("gateFor should never match when the manifest declares no gates")
	}
}

// TestRunChecksGatedCheckIsNotRunAndNeverExecutes proves a gated check
// records not-run with the gate's reason and never shells out, while an
// un-gated check in the same manifest still runs.
func TestRunChecksGatedCheckIsNotRunAndNeverExecutes(t *testing.T) {
	r := &manifest.Ready{
		Drive: map[string]manifest.DriveVerb{"deploy": {Run: "echo deploying"}},
		Checks: []manifest.CheckSpec{
			{Name: "release", Level: "L5", Exercise: "drive.deploy", Expect: []string{"exitCode(release)==0"}},
			{Name: "unit", Level: "L2", Exercise: "echo ok", Expect: []string{"exitCode(unit)==0"}},
		},
		Gates: []manifest.Gate{{On: "deploy", Reason: "cluster release is irreversible"}},
	}
	ops := newFakeOps()
	checks := runChecks(r, Opts{}, ops, nil, false)
	if checks[0].State != evidence.CheckNotRun || checks[0].Reason != "gated: cluster release is irreversible" {
		t.Errorf("release: state %q reason %q, want not-run/\"gated: cluster release is irreversible\"",
			checks[0].State, checks[0].Reason)
	}
	if checks[1].State != evidence.CheckPass {
		t.Errorf("unit: state %q, want pass", checks[1].State)
	}
	if strings.Join(ops.ran, ",") != "unit" {
		t.Errorf("ran %v — a gated check must never shell out", ops.ran)
	}
}

// TestVerdictGatedSkipForcesInconclusive proves a gated not-run check forces
// inconclusive even when every other check passed — a gate must never read
// as a fake pass (PLAN §3.7).
func TestVerdictGatedSkipForcesInconclusive(t *testing.T) {
	checks := []evidence.Check{
		{Name: "a", State: evidence.CheckPass},
		{Name: "b", State: evidence.CheckNotRun, Reason: "gated: manual approval required"},
	}
	v, note := verdict(checks)
	if v != evidence.VerdictInconclusive {
		t.Errorf("verdict = %q, want inconclusive (a gated skip must never pass); note=%q", v, note)
	}
}

// --------------------------------------------------------- required inputs

// TestRunChecksMissingRequiredInputIsNotRun proves a check declaring an env
// input it requires (checks[].requires) records not-run with a named reason,
// and never shells out, when that env var is unset in the process
// environment — the honest-gating fix for a required input hard-failing
// instead of gating.
func TestRunChecksMissingRequiredInputIsNotRun(t *testing.T) {
	r := ready(
		manifest.CheckSpec{
			Name: "action-resolution", Level: "L4", Exercise: "echo hi",
			Expect: []string{"exitCode(action-resolution)==0"}, Requires: []string{"PB_EXECUTION_ID"},
		},
	)
	ops := newFakeOps()
	checks := runChecks(r, Opts{}, ops, nil, false)
	if checks[0].State != evidence.CheckNotRun || checks[0].Reason != "required input PB_EXECUTION_ID unset" {
		t.Errorf("state %q reason %q, want not-run/\"required input PB_EXECUTION_ID unset\"",
			checks[0].State, checks[0].Reason)
	}
	if len(ops.ran) != 0 {
		t.Errorf("ran %v — a check with an unset required input must never shell out", ops.ran)
	}
}

// TestRunChecksRequiredInputSetRuns proves the same check runs normally once
// its required env var is exported.
func TestRunChecksRequiredInputSetRuns(t *testing.T) {
	t.Setenv("PB_EXECUTION_ID", "exec-123")
	r := ready(
		manifest.CheckSpec{
			Name: "action-resolution", Level: "L4", Exercise: "echo hi",
			Expect: []string{"exitCode(action-resolution)==0"}, Requires: []string{"PB_EXECUTION_ID"},
		},
	)
	ops := newFakeOps()
	checks := runChecks(r, Opts{}, ops, nil, false)
	if checks[0].State != evidence.CheckPass {
		t.Errorf("state %q, want pass once PB_EXECUTION_ID is set", checks[0].State)
	}
	if strings.Join(ops.ran, ",") != "action-resolution" {
		t.Errorf("ran %v, want the check to have executed", ops.ran)
	}
}

// TestVerdictRequiredInputNotRunDoesNotForceInconclusive proves a not-run
// from a missing required input behaves like any other not-run for verdict
// purposes — unlike a gated skip, it does not force inconclusive.
func TestVerdictRequiredInputNotRunDoesNotForceInconclusive(t *testing.T) {
	checks := []evidence.Check{
		{Name: "a", State: evidence.CheckPass},
		{Name: "b", State: evidence.CheckNotRun, Reason: "required input PB_EXECUTION_ID unset"},
	}
	v, note := verdict(checks)
	if v != evidence.VerdictPass {
		t.Errorf("verdict = %q, want pass (a missing-required-input not-run must not force inconclusive); note=%q", v, note)
	}
}

// ------------------------------------------------------------- missing exercise file

// TestRunCheckExecMissingExerciseFileIsNotRun proves an exec exercise that is
// unambiguously a bare file reference to a nonexistent file records not-run
// (ADR-0012 preflight-class problem), never a poisoning fail.
func TestRunCheckExecMissingExerciseFileIsNotRun(t *testing.T) {
	r := ready(manifest.CheckSpec{Name: "e2e", Level: "L2", Exercise: "tests/e2e/missing.sh"})
	checks := runChecks(r, Opts{}, newFakeOps(), nil, false)
	if checks[0].State != evidence.CheckNotRun {
		t.Fatalf("state %q, want not-run", checks[0].State)
	}
	if !strings.Contains(checks[0].Reason, "exercise file not found") || !strings.Contains(checks[0].Reason, "tests/e2e/missing.sh") {
		t.Errorf("reason %q should name the missing exercise file", checks[0].Reason)
	}
}

// TestRunCheckPlaywrightMissingExerciseFileIsNotRun proves the same for the
// playwright driver — the redcat case this gap fixes.
func TestRunCheckPlaywrightMissingExerciseFileIsNotRun(t *testing.T) {
	binDir := t.TempDir()
	npx := filepath.Join(binDir, "npx")
	if err := os.WriteFile(npx, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	r := ready(manifest.CheckSpec{Name: "e2e", Level: "L5", Driver: "playwright", Exercise: "tests/e2e/does-not-exist.spec.ts"})
	checks := runChecks(r, Opts{}, newFakeOps(), nil, false)
	if checks[0].State != evidence.CheckNotRun {
		t.Fatalf("state %q, want not-run", checks[0].State)
	}
	if !strings.Contains(checks[0].Reason, "exercise file not found") || !strings.Contains(checks[0].Reason, "does-not-exist.spec.ts") {
		t.Errorf("reason %q should name the missing spec file", checks[0].Reason)
	}
}

// TestRunCheckAmbiguousShellStringStillRuns proves an ambiguous shell
// command (not a clear file reference) is never preflight-checked for file
// existence — it still runs and is judged on its own exit code.
func TestRunCheckAmbiguousShellStringStillRuns(t *testing.T) {
	r := ready(manifest.CheckSpec{Name: "x", Level: "L2", Exercise: "echo tests/e2e/nonexistent.sh", Expect: []string{"exitCode(x)==0"}})
	ops := newFakeOps()
	checks := runChecks(r, Opts{}, ops, nil, false)
	if checks[0].State != evidence.CheckPass {
		t.Errorf("state %q reason %q, want pass — an ambiguous shell string must still run", checks[0].State, checks[0].Reason)
	}
	if strings.Join(ops.ran, ",") != "x" {
		t.Errorf("ran %v, want the check to have executed", ops.ran)
	}
}
