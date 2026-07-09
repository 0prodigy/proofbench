package checkdriver

import (
	"github.com/launchwings/proofbench/internal/evidence"
	"github.com/launchwings/proofbench/internal/manifest"
)

// execDriver runs the exercise as a shell command via the capture's Exec
// (bash -lc, teed to an NN-<name>.log command artifact, provenance harness) —
// the default behaviour extracted from verify.runChecks with no change: the
// exercise string is run verbatim, the returned int is the process exit code,
// and expect predicates read the recorded command artifact.
type execDriver struct {
	dir string
}

// Preflight always succeeds: bash is the harness's own shell (ADR-0012).
func (d *execDriver) Preflight() error { return nil }

// Exercise runs the (endpoint-substituted) exercise string via capture.Exec.
func (d *execDriver) Exercise(spec manifest.CheckSpec, env Env, capture evidence.Capture) (int, error) {
	cmd := SubstituteEndpoints(spec.Exercise, env.Endpoints)
	return capture.Exec(spec.Name, []string{cmd}, true)
}
