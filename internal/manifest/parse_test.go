package manifest

import (
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// testdata returns the absolute path to a testdata fixture.
func testdataPath(name string) string {
	return filepath.Join("testdata", name)
}

// TestLoad_Valid ensures the golden valid fixture loads without error and
// fields are decoded correctly.
func TestLoad_Valid(t *testing.T) {
	r, err := Load(testdataPath("valid.yaml"))
	if err != nil {
		t.Fatalf("Load(valid.yaml) unexpected error: %v", err)
	}
	if r.Service != "orders-api" {
		t.Errorf("Service = %q, want %q", r.Service, "orders-api")
	}
	if len(r.Run.Modes) != 2 {
		t.Errorf("len(Run.Modes) = %d, want 2", len(r.Run.Modes))
	}
	if r.Run.Local.Start != "npm run dev" {
		t.Errorf("Run.Local.Start = %q, want %q", r.Run.Local.Start, "npm run dev")
	}
	if r.Run.Ready.HTTP != ":8080/healthz" {
		t.Errorf("Run.Ready.HTTP = %q, want %q", r.Run.Ready.HTTP, ":8080/healthz")
	}
	if len(r.Seed) != 2 {
		t.Errorf("len(Seed) = %d, want 2", len(r.Seed))
	}
	if _, ok := r.Drive["create-order"]; !ok {
		t.Error("Drive[\"create-order\"] not found")
	}
	if len(r.Checks) != 2 {
		t.Errorf("len(Checks) = %d, want 2", len(r.Checks))
	}
}

// TestLoad_InvalidFixtures is a table-driven test over every invalid fixture.
// Each case must return a non-nil error whose message contains the expected
// substring.
func TestLoad_InvalidFixtures(t *testing.T) {
	cases := []struct {
		file    string
		wantErr string // substring expected in the error message
	}{
		{
			file:    "invalid_unknown_field.yaml",
			wantErr: "unknown_top_level_field",
		},
		{
			file:    "invalid_bad_mode.yaml",
			wantErr: "docker-swarm",
		},
		{
			file:    "invalid_dangling_seed_ref.yaml",
			wantErr: "nonexistent-dep",
		},
		{
			file:    "invalid_duplicate_check.yaml",
			wantErr: "health-check",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.file, func(t *testing.T) {
			_, err := Load(testdataPath(tc.file))
			if err == nil {
				t.Fatalf("Load(%q) expected error, got nil", tc.file)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("Load(%q) error = %q, want substring %q", tc.file, err.Error(), tc.wantErr)
			}
		})
	}
}

// TestValidate_Modes covers mode-specific validation paths.
func TestValidate_Modes(t *testing.T) {
	cases := []struct {
		name    string
		modes   []string
		local   LocalRun
		wantErr string
	}{
		{
			name:    "empty modes",
			modes:   []string{},
			wantErr: "run.modes",
		},
		{
			name:    "unknown mode",
			modes:   []string{"local", "heroku"},
			local:   LocalRun{Start: "./start.sh"},
			wantErr: "heroku",
		},
		{
			name:    "local without start",
			modes:   []string{"local"},
			local:   LocalRun{},
			wantErr: "run.local.start",
		},
		{
			name:    "local start still detect's scaffold placeholder",
			modes:   []string{"local"},
			local:   LocalRun{Start: scaffoldStartCmd},
			wantErr: "generated scaffolding",
		},
		{
			name:    "start mentioning TODO elsewhere is not the scaffold and is valid",
			modes:   []string{"local"},
			local:   LocalRun{Start: "echo TODO items were migrated; ./run.sh"},
			wantErr: "",
		},
		{
			name:  "compose mode no start required",
			modes: []string{"compose"},
			// no local.start — valid because local mode not listed
			wantErr: "",
		},
		{
			name:    "all valid modes",
			modes:   []string{"local", "compose", "k8s-attach", "remote"},
			local:   LocalRun{Start: "./run.sh"},
			wantErr: "",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			r := &Ready{
				Service: "svc",
				Run:     RunSpec{Modes: tc.modes, Local: tc.local},
			}
			err := validateModes(r)
			if tc.wantErr == "" {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
			} else {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Errorf("error = %q, want substring %q", err.Error(), tc.wantErr)
				}
			}
		})
	}
}

