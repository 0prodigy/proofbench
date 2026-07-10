package honesty

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"

	"github.com/0prodigy/proofbench/internal/manifest"
)

func testSigner(t *testing.T, id string) Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return Signer{ID: id, Priv: priv}
}

// TestSignVerifyRoundTrip proves a detached signature verifies over its message
// and rejects a tampered message.
func TestSignVerifyRoundTrip(t *testing.T) {
	s := testSigner(t, "p")
	sig := SignMessage(s, []byte("hello"))
	if err := sig.Verify([]byte("hello")); err != nil {
		t.Errorf("verify same message: %v", err)
	}
	if err := sig.Verify([]byte("hell0")); err == nil {
		t.Error("verify tampered message: want error, got nil")
	}
}

// TestCheckHashDetectsDrift proves any change to a check's labels changes its
// content hash — the R1 drift signal.
func TestCheckHashDetectsDrift(t *testing.T) {
	base := manifest.CheckSpec{Name: "c", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(c)==0"}}
	r := &manifest.Ready{Checks: []manifest.CheckSpec{base}}
	h, err := CheckHash(r, base, "")
	if err != nil {
		t.Fatal(err)
	}
	mutations := []manifest.CheckSpec{
		{Name: "c", Level: "L4", Exercise: "exit 0", Expect: []string{"exitCode(c)==0"}},                           // gutted exercise
		{Name: "c", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(c)==137"}},                        // weakened predicate
		{Name: "c", Level: "L4", Exercise: "echo ok"},                                                              // dropped predicate
		{Name: "c", Level: "L5", Exercise: "echo ok", Expect: []string{"exitCode(c)==0"}},                          // level bump
		{Name: "c", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(c)==0"}, Requires: []string{"X"}}, // added requires
		{Name: "c", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(c)==0"}, Artifacts: []string{"log"}},
	}
	for i, m := range mutations {
		got, err := CheckHash(r, m, "")
		if err != nil {
			t.Fatalf("mutation %d: %v", i, err)
		}
		if got == h {
			t.Errorf("mutation %d did not change the check hash", i)
		}
	}
}

// TestCheckHashFoldsBehavior proves the hash covers BEHAVIOR, not just labels:
// gutting a drive verb's Run body or emptying a referenced script file drifts
// the hash even though the check's exercise string is unchanged (E1's
// gut-the-drive-body attack, ADR-0015 R1).
func TestCheckHashFoldsBehavior(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "fire.sh"), []byte("#!/bin/sh\ncreate-order\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	check := manifest.CheckSpec{Name: "orders", Level: "L4", Exercise: "drive.fire", Expect: []string{"exitCode(orders)==0"}}
	base := &manifest.Ready{
		Drive:  map[string]manifest.DriveVerb{"fire": {Run: "./fire.sh", Identity: "env:TOKEN"}},
		Checks: []manifest.CheckSpec{check},
	}
	h, err := CheckHash(base, check, dir)
	if err != nil {
		t.Fatal(err)
	}

	// Gut the drive body to `exit 0` — exercise string ("drive.fire") unchanged.
	gutted := &manifest.Ready{
		Drive:  map[string]manifest.DriveVerb{"fire": {Run: "exit 0", Identity: "env:TOKEN"}},
		Checks: []manifest.CheckSpec{check},
	}
	if gh, err := CheckHash(gutted, check, dir); err != nil || gh == h {
		t.Errorf("gutting Drive[fire].Run did not drift the hash (err=%v)", err)
	}

	// Empty the referenced script — path unchanged, bytes changed.
	if err := os.WriteFile(filepath.Join(dir, "fire.sh"), nil, 0o755); err != nil {
		t.Fatal(err)
	}
	if eh, err := CheckHash(base, check, dir); err != nil || eh == h {
		t.Errorf("emptying the referenced script did not drift the hash (err=%v)", err)
	}
}

// TestCheckHashMissingFileIsError proves a referenced script that is absent at
// hash time is an error (surfaced as not-run), never a silent skip.
func TestCheckHashMissingFileIsError(t *testing.T) {
	check := manifest.CheckSpec{Name: "e2e", Level: "L4", Exercise: "./gone.sh", Expect: []string{"exitCode(e2e)==0"}}
	r := &manifest.Ready{Checks: []manifest.CheckSpec{check}}
	if _, err := CheckHash(r, check, t.TempDir()); err == nil {
		t.Error("CheckHash over a missing referenced script should error, not skip")
	}
}

// TestLockVerifyDetectsEditedHash proves the lock signature covers the recorded
// per-check hashes: editing one without the key invalidates the lock.
func TestLockVerifyDetectsEditedHash(t *testing.T) {
	r := &manifest.Ready{Checks: []manifest.CheckSpec{{Name: "c", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(c)==0"}}}}
	lock, err := SignLock(r, "", testSigner(t, "p"))
	if err != nil {
		t.Fatal(err)
	}
	if err := lock.Verify(); err != nil {
		t.Fatalf("fresh lock should verify: %v", err)
	}
	lock.CheckHashes["c"] = "deadbeef"
	if err := lock.Verify(); err == nil {
		t.Error("lock with an edited hash should fail signature verification")
	}
}

// TestSelfKeyLockIsNotAnchored proves the default AnchorVerifier treats a lock
// signed by a self-generated key as NOT externally anchored — the truth that
// caps a self-attested run at L3 (ADR-0015 pin-your-own-key defense).
func TestSelfKeyLockIsNotAnchored(t *testing.T) {
	r := &manifest.Ready{Checks: []manifest.CheckSpec{{Name: "c", Level: "L4", Exercise: "echo ok", Expect: []string{"exitCode(c)==0"}}}}
	lock, err := SignLock(r, "", testSigner(t, "attacker"))
	if err != nil {
		t.Fatal(err)
	}
	if Anchored(lock) {
		t.Error("a self-generated-key lock must never report as externally anchored")
	}
}

// TestLoadOrCreateKeyPersists proves the key is generated once and reused.
func TestLoadOrCreateKeyPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".pb", "signing.key")
	first, err := LoadOrCreateKey(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadOrCreateKey(path)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Equal(second) {
		t.Error("LoadOrCreateKey did not persist and reuse the generated key")
	}
}
