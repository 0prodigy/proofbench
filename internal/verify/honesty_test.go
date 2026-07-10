package verify

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0prodigy/proofbench/internal/evidence"
	"github.com/0prodigy/proofbench/internal/honesty"
	"github.com/0prodigy/proofbench/internal/manifest"
)

// genSigner builds a signing principal with a fresh ed25519 key for tests.
func genSigner(t *testing.T, id string) honesty.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return honesty.Signer{ID: id, Priv: priv}
}

// runPinned pins lockR's check set into a fresh dir with signer, then runs
// verify against runR as executor. runR may differ from lockR to simulate a
// post-pin edit of the oracle (an attack); the lock still reflects lockR.
func runPinned(t *testing.T, lockR, runR *manifest.Ready, signer honesty.Signer, executor string) *Summary {
	t.Helper()
	dir := t.TempDir()
	lock, err := honesty.SignLock(lockR, dir, signer)
	if err != nil {
		t.Fatal(err)
	}
	if err := honesty.WriteLock(dir, lock); err != nil {
		t.Fatal(err)
	}
	t.Setenv(honesty.EnvPrincipal, executor)
	_, sum, err := Run(runR, Opts{
		EvidenceRoot: t.TempDir(),
		Claim:        "honesty spine acceptance",
		Substrate:    "local",
		Dir:          dir,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	return sum
}

func only(c manifest.CheckSpec) *manifest.Ready {
	return &manifest.Ready{Checks: []manifest.CheckSpec{c}}
}

// TestHonestySpineE1Acceptance reproduces all five E1 attacks (plus the
// self-attested L3 cap) against the hardened runner and asserts each is now
// caught — refused / capped / not-run — never green at a level it cannot earn.
// This is ADR-0015's original acceptance gate.
func TestHonestySpineE1Acceptance(t *testing.T) {
	good := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(orders)==0"}}

	// Baseline: a pinned, signed, independently-executed check reaches green,
	// so the attacks below are demonstrated against a genuinely-working oracle.
	// The lock is signed by a self-generated key (no external anchor), so the
	// honest ceiling is L3 (SELF-ATTESTED) — an L4 label cannot be earned until
	// the Sigstore anchored-verify slice lands.
	t.Run("baseline pinned check is green, capped at L3 self-attested", func(t *testing.T) {
		sum := runPinned(t, only(good), only(good), genSigner(t, "oracle"), "runner")
		if sum.Verdict != evidence.VerdictPass || sum.Checks[0].State != evidence.CheckPass {
			t.Fatalf("baseline verdict=%q state=%q, want pass/pass", sum.Verdict, sum.Checks[0].State)
		}
		if !sum.SelfAttested {
			t.Error("baseline self-key run not labeled SELF-ATTESTED")
		}
		if sum.ProofLevel != "L3" {
			t.Errorf("baseline proof=%q, want L3 (self-attested cap on an L4 check)", sum.ProofLevel)
		}
	})

	// (a) gut the exercise to exit 0 and weaken the predicate → the definition
	// hash drifts from the signed lock → not-run, never green.
	t.Run("a: gutted exercise + weakened predicate is refused", func(t *testing.T) {
		gutted := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "exit 0", Expect: []string{"exitCode(orders)==0"}}
		sum := runPinned(t, only(good), only(gutted), genSigner(t, "oracle"), "runner")
		assertRefused(t, sum, "unsigned or hash-drifted")
	})

	// (b) alter/weaken a predicate after pinning → hash drift → not-run.
	t.Run("b: predicate altered after pinning is refused", func(t *testing.T) {
		weakened := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(orders)==137"}}
		sum := runPinned(t, only(good), only(weakened), genSigner(t, "oracle"), "runner")
		assertRefused(t, sum, "unsigned or hash-drifted")
	})

	// (c) empty expect: block → vacuous → not-run, never a pass. Pinned to
	// match, so it is the vacuous rule (not drift) that catches it.
	t.Run("c: empty expect is not-run vacuous", func(t *testing.T) {
		empty := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "echo ok"}
		sum := runPinned(t, only(empty), only(empty), genSigner(t, "oracle"), "runner")
		assertRefused(t, sum, "vacuous")
	})

	// (d) self-heal a failing assertion in place (edit after pin) → hash drift
	// caught, rather than the edit silently flipping the check to green.
	t.Run("d: self-healed assertion is caught by drift", func(t *testing.T) {
		failing := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(orders)==1"}}
		healed := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(orders)==0"}}
		sum := runPinned(t, only(failing), only(healed), genSigner(t, "oracle"), "runner")
		assertRefused(t, sum, "unsigned or hash-drifted")
	})

	// (e) edit a recorded sha in manifest.json to launder a swapped artifact →
	// evidence validate detects it via the detached manifest signature.
	t.Run("e: laundered sha in manifest is caught by validate", func(t *testing.T) {
		assertLaunderedShaCaught(t)
	})

	// (f) A self-generated/local key is not an external anchor, so the run is
	// SELF-ATTESTED and its proof capped at L3 (never L5) — the honest
	// degradation that replaces the old signer==executor string check.
	t.Run("f: self-attested run is flagged and capped at L3", func(t *testing.T) {
		e2e := manifest.CheckSpec{Name: "orders", Level: "L5", Exercise: "echo ok", Expect: []string{"exitCode(orders)==0"}}
		signer := genSigner(t, "solo")
		sum := runPinned(t, only(e2e), only(e2e), signer, "solo")
		if !sum.SelfAttested {
			t.Error("self-attested run not flagged")
		}
		if sum.ProofLevel != "L3" {
			t.Errorf("self-attested proof=%q, want L3 (capped, no external anchor)", sum.ProofLevel)
		}
		if sum.Verdict != evidence.VerdictPass {
			t.Errorf("self-attested verdict=%q, want pass (the cap ceilings the level, not the check)", sum.Verdict)
		}
	})
}

