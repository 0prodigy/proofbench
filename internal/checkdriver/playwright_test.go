package checkdriver

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/launchwings/proofbench/internal/manifest"
)

// TestPlaywrightExerciseEmptySpec proves an empty exercise (spec path) is a
// harness error, never a silent no-op.
func TestPlaywrightExerciseEmptySpec(t *testing.T) {
	d := &playwrightDriver{dir: "."}
	capture := &fakeCapture{dir: t.TempDir()}
	_, err := d.Exercise(manifest.CheckSpec{Name: "e2e", Exercise: "   "}, Env{}, capture)
	if err == nil {
		t.Fatal("Exercise with empty spec path expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "empty exercise") {
		t.Errorf("error %q should name the empty exercise", err.Error())
	}
}

// TestPlaywrightExerciseBuildsCommand proves Exercise assembles the
// `npx playwright test` invocation with the spec file, an --output pointed
// at a per-check dir under the bundle, endpoint substitution applied, and
// the env exports prefix (endpoints/vars/session) — but never emits a
// PLAYWRIGHT_OUTPUT_DIR reference (dead env var removed, not half-wired).
func TestPlaywrightExerciseBuildsCommand(t *testing.T) {
	d := &playwrightDriver{dir: "."}
	bundleDir := t.TempDir()
	capture := &fakeCapture{dir: bundleDir}
	env := Env{
		Endpoints: map[string]string{"appservice": "127.0.0.1:18080"},
		Vars:      map[string]string{"PB_TOKEN": "secret"},
		Session:   "/tmp/state.json",
	}
	spec := manifest.CheckSpec{Name: "e2e", Exercise: "tests/${resources.appservice.host}.spec.ts"}

	if _, err := d.Exercise(spec, env, capture); err != nil {
		t.Fatalf("Exercise: %v", err)
	}

	if len(capture.execs) != 1 {
		t.Fatalf("execs = %v, want exactly one", capture.execs)
	}
	got := capture.execs[0]

	wantOutDir := filepath.Join(bundleDir, "playwright-e2e")
	for _, want := range []string{
		"npx playwright test",
		"tests/127.0.0.1.spec.ts", // endpoint placeholder substituted
		"--output " + shellQuote(wantOutDir),
		"--trace on",
		"export PB_ENDPOINT_APPSERVICE=",
		"export PB_TOKEN=",
		"export PB_SESSION=",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("command %q missing %q", got, want)
		}
	}
	if strings.Contains(got, "PLAYWRIGHT_OUTPUT_DIR") {
		t.Errorf("command %q references the removed PLAYWRIGHT_OUTPUT_DIR env var", got)
	}

	if _, err := os.Stat(wantOutDir); err != nil {
		t.Errorf("output dir %q not created: %v", wantOutDir, err)
	}
}

// TestPlaywrightExerciseAttachesProducedArtifacts proves Exercise walks the
// per-check output dir it created and claims every file playwright wrote
// there (trace, screenshot, video) as a tool-provenance artifact, typed by
// extension.
func TestPlaywrightExerciseAttachesProducedArtifacts(t *testing.T) {
	d := &playwrightDriver{dir: "."}
	bundleDir := t.TempDir()
	capture := &fakeCapture{dir: bundleDir}
	spec := manifest.CheckSpec{Name: "e2e", Exercise: "tests/e2e/order.spec.ts"}

	// Pre-seed the output dir the driver will create (MkdirAll on an
	// existing dir succeeds), standing in for files playwright itself would
	// have written during a real `npx playwright test` run.
	outDir := filepath.Join(bundleDir, "playwright-e2e")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		t.Fatalf("pre-seed mkdir: %v", err)
	}
	for _, name := range []string{"trace.zip", "shot.png", "video.webm", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(outDir, name), []byte("x"), 0o644); err != nil {
			t.Fatalf("pre-seed %s: %v", name, err)
		}
	}

	if _, err := d.Exercise(spec, Env{}, capture); err != nil {
		t.Fatalf("Exercise: %v", err)
	}

	want := map[string]string{
		"e2e-trace.zip":  "recording",
		"e2e-shot.png":   "screenshot",
		"e2e-video.webm": "recording",
		"e2e-notes.txt":  "log",
	}
	got := map[string]string{}
	for _, f := range capture.files {
		typ, name, ok := strings.Cut(f, ":")
		if !ok {
			t.Fatalf("malformed fake file entry %q", f)
		}
		got[name] = typ
	}
	for name, wantTyp := range want {
		gotTyp, ok := got[name]
		if !ok {
			t.Errorf("file %q was not attached; attached: %v", name, capture.files)
			continue
		}
		if gotTyp != wantTyp {
			t.Errorf("file %q type = %q, want %q", name, gotTyp, wantTyp)
		}
	}
}
