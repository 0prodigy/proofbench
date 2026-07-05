package evidence

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestBundle creates a minimal Bundle backed by a temp directory.
// It does not call New() (which is a stub in core.go) — it constructs
// the struct directly so run_test.go is self-contained.
func newTestBundle(t *testing.T) *Bundle {
	t.Helper()
	dir := t.TempDir()
	m := &Manifest{
		Schema:    2,
		RunID:     "test-run",
		Claim:     "test",
		Phase:     PhaseVerify,
		StartedAt: "2026-07-04T00:00:00Z",
		Artifacts: []Artifact{},
		Verdict:   "",
	}
	return &Bundle{Dir: dir, M: m}
}

// readManifest loads and unmarshals the manifest.json from a bundle directory.
func readManifest(t *testing.T, dir string) *Manifest {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatalf("readManifest: %v", err)
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("readManifest unmarshal: %v", err)
	}
	return &m
}

// TestRunExitCodeTrue verifies that a successful command returns exit code 0.
func TestRunExitCodeTrue(t *testing.T) {
	b := newTestBundle(t)
	code, err := b.Run("true-cmd", []string{"true"}, false)
	if err != nil {
		t.Fatalf("unexpected harness error: %v", err)
	}
	if code != 0 {
		t.Errorf("want exit 0, got %d", code)
	}
	m := readManifest(t, b.Dir)
	if len(m.Artifacts) != 1 {
		t.Fatalf("want 1 artifact, got %d", len(m.Artifacts))
	}
	a := m.Artifacts[0]
	if a.ExitCode() != 0 {
		t.Errorf("artifact exitCode want 0, got %v", a.Meta["exitCode"])
	}
}

// TestRunExitCodeFalse verifies that a failing command propagates a non-zero
// exit code and does NOT return a Go error.
func TestRunExitCodeFalse(t *testing.T) {
	b := newTestBundle(t)
	code, err := b.Run("false-cmd", []string{"false"}, false)
	if err != nil {
		t.Fatalf("unexpected harness error: %v", err)
	}
	if code == 0 {
		t.Errorf("want non-zero exit code, got 0")
	}
	m := readManifest(t, b.Dir)
	if len(m.Artifacts) != 1 {
		t.Fatalf("want 1 artifact, got %d", len(m.Artifacts))
	}
	a := m.Artifacts[0]
	// exitCode in meta must equal the returned code.
	metaCode := int(a.Meta["exitCode"].(float64))
	if metaCode != code {
		t.Errorf("meta exitCode %d != returned code %d", metaCode, code)
	}
}

// TestRunLogFileContent verifies that the command's output is captured in the
// log file inside the bundle directory.
func TestRunLogFileContent(t *testing.T) {
	b := newTestBundle(t)
	want := "hello from run"
	code, err := b.Run("echo-cmd", []string{"echo", want}, false)
	if err != nil {
		t.Fatalf("unexpected harness error: %v", err)
	}
	if code != 0 {
		t.Errorf("want exit 0, got %d", code)
	}

	// Expect log file 01-echo-cmd.log to contain the output (nextSeq is
	// 1-based, shared with Add).
	logPath := filepath.Join(b.Dir, "01-echo-cmd.log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("log file missing: %v", err)
	}
	if !strings.Contains(string(data), want) {
		t.Errorf("log file %q does not contain %q", string(data), want)
	}

	// Artifact must be registered with provenance harness and the log path.
	m := readManifest(t, b.Dir)
	if len(m.Artifacts) != 1 {
		t.Fatalf("want 1 artifact, got %d", len(m.Artifacts))
	}
	a := m.Artifacts[0]
	if a.Provenance != ProvenanceHarness {
		t.Errorf("provenance: want %q, got %q", ProvenanceHarness, a.Provenance)
	}
	if a.Path != "01-echo-cmd.log" {
		t.Errorf("path: want 01-echo-cmd.log, got %q", a.Path)
	}
	if a.SHA256 == "" {
		t.Errorf("sha256 must be set")
	}
}

