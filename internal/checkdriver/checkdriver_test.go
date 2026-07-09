package checkdriver

import (
	"os"
	"strings"
	"testing"

	"github.com/launchwings/proofbench/internal/evidence"
	"github.com/launchwings/proofbench/internal/manifest"
)

// fakeCapture records Exec calls and File claims, standing in for *Bundle.
type fakeCapture struct {
	dir     string
	execs   []string // command strings passed to Exec
	files   []string // "typ:name" per File claim
	exit    int
	execErr error
}

func (f *fakeCapture) Exec(_ string, argv []string, _ bool) (int, error) {
	f.execs = append(f.execs, strings.Join(argv, " "))
	return f.exit, f.execErr
}

func (f *fakeCapture) File(typ, name, _ string, _ map[string]any) error {
	f.files = append(f.files, typ+":"+name)
	return nil
}

func (f *fakeCapture) BundleDir() string { return f.dir }

func TestNewKinds(t *testing.T) {
	for _, kind := range []string{"", KindExec, KindPlaywright} {
		if _, err := New(kind, "."); err != nil {
			t.Errorf("New(%q) errored: %v", kind, err)
		}
	}
	if _, err := New("bogus", "."); err == nil {
		t.Error("New(bogus) should error")
	}
	// *Bundle must satisfy Capture (compile-time via the interface use here).
	var _ evidence.Capture = (*evidence.Bundle)(nil)
}

func TestSubstituteEndpoints(t *testing.T) {
	ep := map[string]string{"appservice": "127.0.0.1:18080", "mongo": "127.0.0.1:27099"}
	tests := []struct{ in, want string }{
		{"curl ${endpoints.appservice}/health", "curl 127.0.0.1:18080/health"},
		{"mongosh --host ${resources.mongo.host} --port ${resources.mongo.port}", "mongosh --host 127.0.0.1 --port 27099"},
		{"no placeholders", "no placeholders"},
		{"unknown ${resources.nope.host}", "unknown ${resources.nope.host}"}, // left verbatim
	}
	for _, tt := range tests {
		if got := SubstituteEndpoints(tt.in, ep); got != tt.want {
			t.Errorf("SubstituteEndpoints(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
	if got := SubstituteEndpoints("x", nil); got != "x" {
		t.Errorf("nil endpoints changed the string: %q", got)
	}
}

func TestUnresolvedEndpoints(t *testing.T) {
	tests := []struct {
		in   string
		want []string
	}{
		// resolved / no endpoint placeholders
		{"curl 127.0.0.1:18080/health", nil},
		{"no placeholders", nil},
		// ordinary shell vars must NOT be flagged as unresolved endpoints
		{"lyric-mongo.sh --db lyric --eval $PB_SCENARIO_A", nil},
		{"fire ${PB_RUN_ACTIONS:+--selected \"$PB_RUN_ACTIONS\"}", nil},
		// real unresolved endpoint placeholders
		{"curl http://${resources.appservice.host}:${resources.appservice.port}/x",
			[]string{"${resources.appservice.host}", "${resources.appservice.port}"}},
		{"dial ${endpoints.mongo}", []string{"${endpoints.mongo}"}},
	}
	for _, tt := range tests {
		got := UnresolvedEndpoints(tt.in)
		if len(got) != len(tt.want) {
			t.Errorf("UnresolvedEndpoints(%q) = %v, want %v", tt.in, got, tt.want)
			continue
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Errorf("UnresolvedEndpoints(%q)[%d] = %q, want %q", tt.in, i, got[i], tt.want[i])
			}
		}
	}
}

func TestExecDriverSubstitutesAndRuns(t *testing.T) {
	d, err := New(KindExec, ".")
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Preflight(); err != nil {
		t.Fatalf("exec Preflight: %v", err)
	}
	capture := &fakeCapture{}
	spec := manifest.CheckSpec{Name: "up", Exercise: "curl ${endpoints.appservice}/health"}
	env := Env{Endpoints: map[string]string{"appservice": "127.0.0.1:18080"}}
	if _, err := d.Exercise(spec, env, capture); err != nil {
		t.Fatal(err)
	}
	if len(capture.execs) != 1 || capture.execs[0] != "curl 127.0.0.1:18080/health" {
		t.Errorf("exec driver ran %v, want substituted localhost command", capture.execs)
	}
}

func TestPlaywrightPreflight(t *testing.T) {
	d, err := New(KindPlaywright, ".")
	if err != nil {
		t.Fatal(err)
	}
	err = d.Preflight()
	// npx may or may not be present; assert the not-run reason shape when absent.
	if err != nil && !strings.Contains(err.Error(), "npx") {
		t.Errorf("playwright Preflight error %q should name npx", err)
	}
}

func TestEnvExports(t *testing.T) {
	env := Env{
		Endpoints: map[string]string{"appservice": "127.0.0.1:18080"},
		Vars:      map[string]string{"PB_TOKEN": "secret"},
		Session:   "/tmp/state.json",
	}
	got := envExports(env)
	for _, want := range []string{"export PB_ENDPOINT_APPSERVICE=", "export PB_TOKEN=", "export PB_SESSION="} {
		if !strings.Contains(got, want) {
			t.Errorf("envExports missing %q in %q", want, got)
		}
	}
}

func TestSanitize(t *testing.T) {
	if got := sanitize("app-service.v1/x"); got != "app_service_v1_x" {
		t.Errorf("sanitize = %q", got)
	}
	_ = os.Environ
}
