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

// mustLoadProposal renders r via MarshalProposal, writes it to a temp file,
// and loads it back through manifest.Load — proving every field Detect
// proposes is not just structurally present but actually passes Validate.
func mustLoadProposal(t *testing.T, r *Ready) *Ready {
	t.Helper()
	data, err := MarshalProposal(r)
	if err != nil {
		t.Fatalf("MarshalProposal: %v", err)
	}
	path := filepath.Join(t.TempDir(), "ready.yaml")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write proposal: %v", err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load(proposal) = %v; proposal:\n%s", err, data)
	}
	return loaded
}

// mustLoadProposalRejectsScaffold marshals r, writes it, and asserts Load
// rejects it as generated scaffolding — the pb lint side of the "unedited
// proposal must not silently pass" fix.
func mustLoadProposalRejectsScaffold(t *testing.T, r *Ready) {
	t.Helper()
	data, err := MarshalProposal(r)
	if err != nil {
		t.Fatalf("MarshalProposal: %v", err)
	}
	path := filepath.Join(t.TempDir(), "ready.yaml")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write proposal: %v", err)
	}
	_, err = Load(path)
	if err == nil {
		t.Fatalf("Load(proposal) succeeded; want a scaffolding rejection error for:\n%s", data)
	}
	if !strings.Contains(err.Error(), "generated scaffolding") {
		t.Errorf("Load(proposal) error = %q, want substring %q", err.Error(), "generated scaffolding")
	}
}

// TestDetect_ProcfileMultiEntry: a Procfile with more than one process type
// (web + worker) must expand into run.local.start joined as "cmd1 & cmd2 &
// ... & wait" — never just the first entry silently dropping the rest, and
// never falling through to an unrunnable Makefile target.
func TestDetect_ProcfileMultiEntry(t *testing.T) {
	dir := fixtureDir(t, "detect_procfile_only")
	r, err := Detect(dir)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	if !strings.Contains(r.Run.Local.Start, "gunicorn") {
		t.Errorf("run.local.start = %q; want the web entry's gunicorn command", r.Run.Local.Start)
	}
	if !strings.Contains(r.Run.Local.Start, "celery") {
		t.Errorf("run.local.start = %q; want the worker entry's celery command too", r.Run.Local.Start)
	}
	if !strings.HasSuffix(r.Run.Local.Start, " & wait") {
		t.Errorf("run.local.start = %q; want a joined multi-entry line ending in ' & wait'", r.Run.Local.Start)
	}

	mustLoadProposal(t, r)
}

// TestDetect_ProcfileSingleEntry: a Procfile with exactly one process type
// becomes run.local.start verbatim — no "& wait" join for a single command.
func TestDetect_ProcfileSingleEntry(t *testing.T) {
	dir := fixtureDir(t, "detect_procfile_single")
	r, err := Detect(dir)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	want := "python manage.py runserver 0.0.0.0:$PORT"
	if r.Run.Local.Start != want {
		t.Errorf("run.local.start = %q; want %q", r.Run.Local.Start, want)
	}
	if strings.Contains(r.Run.Local.Start, "& wait") {
		t.Errorf("run.local.start = %q; a single Procfile entry must not be join-annotated", r.Run.Local.Start)
	}

	mustLoadProposal(t, r)
}

// TestDetect_ReadyProbeFromSource: a "/healthz" handler registration plus a
// ListenAndServe port grepped from source propose run.ready.http.
func TestDetect_ReadyProbeFromSource(t *testing.T) {
	dir := fixtureDir(t, "detect_health")
	r, err := Detect(dir)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	if want := ":8080/healthz"; r.Run.Ready.HTTP != want {
		t.Errorf("run.ready.http = %q; want %q", r.Run.Ready.HTTP, want)
	}

	// This fixture has no derivable start command, so Detect proposes the
	// generated scaffold placeholder — Detect itself must still succeed (pb
	// init always writes a file), but the written proposal must fail pb
	// lint until a human replaces the placeholder.
	mustLoadProposalRejectsScaffold(t, r)
}

// TestDetect_ReadyProbeTODOWhenUnconfident: a dir with nothing to grep a
// probe from leaves run.ready unset, and MarshalProposal notes the gap with
// a TODO comment rather than pb init silently proposing nothing at all.
func TestDetect_ReadyProbeTODOWhenUnconfident(t *testing.T) {
	dir := fixtureDir(t, "detect_go_only")
	r, err := Detect(dir)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if r.Run.Ready != (Probe{}) {
		t.Fatalf("run.ready = %+v; want zero-value (this fixture has no grep-able probe)", r.Run.Ready)
	}

	data, err := MarshalProposal(r)
	if err != nil {
		t.Fatalf("MarshalProposal: %v", err)
	}
	if !strings.Contains(string(data), "TODO") || !strings.Contains(string(data), "ready:") {
		t.Errorf("proposal missing a TODO comment on an empty run.ready section:\n%s", data)
	}

	mustLoadProposal(t, r)
}

