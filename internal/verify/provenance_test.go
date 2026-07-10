package verify

import (
	"errors"
	"strings"
	"testing"

	"github.com/0prodigy/proofbench/internal/evidence"
	"github.com/0prodigy/proofbench/internal/honesty"
	"github.com/0prodigy/proofbench/internal/manifest"
)

const pocImage = "ghcr.io/0prodigy/pb-ci-trust-poc@sha256:deadbeef"

// stubGh installs a deterministic gh attestation-verify seam for one test.
func stubGh(t *testing.T, fn func(ociRef, owner, signerWorkflow string) error) {
	t.Helper()
	prev := ghAttestationVerify
	ghAttestationVerify = fn
	t.Cleanup(func() { ghAttestationVerify = prev })
}

// TestVerifyProvenanceRung exercises the ADR-0016 rung ladder directly: only a
// passing `gh attestation verify` earns R4; every other outcome degrades and is
// never green at R4.
func TestVerifyProvenanceRung(t *testing.T) {
	inScope := ProvenanceOpts{Owner: "0prodigy", SignerWorkflow: "0prodigy/proofbench-ci-trust-poc/.github/workflows/build-attest.yml", Image: pocImage}

	t.Run("not in scope leaves the ladder untouched", func(t *testing.T) {
		stubGh(t, func(string, string, string) error { t.Fatal("gh should not run out of scope"); return nil })
		rung, reason := verifyProvenance(ProvenanceOpts{}, nil)
		if rung != "" || reason != "" {
			t.Fatalf("out of scope rung=%q reason=%q, want empty", rung, reason)
		}
	})

	t.Run("genuine attestation earns R4", func(t *testing.T) {
		stubGh(t, func(ref, owner, wf string) error {
			if ref != pocImage || owner != inScope.Owner || wf != inScope.SignerWorkflow {
				t.Fatalf("gh args ref=%q owner=%q wf=%q unexpected", ref, owner, wf)
			}
			return nil
		})
		rung, _ := verifyProvenance(inScope, nil)
		if rung != RungR4 {
			t.Fatalf("rung=%q, want R4 for a verified attestation", rung)
		}
	})

	t.Run("wrong signer / unattested degrades below R4", func(t *testing.T) {
		stubGh(t, func(string, string, string) error { return errors.New("no attestation matching signer") })
		rung, _ := verifyProvenance(inScope, nil)
		if rung == RungR4 {
			t.Fatal("rung R4 on a failing verify — never green at R4")
		}
		if rung != RungR3 {
			t.Errorf("rung=%q, want R3 (claimed-unverified)", rung)
		}
	})

	t.Run("gh absent degrades honestly, never R4", func(t *testing.T) {
		stubGh(t, func(string, string, string) error { return errGhAbsent })
		rung, _ := verifyProvenance(inScope, nil)
		if rung == RungR4 {
			t.Fatal("rung R4 with gh absent — fake pass")
		}
	})

	t.Run("no resolvable image in scope is R0", func(t *testing.T) {
		stubGh(t, func(string, string, string) error { t.Fatal("gh should not run with no image"); return nil })
		rung, _ := verifyProvenance(ProvenanceOpts{Owner: "o", SignerWorkflow: "w"}, nil)
		if rung != RungR0 {
			t.Fatalf("rung=%q, want R0 (no image digest in scope)", rung)
		}
	})

	t.Run("image digest resolves from a k8s-attach pin", func(t *testing.T) {
		var gotRef string
		stubGh(t, func(ref, _, _ string) error { gotRef = ref; return nil })
		pins := map[string]string{"k8s.namespace": "delta", "image.orders": pocImage}
		rung, _ := verifyProvenance(ProvenanceOpts{Owner: "o", SignerWorkflow: "w"}, pins)
		if rung != RungR4 || gotRef != pocImage {
			t.Fatalf("rung=%q ref=%q, want R4 verifying the pinned image", rung, gotRef)
		}
	})
}