// TestValidate_Probe covers probe-specific validation paths.
func TestValidate_Probe(t *testing.T) {
	cases := []struct {
		name    string
		probe   Probe
		wantErr string
	}{
		{
			name:    "two probe types set",
			probe:   Probe{HTTP: ":8080/health", TCP: ":5432"},
			wantErr: "at most one",
		},
		{
			name:    "three probe types set",
			probe:   Probe{HTTP: ":8080/health", TCP: ":5432", Exec: "pg_isready"},
			wantErr: "at most one",
		},
		{
			name:    "bad timeout",
			probe:   Probe{HTTP: ":8080/health", Timeout: "not-a-duration"},
			wantErr: "timeout",
		},
		{
			name:    "bad interval",
			probe:   Probe{HTTP: ":8080/health", Interval: "5"},
			wantErr: "interval",
		},
		{
			name:  "valid http probe",
			probe: Probe{HTTP: ":8080/health", Timeout: "30s", Interval: "5s"},
		},
		{
			name:  "valid tcp probe no timeout",
			probe: Probe{TCP: ":5432"},
		},
		{
			name:  "valid exec probe",
			probe: Probe{Exec: "pg_isready"},
		},
		{
			name:  "no probe set is valid",
			probe: Probe{},
		},
		{
			name:    "statically invalid http probe URL",
			probe:   Probe{HTTP: "not a url"},
			wantErr: "not a valid URL",
		},
		{
			name:  "http probe shorthand normalizes and parses cleanly",
			probe: Probe{HTTP: ":8391/healthz"},
		},
		{
			name:  "http probe with explicit host:port parses cleanly",
			probe: Probe{HTTP: "localhost:8391/healthz"},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			err := validateProbe(tc.probe)
			if tc.wantErr == "" {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
			} else {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Errorf("error = %q, want substring %q", err.Error(), tc.wantErr)
				}
			}
		})
	}
}

// TestValidate_ProbeBadHTTPURLIncludesParseError ensures a statically
// invalid run.ready.http value is rejected with the underlying url.Parse
// error wrapped in, not just a generic message — so `pb ready` never spends
// its readiness window retrying a URL that could never have parsed.
func TestValidate_ProbeBadHTTPURLIncludesParseError(t *testing.T) {
	raw := "not a url"
	_, parseErr := url.Parse(httpProbeURL(raw))
	if parseErr == nil {
		t.Fatalf("setup: url.Parse(%q) unexpectedly succeeded", httpProbeURL(raw))
	}

	err := validateProbe(Probe{HTTP: raw})
	if err == nil {
		t.Fatal("expected error for statically invalid probe URL, got nil")
	}
	if !strings.Contains(err.Error(), parseErr.Error()) {
		t.Errorf("error = %q, want it to include the url.Parse error %q", err.Error(), parseErr.Error())
	}
}

// TestValidate_Seed covers seed step validation paths.
func TestValidate_Seed(t *testing.T) {
	cases := []struct {
		name      string
		seed      []SeedStep
		resources map[string]Resource
		wantErr   string
	}{
		{
			name: "duplicate seed names",
			seed: []SeedStep{
				{Name: "schema", Run: "./migrate.sh"},
				{Name: "schema", Run: "./migrate2.sh"},
			},
			wantErr: "schema",
		},
		{
			name: "dangling after ref to unknown name",
			seed: []SeedStep{
				{Name: "fixtures", Run: "./seed.sh", After: []string{"ghost"}},
			},
			wantErr: "ghost",
		},
		{
			name: "after resolves to resource name",
			seed: []SeedStep{
				{Name: "schema", Run: "./migrate.sh", After: []string{"db"}},
			},
			resources: map[string]Resource{"db": {Type: "postgres"}},
		},
		{
			name: "after resolves to prior seed step",
			seed: []SeedStep{
				{Name: "schema", Run: "./migrate.sh"},
				{Name: "fixtures", Run: "./seed.sh", After: []string{"schema"}},
			},
		},
		{
			name: "cycle among seed steps",
			seed: []SeedStep{
				{Name: "a", Run: "./a.sh", After: []string{"b"}},
				{Name: "b", Run: "./b.sh", After: []string{"a"}},
			},
			wantErr: "cycle",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			r := &Ready{
				Service:   "svc",
				Seed:      tc.seed,
				Resources: tc.resources,
				Run:       RunSpec{Modes: []string{"compose"}},
			}
			err := validateSeed(r)
			if tc.wantErr == "" {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
			} else {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Errorf("error = %q, want substring %q", err.Error(), tc.wantErr)
				}
			}
		})
	}
}

