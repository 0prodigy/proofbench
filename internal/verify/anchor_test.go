package verify

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/0prodigy/proofbench/internal/evidence"
	"github.com/0prodigy/proofbench/internal/honesty"
	"github.com/0prodigy/proofbench/internal/manifest"
)

// Fulcio SANs the PoC confirmed: a protected-main run's cert vs a branch run's
// cert. The branch SAN is what an agent operating in branch context is stuck
// with — it cannot forge the @refs/heads/main identity.
const (
	mainSAN   = "https://github.com/0prodigy/proofbench-ci-trust-poc/.github/workflows/build-attest.yml@refs/heads/main"
	branchSAN = "https://github.com/0prodigy/proofbench-ci-trust-poc/.github/workflows/build-attest.yml@refs/heads/ENG-17397"
)

// fakeCosignVerify is a deterministic stand-in for `cosign verify-blob`: it
// reads the --bundle file (which signKeyless wrote the signer SAN into, modeling
// the Fulcio cert) and the verifier-supplied --certificate-identity[-regexp],
// and accepts iff they match — exactly cosign's identity check, minus the
// crypto. This proves the WIRING: a verifier-supplied identity, never one read
// from the lock, decides anchoring.
func fakeCosignVerify(args []string) error {
	var bundlePath, expID string
	var isRegexp bool
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--bundle":
			bundlePath, i = args[i+1], i+1
		case "--certificate-identity":
			expID, i = args[i+1], i+1
		case "--certificate-identity-regexp":
			expID, isRegexp, i = args[i+1], true, i+1
		}
	}
	data, err := os.ReadFile(bundlePath)
	if err != nil {
		return err
	}
	certID := strings.TrimSpace(string(data))
	if isRegexp {
		if ok, _ := regexp.MatchString(expID, certID); ok {
			return nil
		}
		return fmt.Errorf("cosign: cert identity %q does not match regexp %q", certID, expID)
	}
	if certID == expID {
		return nil
	}
	return fmt.Errorf("cosign: cert identity %q != expected %q", certID, expID)
}

// signKeyless produces a Sigstore-keyless lock for r whose recorded "Fulcio
// cert" (the fake bundle body) is san, via SignLockKeyless with a fake
// sign-blob that writes san as the bundle. This models `pb pin` under CI OIDC.
func signKeyless(t *testing.T, r *manifest.Ready, dir, san string) honesty.Lock {
	t.Helper()
	lock, err := honesty.SignLockKeyless(r, dir, func(args ...string) error {
		for i, a := range args {
			if a == "--bundle" {
				return os.WriteFile(args[i+1], []byte(san), 0o600)
			}
		}
		return fmt.Errorf("fake sign-blob: no --bundle in %v", args)
	})
	if err != nil {
		t.Fatalf("SignLockKeyless: %v", err)
	}
	return lock
}

// runAnchored writes an anchored (keyless) lock for r into a fresh dir, installs
// a CosignAnchor pinned to expectID (with the fake cosign), and runs verify.
func runAnchored(t *testing.T, r *manifest.Ready, san, expectID string) *Summary {
	t.Helper()
	dir := t.TempDir()
	lock := signKeyless(t, r, dir, san)
	if err := honesty.WriteLock(dir, lock); err != nil {
		t.Fatal(err)
	}
	honesty.SetAnchorVerifier(&honesty.CosignAnchor{
		ExpectedIdentity: expectID,
		OIDCIssuer:       honesty.DefaultOIDCIssuer,
		Run:              func(a ...string) error { return fakeCosignVerify(a) },
	})
	t.Cleanup(func() { honesty.SetAnchorVerifier(nil) })
	_, sum, err := Run(r, Opts{EvidenceRoot: t.TempDir(), Claim: "anchor acceptance", Substrate: "local", Dir: dir})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	return sum
}