// TestProvenanceR4GatesL4 proves the cap wiring: with a provenance claim in
// scope, L4/L5 require R4 even on an otherwise-anchored run. A verified R4 lets
// L4 stand; a degraded rung caps to L3.
func TestProvenanceR4GatesL4(t *testing.T) {
	good := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(orders)==0"}}

	run := func(t *testing.T, ghErr error) *Summary {
		t.Helper()
		dir := t.TempDir()
		lock := signKeyless(t, only(good), dir, mainSAN)
		if err := honesty.WriteLock(dir, lock); err != nil {
			t.Fatal(err)
		}
		honesty.SetAnchorVerifier(&honesty.CosignAnchor{
			ExpectedIdentity: mainSAN,
			Run:              func(a ...string) error { return fakeCosignVerify(a) },
		})
		t.Cleanup(func() { honesty.SetAnchorVerifier(nil) })
		stubGh(t, func(string, string, string) error { return ghErr })
		_, sum, err := Run(only(good), Opts{
			EvidenceRoot: t.TempDir(),
			Claim:        "provenance gate",
			Substrate:    "local",
			Dir:          dir,
			Provenance:   ProvenanceOpts{Owner: "0prodigy", SignerWorkflow: "wf", Image: pocImage},
		})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		return sum
	}

	t.Run("verified R4 lets an anchored L4 stand", func(t *testing.T) {
		sum := run(t, nil)
		if sum.ProvenanceRung != RungR4 {
			t.Fatalf("rung=%q, want R4", sum.ProvenanceRung)
		}
		if sum.ProofLevel != "L4" {
			t.Fatalf("proof=%q, want L4 (anchored + R4)", sum.ProofLevel)
		}
	})

	t.Run("degraded provenance caps L4 to L3, never green at R4", func(t *testing.T) {
		sum := run(t, errors.New("wrong signer"))
		if sum.ProvenanceRung == RungR4 {
			t.Fatal("rung R4 on a failed attestation verify")
		}
		if sum.ProofLevel == "L4" || sum.ProofLevel == "L5" {
			t.Fatalf("proof=%q not capped despite sub-R4 provenance in scope", sum.ProofLevel)
		}
		if sum.ProofLevel != "L3" {
			t.Errorf("proof=%q, want L3 (R4 required for L4)", sum.ProofLevel)
		}
		if sum.Verdict != evidence.VerdictPass {
			t.Errorf("verdict=%q, want pass (the cap ceilings the level, not the check)", sum.Verdict)
		}
	})
}

