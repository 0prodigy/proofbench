// Package manifest models the readiness manifest (ready.yaml) and the
// org-level workspace graph (workspace.yaml) per PLAN.md §4.
package manifest

// Ready is the per-repo readiness manifest (ready.yaml): how the service
// becomes runnable and testable on any substrate.
type Ready struct {
	Service    string               `yaml:"service"`
	Role       string               `yaml:"role"`
	Sources    map[string]string    `yaml:"sources"`
	Run        RunSpec              `yaml:"run"`
	Resources  map[string]Resource  `yaml:"resources"`
	Seed       []SeedStep           `yaml:"seed"`
	Drive      map[string]DriveVerb `yaml:"drive"`
	Checks     []CheckSpec          `yaml:"checks"`
	Gates      []Gate               `yaml:"gates"`
	KnownWalls []Wall               `yaml:"known_walls"`
}

// RunSpec declares supported run modes and how to start/probe the service.
type RunSpec struct {
	Modes []string `yaml:"modes"`
	Local LocalRun `yaml:"local"`
	Ready Probe    `yaml:"ready"`
}

// LocalRun is the bare-process (local substrate) start recipe.
type LocalRun struct {
	Start string  `yaml:"start"`
	Env   EnvSpec `yaml:"env"`
}

// EnvSpec sources environment from a file plus explicit overrides.
type EnvSpec struct {
	File      string            `yaml:"file"`
	Overrides map[string]string `yaml:"overrides"`
}

// Probe uses k8s readiness-probe vocabulary: exactly one of HTTP/TCP/Exec.
type Probe struct {
	HTTP     string `yaml:"http"`
	TCP      string `yaml:"tcp"`
	Exec     string `yaml:"exec"`
	Timeout  string `yaml:"timeout"`
	Interval string `yaml:"interval"`
}

// Resource is a Score-style typed dependency, resolved per substrate via
// the Via map (substrate name -> locator).
type Resource struct {
	Type     string            `yaml:"type"`
	Via      map[string]string `yaml:"via"`
	Optional bool              `yaml:"optional"`
	Repo     string            `yaml:"repo"`
}

// SeedStep is one seed task, ordered by its After dependencies.
type SeedStep struct {
	Name  string   `yaml:"name"`
	Run   string   `yaml:"run"`
	After []string `yaml:"after"`
}

// DriveVerb is a real product entrypoint the harness may exercise.
type DriveVerb struct {
	Run      string `yaml:"run"`
	Identity string `yaml:"identity"`
	Output   string `yaml:"output"`
}

// CheckSpec is a declared validation surface: what to exercise, the
// proof-ladder level it proves, and the predicates that must hold.
type CheckSpec struct {
	Name      string   `yaml:"name"`
	Level     string   `yaml:"level"`
	Exercise  string   `yaml:"exercise"`
	Expect    []string `yaml:"expect"`
	Artifacts []string `yaml:"artifacts"`
}

// Gate names a human gate on a destructive/irreversible step.
type Gate struct {
	On     string `yaml:"on"`
	Reason string `yaml:"reason"`
}

// Wall is a known trap: symptom, cause, and recovery.
type Wall struct {
	Symptom string `yaml:"symptom"`
	Cause   string `yaml:"cause"`
	Recover string `yaml:"recover"`
}

// Workspace is the org-level graph (workspace.yaml): service name -> repo
// path, plus named cluster contexts for k8s-attach.
type Workspace struct {
	Services map[string]string `yaml:"services"`
	Contexts map[string]string `yaml:"contexts"`
}
