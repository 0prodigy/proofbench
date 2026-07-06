// Package evidence implements the evidence bundle v2 format: a schema'd,
// portable, tamper-evident record of a verification run (manifest.json plus
// captured artifacts) per PLAN.md §5.
package evidence

// Phase enum — the lifecycle stage a bundle documents.
const (
	PhaseRepro    = "repro"
	PhaseVerify   = "verify"
	PhaseReverify = "reverify"
	PhaseFix      = "fix"
	PhaseReport   = "report"
)

// Verdict enum — the overall outcome of a bundle, set last from artifacts.
const (
	VerdictPass         = "pass"
	VerdictFail         = "fail"
	VerdictInconclusive = "inconclusive"
)

// Check state enum — tri-state, never default-green.
const (
	CheckPass   = "pass"
	CheckFail   = "fail"
	CheckNotRun = "not-run"
)

// Artifact type enum.
const (
	ArtifactCommand    = "command"
	ArtifactSnapshot   = "snapshot"
	ArtifactScreenshot = "screenshot"
	ArtifactLog        = "log"
	ArtifactRecording  = "recording"
	ArtifactLink       = "link"
)

// Provenance enum — who produced the artifact (anti-fabrication flag).
const (
	ProvenanceHarness = "harness"
	ProvenanceAgent   = "agent"
	// ProvenanceTool marks harness-directed tool output (ADR-0013): the
	// harness chose the tool, its flags, and its output path but did not tee
	// the bytes itself (Capture.File). Distinct from ProvenanceHarness
	// (teed subprocess) and ProvenanceAgent (operator-supplied / Seal sweep).
	ProvenanceTool = "tool"
)

// Capture is the single seam through which any driver's observations enter a
// bundle (driver-interfaces §2). *Bundle satisfies it; drivers never touch
// *Bundle directly, so provenance and sealing stay uniform.
type Capture interface {
	// Exec spawns argv (bash -lc when shell), tees combined output to an
	// NN-<name>.log artifact with provenance harness, and returns the exit
	// code. Equivalent to Bundle.Run.
	Exec(name string, argv []string, shell bool) (exitCode int, err error)
	// File claims a driver-produced file (trace, screenshot, video) as an
	// artifact with provenance tool (ADR-0013); typ is an Artifact* enum.
	File(typ, name, srcPath string, meta map[string]any) error
	// BundleDir is the bundle directory, for pointing external tools' output
	// at. Named BundleDir (not Dir) because Bundle.Dir is a frozen field
	// (types.go) and Go forbids a method and field sharing a name.
	BundleDir() string
}

// Manifest is the evidence bundle manifest (evidence/<runId>/manifest.json),
// schema version 2.
type Manifest struct {
	Schema     int               `json:"schema"`
	Ticket     string            `json:"ticket,omitempty"`
	RunID      string            `json:"runId"`
	Claim      string            `json:"claim"`
	Phase      string            `json:"phase"`
	Kind       string            `json:"kind,omitempty"`
	PairsWith  string            `json:"pairsWith,omitempty"`
	Surface    map[string]string `json:"surface,omitempty"`
	Pins       map[string]string `json:"pins,omitempty"`
	ProofLevel string            `json:"proofLevel,omitempty"`
	StartedAt  string            `json:"startedAt"`
	FinishedAt string            `json:"finishedAt,omitempty"`
	Checks     []Check           `json:"checks,omitempty"`
	Artifacts  []Artifact        `json:"artifacts"`
	Verdict    string            `json:"verdict"`
	Note       string            `json:"note,omitempty"`
}

// Check is a machine-evaluated predicate result. State is tri-state
// (pass|fail|not-run) — a check that never ran must say so explicitly.
type Check struct {
	Name      string   `json:"name"`
	State     string   `json:"state"`
	Level     string   `json:"level,omitempty"`
	Expect    string   `json:"expect,omitempty"`
	Observed  string   `json:"observed,omitempty"`
	Reason    string   `json:"reason,omitempty"`
	Artifacts []string `json:"artifacts,omitempty"`
}

// Artifact is one captured file (or link) inside the bundle directory.
type Artifact struct {
	Type       string         `json:"type"`
	Name       string         `json:"name"`
	Path       string         `json:"path"`
	SHA256     string         `json:"sha256,omitempty"`
	Provenance string         `json:"provenance,omitempty"`
	Meta       map[string]any `json:"meta,omitempty"`
}

// Bundle is an open evidence bundle: its directory on disk plus the
// in-memory manifest.
type Bundle struct {
	Dir string
	M   *Manifest
}

// NewOpts are the caller-supplied fields for creating a new bundle.
type NewOpts struct {
	Ticket    string
	Claim     string
	Phase     string
	Kind      string
	PairsWith string
	Surface   map[string]string
}