// TestL4RequiresR4WhenImageExposed is FIX 2's coupling gate: an anchor unlock and
// the R4 gate are coupled, so an L4 check whose lock the anchor accepted, but with
// a deployed image exposed and NO --owner/--signer-workflow (provenance never in
// scope), is capped to L3 — clearing the self-attested cap does not by itself
// grant L4/L5 on an unverified runtime→source binding.
func TestL4RequiresR4WhenImageExposed(t *testing.T) {
	good := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(orders)==0"}}
	dir := t.TempDir()
	lock := signKeyless(t, only(good), dir, mainSAN)
	if err := honesty.WriteLock(dir, lock); err != nil {
		t.Fatal(err)
	}
	honesty.SetAnchorVerifier(&honesty.CosignAnchor{
		ExpectedIdentity: mainSAN,
		Run:              func(a ...string) error { return fakeCosignVerify(a) },
	})
	t.Cleanup(func() { honesty.SetAnchorVerifier(nil) })
	// A deployed image is exposed (--image), but provenance is NOT in scope (no
	// owner/signer-workflow), so no R4 binding was verified.
	_, sum, err := Run(only(good), Opts{
		EvidenceRoot: t.TempDir(),
		Claim:        "L4 requires R4",
		Substrate:    "local",
		Dir:          dir,
		Provenance:   ProvenanceOpts{Image: pocImage},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if sum.SelfAttested {
		t.Error("anchored run wrongly flagged SELF-ATTESTED")
	}
	if sum.ProofLevel == "L4" || sum.ProofLevel == "L5" {
		t.Fatalf("proof=%q reached L4+ with an exposed image but no verified R4 — coupling NOT enforced", sum.ProofLevel)
	}
	if sum.ProofLevel != "L3" {
		t.Errorf("proof=%q, want L3 (L4/L5 requires verified R4 provenance)", sum.ProofLevel)
	}
	if sum.Verdict != evidence.VerdictPass {
		t.Errorf("verdict=%q, want pass (the cap ceilings the level, not the check)", sum.Verdict)
	}
}

// TestProvenanceVerifiesAllImages is FIX 3: R4 is TRUSTED only when EVERY deployed
// image pin (and every comma-separated ref within) verifies. Two images, one
// genuine-attested and one unattested, must degrade below R4 and name the failing
// image — never "first image only".
func TestProvenanceVerifiesAllImages(t *testing.T) {
	const (
		genuine = "ghcr.io/0prodigy/genuine@sha256:aaaa"
		bad     = "ghcr.io/0prodigy/bad@sha256:bbbb"
	)

	t.Run("rung ladder: any unattested image degrades below R4", func(t *testing.T) {
		stubGh(t, func(ref, _, _ string) error {
			if ref == genuine {
				return nil
			}
			return errors.New("no attestation matching signer")
		})
		inScope := ProvenanceOpts{Owner: "0prodigy", SignerWorkflow: "wf", Image: genuine + "," + bad}
		rung, reason := verifyProvenance(inScope, nil)
		if rung == RungR4 {
			t.Fatal("rung R4 with one unattested image — R4 must require ALL images verify")
		}
		if rung != RungR3 {
			t.Errorf("rung=%q, want R3", rung)
		}
		if !strings.Contains(reason, bad) {
			t.Errorf("reason %q should name the failing image %q", reason, bad)
		}
	})

	t.Run("full run with a mixed image list is not green at L4+", func(t *testing.T) {
		good := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(orders)==0"}}
		dir := t.TempDir()
		lock := signKeyless(t, only(good), dir, mainSAN)
		if err := honesty.WriteLock(dir, lock); err != nil {
			t.Fatal(err)
		}
		honesty.SetAnchorVerifier(&honesty.CosignAnchor{
			ExpectedIdentity: mainSAN,
			Run:              func(a ...string) error { return fakeCosignVerify(a) },
		})
		t.Cleanup(func() { honesty.SetAnchorVerifier(nil) })
		stubGh(t, func(ref, _, _ string) error {
			if ref == genuine {
				return nil
			}
			return errors.New("no attestation")
		})
		_, sum, err := Run(only(good), Opts{
			EvidenceRoot: t.TempDir(),
			Claim:        "all images verified",
			Substrate:    "local",
			Dir:          dir,
			Provenance:   ProvenanceOpts{Owner: "0prodigy", SignerWorkflow: "wf", Image: genuine + "," + bad},
		})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if sum.ProvenanceRung == RungR4 {
			t.Fatal("rung R4 despite one unattested image in the list")
		}
		if sum.ProofLevel == "L4" || sum.ProofLevel == "L5" {
			t.Fatalf("proof=%q green at L4+ despite a sub-R4 image", sum.ProofLevel)
		}
	})
}

// TestImageFlagIsAdditive is Fix 3: --image is ADDITIVE to the substrate's real
// image.<name> pins, never a substitute. An agent passing a decoy attested
// --image must NOT be able to mask an unattested real deployed-image pin: the
// union must all verify for R4, so a mixed set degrades below R4 and names the
// failing real image.
func TestImageFlagIsAdditive(t *testing.T) {
	const (
		decoy   = "ghcr.io/0prodigy/decoy@sha256:cccc" // agent-chosen, genuinely attested
		realImg = "ghcr.io/0prodigy/real@sha256:dddd"  // the real deployed image, UNATTESTED
	)
	stubGh(t, func(ref, _, _ string) error {
		if ref == decoy {
			return nil
		}
		return errors.New("no attestation matching signer")
	})
	pins := map[string]string{"repo": "abc123", "image.svc": realImg}
	inScope := ProvenanceOpts{Owner: "0prodigy", SignerWorkflow: "wf", Image: decoy}

	rung, reason := verifyProvenance(inScope, pins)
	if rung == RungR4 {
		t.Fatal("R4 with a decoy --image masking an unattested deployed-image pin — --image treated as override, not additive")
	}
	if rung != RungR3 {
		t.Errorf("rung=%q, want R3 (union not fully attested)", rung)
	}
	if !strings.Contains(reason, realImg) {
		t.Errorf("reason %q should name the unattested real deployed image %q", reason, realImg)
	}

	// Control: when the substrate pin IS attested too, the union verifies to R4.
	stubGh(t, func(string, string, string) error { return nil })
	if rung, _ := verifyProvenance(inScope, pins); rung != RungR4 {
		t.Errorf("rung=%q, want R4 when the whole union is attested", rung)
	}
}

// TestReducedAssuranceCapsBelowL5 is FIX 4: --insecure-ignore-tlog is reduced
// assurance (offline Fulcio-cert identity only, no Rekor inclusion proof) and
// cannot ground the top rung — an otherwise-L5 anchored run is capped to L4.
func TestReducedAssuranceCapsBelowL5(t *testing.T) {
	e2e := manifest.CheckSpec{Name: "orders", Level: "L5", Exercise: "echo ok", Expect: []string{"exitCode(orders)==0"}}
	dir := t.TempDir()
	lock := signKeyless(t, only(e2e), dir, mainSAN)
	if err := honesty.WriteLock(dir, lock); err != nil {
		t.Fatal(err)
	}
	honesty.SetAnchorVerifier(&honesty.CosignAnchor{
		ExpectedIdentity: mainSAN,
		IgnoreTlog:       true,
		Run:              func(a ...string) error { return fakeCosignVerify(a) },
	})
	t.Cleanup(func() { honesty.SetAnchorVerifier(nil) })
	_, sum, err := Run(only(e2e), Opts{EvidenceRoot: t.TempDir(), Claim: "reduced assurance", Substrate: "local", Dir: dir})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if sum.SelfAttested {
		t.Error("anchored run wrongly flagged SELF-ATTESTED")
	}
	if sum.ProofLevel == "L5" {
		t.Fatalf("proof=L5 under --insecure-ignore-tlog — reduced assurance must cap below L5")
	}
	if sum.ProofLevel != "L4" {
		t.Errorf("proof=%q, want L4 (reduced assurance ceiling)", sum.ProofLevel)
	}
}
