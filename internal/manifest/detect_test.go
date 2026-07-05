package manifest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixtureDir returns the absolute path to a testdata/detect_* fixture.
func fixtureDir(t *testing.T, name string) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("resolve fixture dir: %v", err)
	}
	return abs
}

// TestDetect_NodeCompose: a directory with docker-compose.yml + package.json
// should propose compose+local modes, a start command, service resources from
// compose services, and a unit check from the test script.
func TestDetect_NodeCompose(t *testing.T) {
	dir := fixtureDir(t, "detect_node_compose")
	r, _ := Detect(dir) // ignore validation error from unimplemented Validate
	if r == nil {
		t.Fatal("Detect returned nil Ready")
	}

	// Service name = dir basename.
	if r.Service != "detect_node_compose" {
		t.Errorf("service = %q; want %q", r.Service, "detect_node_compose")
	}

	// Modes must include "compose".
	if !containsMode(r, "compose") {
		t.Errorf("modes %v missing 'compose'", r.Run.Modes)
	}

	// Modes must include "local" (package.json has a dev/start script).
	if !containsMode(r, "local") {
		t.Errorf("modes %v missing 'local'", r.Run.Modes)
	}

	// Local start command from package.json scripts.dev.
	if r.Run.Local.Start == "" {
		t.Error("run.local.start is empty; want npm run dev or npm run start")
	}
	if !strings.Contains(r.Run.Local.Start, "npm run") {
		t.Errorf("run.local.start = %q; want an npm run command", r.Run.Local.Start)
	}

	// Resources from compose services (api, db).
	if len(r.Resources) == 0 {
		t.Error("resources is empty; want compose services mapped")
	}
	for name, res := range r.Resources {
		if res.Via == nil || res.Via["compose"] == "" {
			t.Errorf("resource %q missing via.compose", name)
		}
	}

	// Unit check from package.json test script.
	if !hasCheckNamed(r, "unit") {
		t.Errorf("checks %v missing 'unit'; want check from npm test", checkNames(r))
	}
	uc := findCheck(r, "unit")
	if uc.Level != "L2" {
		t.Errorf("unit check level = %q; want L2", uc.Level)
	}

	// Sources should reference the compose file.
	if r.Sources["compose"] == "" {
		t.Error("sources.compose is empty; want docker-compose.yml")
	}
}

// TestDetect_GoOnly: a directory with go.mod + main.go + Makefile should
// propose a local mode with "go run ." (or make run) and a unit check.
func TestDetect_GoOnly(t *testing.T) {
	dir := fixtureDir(t, "detect_go_only")
	r, _ := Detect(dir)
	if r == nil {
		t.Fatal("Detect returned nil Ready")
	}

	if r.Service != "detect_go_only" {
		t.Errorf("service = %q; want %q", r.Service, "detect_go_only")
	}

	// Must have local mode.
	if !containsMode(r, "local") {
		t.Errorf("modes %v missing 'local'", r.Run.Modes)
	}

	// Start command: Makefile has 'run' target so make run wins over go run.
	if r.Run.Local.Start == "" {
		t.Error("run.local.start is empty")
	}

	// Unit check from Makefile 'test' target or go.mod fallback.
	if !hasCheckNamed(r, "unit") {
		t.Errorf("checks %v missing 'unit'", checkNames(r))
	}

	// go.mod or makefile source recorded.
	if r.Sources["gomod"] == "" && r.Sources["makefile"] == "" {
		t.Error("sources missing both gomod and makefile")
	}
}

// TestDetect_ProcfileOnly: a directory with only a Procfile should propose
// local mode with the web process command as the start command.
func TestDetect_ProcfileOnly(t *testing.T) {
	dir := fixtureDir(t, "detect_procfile_only")
	r, _ := Detect(dir)
	if r == nil {
		t.Fatal("Detect returned nil Ready")
	}

	if r.Service != "detect_procfile_only" {
		t.Errorf("service = %q; want %q", r.Service, "detect_procfile_only")
	}

	if !containsMode(r, "local") {
		t.Errorf("modes %v missing 'local'", r.Run.Modes)
	}

	// Start command from Procfile web: line.
	if r.Run.Local.Start == "" {
		t.Error("run.local.start is empty; want the Procfile web: command")
	}
	if !strings.Contains(r.Run.Local.Start, "gunicorn") {
		t.Errorf("run.local.start = %q; want gunicorn command from Procfile", r.Run.Local.Start)
	}

	if r.Sources["procfile"] == "" {
		t.Error("sources.procfile is empty; want 'Procfile'")
	}
}

