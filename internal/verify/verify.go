// Package verify orchestrates a full verification run: bring the target up
// on the chosen substrate, exercise the manifest's declared checks, and
// capture everything into an evidence bundle.
package verify

import (
	"fmt"
	"slices"
	"strings"

	"github.com/launchwings/proofbench/internal/evidence"
	"github.com/launchwings/proofbench/internal/manifest"
)

// Opts configures a verification run.
type Opts struct {
	EvidenceRoot string   // root directory for evidence bundles
	Ticket       string   // optional ticket key recorded in the bundle
	Claim        string   // the claim under verification
	Substrate    string   // substrate kind (local|compose)
	Only         []string // restrict to these check names; empty = all
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

// Run executes the manifest's checks per o: up + ready + seed on the
// substrate, evaluate each CheckSpec's expect predicates, record tri-state
// results and artifacts into a new evidence bundle, set the verdict last,
// and return the sealed bundle plus a summary.
//
// Substrate bring-up is the CLI's job (pb up runs first); Run only records
// the substrate in the bundle's surface.
func Run(r *manifest.Ready, o Opts) (*evidence.Bundle, *Summary, error) {
	root := o.EvidenceRoot
	if root == "" {
		root = "./evidence"
	}
	no := evidence.NewOpts{Ticket: o.Ticket, Claim: o.Claim, Phase: evidence.PhaseVerify}
	if o.Substrate != "" {
		no.Surface = map[string]string{"substrate": o.Substrate}
	}
	b, err := evidence.New(root, no)
	if err != nil {
		return nil, nil, err
	}
	checks := runChecks(r, o, b)
	b.M.Checks = append(b.M.Checks, checks...)
	level := proofLevel(checks)
	b.M.ProofLevel = level
	v, note := verdict(checks)
	if err := b.SetVerdict(v, note); err != nil {
		return nil, nil, err
	}
	return b, &Summary{ProofLevel: level, Checks: checks, Verdict: v}, nil
}

// runChecks executes every declared check independently — one failure never
// aborts the rest — and returns one tri-state result per CheckSpec, in order.
func runChecks(r *manifest.Ready, o Opts, ops bundleOps) []evidence.Check {
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
		cmd, err := resolveExercise(r, spec.Exercise)
		if err != nil {
			c.State = evidence.CheckFail
			c.Reason = err.Error()
			out = append(out, c)
			continue
		}
		if _, err := ops.Run(spec.Name, []string{cmd}, true); err != nil {
			// Harness-level spawn/capture failure — the exercise never ran.
			c.State = evidence.CheckFail
			c.Reason = "exercise: " + err.Error()
			out = append(out, c)
			continue
		}
		// ponytail: a nonzero exit is only a failure if an expect says so
		// (exitCode(...)==0); a check with zero expects passes vacuously.
		c.State = evidence.CheckPass
		observed := make([]string, 0, len(spec.Expect))
		for _, expr := range spec.Expect {
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
		out = append(out, c)
	}
	return out
}

// resolveExercise turns a CheckSpec exercise into a shell command:
// "drive.<name>" means the named drive verb's run string; anything else is
// already a raw shell command.
func resolveExercise(r *manifest.Ready, exercise string) (string, error) {
	name, isDrive := strings.CutPrefix(exercise, "drive.")
	if !isDrive {
		return exercise, nil
	}
	v, ok := r.Drive[name]
	if !ok {
		return "", fmt.Errorf("unknown drive verb %q", name)
	}
	return v.Run, nil
}

// proofLevel returns the highest Ln such that at least one check at Ln
// passed and no check with level <= Ln that ran failed; "" if none passed.
func proofLevel(checks []evidence.Check) string {
	var passed [6]bool
	minFailed := 6 // lowest failed rung; 6 = none
	for _, c := range checks {
		n, ok := levelNum(c.Level)
		if !ok {
			// ponytail: checks without a parseable L0–L5 level neither
			// advance nor block the ladder.
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
// results: pass iff no check failed and at least one passed; fail if any
// failed (naming them); else inconclusive.
func verdict(checks []evidence.Check) (string, string) {
	var pass, fail, notRun int
	var failedNames []string
	for _, c := range checks {
		switch c.State {
		case evidence.CheckPass:
			pass++
		case evidence.CheckFail:
			fail++
			failedNames = append(failedNames, c.Name)
		default:
			notRun++
		}
	}
	if fail > 0 {
		note := fmt.Sprintf("%d pass, %d fail (%s), %d not-run",
			pass, fail, strings.Join(failedNames, ", "), notRun)
		return evidence.VerdictFail, note
	}
	note := fmt.Sprintf("%d pass, %d fail, %d not-run", pass, fail, notRun)
	if pass > 0 {
		return evidence.VerdictPass, note
	}
	return evidence.VerdictInconclusive, note
}
