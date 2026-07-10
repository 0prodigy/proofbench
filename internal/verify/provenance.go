package verify

import (
	"errors"
	"fmt"
	"os/exec"
	"sort"
	"strings"

	"github.com/0prodigy/proofbench/internal/honesty"
)

// Provenance ladder rungs (ADR-0016): only R4 — a verified signed build
// attestation — is green; every weaker signal is named as a lesser rung, never
// treated as proof.
const (
	RungR4 = "R4" // verified signed attestation ⇒ TRUSTED / green
	RungR3 = "R3" // build-provenance present but not verified ⇒ CLAIMED-UNVERIFIED
	RungR0 = "R0" // no verifiable attestation in scope ⇒ UNPROVEN
)

// ProvenanceOpts configures ADR-0016 R4 (Hop B: image digest → source commit)
// verification for a run. It is IN SCOPE only when both Owner and SignerWorkflow
// are supplied by the verifier — a provenance claim the runner was asked to
// prove; otherwise provenance is not evaluated and never caps the ladder.
type ProvenanceOpts struct {
	// Owner is the GitHub org/user that owns the signing identity (gh
	// attestation verify --owner). Verifier-supplied, out-of-band.
	Owner string
	// SignerWorkflow is the expected build workflow ref
	// (<org>/<repo>/.github/workflows/<wf>.yml[@ref]) the attestation must be
	// signed by (--signer-workflow). Verifier-supplied — never read from the
	// image or the registry.
	SignerWorkflow string
	// Image optionally overrides the OCI reference to verify; when empty the
	// deployed image digest is resolved from the run's pins (k8s-attach's
	// "image.<name>" imageID). Verified as oci://<ref>.
	Image string
}

// inScope reports whether a provenance claim was put in scope for this run.
func (o ProvenanceOpts) inScope() bool {
	return o.Owner != "" && o.SignerWorkflow != ""
}

// errGhAbsent marks the gh CLI not being installed — the honest not-run signal
// (ADR-0012 capability), distinct from a real attestation-verification failure.
var errGhAbsent = errors.New("verify: gh not found in PATH")