// TestValidate_Checks covers check-level validation paths.
func TestValidate_Checks(t *testing.T) {
	cases := []struct {
		name    string
		checks  []CheckSpec
		drive   map[string]DriveVerb
		wantErr string
	}{
		{
			name: "duplicate check names",
			checks: []CheckSpec{
				{Name: "ping", Level: "L3", Exercise: "curl :8080"},
				{Name: "ping", Level: "L4", Exercise: "curl :8080/v2"},
			},
			wantErr: "ping",
		},
		{
			name: "invalid level",
			checks: []CheckSpec{
				{Name: "ping", Level: "L6", Exercise: "curl :8080"},
			},
			wantErr: "L6",
		},
		{
			name: "empty exercise",
			checks: []CheckSpec{
				{Name: "ping", Level: "L3", Exercise: ""},
			},
			wantErr: "exercise",
		},
		{
			name: "drive verb not defined",
			checks: []CheckSpec{
				{Name: "fire", Level: "L4", Exercise: "drive.missing-verb"},
			},
			drive:   map[string]DriveVerb{},
			wantErr: "missing-verb",
		},
		{
			name: "drive verb resolves",
			checks: []CheckSpec{
				{Name: "fire", Level: "L4", Exercise: "drive.create-order"},
			},
			drive: map[string]DriveVerb{
				"create-order": {Run: "./create-order.sh"},
			},
		},
		{
			name: "non-drive exercise always valid",
			checks: []CheckSpec{
				{Name: "e2e", Level: "L5", Exercise: "playwright tests/e2e/order.spec.ts"},
			},
		},
		{
			name: "unknown driver rejected",
			checks: []CheckSpec{
				{Name: "e2e", Level: "L5", Exercise: "tests/e2e/order.spec.ts", Driver: "bogus"},
			},
			wantErr: "bogus",
		},
		{
			name: "playwright driver valid",
			checks: []CheckSpec{
				{Name: "e2e", Level: "L5", Exercise: "tests/e2e/order.spec.ts", Driver: "playwright"},
			},
		},
		{
			name: "explicit exec driver valid",
			checks: []CheckSpec{
				{Name: "ping", Level: "L3", Exercise: "curl :8080", Driver: "exec"},
			},
		},
		{
			name: "requires valid env names",
			checks: []CheckSpec{
				{Name: "ping", Level: "L3", Exercise: "curl :8080", Requires: []string{"PB_EXECUTION_ID", "PB_EXPECTED_ACTION"}},
			},
		},
		{
			name: "requires rejects a non-env-shaped name",
			checks: []CheckSpec{
				{Name: "ping", Level: "L3", Exercise: "curl :8080", Requires: []string{"pb-execution-id"}},
			},
			wantErr: "pb-execution-id",
		},
		{
			name: "check exercise still detect's scaffold placeholder",
			checks: []CheckSpec{
				{Name: "ping", Level: "L3", Exercise: scaffoldStartCmd},
			},
			wantErr: "generated scaffolding",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			r := &Ready{
				Service: "svc",
				Checks:  tc.checks,
				Drive:   tc.drive,
				Run:     RunSpec{Modes: []string{"compose"}},
			}
			err := validateChecks(r)
			if tc.wantErr == "" {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
			} else {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Errorf("error = %q, want substring %q", err.Error(), tc.wantErr)
				}
			}
		})
	}
}

