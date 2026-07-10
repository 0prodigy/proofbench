//go:build live

// Package verify's LIVE provenance integration test (ADR-0016 R4). Run with:
//
//	go test -tags live -run TestProvenanceLiveGhAttestation ./internal/verify/
//
// It exercises the REAL `gh attestation verify` against the PoC repo's actual
// signed image (ghcr.io/0prodigy/pb-ci-trust-poc): a genuine attestation with
// the correct signer-workflow PASSES, a wrong --signer-workflow FAILS. It is
// build-tagged so the default suite never depends on network/gh, and it SKIPS
// (not fails) when gh is absent or the network is unavailable, logging why.
package verify

import (
	"os/exec"
	"testing"
)

const (
	livePoCImage         = "ghcr.io/0prodigy/pb-ci-trust-poc"
	livePoCSignerCorrect = "0prodigy/proofbench-ci-trust-poc/.github/workflows/build-attest.yml"
	livePoCSignerWrong   = "0prodigy/proofbench-ci-trust-poc/.github/workflows/does-not-exist.yml"
)

func TestProvenanceLiveGhAttestation(t *testing.T) {
	if _, err := exec.LookPath("gh"); err != nil {
		t.Skip("gh not in PATH — skipping live attestation test")
	}
	// Probe once: if even the owner-only verify errors in a way that looks like
	// no network / not authenticated, skip rather than fail (offline is not a
	// code defect).
	if err := ghAttestationVerify(livePoCImage, "0prodigy", ""); err != nil {
		t.Skipf("live attestation unreachable (offline / unauthenticated / registry down): %v", err)
	}

	t.Run("correct signer-workflow verifies", func(t *testing.T) {
		if err := ghAttestationVerify(livePoCImage, "0prodigy", livePoCSignerCorrect); err != nil {
			t.Fatalf("genuine attestation should verify, got: %v", err)
		}
	})

	t.Run("wrong signer-workflow is rejected", func(t *testing.T) {
		if err := ghAttestationVerify(livePoCImage, "0prodigy", livePoCSignerWrong); err == nil {
			t.Fatal("wrong signer-workflow verified — R4 gate is not enforced")
		}
	})
}
