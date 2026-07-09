package evidence

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// helper: compute sha256 of raw bytes.
func hexSHA(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// helper: write a small file into dir and return its path.
func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("writeFile %s: %v", name, err)
	}
	return p
}

// TestNewCreatesBundleDir verifies New creates the directory and a valid manifest.
func TestNewCreatesBundleDir(t *testing.T) {
	root := t.TempDir()
	b, err := New(root, NewOpts{
		Ticket: "ENG-0001",
		Claim:  "smoke test",
		Phase:  PhaseVerify,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if b.Dir == "" {
		t.Fatal("Dir is empty")
	}
	if _, err := os.Stat(b.Dir); err != nil {
		t.Fatalf("bundle dir missing: %v", err)
	}
	if b.M.Schema != 2 {
		t.Errorf("schema: got %d, want 2", b.M.Schema)
	}
	if b.M.Verdict != VerdictInconclusive {
		t.Errorf("initial verdict: got %q, want %q", b.M.Verdict, VerdictInconclusive)
	}
	if b.M.StartedAt == "" {
		t.Error("StartedAt is empty")
	}
	if b.M.RunID == "" {
		t.Error("RunID is empty")
	}
	if !strings.HasSuffix(b.M.RunID, "-"+PhaseVerify) {
		t.Errorf("RunID %q does not end with phase suffix", b.M.RunID)
	}
}

// TestNewInvalidPhase verifies New rejects an unknown phase.
func TestNewInvalidPhase(t *testing.T) {
	root := t.TempDir()
	_, err := New(root, NewOpts{Phase: "unknown"})
	if err == nil {
		t.Fatal("expected error for invalid phase, got nil")
	}
}

// TestKindValidation is table-driven over the kind enum ("" | before | after),
// asserting New accepts/rejects the same values Validate does — a bundle
// created with a given kind must be judged consistently at both seams.
func TestKindValidation(t *testing.T) {
	cases := []struct {
		name    string
		kind    string
		wantErr bool
	}{
		{"empty (unpaired)", "", false},
		{"before", "before", false},
		{"after", "after", false},
		{"invalid", "sideways", true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			b, err := New(root, NewOpts{Phase: PhaseVerify, Claim: "kind test", Kind: tc.kind})
			if tc.wantErr {
				if err == nil {
					t.Fatalf("New(kind=%q): expected error, got nil", tc.kind)
				}
				return
			}
			if err != nil {
				t.Fatalf("New(kind=%q): unexpected error: %v", tc.kind, err)
			}
			if b.M.Kind != tc.kind {
				t.Errorf("Kind: got %q, want %q", b.M.Kind, tc.kind)
			}
			if err := b.SetVerdict(VerdictPass, ""); err != nil {
				t.Fatalf("SetVerdict: %v", err)
			}
			if err := Validate(b.Dir); err != nil {
				t.Errorf("Validate(kind=%q): unexpected error: %v", tc.kind, err)
			}
		})
	}
}

// TestValidateRejectsInvalidKind proves Validate independently rejects a
// manifest whose kind was tampered with on disk after creation (not just at
// New time), mirroring how validPhases/validVerdicts are enforced.
func TestValidateRejectsInvalidKind(t *testing.T) {
	root := t.TempDir()
	b, err := New(root, NewOpts{Phase: PhaseVerify, Claim: "tampered kind"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	b.M.Kind = "sideways"
	if err := b.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := Validate(b.Dir); err == nil {
		t.Error("expected Validate to reject invalid kind, got nil")
	}
}

// TestRoundTrip exercises New / Add / Seal / SetVerdict / Open.
func TestRoundTrip(t *testing.T) {
	root := t.TempDir()
	external := t.TempDir()

	// Create bundle.
	b, err := New(root, NewOpts{
		Ticket: "ENG-9999",
		Claim:  "round-trip",
		Phase:  PhaseFix,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Add an external file.
	src := writeFile(t, external, "output.log", "hello world\n")
	if err := b.Add(src, ArtifactLog, "output", nil); err != nil {
		t.Fatalf("Add external: %v", err)
	}
	if len(b.M.Artifacts) != 1 {
		t.Fatalf("expected 1 artifact after Add, got %d", len(b.M.Artifacts))
	}
	a := b.M.Artifacts[0]
	if a.Type != ArtifactLog {
		t.Errorf("type: got %q, want %q", a.Type, ArtifactLog)
	}
	if a.Provenance != ProvenanceAgent {
		t.Errorf("provenance: got %q, want %q", a.Provenance, ProvenanceAgent)
	}
	if a.SHA256 == "" {
		t.Error("SHA256 is empty after Add")
	}
	// The sequence prefix should be 01-.
	if !strings.HasPrefix(a.Path, "01-") {
		t.Errorf("path %q does not start with 01-", a.Path)
	}

	// Add a file already inside the bundle (no copy, registered in-place).
	inBundle := writeFile(t, b.Dir, "internal.txt", "internal content")
	if err := b.Add(inBundle, ArtifactSnapshot, "internal", nil); err != nil {
		t.Fatalf("Add in-bundle: %v", err)
	}
	if len(b.M.Artifacts) != 2 {
		t.Fatalf("expected 2 artifacts, got %d", len(b.M.Artifacts))
	}
	a2 := b.M.Artifacts[1]
	if a2.Path != "internal.txt" {
		t.Errorf("in-bundle path: got %q, want internal.txt", a2.Path)
	}

	// Drop an unregistered file and Seal.
	writeFile(t, b.Dir, "stray.log", "orphan")
	if err := b.Seal(); err != nil {
		t.Fatalf("Seal: %v", err)
	}
	found := false
	for _, a := range b.M.Artifacts {
		if a.Path == "stray.log" {
			found = true
			if a.Type != ArtifactLog {
				t.Errorf("seal artifact type: got %q, want %q", a.Type, ArtifactLog)
			}
			if a.Provenance != ProvenanceAgent {
				t.Errorf("seal artifact provenance: got %q", a.Provenance)
			}
		}
	}
	if !found {
		t.Error("Seal did not register stray.log")
	}

	// SetVerdict.
	if err := b.SetVerdict(VerdictPass, "all good"); err != nil {
		t.Fatalf("SetVerdict: %v", err)
	}
	if b.M.Verdict != VerdictPass {
		t.Errorf("verdict: got %q, want %q", b.M.Verdict, VerdictPass)
	}
	if b.M.FinishedAt == "" {
		t.Error("FinishedAt is empty after SetVerdict")
	}

	// Open the bundle from disk and verify round-trip.
	b2, err := Open(b.Dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if b2.M.Verdict != VerdictPass {
		t.Errorf("round-trip verdict: got %q", b2.M.Verdict)
	}
	if b2.M.Schema != 2 {
		t.Errorf("round-trip schema: got %d", b2.M.Schema)
	}
	if len(b2.M.Artifacts) != len(b.M.Artifacts) {
		t.Errorf("round-trip artifact count: got %d, want %d", len(b2.M.Artifacts), len(b.M.Artifacts))
	}
}

// TestSetVerdictAutoSeals verifies unregistered files are sealed at verdict
// time (PLAN §5), without waiting for an explicit Seal call.
func TestSetVerdictAutoSeals(t *testing.T) {
	root := t.TempDir()
	b, _ := New(root, NewOpts{Phase: PhaseVerify, Claim: "auto-seal"})
	writeFile(t, b.Dir, "unregistered.log", "orphan at verdict time")

	if err := b.SetVerdict(VerdictPass, ""); err != nil {
		t.Fatalf("SetVerdict: %v", err)
	}
	found := false
	for _, a := range b.M.Artifacts {
		if a.Path == "unregistered.log" {
			found = true
		}
	}
	if !found {
		t.Error("SetVerdict did not seal unregistered.log")
	}
	if err := Validate(b.Dir); err != nil {
		t.Errorf("Validate after auto-seal: %v", err)
	}
}

// TestSetVerdictRequiresNoteForFailInconclusive enforces the note requirement.
func TestSetVerdictRequiresNoteForFailInconclusive(t *testing.T) {
	root := t.TempDir()
	b, _ := New(root, NewOpts{Phase: PhaseVerify, Claim: "x"})

	if err := b.SetVerdict(VerdictFail, ""); err == nil {
		t.Error("expected error for fail with empty note")
	}
	if err := b.SetVerdict(VerdictInconclusive, ""); err == nil {
		t.Error("expected error for inconclusive with empty note")
	}
	// Pass does not require a note.
	if err := b.SetVerdict(VerdictPass, ""); err != nil {
		t.Errorf("pass without note: unexpected error: %v", err)
	}
}

// TestSetVerdictInvalidEnum rejects unknown verdicts.
func TestSetVerdictInvalidEnum(t *testing.T) {
	root := t.TempDir()
	b, _ := New(root, NewOpts{Phase: PhaseVerify, Claim: "x"})
	if err := b.SetVerdict("maybe", "some note"); err == nil {
		t.Error("expected error for invalid verdict enum")
	}
}

// TestLink registers a link artifact.
func TestLink(t *testing.T) {
	root := t.TempDir()
	b, _ := New(root, NewOpts{Phase: PhaseVerify, Claim: "link test"})
	if err := b.Link("exec-abc123", "https://example.com/exec/abc123"); err != nil {
		t.Fatalf("Link: %v", err)
	}
	if len(b.M.Artifacts) != 1 {
		t.Fatalf("expected 1 artifact, got %d", len(b.M.Artifacts))
	}
	a := b.M.Artifacts[0]
	if a.Type != ArtifactLink {
		t.Errorf("type: got %q", a.Type)
	}
	if a.Meta["executionId"] != "exec-abc123" {
		t.Errorf("executionId: got %v", a.Meta["executionId"])
	}
	if a.Meta["url"] != "https://example.com/exec/abc123" {
		t.Errorf("url: got %v", a.Meta["url"])
	}
	// Link artifacts must not affect Seal's seq counter for file artifacts.
}

// TestOpenV1Manifest verifies that a schema:1 manifest is parsed and upgraded in-memory.
func TestOpenV1Manifest(t *testing.T) {
	dir := t.TempDir()

	// Write a v1-shaped manifest (field names identical, no checks/proofLevel/pins,
	// null path/sha256 on link artifacts, as seen in ENG-20190 bundles).
	v1 := map[string]any{
		"schema":     1,
		"ticket":     "ENG-20190",
		"runId":      "20260702-123231-reverify",
		"claim":      "fake-ml orchestrator e2e green",
		"phase":      "reverify",
		"kind":       "after",
		"startedAt":  "2026-07-02T07:02:31Z",
		"finishedAt": "2026-07-02T07:02:31Z",
		"verdict":    "pass",
		"note":       "retrofitted",
		"artifacts": []map[string]any{
			{
				"type":   "link",
				"name":   "link",
				"path":   nil,
				"sha256": nil,
				"meta": map[string]any{
					"executionId": "6a3ed73c",
					"url":         "https://example.studio.lyric.tech",
				},
			},
			{
				"type":   "log",
				"name":   "campaign-record",
				"path":   "01-campaign.md",
				"sha256": "abc123",
				"meta":   map[string]any{},
			},
		},
	}
	raw, _ := json.MarshalIndent(v1, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), raw, 0o644); err != nil {
		t.Fatalf("write v1 manifest: %v", err)
	}

	b, err := Open(dir)
	if err != nil {
		t.Fatalf("Open v1: %v", err)
	}
	if b.M.Schema != 2 {
		t.Errorf("expected schema upgraded to 2, got %d", b.M.Schema)
	}
	if b.M.Ticket != "ENG-20190" {
		t.Errorf("ticket: got %q", b.M.Ticket)
	}
	if b.M.Verdict != "pass" {
		t.Errorf("verdict: got %q", b.M.Verdict)
	}
	if len(b.M.Artifacts) != 2 {
		t.Fatalf("artifact count: got %d, want 2", len(b.M.Artifacts))
	}
	// Provenance must be filled in during upgrade.
	for _, a := range b.M.Artifacts {
		if a.Provenance != ProvenanceAgent {
			t.Errorf("artifact %q provenance: got %q, want %q", a.Name, a.Provenance, ProvenanceAgent)
		}
	}
}

// TestValidateMissingArtifact verifies Validate fails when an artifact file is absent.
func TestValidateMissingArtifact(t *testing.T) {
	root := t.TempDir()
	b, _ := New(root, NewOpts{Phase: PhaseVerify, Claim: "validate test"})

	// Manually inject an artifact pointing to a nonexistent file.
	b.M.Artifacts = append(b.M.Artifacts, Artifact{
		Type:       ArtifactLog,
		Name:       "ghost",
		Path:       "ghost.log",
		SHA256:     "deadbeef",
		Provenance: ProvenanceHarness,
	})
	if err := b.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	if err := Validate(b.Dir); err == nil {
		t.Error("expected Validate to fail for missing artifact, got nil")
	}
}

// TestValidateBadSHA verifies Validate fails when the sha256 does not match file content.
func TestValidateBadSHA(t *testing.T) {
	root := t.TempDir()
	b, _ := New(root, NewOpts{Phase: PhaseVerify, Claim: "sha test"})

	// Write a real file into the bundle.
	content := "real content"
	fpath := writeFile(t, b.Dir, "real.log", content)
	_ = fpath

	// Register it with a wrong sha256.
	b.M.Artifacts = append(b.M.Artifacts, Artifact{
		Type:       ArtifactLog,
		Name:       "real",
		Path:       "real.log",
		SHA256:     "0000000000000000000000000000000000000000000000000000000000000000",
		Provenance: ProvenanceHarness,
	})
	if err := b.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	if err := Validate(b.Dir); err == nil {
		t.Error("expected Validate to fail for sha256 mismatch, got nil")
	}
}

// TestValidateHappyPath verifies Validate passes for a well-formed bundle.
func TestValidateHappyPath(t *testing.T) {
	root := t.TempDir()
	b, _ := New(root, NewOpts{Phase: PhaseVerify, Claim: "valid"})

	content := "some log output\n"
	src := writeFile(t, b.Dir, "run.log", content)
	sum := hexSHA([]byte(content))
	b.M.Artifacts = append(b.M.Artifacts, Artifact{
		Type:       ArtifactLog,
		Name:       "run",
		Path:       filepath.Base(src),
		SHA256:     sum,
		Provenance: ProvenanceHarness,
	})
	if err := b.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}
	// Link artifact with no path — must not trigger missing-file error.
	b.M.Artifacts = append(b.M.Artifacts, Artifact{
		Type:       ArtifactLink,
		Name:       "link",
		Provenance: ProvenanceAgent,
		Meta:       map[string]any{"executionId": "abc"},
	})
	if err := b.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := b.SetVerdict(VerdictPass, ""); err != nil {
		t.Fatalf("SetVerdict: %v", err)
	}

	if err := Validate(b.Dir); err != nil {
		t.Errorf("Validate happy path: %v", err)
	}
}

// TestAddSequencePrefix verifies that multiple external file adds get correct NN- prefixes.
func TestAddSequencePrefix(t *testing.T) {
	root := t.TempDir()
	ext := t.TempDir()
	b, _ := New(root, NewOpts{Phase: PhaseRepro, Claim: "seq"})

	for i, name := range []string{"a.log", "b.log", "c.log"} {
		src := writeFile(t, ext, name, name)
		if err := b.Add(src, ArtifactLog, name, nil); err != nil {
			t.Fatalf("Add %s: %v", name, err)
		}
		a := b.M.Artifacts[i]
		// Check zero-padded two-digit prefix: "01-", "02-", "03-".
		expected := []string{"01-", "02-", "03-"}[i]
		if !strings.HasPrefix(a.Path, expected) {
			t.Errorf("artifact[%d] path %q: expected prefix %q", i, a.Path, expected)
		}
	}
}

// TestSealIdempotent verifies calling Seal twice does not double-register files.
func TestSealIdempotent(t *testing.T) {
	root := t.TempDir()
	b, _ := New(root, NewOpts{Phase: PhaseVerify, Claim: "idempotent seal"})
	writeFile(t, b.Dir, "orphan.log", "data")

	if err := b.Seal(); err != nil {
		t.Fatalf("Seal 1: %v", err)
	}
	count1 := len(b.M.Artifacts)

	if err := b.Seal(); err != nil {
		t.Fatalf("Seal 2: %v", err)
	}
	count2 := len(b.M.Artifacts)

	if count1 != count2 {
		t.Errorf("Seal is not idempotent: count went from %d to %d", count1, count2)
	}
}

// TestSealWalksSubdirectories proves Seal claims files inside a subdirectory
// (e.g. the playwright-<check>/ trace/screenshot subtree a driver writes),
// not just the bundle's top level, registering the subdir file's path as its
// path relative to the bundle dir.
func TestSealWalksSubdirectories(t *testing.T) {
	root := t.TempDir()
	b, _ := New(root, NewOpts{Phase: PhaseVerify, Claim: "nested seal"})

	subdir := filepath.Join(b.Dir, "playwright-e2e")
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		t.Fatalf("mkdir subdir: %v", err)
	}
	writeFile(t, subdir, "trace.zip", "fake trace bytes")

	if err := b.Seal(); err != nil {
		t.Fatalf("Seal: %v", err)
	}

	wantPath := filepath.Join("playwright-e2e", "trace.zip")
	found := false
	for _, a := range b.M.Artifacts {
		if a.Path == wantPath {
			found = true
			if a.Type != ArtifactLog {
				t.Errorf("subdir artifact type: got %q, want %q", a.Type, ArtifactLog)
			}
		}
	}
	if !found {
		t.Errorf("Seal did not register subdir file %q; artifacts: %+v", wantPath, b.M.Artifacts)
	}
	if err := Validate(b.Dir); err != nil {
		t.Errorf("Validate after subdir seal: %v", err)
	}
}

// TestAddInvalidArtifactType proves Add rejects a type outside the enum, the
// same way File already does — a bundle written via Add must never contain a
// type its own Validate would reject.
func TestAddInvalidArtifactType(t *testing.T) {
	root := t.TempDir()
	ext := t.TempDir()
	b, _ := New(root, NewOpts{Phase: PhaseVerify, Claim: "bad type"})
	src := writeFile(t, ext, "x.log", "data")

	if err := b.Add(src, "bogus", "x", nil); err == nil {
		t.Fatal("Add with invalid artifact type expected an error, got nil")
	}
	if len(b.M.Artifacts) != 0 {
		t.Errorf("Add with invalid type registered an artifact: %+v", b.M.Artifacts)
	}
}

// TestOpenRejectsUnsupportedSchema proves Open rejects a schema number it
// does not understand rather than silently trusting it.
func TestOpenRejectsUnsupportedSchema(t *testing.T) {
	dir := t.TempDir()
	raw := `{"schema": 3, "runId": "x", "verdict": "pass", "artifacts": []}`
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), []byte(raw), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	if _, err := Open(dir); err == nil {
		t.Fatal("Open(schema:3) expected an error, got nil")
	} else if !strings.Contains(err.Error(), "3") {
		t.Errorf("Open error %q should name the unsupported schema", err.Error())
	}
}