// ghAttestationVerify runs `gh attestation verify oci://<ref> --owner <owner>
// --signer-workflow <wf>` and returns nil iff gh exits 0 — a GENUINE attestation
// signed by the pinned workflow. A wrong --signer-workflow or an unattested
// digest exits nonzero (rejected); a missing gh binary is errGhAbsent. Package
// var so tests can substitute a deterministic seam, mirroring the cosign runner.
var ghAttestationVerify = func(ociRef, owner, signerWorkflow string) error {
	if _, err := exec.LookPath("gh"); err != nil {
		return errGhAbsent
	}
	args := []string{"attestation", "verify", "oci://" + ociRef, "--owner", owner}
	if signerWorkflow != "" {
		args = append(args, "--signer-workflow", signerWorkflow)
	}
	out, err := exec.Command("gh", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("gh attestation verify: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// verifyProvenance resolves the deployed image reference for this run and
// verifies its build-provenance attestation (ADR-0016 R4). It returns the earned
// rung and a reason. Not in scope ⇒ ("", "") and the ladder is untouched. In
// scope with no resolvable image ⇒ RungR0. gh absent ⇒ RungR3 (cannot verify —
// honest cap, never a fake R4). gh present but verification fails (unattested /
// wrong signer) ⇒ RungR3 (CLAIMED-UNVERIFIED). Only a passing verify ⇒ RungR4.
func verifyProvenance(o ProvenanceOpts, pins map[string]string) (rung, reason string) {
	if !o.inScope() {
		return "", ""
	}
	refs, ok := resolveImageRefs(o, pins)
	if !ok {
		return RungR0, "no resolvable image digest in scope: pass --image or run against a k8s-attach image pin"
	}
	// R4 is TRUSTED only when EVERY deployed image pin — and every comma-separated
	// ref within each (k8s-attach emits one per forward, comma-joined per
	// container) — resolves to a verified attestation under the expected signer.
	// ANY unattested / wrong-signer / unresolved ref degrades below R4, naming the
	// failing image (ADR-0016 R4; no "first image only").
	for _, ref := range refs {
		err := ghAttestationVerify(ref, o.Owner, o.SignerWorkflow)
		if err == nil {
			continue
		}
		if errors.Is(err, errGhAbsent) {
			return RungR3, "R3 CLAIMED-UNVERIFIED: gh not installed — cannot verify the build attestation (capability absent, ADR-0012)"
		}
		return RungR3, fmt.Sprintf("R3 CLAIMED-UNVERIFIED: no verified attestation for %s from %s (%v)",
			ref, o.SignerWorkflow, err)
	}
	return RungR4, fmt.Sprintf("R4 TRUSTED: all %d deployed image(s) have a verified attestation signed by %s (owner %s)",
		len(refs), o.SignerWorkflow, o.Owner)
}

// resolveImageRefs collects EVERY OCI reference to verify: the run's
// "image.<name>" pins (a k8s-attach imageID repo@sha256:... is exactly Hop A's
// runtime→digest binding) PLUS an explicit ProvenanceOpts.Image. --image is
// ADDITIVE, never a substitute: the substrate's real deployed-image pins always
// stay in scope, so a decoy attested --image can never mask an unattested real
// deployed image — the whole union must verify for R4. Each pin/flag value may
// carry a comma-separated container list, so every concrete ref within it is
// included; refs are de-duplicated. Returns false when nothing image-like is in
// scope.
func resolveImageRefs(o ProvenanceOpts, pins map[string]string) ([]string, bool) {
	var refs []string
	seen := map[string]bool{}
	add := func(rs []string) {
		for _, r := range rs {
			if !seen[r] {
				seen[r] = true
				refs = append(refs, r)
			}
		}
	}
	keys := make([]string, 0, len(pins))
	for k := range pins {
		if strings.HasPrefix(k, "image.") {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		add(splitRefs(pins[k]))
	}
	add(splitRefs(o.Image))
	if len(refs) == 0 {
		return nil, false
	}
	return refs, true
}

// splitRefs splits a comma-separated pin value into its non-empty, trimmed
// concrete OCI references.
func splitRefs(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if r := strings.TrimSpace(part); r != "" {
			out = append(out, r)
		}
	}
	return out
}

// exposesDeployedImage reports whether the run has any deployed image the R4 gate
// must cover: an explicit --image, or a substrate-reported "image.<name>" pin
// (k8s-attach's Hop A imageID). When true, L4/L5 require a verified R4 binding.
func exposesDeployedImage(o ProvenanceOpts, pins map[string]string) bool {
	if o.Image != "" {
		return true
	}
	for k := range pins {
		if strings.HasPrefix(k, "image.") {
			return true
		}
	}
	return false
}

// requireR4 caps level below L4 (to honesty.SelfAttestedCap, L3) when a
// provenance claim is in scope but did not reach R4: ADR-0016's "green only at
// verified R4" — L4/L5 (effect-verified / end-to-end) may not stand on an
// unverified runtime→source binding. Levels at or below the cap are unchanged.
func requireR4(level string) string {
	capN, _ := levelNum(honesty.SelfAttestedCap)
	n, ok := levelNum(level)
	if !ok || n <= capN {
		return level
	}
	return honesty.SelfAttestedCap
}

// capBelowL5 caps a run at L4 when it would otherwise reach L5 — the ceiling on a
// REDUCED-ASSURANCE anchor (--insecure-ignore-tlog: no Rekor inclusion proof).
// Levels below L5, and unparseable levels, are unchanged.
func capBelowL5(level string) string {
	if n, ok := levelNum(level); ok && n >= 5 {
		return "L4"
	}
	return level
}