// TestValidate_Drive covers drive-verb validation paths.
func TestValidate_Drive(t *testing.T) {
	cases := []struct {
		name    string
		drive   map[string]DriveVerb
		wantErr string
	}{
		{
			name: "drive verb still detect's scaffold placeholder",
			drive: map[string]DriveVerb{
				"create-order": {Run: scaffoldStartCmd},
			},
			wantErr: "generated scaffolding",
		},
		{
			name: "drive verb with a real command is valid",
			drive: map[string]DriveVerb{
				"create-order": {Run: "./scripts/create-order.sh"},
			},
		},
		{
			name:  "no drive verbs is valid",
			drive: nil,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			r := &Ready{
				Service: "svc",
				Drive:   tc.drive,
				Run:     RunSpec{Modes: []string{"compose"}},
			}
			err := validateDrive(r)
			if tc.wantErr == "" {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
			} else {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Errorf("error = %q, want substring %q", err.Error(), tc.wantErr)
				}
			}
		})
	}
}

// TestLoadWorkspace covers workspace.yaml loading.
func TestLoadWorkspace(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "workspace.yaml")

	content := `services:
  orders-api: ./orders
  auth-svc: ./auth
contexts:
  staging: staging-ctx
  prod: prod-ctx
`
	if err := writeFile(path, content); err != nil {
		t.Fatalf("setup: %v", err)
	}

	w, err := LoadWorkspace(path)
	if err != nil {
		t.Fatalf("LoadWorkspace unexpected error: %v", err)
	}
	if len(w.Services) != 2 {
		t.Errorf("len(Services) = %d, want 2", len(w.Services))
	}
	if w.Services["orders-api"] != "./orders" {
		t.Errorf("Services[orders-api] = %q, want %q", w.Services["orders-api"], "./orders")
	}
	if len(w.Contexts) != 2 {
		t.Errorf("len(Contexts) = %d, want 2", len(w.Contexts))
	}
}

// TestLoadWorkspace_UnknownField ensures strict decoding rejects unknown fields.
func TestLoadWorkspace_UnknownField(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "workspace.yaml")

	content := `services:
  svc: ./svc
bogus_field: should-fail
`
	if err := writeFile(path, content); err != nil {
		t.Fatalf("setup: %v", err)
	}

	_, err := LoadWorkspace(path)
	if err == nil {
		t.Fatal("expected error for unknown field, got nil")
	}
	if !strings.Contains(err.Error(), "bogus_field") {
		t.Errorf("error = %q, want substring %q", err.Error(), "bogus_field")
	}
}

// TestLoad_FileNotFound ensures a missing file produces a clear error.
func TestLoad_FileNotFound(t *testing.T) {
	_, err := Load("/does/not/exist/ready.yaml")
	if err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
	if !strings.Contains(err.Error(), "cannot read") {
		t.Errorf("error = %q, want substring %q", err.Error(), "cannot read")
	}
}

// TestLoad_ServiceRequired ensures an empty service name is rejected.
func TestLoad_ServiceRequired(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ready.yaml")
	content := `service: ""
run:
  modes: [local]
  local:
    start: ./run.sh
`
	if err := writeFile(path, content); err != nil {
		t.Fatalf("setup: %v", err)
	}
	_, err := Load(path)
	if err == nil {
		t.Fatal("expected error for empty service, got nil")
	}
	if !strings.Contains(err.Error(), "service") {
		t.Errorf("error = %q, want substring %q", err.Error(), "service")
	}
}

// TestLoad_AllRepoFixturesAndExamplesValid walks every ready.yaml checked
// into examples/ and fixtures/ (real repos' declared manifests, not the raw
// source trees under testdata/detect_*) and asserts each still passes
// Validate — the scaffold/probe checks above must never regress a real,
// hand-written manifest.
func TestLoad_AllRepoFixturesAndExamplesValid(t *testing.T) {
	var paths []string
	for _, root := range []string{"../../examples", "../../fixtures"} {
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			name := d.Name()
			if name == "ready.yaml" || strings.HasSuffix(name, ".ready.yaml") {
				paths = append(paths, path)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", root, err)
		}
	}
	if len(paths) == 0 {
		t.Fatal("no ready.yaml manifests found under examples/ or fixtures/")
	}
	sort.Strings(paths)

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			if _, err := Load(path); err != nil {
				t.Errorf("Load(%s) unexpected error: %v", path, err)
			}
		})
	}
}

// writeFile is a small helper that writes content to path, used only in tests.
func writeFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o644)
}
