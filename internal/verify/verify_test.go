package verify

import (
	"errors"
	"os/exec"
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
	checks := runChecks(r, Opts{}, ops, nil)
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
	checks := runChecks(r, Opts{}, ops, nil)
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
	checks := runChecks(r, Opts{Only: []string{"b"}}, ops, nil)
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
	checks := runChecks(r, Opts{}, ops, nil)
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
	checks := runChecks(r, Opts{}, ops, nil)
	if checks[0].State != evidence.CheckFail || !strings.Contains(checks[0].Reason, "no such binary") {
		t.Errorf("x: state %q reason %q, want fail with spawn reason", checks[0].State, checks[0].Reason)
	}
}

func TestRunChecksExpectError(t *testing.T) {
	r := ready(
		manifest.CheckSpec{Name: "x", Level: "L3", Exercise: "echo hi", Expect: []string{"bogus predicate"}},
	)
	checks := runChecks(r, Opts{}, newFakeOps(), nil)
	if checks[0].State != evidence.CheckFail || !strings.Contains(checks[0].Reason, "bogus predicate") {
		t.Errorf("x: state %q reason %q, want fail naming the erroring expect", checks[0].State, checks[0].Reason)
	}
}

func TestRunChecksNoExpectsPassesVacuously(t *testing.T) {
	r := ready(manifest.CheckSpec{Name: "x", Level: "L1", Exercise: "exit 7"})
	checks := runChecks(r, Opts{}, newFakeOps(), nil)
	if checks[0].State != evidence.CheckPass {
		t.Errorf("x: state %q, want pass (no expects, exercise spawned)", checks[0].State)
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
		{"no checks", nil, evidence.VerdictInconclusive, "0 pass, 0 fail, 0 not-run"},
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