// TestDetect_Empty: an empty directory must never fail hard; it yields a
// minimal Ready with service name from the dir basename and a TODO role.
func TestDetect_Empty(t *testing.T) {
	dir := fixtureDir(t, "detect_empty")
	// Ensure the fixture dir exists (it may be empty).
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdirall: %v", err)
	}

	r, err := Detect(dir)
	if err != nil {
		t.Fatalf("Detect on empty dir must yield a valid manifest (pb init writes a file): %v", err)
	}
	if r == nil {
		t.Fatal("Detect returned nil Ready on empty dir; must never fail hard")
	}
	if r.Service == "" {
		t.Error("service is empty on empty dir; want dir basename")
	}
	if r.Service != "detect_empty" {
		t.Errorf("service = %q; want %q", r.Service, "detect_empty")
	}
	if !strings.Contains(strings.ToLower(r.Role), "todo") {
		t.Errorf("role = %q; want a TODO placeholder", r.Role)
	}
	// modes must be non-empty even for empty dir (Validate would reject empty modes).
	if len(r.Run.Modes) == 0 {
		t.Error("run.modes is empty on empty dir; Validate would reject this")
	}
}

// TestDetect_TempDir_Compose: create a minimal compose-only dir at runtime and
// verify the key properties without depending on committed fixture content.
func TestDetect_TempDir_Compose(t *testing.T) {
	dir := t.TempDir()

	composeContent := `version: "3"
services:
  web:
    image: nginx
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost"]
  redis:
    image: redis
`
	if err := os.WriteFile(filepath.Join(dir, "compose.yaml"), []byte(composeContent), 0o644); err != nil {
		t.Fatal(err)
	}

	r, _ := Detect(dir)
	if r == nil {
		t.Fatal("nil Ready")
	}
	if !containsMode(r, "compose") {
		t.Errorf("modes %v missing 'compose'", r.Run.Modes)
	}
	if r.Sources["compose"] != "compose.yaml" {
		t.Errorf("sources.compose = %q; want compose.yaml", r.Sources["compose"])
	}
	if r.Resources["web"].Via["compose"] != "web" {
		t.Errorf("resource web via.compose = %q; want 'web'", r.Resources["web"].Via["compose"])
	}
	if r.Resources["redis"].Via["compose"] != "redis" {
		t.Errorf("resource redis via.compose = %q; want 'redis'", r.Resources["redis"].Via["compose"])
	}
}

// TestDetect_TempDir_GoMain: go.mod + package main -> "go run ." as start.
func TestDetect_TempDir_GoMain(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module example.com/x\ngo 1.23\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\nfunc main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	r, _ := Detect(dir)
	if r == nil {
		t.Fatal("nil Ready")
	}
	if r.Run.Local.Start != "go run ." {
		t.Errorf("run.local.start = %q; want 'go run .'", r.Run.Local.Start)
	}
	if !hasCheckNamed(r, "unit") {
		t.Errorf("checks %v missing 'unit'", checkNames(r))
	}
	uc := findCheck(r, "unit")
	if uc.Exercise != "go test ./..." {
		t.Errorf("unit check exercise = %q; want 'go test ./...'", uc.Exercise)
	}
}

// TestDetect_TempDir_GoLib: go.mod without main package -> no start cmd proposed.
func TestDetect_TempDir_GoLib(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module example.com/lib\ngo 1.23\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "lib.go"), []byte("package mylib\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	r, _ := Detect(dir)
	if r == nil {
		t.Fatal("nil Ready")
	}
	// No main package: start command should be empty (library, not a runnable).
	if r.Run.Local.Start == "go run ." {
		t.Error("run.local.start = 'go run .' for a library package; should not set start")
	}
	// Unit check still proposed.
	if !hasCheckNamed(r, "unit") {
		t.Errorf("checks %v missing 'unit'", checkNames(r))
	}
}