// TestRunTimeout verifies that a long-running command is killed after the
// PB_RUN_TIMEOUT deadline and returns exit code 124 (timeout(1) convention)
// with meta.timedOut=true.
func TestRunTimeout(t *testing.T) {
	t.Setenv("PB_RUN_TIMEOUT", "100ms")

	b := newTestBundle(t)
	// sleep 5 would run for 5 s; timeout kills it at 100 ms.
	code, err := b.Run("sleep-cmd", []string{"sleep", "5"}, false)
	if err != nil {
		t.Fatalf("unexpected harness error: %v", err)
	}
	if code != 124 {
		t.Errorf("want exit code 124 on timeout, got %d", code)
	}

	m := readManifest(t, b.Dir)
	if len(m.Artifacts) != 1 {
		t.Fatalf("want 1 artifact, got %d", len(m.Artifacts))
	}
	a := m.Artifacts[0]
	timedOut, ok := a.Meta["timedOut"].(bool)
	if !ok || !timedOut {
		t.Errorf("want meta.timedOut=true, got %v", a.Meta["timedOut"])
	}
	metaCode := int(a.Meta["exitCode"].(float64))
	if metaCode != 124 {
		t.Errorf("meta exitCode want 124, got %d", metaCode)
	}
}

// TestRunBadTimeoutEnv verifies that an unparseable PB_RUN_TIMEOUT surfaces
// as a harness error instead of silently disabling the timeout.
func TestRunBadTimeoutEnv(t *testing.T) {
	t.Setenv("PB_RUN_TIMEOUT", "banana")

	b := newTestBundle(t)
	if _, err := b.Run("bad-timeout", []string{"true"}, false); err == nil {
		t.Fatal("want error for unparseable PB_RUN_TIMEOUT, got nil")
	} else if !strings.Contains(err.Error(), "PB_RUN_TIMEOUT") {
		t.Errorf("error %q does not name PB_RUN_TIMEOUT", err)
	}
}

// TestRunAfterAddDoesNotTruncate reproduces the add-then-run collision:
// `evidence add up.log` followed by `evidence run --name up` must not
// truncate the added artifact, and the bundle must still self-validate.
func TestRunAfterAddDoesNotTruncate(t *testing.T) {
	b := newTestBundle(t)
	ext := t.TempDir()
	src := filepath.Join(ext, "up.log")
	if err := os.WriteFile(src, []byte("added artifact content\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := b.Add(src, ArtifactLog, "up.log", nil); err != nil {
		t.Fatalf("Add: %v", err)
	}

	code, err := b.Run("up", []string{"echo", "run output"}, false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if code != 0 {
		t.Errorf("want exit 0, got %d", code)
	}

	m := readManifest(t, b.Dir)
	if len(m.Artifacts) != 2 {
		t.Fatalf("want 2 artifacts, got %d", len(m.Artifacts))
	}
	if m.Artifacts[0].Path == m.Artifacts[1].Path {
		t.Errorf("artifact paths collide: %q", m.Artifacts[0].Path)
	}
	// The bundle must pass its own sha256 validation.
	if err := Validate(b.Dir); err != nil {
		t.Errorf("bundle fails self-validation after add+run: %v", err)
	}
}

// TestRunShellPipeline verifies that shell=true runs the joined argv through
// bash -lc, enabling pipelines.
func TestRunShellPipeline(t *testing.T) {
	b := newTestBundle(t)
	// echo hi | wc -l should output "1\n" (one line).
	code, err := b.Run("pipeline", []string{"echo hi | wc -l"}, true)
	if err != nil {
		t.Fatalf("unexpected harness error: %v", err)
	}
	if code != 0 {
		t.Errorf("want exit 0, got %d", code)
	}

	logPath := filepath.Join(b.Dir, "01-pipeline.log")
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("log file missing: %v", err)
	}
	// wc -l outputs "       1\n" or "1\n" depending on platform; just check
	// that the output contains "1".
	if !strings.Contains(strings.TrimSpace(string(data)), "1") {
		t.Errorf("expected wc output to contain '1', got %q", string(data))
	}
}

// ExitCode is a helper on Artifact that reads exitCode from meta without
// type assertions in every test.
func (a *Artifact) ExitCode() int {
	v, ok := a.Meta["exitCode"]
	if !ok {
		return -999
	}
	switch x := v.(type) {
	case float64:
		return int(x)
	case int:
		return x
	}
	return -999
}