// TestDetect_ScriptsSeedAndDrive: scripts/seed*.sh and db:seed-style
// package.json scripts propose seed steps; other executable scripts/*.sh
// files propose drive verbs named after the script; non-executable scripts
// are not proposed as drive verbs.
func TestDetect_ScriptsSeedAndDrive(t *testing.T) {
	dir := fixtureDir(t, "detect_scripts")
	r, err := Detect(dir)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	if !hasSeedNamed(r, "seed") {
		t.Errorf("seed %v missing 'seed' (from scripts/seed.sh)", seedNames(r))
	}
	if !hasSeedNamed(r, "db:seed") {
		t.Errorf("seed %v missing 'db:seed' (from package.json scripts)", seedNames(r))
	}

	dv, ok := r.Drive["backup"]
	if !ok {
		t.Fatalf("drive %v missing 'backup' (from executable scripts/backup.sh)", driveNames(r))
	}
	if dv.Run != "bash scripts/backup.sh" {
		t.Errorf("drive[backup].run = %q; want %q", dv.Run, "bash scripts/backup.sh")
	}

	if _, ok := r.Drive["not-executable"]; ok {
		t.Error("drive proposes 'not-executable'; scripts/not-executable.sh is not executable and must be skipped")
	}
	if _, ok := r.Drive["seed"]; ok {
		t.Error("drive proposes 'seed'; scripts/seed.sh must be a seed step, not a drive verb")
	}

	// This fixture has no dev/start package.json script, so Detect proposes
	// the generated scaffold placeholder for run.local.start — Detect
	// itself must still succeed, but pb lint must reject it unedited.
	mustLoadProposalRejectsScaffold(t, r)
}

// TestDetect_K8sManifests: deploy/*.yml Service documents (multi-document
// YAML, including one unparsable document that must be ignored silently)
// add k8s-attach to run.modes, a sources.k8s + resources entry for the
// Service matching the repo name, a resources entry for every other Service
// found, and a TCP readiness probe against the matched service.
func TestDetect_K8sManifests(t *testing.T) {
	dir := fixtureDir(t, "detect_k8s")
	r, err := Detect(dir)
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}

	if !containsMode(r, "k8s-attach") {
		t.Errorf("modes %v missing 'k8s-attach'", r.Run.Modes)
	}
	if want := "svc/detect_k8s:8080"; r.Sources["k8s"] != want {
		t.Errorf("sources.k8s = %q; want %q", r.Sources["k8s"], want)
	}

	primary, ok := r.Resources["detect_k8s"]
	if !ok {
		t.Fatalf("resources missing the matched service %q", "detect_k8s")
	}
	if primary.Via["k8s"] != "svc/detect_k8s:8080" {
		t.Errorf("resources[detect_k8s].via.k8s = %q; want %q", primary.Via["k8s"], "svc/detect_k8s:8080")
	}
	other, ok := r.Resources["mongo"]
	if !ok {
		t.Fatalf("resources missing the other service %q", "mongo")
	}
	if other.Via["k8s"] != "svc/mongo:27017" {
		t.Errorf("resources[mongo].via.k8s = %q; want %q", other.Via["k8s"], "svc/mongo:27017")
	}

	wantTCP := "${resources.detect_k8s.host}:${resources.detect_k8s.port}"
	if r.Run.Ready.TCP != wantTCP {
		t.Errorf("run.ready.tcp = %q; want %q", r.Run.Ready.TCP, wantTCP)
	}
	if r.Run.Ready.Timeout == "" || r.Run.Ready.Interval == "" {
		t.Errorf("run.ready timeout/interval unset: %+v", r.Run.Ready)
	}

	mustLoadProposal(t, r)
}

// TestDetect_AllFixturesLoadClean proves every testdata/detect_* fixture that
// has a real derivable start command both validates in-process (Detect's own
// err return) and survives a MarshalProposal -> manifest.Load round trip —
// the concrete requirement that every proposal pb init could write for a
// detectable repo is a proposal pb lint accepts.
func TestDetect_AllFixturesLoadClean(t *testing.T) {
	names := []string{
		"detect_node_compose",
		"detect_go_only",
		"detect_procfile_only",
		"detect_procfile_single",
		"detect_k8s",
	}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			dir := fixtureDir(t, name)
			r, err := Detect(dir)
			if err != nil {
				t.Fatalf("Detect(%s): %v", name, err)
			}
			mustLoadProposal(t, r)
		})
	}
}

// TestDetect_UndetectableFixturesRejectScaffold proves every testdata/detect_*
// fixture with no derivable start command still lets Detect succeed (pb init
// always writes a file) while the written proposal fails pb lint until the
// scaffold placeholder is replaced — the fix for the "lint passes TODO
// scaffold" gap.
func TestDetect_UndetectableFixturesRejectScaffold(t *testing.T) {
	names := []string{
		"detect_empty",
		"detect_health",
		"detect_scripts",
	}
	for _, name := range names {
		t.Run(name, func(t *testing.T) {
			dir := fixtureDir(t, name)
			r, err := Detect(dir)
			if err != nil {
				t.Fatalf("Detect(%s): %v", name, err)
			}
			mustLoadProposalRejectsScaffold(t, r)
		})
	}
}

func seedNames(r *Ready) []string {
	names := make([]string, len(r.Seed))
	for i, s := range r.Seed {
		names[i] = s.Name
	}
	return names
}

func driveNames(r *Ready) []string {
	names := make([]string, 0, len(r.Drive))
	for name := range r.Drive {
		names = append(names, name)
	}
	return names
}