// TestDetect_TempDir_PackageJSON_StartOnly: package.json with only a "start" script
// (no "dev") uses npm run start.
func TestDetect_TempDir_PackageJSON_StartOnly(t *testing.T) {
	dir := t.TempDir()
	pkg := `{"name":"myapp","scripts":{"start":"node index.js","test":"mocha"}}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(pkg), 0o644); err != nil {
		t.Fatal(err)
	}

	r, _ := Detect(dir)
	if r == nil {
		t.Fatal("nil Ready")
	}
	if r.Run.Local.Start != "npm run start" {
		t.Errorf("run.local.start = %q; want 'npm run start'", r.Run.Local.Start)
	}
}

// TestDetect_TempDir_MakefileStartTargets: Makefile with 'dev' target preferred
// over later start targets.
func TestDetect_TempDir_MakefileStartTargets(t *testing.T) {
	tests := []struct {
		target  string
		wantCmd string
	}{
		{"run", "make run"},
		{"dev", "make dev"},
		{"start", "make start"},
	}
	for _, tc := range tests {
		t.Run(tc.target, func(t *testing.T) {
			dir := t.TempDir()
			mk := ".PHONY: " + tc.target + "\n" + tc.target + ":\n\t./server\n"
			if err := os.WriteFile(filepath.Join(dir, "Makefile"), []byte(mk), 0o644); err != nil {
				t.Fatal(err)
			}
			r, _ := Detect(dir)
			if r == nil {
				t.Fatal("nil Ready")
			}
			if r.Run.Local.Start != tc.wantCmd {
				t.Errorf("run.local.start = %q; want %q", r.Run.Local.Start, tc.wantCmd)
			}
		})
	}
}

// TestDetect_CheckLevels: all checks emitted by Detect must use valid proof-ladder
// levels (L0-L5) so a correct Validate() can accept them.
func TestDetect_CheckLevels(t *testing.T) {
	valid := map[string]bool{"L0": true, "L1": true, "L2": true, "L3": true, "L4": true, "L5": true}
	dirs := []string{
		fixtureDir(t, "detect_node_compose"),
		fixtureDir(t, "detect_go_only"),
		fixtureDir(t, "detect_procfile_only"),
		fixtureDir(t, "detect_empty"),
	}
	for _, dir := range dirs {
		r, _ := Detect(dir)
		if r == nil {
			continue
		}
		for _, c := range r.Checks {
			if !valid[c.Level] {
				t.Errorf("dir %s: check %q has invalid level %q", dir, c.Name, c.Level)
			}
		}
	}
}

// TestDetect_ModesValid: all modes emitted must be known substrate kinds.
func TestDetect_ModesValid(t *testing.T) {
	known := map[string]bool{"local": true, "compose": true, "k8s-attach": true, "remote": true}
	dirs := []string{
		fixtureDir(t, "detect_node_compose"),
		fixtureDir(t, "detect_go_only"),
		fixtureDir(t, "detect_procfile_only"),
		fixtureDir(t, "detect_empty"),
	}
	for _, dir := range dirs {
		r, _ := Detect(dir)
		if r == nil {
			continue
		}
		for _, m := range r.Run.Modes {
			if !known[m] {
				t.Errorf("dir %s: unknown mode %q", dir, m)
			}
		}
	}
}

// TestDetect_ServiceName: Detect always sets a non-empty service name.
func TestDetect_ServiceName(t *testing.T) {
	dirs := []string{
		fixtureDir(t, "detect_node_compose"),
		fixtureDir(t, "detect_go_only"),
		fixtureDir(t, "detect_procfile_only"),
		fixtureDir(t, "detect_empty"),
	}
	for _, dir := range dirs {
		r, _ := Detect(dir)
		if r == nil {
			t.Errorf("dir %s: nil Ready", dir)
			continue
		}
		if r.Service == "" {
			t.Errorf("dir %s: service is empty", dir)
		}
	}
}

// ---- helpers ----------------------------------------------------------------

func containsMode(r *Ready, mode string) bool {
	for _, m := range r.Run.Modes {
		if m == mode {
			return true
		}
	}
	return false
}

func checkNames(r *Ready) []string {
	names := make([]string, len(r.Checks))
	for i, c := range r.Checks {
		names[i] = c.Name
	}
	return names
}

func findCheck(r *Ready, name string) CheckSpec {
	for _, c := range r.Checks {
		if c.Name == name {
			return c
		}
	}
	return CheckSpec{}
}
