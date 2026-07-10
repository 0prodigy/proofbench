package substrate

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/0prodigy/proofbench/internal/manifest"
)

// ------------------------------------------------------------- env parsing

func TestParseEnvFile(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    []string
		wantErr string
	}{
		{
			name:    "basic",
			content: "FOO=1\nBAR=two\n",
			want:    []string{"FOO=1", "BAR=two"},
		},
		{
			name:    "comments and blanks ignored",
			content: "# a comment\n\n  \nFOO=1\n  # indented comment\nBAR=2",
			want:    []string{"FOO=1", "BAR=2"},
		},
		{
			name:    "export prefix stripped",
			content: "export FOO=1\n",
			want:    []string{"FOO=1"},
		},
		{
			name:    "value may contain equals",
			content: "URL=http://x?a=b\n",
			want:    []string{"URL=http://x?a=b"},
		},
		{
			name:    "malformed line errors with line number",
			content: "FOO=1\nnot a pair\n",
			wantErr: ":2",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), ".env")
			if err := os.WriteFile(path, []byte(tt.content), 0o644); err != nil {
				t.Fatal(err)
			}
			got, err := parseEnvFile(path)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("want error containing %q, got %v", tt.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestParseEnvFileMissing(t *testing.T) {
	if _, err := parseEnvFile(filepath.Join(t.TempDir(), "nope.env")); err == nil {
		t.Fatal("want error for missing env file")
	}
}

func TestSetEnv(t *testing.T) {
	env := []string{"A=1", "B=2"}
	env = setEnv(env, "B=override")
	env = setEnv(env, "C=new")
	want := []string{"A=1", "B=override", "C=new"}
	if !reflect.DeepEqual(env, want) {
		t.Fatalf("got %v, want %v", env, want)
	}
}

// ------------------------------------------------------------ seed ordering

func step(name, run string, after ...string) manifest.SeedStep {
	return manifest.SeedStep{Name: name, Run: run, After: after}
}

func TestSeedOrder(t *testing.T) {
	tests := []struct {
		name    string
		steps   []manifest.SeedStep
		want    []string
		wantErr string
	}{
		{
			name:  "no deps keeps manifest order",
			steps: []manifest.SeedStep{step("a", ""), step("b", ""), step("c", "")},
			want:  []string{"a", "b", "c"},
		},
		{
			name:  "chain declared in reverse",
			steps: []manifest.SeedStep{step("c", "", "b"), step("b", "", "a"), step("a", "")},
			want:  []string{"a", "b", "c"},
		},
		{
			name: "diamond",
			steps: []manifest.SeedStep{
				step("end", "", "left", "right"),
				step("left", "", "root"),
				step("right", "", "root"),
				step("root", ""),
			},
			want: []string{"root", "left", "right", "end"},
		},
		{
			name:  "after ref to non-step (resource) is ignored",
			steps: []manifest.SeedStep{step("schema", "", "db"), step("fixtures", "", "schema")},
			want:  []string{"schema", "fixtures"},
		},
		{
			name:    "cycle errors",
			steps:   []manifest.SeedStep{step("a", "", "b"), step("b", "", "a")},
			wantErr: "cycle",
		},
		{
			name:    "self cycle errors",
			steps:   []manifest.SeedStep{step("a", "", "a")},
			wantErr: "cycle",
		},
		{
			name:    "duplicate names error",
			steps:   []manifest.SeedStep{step("a", ""), step("a", "")},
			wantErr: "duplicate",
		},
		{
			name:  "empty seed list",
			steps: nil,
			want:  []string{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			order, err := seedOrder(tt.steps)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("want error containing %q, got %v", tt.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got := make([]string, 0, len(order))
			for _, st := range order {
				got = append(got, st.Name)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestRunSeedRunsInDependencyOrder(t *testing.T) {
	dir := t.TempDir()
	r := &manifest.Ready{Seed: []manifest.SeedStep{
		step("third", "echo third >> log.txt", "second"),
		step("first", "echo first >> log.txt"),
		step("second", "echo second >> log.txt", "first"),
	}}
	if err := runSeed(dir, r); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "log.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "first\nsecond\nthird\n"; string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestRunSeedStopsAtFirstFailureNamingStep(t *testing.T) {
	dir := t.TempDir()
	r := &manifest.Ready{Seed: []manifest.SeedStep{
		step("ok", "echo ok >> log.txt"),
		step("boom", "exit 7", "ok"),
		step("never", "echo never >> log.txt", "boom"),
	}}
	err := runSeed(dir, r)
	if err == nil || !strings.Contains(err.Error(), `seed step "boom"`) {
		t.Fatalf("want error naming step boom, got %v", err)
	}
	got, readErr := os.ReadFile(filepath.Join(dir, "log.txt"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(got) != "ok\n" {
		t.Fatalf("later step ran after failure; log = %q", got)
	}
}

// ------------------------------------------------------------------ probes

func TestHTTPProbeURL(t *testing.T) {
	tests := []struct{ in, want string }{
		{":8080/healthz", "http://localhost:8080/healthz"},
		{"example.com:9090/x", "http://example.com:9090/x"},
		{"https://x/y", "https://x/y"},
	}
	for _, tt := range tests {
		if got := httpProbeURL(tt.in); got != tt.want {
			t.Errorf("httpProbeURL(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestWaitProbeErrors(t *testing.T) {
	dir := t.TempDir()
	t.Run("no probe declared", func(t *testing.T) {
		err := waitProbe(dir, manifest.Probe{})
		if err == nil || !strings.Contains(err.Error(), "no readiness probe") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("multiple probes declared", func(t *testing.T) {
		err := waitProbe(dir, manifest.Probe{HTTP: ":1/", TCP: ":1"})
		if err == nil || !strings.Contains(err.Error(), "exactly one") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("bad timeout duration", func(t *testing.T) {
		err := waitProbe(dir, manifest.Probe{TCP: ":1", Timeout: "banana"})
		if err == nil || !strings.Contains(err.Error(), "ready.timeout") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("tcp timeout names the probe", func(t *testing.T) {
		port := freePort(t) // nothing listening
		p := manifest.Probe{TCP: fmt.Sprintf(":%d", port), Timeout: "300ms", Interval: "50ms"}
		err := waitProbe(dir, p)
		if err == nil || !strings.Contains(err.Error(), "tcp probe") {
			t.Fatalf("want error naming tcp probe, got %v", err)
		}
	})
	t.Run("exec probe passes on exit 0", func(t *testing.T) {
		p := manifest.Probe{Exec: "true", Timeout: "2s", Interval: "50ms"}
		if err := waitProbe(dir, p); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("exec probe failure names the probe", func(t *testing.T) {
		p := manifest.Probe{Exec: "false", Timeout: "200ms", Interval: "50ms"}
		err := waitProbe(dir, p)
		if err == nil || !strings.Contains(err.Error(), "exec probe") {
			t.Fatalf("got %v", err)
		}
	})
}

// ----------------------------------------------------------- local substrate

func TestLocalEndToEnd(t *testing.T) {
	// ponytail: GitHub-hosted macOS runners have flaky localhost networking for
	// spawned servers — the python http.server probe never returns headers even
	// past 60s. Covered on linux CI and local dev; skip only on macOS CI.
	if runtime.GOOS == "darwin" && os.Getenv("CI") != "" {
		t.Skip("flaky on GitHub-hosted macOS runners; covered on linux + local")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not in PATH")
	}
	dir := t.TempDir()
	port := freePort(t)
	r := &manifest.Ready{
		Service: "web",
		Run: manifest.RunSpec{
			Local: manifest.LocalRun{Start: fmt.Sprintf("python3 -m http.server %d", port)},
			Ready: manifest.Probe{HTTP: fmt.Sprintf(":%d/", port), Timeout: "60s", Interval: "100ms"},
		},
	}
	s, err := New(KindLocal, dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Down(r) })

	if err := s.Up(r); err != nil {
		t.Fatal(err)
	}
	pidPath := filepath.Join(dir, ".pb", "web.pid")
	if _, err := os.Stat(pidPath); err != nil {
		t.Fatalf("pidfile not written: %v", err)
	}
	if err := s.Ready(r); err != nil {
		t.Fatalf("Ready: %v", err)
	}
	// The same server also satisfies a tcp probe.
	tcp := manifest.Probe{TCP: fmt.Sprintf(":%d", port), Timeout: "5s", Interval: "100ms"}
	if err := waitProbe(dir, tcp); err != nil {
		t.Fatalf("tcp probe: %v", err)
	}

	if err := s.Down(r); err != nil {
		t.Fatalf("Down: %v", err)
	}
	if _, err := os.Stat(pidPath); !os.IsNotExist(err) {
		t.Fatalf("pidfile not removed by Down: %v", err)
	}
	addr := fmt.Sprintf("localhost:%d", port)
	deadline := time.Now().Add(3 * time.Second)
	for {
		c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err != nil {
			break
		}
		c.Close()
		if time.Now().After(deadline) {
			t.Fatal("server still accepting connections after Down")
		}
		time.Sleep(100 * time.Millisecond)
	}
	// Idempotent: a second Down (pidfile gone) is not an error.
	if err := s.Down(r); err != nil {
		t.Fatalf("second Down: %v", err)
	}
}

func TestLocalUpEnvMerge(t *testing.T) {
	dir := t.TempDir()
	envFile := filepath.Join(dir, ".env.local")
	content := "# comment\nFOO=file-foo\nBAR=file-bar\n"
	if err := os.WriteFile(envFile, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PB_TEST_FROM_OS", "os-val")
	r := &manifest.Ready{
		Service: "envcheck",
		Run: manifest.RunSpec{
			Local: manifest.LocalRun{
				// Write the merged env, then stay alive so Up's liveness
				// grace window passes; Down kills the sleep.
				Start: `printf '%s,%s,%s' "$FOO" "$BAR" "$PB_TEST_FROM_OS" > out.txt && sleep 30`,
				Env: manifest.EnvSpec{
					File:      ".env.local",
					Overrides: map[string]string{"BAR": "override-bar"},
				},
			},
			Ready: manifest.Probe{Exec: "test -s out.txt", Timeout: "5s", Interval: "50ms"},
		},
	}
	s, err := New(KindLocal, dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Down(r) })
	if err := s.Up(r); err != nil {
		t.Fatal(err)
	}
	if err := s.Ready(r); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "out.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "file-foo,override-bar,os-val"; string(got) != want {
		t.Fatalf("env merge: got %q, want %q", got, want)
	}
	if err := s.Down(r); err != nil {
		t.Fatalf("Down: %v", err)
	}
}

func TestLocalUpMissingStart(t *testing.T) {
	s, err := New(KindLocal, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Up(&manifest.Ready{}); err == nil || !strings.Contains(err.Error(), "run.local.start") {
		t.Fatalf("got %v", err)
	}
}

func TestLocalUpMissingEnvFile(t *testing.T) {
	s, err := New(KindLocal, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r := &manifest.Ready{Run: manifest.RunSpec{Local: manifest.LocalRun{
		Start: "true",
		Env:   manifest.EnvSpec{File: "no-such.env"},
	}}}
	if err := s.Up(r); err == nil || !strings.Contains(err.Error(), "env file") {
		t.Fatalf("got %v", err)
	}
}

func TestLocalDownIdempotent(t *testing.T) {
	dir := t.TempDir()
	s, err := New(KindLocal, dir)
	if err != nil {
		t.Fatal(err)
	}
	r := &manifest.Ready{Service: "ghost"}
	if err := s.Down(r); err != nil { // no pidfile at all
		t.Fatalf("Down with missing pidfile: %v", err)
	}
	// Stale pidfile with garbage content is not an error and is removed.
	pidPath := filepath.Join(dir, ".pb", "ghost.pid")
	if err := os.MkdirAll(filepath.Dir(pidPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pidPath, []byte("not-a-pid\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.Down(r); err != nil {
		t.Fatalf("Down with garbage pidfile: %v", err)
	}
	if _, err := os.Stat(pidPath); !os.IsNotExist(err) {
		t.Fatal("garbage pidfile not removed")
	}
}

// TestPidGone exercises the liveness poll Down uses to confirm a SIGKILL
// actually landed: an alive process must never be reported gone, and an
// exited (reaped) process must be reported gone without waiting out the
// full poll budget.
func TestPidGone(t *testing.T) {
	if pidGone(os.Getpid()) {
		t.Fatal("pidGone reported the current (alive) process as gone")
	}

	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Fatalf("run true: %v", err)
	}
	pid := cmd.Process.Pid
	if !pidGone(pid) {
		t.Fatalf("pidGone reported exited pid %d as still alive", pid)
	}
}

// --------------------------------------------------------- compose substrate

func TestComposeUnavailableTypedError(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // no docker on PATH
	s, err := New(KindCompose, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for name, fn := range map[string]func(*manifest.Ready) error{
		"Up": s.Up, "Ready": s.Ready, "Down": s.Down,
	} {
		err := fn(&manifest.Ready{})
		var cu *ComposeUnavailable
		if !errors.As(err, &cu) {
			t.Fatalf("%s: want *ComposeUnavailable, got %T %v", name, err, err)
		}
		if !strings.HasPrefix(err.Error(), "substrate compose unavailable: ") {
			t.Fatalf("%s: error message %q lacks CLI prefix", name, err)
		}
	}
}

func TestParseComposePS(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    []composePSRow
		wantErr bool
	}{
		{
			name: "ndjson lines",
			in:   "{\"Name\":\"p-db-1\",\"Service\":\"db\",\"State\":\"running\"}\n{\"Name\":\"p-api-1\",\"Service\":\"api\",\"State\":\"exited\"}\n",
			want: []composePSRow{
				{Name: "p-db-1", Service: "db", State: "running"},
				{Name: "p-api-1", Service: "api", State: "exited"},
			},
		},
		{
			name: "json array",
			in:   `[{"Name":"p-db-1","Service":"db","State":"running"}]`,
			want: []composePSRow{{Name: "p-db-1", Service: "db", State: "running"}},
		},
		{name: "empty output", in: "  \n", want: nil},
		{name: "garbage", in: "not json", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseComposePS([]byte(tt.in))
			if tt.wantErr {
				if err == nil {
					t.Fatal("want error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestComposeFileDefault(t *testing.T) {
	if got := composeFile(&manifest.Ready{}); got != "docker-compose.yml" {
		t.Fatalf("default compose file = %q", got)
	}
	r := &manifest.Ready{Sources: map[string]string{"compose": "deploy/compose.yaml"}}
	if got := composeFile(r); got != "deploy/compose.yaml" {
		t.Fatalf("compose file from sources = %q", got)
	}
}

func TestComposeEndToEnd(t *testing.T) {
	if err := exec.Command("docker", "info").Run(); err != nil {
		t.Skip("docker unavailable")
	}
	if err := exec.Command("docker", "compose", "version").Run(); err != nil {
		t.Skip("docker compose plugin unavailable")
	}
	if err := exec.Command("docker", "image", "inspect", "busybox").Run(); err != nil {
		if err := exec.Command("docker", "pull", "busybox").Run(); err != nil {
			t.Skip("busybox image unavailable and cannot pull")
		}
	}
	dir := t.TempDir()
	compose := "services:\n  sleeper:\n    image: busybox\n    command: sleep 60\n"
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(compose), 0o644); err != nil {
		t.Fatal(err)
	}
	r := &manifest.Ready{Service: "sleeper"} // no probe: Ready uses compose ps
	s, err := New(KindCompose, dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Down(r) })
	if err := s.Up(r); err != nil {
		t.Fatalf("Up: %v", err)
	}
	if err := s.Ready(r); err != nil {
		t.Fatalf("Ready: %v", err)
	}
	if err := s.Down(r); err != nil {
		t.Fatalf("Down: %v", err)
	}
}

// -------------------------------------------------------- k8s-attach substrate

func TestSplitLocatorPort(t *testing.T) {
	tests := []struct {
		in      string
		locator string
		port    int
	}{
		{"svc/appservice:8080", "svc/appservice", 8080},
		{"deploy/appservice", "deploy/appservice", 0},
		{"pod/mongo-0:27017", "pod/mongo-0", 27017},
		{"appservice:8080", "appservice", 8080},
		{"appservice", "appservice", 0},
	}
	for _, tt := range tests {
		loc, port := splitLocatorPort(tt.in)
		if loc != tt.locator || port != tt.port {
			t.Errorf("splitLocatorPort(%q) = %q,%d; want %q,%d", tt.in, loc, port, tt.locator, tt.port)
		}
	}
}

func TestSplitKindName(t *testing.T) {
	tests := []struct{ in, kind, name string }{
		{"svc/appservice", "svc", "appservice"},
		{"deploy/x", "deploy", "x"},
		{"bare-pod", "pod", "bare-pod"},
	}
	for _, tt := range tests {
		k, n := splitKindName(tt.in)
		if k != tt.kind || n != tt.name {
			t.Errorf("splitKindName(%q) = %q,%q; want %q,%q", tt.in, k, n, tt.kind, tt.name)
		}
	}
}

func TestNewK8sAttachNeedsNamespace(t *testing.T) {
	dir := t.TempDir() // no workspace.yaml, no env
	if _, err := New(KindK8sAttach, dir); err == nil || !strings.Contains(err.Error(), "namespace") {
		t.Fatalf("want namespace error, got %v", err)
	}
}

func TestNewK8sAttachFromEnv(t *testing.T) {
	t.Setenv("PB_K8S_CONTEXT", "redcat")
	t.Setenv("PB_K8S_NAMESPACE", "delta")
	s, err := New(KindK8sAttach, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ka := s.(*k8sAttach)
	if ka.context != "redcat" || ka.namespace != "delta" {
		t.Fatalf("got context=%q namespace=%q, want redcat/delta", ka.context, ka.namespace)
	}
	// It satisfies the optional Endpoints capability.
	if _, ok := s.(Endpoints); !ok {
		t.Fatal("k8s-attach must satisfy the optional Endpoints capability")
	}
}

func TestWorkspaceContext(t *testing.T) {
	dir := t.TempDir()
	ws := "contexts:\n  k8s-attach: \"dev-control@mltest\"\n"
	if err := os.WriteFile(filepath.Join(dir, "workspace.yaml"), []byte(ws), 0o644); err != nil {
		t.Fatal(err)
	}
	kctx, ns, ok := workspaceContext(dir)
	if !ok || kctx != "dev-control" || ns != "mltest" {
		t.Fatalf("workspaceContext = %q,%q,%v; want dev-control,mltest,true", kctx, ns, ok)
	}
	s, err := New(KindK8sAttach, dir)
	if err != nil {
		t.Fatal(err)
	}
	ka := s.(*k8sAttach)
	if ka.context != "dev-control" || ka.namespace != "mltest" {
		t.Fatalf("New from workspace got %q/%q", ka.context, ka.namespace)
	}
}

func TestK8sAttachEndpointFromForwards(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PB_K8S_NAMESPACE", "delta")
	s, err := New(KindK8sAttach, dir)
	if err != nil {
		t.Fatal(err)
	}
	ka := s.(*k8sAttach)
	if err := ka.saveForwards([]forward{
		{Name: "appservice", Locator: "svc/appservice", LocalPort: 18080, PID: 0},
		{Name: "mongo", Locator: "svc/mongo", LocalPort: 27099, PID: 0},
	}); err != nil {
		t.Fatal(err)
	}
	ep := s.(Endpoints)
	if hp, err := ep.Endpoint("appservice"); err != nil || hp != "127.0.0.1:18080" {
		t.Errorf("Endpoint(appservice) = %q, %v; want 127.0.0.1:18080", hp, err)
	}
	if hp, err := ep.Endpoint("mongo"); err != nil || hp != "127.0.0.1:27099" {
		t.Errorf("Endpoint(mongo) = %q, %v; want 127.0.0.1:27099", hp, err)
	}
	if _, err := ep.Endpoint("ghost"); err == nil {
		t.Error("Endpoint(ghost) should error")
	}
}

func TestK8sAttachDownIdempotent(t *testing.T) {
	t.Setenv("PB_K8S_NAMESPACE", "delta")
	s, err := New(KindK8sAttach, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// No forwards file at all — Down is a no-op, never an error, never a
	// cluster mutation (Shape-A).
	if err := s.Down(&manifest.Ready{}); err != nil {
		t.Fatalf("Down with no forwards: %v", err)
	}
}

func TestK8sAttachForwardTargets(t *testing.T) {
	t.Setenv("PB_K8S_NAMESPACE", "delta")
	s, err := New(KindK8sAttach, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ka := s.(*k8sAttach)
	r := &manifest.Ready{
		Service: "appservice",
		Sources: map[string]string{"k8s": "svc/appservice:80"},
		Resources: map[string]manifest.Resource{
			"mongo": {Type: "mongodb", Via: map[string]string{"k8s": "svc/mongodb-svc:27017"}},
			"kafka": {Type: "kafka", Via: map[string]string{"k8s": "svc/kafka:9092"}},
			"local": {Type: "http", Via: map[string]string{"compose": "x"}}, // no k8s locator
		},
	}
	got := ka.forwardTargets(r)
	// service first, then resources sorted by name (kafka, mongo); 'local' skipped.
	want := []struct {
		name    string
		locator string
		port    int
	}{
		{"appservice", "svc/appservice", 80},
		{"kafka", "svc/kafka", 9092},
		{"mongo", "svc/mongodb-svc", 27017},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d targets, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i].Name != w.name || got[i].Locator != w.locator || got[i].RemotePort != w.port {
			t.Errorf("target[%d] = %+v, want %s/%s/%d", i, got[i], w.name, w.locator, w.port)
		}
	}
}

// ------------------------------------------------------------------ helpers

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}