// TestAnchoredVerifyAcceptance is the Sigstore R1-external-anchor gate: a lock
// keyless-signed under the pinned @main identity reaches L4 (anchor clears the
// self-attested cap); a lock signed under a @branch identity is REJECTED and
// stays self-attested/capped at L3; cosign absent degrades honestly, never a
// fake pass. Mirrors the PoC at pb level with a deterministic cosign seam.
func TestAnchoredVerifyAcceptance(t *testing.T) {
	good := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(orders)==0"}}

	// (a) @main identity ⇒ Anchored ⇒ not self-attested ⇒ L4 reached.
	t.Run("a: main-anchored lock reaches L4, not capped", func(t *testing.T) {
		sum := runAnchored(t, only(good), mainSAN, mainSAN)
		if sum.SelfAttested {
			t.Error("anchored run wrongly flagged SELF-ATTESTED")
		}
		if sum.ProofLevel != "L4" {
			t.Fatalf("proof=%q, want L4 (anchor clears the L3 cap)", sum.ProofLevel)
		}
		if sum.Checks[0].State != evidence.CheckPass || sum.Verdict != evidence.VerdictPass {
			t.Fatalf("state=%q verdict=%q, want pass/pass", sum.Checks[0].State, sum.Verdict)
		}
		if !strings.Contains(sum.AnchorReason, "anchored") {
			t.Errorf("anchor reason %q should record the anchoring", sum.AnchorReason)
		}
	})

	// (b) @branch identity, verifier pins @main ⇒ cosign REJECTS ⇒ not anchored
	// ⇒ self-attested, capped at L3. This is the un-forgeable branch/main split.
	t.Run("b: branch-signed lock is rejected, capped at L3 self-attested", func(t *testing.T) {
		sum := runAnchored(t, only(good), branchSAN, mainSAN)
		if !sum.SelfAttested {
			t.Error("branch-anchored (rejected) run not flagged SELF-ATTESTED")
		}
		if sum.ProofLevel == "L4" || sum.ProofLevel == "L5" {
			t.Fatalf("proof=%q reached L4+ on a branch identity — anchor rejection NOT enforced", sum.ProofLevel)
		}
		if sum.ProofLevel != "L3" {
			t.Errorf("proof=%q, want L3 (rejected anchor stays self-attested)", sum.ProofLevel)
		}
		if !strings.Contains(sum.AnchorReason, "rejected") {
			t.Errorf("anchor reason %q should record the rejection", sum.AnchorReason)
		}
	})

	// (c) cosign absent ⇒ the keyless lock cannot be verified at all ⇒ honest
	// refusal (not-run), never a fake pass at L4.
	t.Run("c: cosign absent degrades honestly, no fake pass", func(t *testing.T) {
		dir := t.TempDir()
		lock := signKeyless(t, only(good), dir, mainSAN)
		if err := honesty.WriteLock(dir, lock); err != nil {
			t.Fatal(err)
		}
		honesty.SetAnchorVerifier(&honesty.CosignAnchor{
			ExpectedIdentity: mainSAN,
			Run:              func(...string) error { return honesty.ErrCosignAbsent },
		})
		t.Cleanup(func() { honesty.SetAnchorVerifier(nil) })
		_, sum, err := Run(only(good), Opts{EvidenceRoot: t.TempDir(), Claim: "cosign absent", Substrate: "local", Dir: dir})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if sum.Verdict == evidence.VerdictPass {
			t.Fatalf("verdict=pass with cosign absent — fake pass on an unverifiable keyless lock")
		}
		if sum.ProofLevel == "L4" || sum.ProofLevel == "L5" {
			t.Fatalf("proof=%q reached L4+ with cosign absent", sum.ProofLevel)
		}
		if sum.Checks[0].State == evidence.CheckPass {
			t.Errorf("check passed on an unverifiable keyless lock (cosign absent)")
		}
	})

	// The verifier-supplied identity may be a regexp (e.g. pin the workflow but
	// allow any protected ref) — accepted the same way, still verifier-supplied.
	t.Run("regexp identity is honored", func(t *testing.T) {
		dir := t.TempDir()
		lock := signKeyless(t, only(good), dir, mainSAN)
		if err := honesty.WriteLock(dir, lock); err != nil {
			t.Fatal(err)
		}
		honesty.SetAnchorVerifier(&honesty.CosignAnchor{
			ExpectedIdentity: `^https://github\.com/0prodigy/proofbench-ci-trust-poc/.*@refs/heads/main$`,
			IdentityRegexp:   true,
			Run:              func(a ...string) error { return fakeCosignVerify(a) },
		})
		t.Cleanup(func() { honesty.SetAnchorVerifier(nil) })
		_, sum, err := Run(only(good), Opts{EvidenceRoot: t.TempDir(), Claim: "regexp identity", Substrate: "local", Dir: dir})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		if sum.ProofLevel != "L4" {
			t.Fatalf("proof=%q, want L4 (regexp identity matched)", sum.ProofLevel)
		}
	})
}