// TestHonestySpineAdversarialGate is the ADR-0015 trust-model-independent
// acceptance gate: the two confirmed forgery holes the honesty spine closes
// without crypto. (A) pin-your-own-key dies by honest degradation (SELF-ATTESTED
// L3 cap); (B) gut-the-drive-body dies by complete CheckHash (behavior drift).
func TestHonestySpineAdversarialGate(t *testing.T) {
	// (A) pin-your-own-key: an attacker mints their OWN signing key and pins a
	// tampered (gutted) check with it, so the lock matches (no drift) and the
	// signature verifies. Crypto cannot distinguish this from an honest key —
	// honest degradation must: with no external anchor the run is SELF-ATTESTED
	// and capped at L3, so the forged oracle can never claim L4+.
	t.Run("A: pin-your-own-key is capped at L3 SELF-ATTESTED, never L4+", func(t *testing.T) {
		tampered := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "exit 0", Expect: []string{"exitCode(orders)==0"}}
		sum := runPinned(t, only(tampered), only(tampered), genSigner(t, "attacker"), "attacker")
		if !sum.SelfAttested {
			t.Error("self-minted-key run not labeled SELF-ATTESTED")
		}
		if sum.ProofLevel == "L4" || sum.ProofLevel == "L5" {
			t.Fatalf("proof=%q reached L4+ on a self-minted key — pin-your-own-key NOT closed", sum.ProofLevel)
		}
		if sum.ProofLevel != "L3" {
			t.Errorf("proof=%q, want L3 (self-attested cap)", sum.ProofLevel)
		}
	})

	// (B) gut-the-drive-body: the exercise string ("drive.fire") is unchanged,
	// but the drive verb's Run body is rewritten to `exit 0` AND the referenced
	// script is emptied. Complete CheckHash folds the drive body and the script's
	// bytes, so this behavior swap drifts the hash → the check is refused
	// (not-run), never silently green (ADR-0015 R1).
	t.Run("B: gut-the-drive-body drifts CheckHash to not-run", func(t *testing.T) {
		dir := t.TempDir()
		script := filepath.Join(dir, "fire.sh")
		if err := os.WriteFile(script, []byte("#!/bin/sh\ncreate-order --commit\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		check := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "drive.fire", Expect: []string{"exitCode(orders)==0"}}
		honest := &manifest.Ready{
			Drive:  map[string]manifest.DriveVerb{"fire": {Run: "./fire.sh"}},
			Checks: []manifest.CheckSpec{check},
		}
		lock, err := honesty.SignLock(honest, dir, genSigner(t, "oracle"))
		if err != nil {
			t.Fatal(err)
		}
		if err := honesty.WriteLock(dir, lock); err != nil {
			t.Fatal(err)
		}
		// Tamper: gut the drive body and empty the script it used to run.
		if err := os.WriteFile(script, nil, 0o755); err != nil {
			t.Fatal(err)
		}
		gutted := &manifest.Ready{
			Drive:  map[string]manifest.DriveVerb{"fire": {Run: "exit 0"}},
			Checks: []manifest.CheckSpec{check},
		}
		t.Setenv(honesty.EnvPrincipal, "runner")
		_, sum, err := Run(gutted, Opts{EvidenceRoot: t.TempDir(), Claim: "gut-the-drive-body", Substrate: "local", Dir: dir})
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		assertRefused(t, sum, "unsigned or hash-drifted")
	})
}

// assertRefused asserts the single-check run never reached green: the check is
// not-run with a reason containing want, the verdict is not pass, and no rung
// was promoted.
func assertRefused(t *testing.T, sum *Summary, want string) {
	t.Helper()
	if sum.Checks[0].State != evidence.CheckNotRun {
		t.Fatalf("state=%q reason=%q, want not-run", sum.Checks[0].State, sum.Checks[0].Reason)
	}
	if !strings.Contains(sum.Checks[0].Reason, want) {
		t.Errorf("reason=%q, want it to contain %q", sum.Checks[0].Reason, want)
	}
	if sum.Verdict == evidence.VerdictPass {
		t.Errorf("verdict=%q, want NOT pass (a caught attack must never be green)", sum.Verdict)
	}
	if sum.ProofLevel != "none" {
		t.Errorf("proof=%q, want none (a not-run check promotes no rung)", sum.ProofLevel)
	}
}

// assertLaunderedShaCaught builds a signed bundle, then swaps an artifact's
// bytes AND re-anchors its recorded sha (so the per-artifact sha check would
// pass, exactly E1 R3b), and asserts validate rejects it on the manifest
// signature.
func assertLaunderedShaCaught(t *testing.T) {
	t.Helper()
	b, err := evidence.New(t.TempDir(), evidence.NewOpts{Claim: "sha ledger", Phase: evidence.PhaseVerify})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Run("probe", []string{"echo original"}, true); err != nil {
		t.Fatal(err)
	}
	if err := b.SetVerdict(evidence.VerdictPass, ""); err != nil {
		t.Fatal(err)
	}
	if err := b.SignManifest(genSigner(t, "oracle")); err != nil {
		t.Fatal(err)
	}
	if err := evidence.Validate(b.Dir); err != nil {
		t.Fatalf("clean signed bundle should validate: %v", err)
	}

	reopened, err := evidence.Open(b.Dir)
	if err != nil {
		t.Fatal(err)
	}
	laundered := []byte("laundered\n")
	sum := sha256.Sum256(laundered)
	swapped := false
	for i, a := range reopened.M.Artifacts {
		if a.Type != evidence.ArtifactCommand {
			continue
		}
		if err := os.WriteFile(filepath.Join(reopened.Dir, a.Path), laundered, 0o644); err != nil {
			t.Fatal(err)
		}
		reopened.M.Artifacts[i].SHA256 = hex.EncodeToString(sum[:])
		swapped = true
	}
	if !swapped {
		t.Fatal("no command artifact to launder")
	}
	if err := reopened.Save(); err != nil {
		t.Fatal(err)
	}

	err = evidence.Validate(b.Dir)
	if err == nil {
		t.Fatal("laundered sha not caught — validate passed")
	}
	if !strings.Contains(err.Error(), "signature") {
		t.Errorf("validate error %q should cite the manifest signature", err.Error())
	}
}
