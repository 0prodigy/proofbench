// Package agentruntime is the AgentRuntime driver family (ADR-0009 process
// boundary; ADR-0014): every kind shells out to a customer-installed agent
// binary and inherits THAT installation's own authentication (subscription
// OAuth or an API key) — proofbench never reads, stores, or forwards
// credentials itself. Same registry idiom as substrate.New / checkdriver.New
// (driver-interfaces §1): one package, one small frozen interface, one New
// selector, one Kinds list.
//
// Explore's proposed-checks.json is untrusted agent output — an LLM round's
// proposal, never a verdict — pending human review before any check in it
// is trusted or run.
package agentruntime

import (
	"fmt"
	"time"
)

// AgentRuntime kinds.
const (
	KindClaudeCode = "claude-code"
)

// RoundResult.Status enum values. A round is never pass/fail — only whether
// it produced a proposal, and if not, why (tri-state discipline).
const (
	StatusProposed     = "proposed"     // the agent completed and returned a structured proposal
	StatusNotRun       = "not-run"      // the round never produced a result (env/auth/rate-limit)
	StatusInconclusive = "inconclusive" // the round ran but budget/protocol prevented a proposal
)

// ProposalSchemaFile is the filename the caller (Explore) writes the
// proposal JSON schema to inside RoundOpts.OutDir before calling RunRound;
// RunRound passes this path to the runtime's --json-schema flag.
const ProposalSchemaFile = "proposal-schema.json"

// RoundOpts is one exploration round's inputs.
type RoundOpts struct {
	Dir      string        // repo root the agent explores (process cwd)
	Prompt   string        // the round's prompt
	MaxTurns int           // agent turn budget
	Timeout  time.Duration // wall-clock timeout for the round; <=0 means the runtime's default
	OutDir   string        // where raw output + proposal land (must contain ProposalSchemaFile)
}

// RoundResult is what one round observed. Never a verdict — a runtime never
// sets check state or ready.yaml; callers (pb-explore, verify) own that.
type RoundResult struct {
	Status            string
	Reason            string
	Proposal          []byte // raw structured_output JSON, set only when Status == StatusProposed
	SessionID         string
	CostUSD           float64
	NumTurns          int
	DurationMS        int64
	PermissionDenials []string
}

// Runtime drives one agent round.
type Runtime interface {
	// Preflight reports whether this runtime can run here (binary found,
	// version probe succeeds). A failure's text names the recovery. Preflight
	// may also record non-blocking warnings on the concrete type (discovered
	// by the caller via an optional Warnings() []string type assertion,
	// mirroring substrate's optional Endpoints capability) — it must still
	// return nil in that case, since a warning does not block the round.
	Preflight() error
	// RunRound drives one exploration round and returns its RoundResult. A
	// non-nil error is a harness failure (bad opts, unwritable OutDir);
	// runtime-observed conditions (missing binary, auth, rate limits,
	// budget, protocol errors) are reported through RoundResult.Status/Reason
	// instead — never returned as an error.
	RunRound(o RoundOpts) (*RoundResult, error)
}

// New returns the AgentRuntime driver for kind.
func New(kind string) (Runtime, error) {
	switch kind {
	case KindClaudeCode:
		return &claudeCodeRuntime{}, nil
	default:
		return nil, fmt.Errorf("agentruntime.New: unknown kind %q (want %s)", kind, KindClaudeCode)
	}
}

// Kinds lists the registered AgentRuntime kinds, for preflight and error text.
func Kinds() []string { return []string{KindClaudeCode} }
