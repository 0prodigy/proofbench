package verify

import (
	"os"

	"github.com/0prodigy/proofbench/internal/evidence"
	"github.com/0prodigy/proofbench/internal/honesty"
	"github.com/0prodigy/proofbench/internal/manifest"
)

// pinState is the per-run result of the ADR-0015 R1 pin/signature gate: which
// checks are pinned, signed by the recorded principal, and hash-current — and
// therefore allowed to reach green — plus the signing principal for the R2
// self-judged determination.
type pinState struct {
	// engaged is true once the per-check R1 refusal applies to this run: a lock
	// is present, PB_REQUIRE_PIN forces it, or the lock is unreadable. When
	// false (no lock, opt-in un-pinned repo) the drift/unsigned refusal is
	// skipped — but the self-attested L3 cap still applies (see selfAttested).
	engaged bool
	signer  string
	// anchored is true only when a valid lock's signer is an externally-anchored
	// identity the agent cannot assume (honesty.Anchored, via an installed
	// CosignAnchor); with the default self-held-key verifier it is always false,
	// so every run is self-attested (ADR-0015).
	anchored bool
	// anchorReason records WHY the run was or was not externally anchored (the
	// identity pinned, or why it stays self-attested) for the verdict surface.
	anchorReason string
	valid        map[string]bool // check name -> pinned, signed, and hash-current
}

// pinReason is the not-run reason recorded for a check the spine refuses,
// reusing the ADR-0012 not-run taxonomy.
const pinReason = "unsigned or hash-drifted check definition (ADR-0015 R1)"

// refuses reports whether the spine refuses name (and the reason to record).
// A refused check can never be green.
func (p pinState) refuses(name string) (string, bool) {
	if !p.engaged || p.valid[name] {
		return "", false
	}
	return pinReason, true
}

// selfAttested reports whether this run has no externally-anchored signer
// (ADR-0015): a valid local/self-key lock — or no lock at all — proves the
// check set internally authentic but says nothing about an external identity
// the agent cannot assume, so the run is SELF-ATTESTED and its proof is capped
// at honesty.SelfAttestedCap (L3). This is intentionally NOT gated on engaged:
// deleting ready.lock does not lift the cap (absence of a valid anchored lock
// ⇒ L3, never legacy-green). Only a lock the installed AnchorVerifier accepts
// (the Sigstore slice) clears it and unlocks L4/L5.
func (p pinState) selfAttested() bool {
	return !p.anchored
}

// loadPinState loads and validates the check lock for dir, recomputing each
// check's current hash from r (including behavior: drive bodies and referenced
// script shas) to detect drift. A present lock is verified against its own
// signature and its signer tested for an external anchor; an absent lock leaves
// the per-check R1 refusal disengaged unless PB_REQUIRE_PIN=1; an unreadable/
// invalid lock engages the spine with nothing trusted (every check refused). A
// check whose hash cannot even be recomputed (e.g. a referenced script vanished
// or a drive verb is unknown) is treated as not hash-current — refused, never
// silently trusted.
func loadPinState(dir string, r *manifest.Ready) pinState {
	lock, present, err := honesty.LoadLock(dir)
	if err != nil {
		return pinState{engaged: true, valid: map[string]bool{}}
	}
	if !present {
		if os.Getenv(honesty.EnvRequirePin) == "1" {
			return pinState{engaged: true, valid: map[string]bool{}}
		}
		return pinState{}
	}
	// anchored (external anchor, L4/L5) is the pinned-identity check; sigOK
	// (internal authenticity, self-attested at least) is the weaker gate that a
	// keyless lock's signature is genuine at all — a genuine but non-pinned
	// keyless lock is SELF-ATTESTED (capped L3), a forged/tampered one is refused.
	// A self-held ed25519 lock is authentic via its own signature. Anchored is
	// evaluated first so its reason is what AnchorReason surfaces.
	anchored := honesty.Anchored(lock)
	sigOK := honesty.LockAuthentic(lock)
	valid := make(map[string]bool, len(r.Checks))
	for _, c := range r.Checks {
		cur, herr := honesty.CheckHash(r, c, dir)
		valid[c.Name] = sigOK && herr == nil && lock.CheckHashes[c.Name] == cur
	}
	return pinState{
		engaged:      true,
		signer:       lockSigner(lock),
		anchored:     anchored,
		anchorReason: honesty.AnchorReason(),
		valid:        valid,
	}
}

// lockSigner names the lock's signing principal: the keyless anchor's recorded
// Fulcio identity when present (audit/display only), else the self-held-key
// signer id.
func lockSigner(lock honesty.Lock) string {
	if lock.Anchor != nil && lock.Anchor.Identity != "" {
		return lock.Anchor.Identity
	}
	return lock.Sig.Signer
}

// capToSelfAttested caps level at honesty.SelfAttestedCap (L3) — the ADR-0015
// ceiling on a run with no externally-anchored signer. Levels already at or
// below the cap, and unparseable levels, are unchanged.
func capToSelfAttested(level string) string {
	capN, _ := levelNum(honesty.SelfAttestedCap)
	n, ok := levelNum(level)
	if !ok || n <= capN {
		return level
	}
	return honesty.SelfAttestedCap
}

// provenanceProber is the optional seam evaluateExpects uses to enforce
// ADR-0015 R3: only harness-collected evidence promotes. *evidence.Bundle
// implements it; a test double that does not is treated as all-harness, so the
// rule never demotes a check it cannot reason about.
type provenanceProber interface {
	// Provenance returns the weakest artifact provenance the predicate expr
	// relies on ("agent" < "tool" < "harness"), or "" when it references no
	// recorded artifact (e.g. a live http probe).
	Provenance(expr string) (string, error)
}

// nonPromoting reports whether a passing check must be demoted because it is
// satisfied only by agent- or tool-provenance evidence (ADR-0015 R3), plus the
// weakest such provenance for the recorded reason.
func nonPromoting(ops bundleOps, exprs []string) (string, bool) {
	pp, ok := ops.(provenanceProber)
	if !ok {
		return "", false
	}
	weakest := ""
	for _, e := range exprs {
		prov, err := pp.Provenance(e)
		if err != nil {
			continue
		}
		if provRank(prov) < provRank(weakest) {
			weakest = prov
		}
	}
	if weakest == evidence.ProvenanceAgent || weakest == evidence.ProvenanceTool {
		return weakest, true
	}
	return "", false
}

// provRank orders provenance from weakest (most agent-supplied, lowest) to
// strongest; "" (no recorded-artifact dependency) ranks highest so it never
// demotes a check on its own.
func provRank(p string) int {
	switch p {
	case evidence.ProvenanceAgent:
		return 0
	case evidence.ProvenanceTool:
		return 1
	case evidence.ProvenanceHarness:
		return 2
	default:
		return 3
	}
}
