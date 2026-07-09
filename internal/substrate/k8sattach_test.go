package substrate

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/launchwings/proofbench/internal/manifest"
)

// ------------------------------------------------------------------------
// fake kubectl PATH shim
//
// A single bash script serves every test case: it dispatches on argv and
// reads its behavior from PB_FAKE_* env vars (t.Setenv scoped per (sub)test),
// so no real kubectl or cluster is ever touched. Every invocation (full argv,
// including the --context/-n baseArgs prefix) is appended to
// PB_FAKE_KUBECTL_LOG for assertions.
// ------------------------------------------------------------------------

const fakeKubectlScript = `#!/bin/bash
# Fake kubectl for hermetic k8s-attach substrate tests. Behavior is driven by
# PB_FAKE_* env vars; every invocation is logged to PB_FAKE_KUBECTL_LOG.
set -u

if [ -n "${PB_FAKE_KUBECTL_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$PB_FAKE_KUBECTL_LOG"
fi

# Strip --context <val> and -n <val> (baseArgs prepends these); keep the rest.
rest=()
skip=0
for arg in "$@"; do
  if [ "$skip" = "1" ]; then
    skip=0
    continue
  fi
  case "$arg" in
    --context|-n) skip=1 ;;
    *) rest+=("$arg") ;;
  esac
done

sub="${rest[0]:-}"
case "$sub" in
get)
  kind="${rest[1]:-}"
  case "$kind" in
  pod/*)
    name="${kind#pod/}"
    if [ "$name" = "${PB_FAKE_FAIL_NAME:-}" ]; then
      echo "Error from server (NotFound): pods \"$name\" not found" >&2
      exit 1
    fi
    echo "${PB_FAKE_POD_READY:-True}"
    exit 0
    ;;
  deploy)
    name="${rest[2]:-}"
    if [ "$name" = "${PB_FAKE_FAIL_NAME:-}" ]; then
      echo "Error from server (NotFound): deployments.apps \"$name\" not found" >&2
      exit 1
    fi
    echo "${PB_FAKE_DEPLOY_REPLICAS:-1}"
    exit 0
    ;;
  svc)
    name="${rest[2]:-}"
    if [ "$name" = "${PB_FAKE_FAIL_NAME:-}" ]; then
      echo "Error from server (NotFound): services \"$name\" not found" >&2
      exit 1
    fi
    echo "service/$name"
    exit 0
    ;;
  pods)
    if [ -z "${PB_FAKE_POD_NAME:-}" ]; then
      echo "" >&2
      exit 1
    fi
    echo "$PB_FAKE_POD_NAME"
    exit 0
    ;;
  *)
    echo "fake kubectl: unsupported get kind '$kind'" >&2
    exit 1
    ;;
  esac
  ;;
port-forward)
  portspec="${rest[2]:-}"
  local_port="${portspec%%:*}"
  if [ -n "${PB_FAKE_FORWARD_PIDFILE:-}" ]; then
    echo $$ > "$PB_FAKE_FORWARD_PIDFILE"
  fi
  if [ "${PB_FAKE_FORWARD_MODE:-ok}" = "ok" ]; then
    exec python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', $local_port))
s.listen(5)
print('Forwarding from 127.0.0.1:$local_port -> remote', flush=True)
while True:
    conn, _ = s.accept()
    conn.close()
"
  else
    # timeout mode: never bind, never print; just hang until the caller's
    # deadline kills our process group.
    exec sleep 600
  fi
  ;;
exec)
  if [ "${PB_FAKE_EXEC_FAIL:-0}" = "1" ]; then
    echo "error: unable to upgrade connection" >&2
    exit 1
  fi
  printf '%s\n' "${PB_FAKE_EXEC_ENV_OUT:-}"
  exit 0
  ;;
*)
  echo "fake kubectl: unsupported subcommand '$sub'" >&2
  exit 1
  ;;
esac
`

// newFakeKubectl installs the fake kubectl shim at the front of PATH for the
// duration of t and returns the log file path invocations are appended to.
func newFakeKubectl(t *testing.T) string {
	t.Helper()
	binDir := t.TempDir()
	script := filepath.Join(binDir, "kubectl")
	if err := os.WriteFile(script, []byte(fakeKubectlScript), 0o755); err != nil {
		t.Fatal(err)
	}
	logFile := filepath.Join(t.TempDir(), "kubectl.log")
	t.Setenv("PB_FAKE_KUBECTL_LOG", logFile)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return logFile
}

func readLog(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return ""
		}
		t.Fatal(err)
	}
	return string(data)
}

// waitDialable blocks until addr accepts a TCP connection or timeout elapses.
func waitDialable(t *testing.T, addr string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			c.Close()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s never became dialable: %v", addr, err)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// waitNotDialable blocks until addr stops accepting TCP connections or
// timeout elapses (used to confirm a forward was actually killed).
func waitNotDialable(t *testing.T, addr string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err != nil {
			return
		}
		c.Close()
		if time.Now().After(deadline) {
			t.Fatalf("%s still accepting connections", addr)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// waitPidDead blocks until pid no longer exists (signal 0 fails) or timeout.
func waitPidDead(t *testing.T, pid int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if err := syscall.Kill(pid, 0); err != nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("pid %d still alive after %s", pid, timeout)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func readPidFile(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("pidfile %s not written: %v", path, err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatalf("pidfile %s content %q not an int: %v", path, data, err)
	}
	return pid
}

// ------------------------------------------------------------------- Up

func TestK8sAttachUpHappyPathEndpointReadyDown(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not in PATH")
	}
	logFile := newFakeKubectl(t)
	t.Setenv("PB_K8S_CONTEXT", "redcat")
	t.Setenv("PB_K8S_NAMESPACE", "delta")

	dir := t.TempDir()
	s, err := New(KindK8sAttach, dir)
	if err != nil {
		t.Fatal(err)
	}
	ka := s.(*k8sAttach)
	r := &manifest.Ready{
		Service: "appservice",
		Sources: map[string]string{"k8s": "svc/appservice:8080"},
		Resources: map[string]manifest.Resource{
			"mongo": {Type: "mongodb", Via: map[string]string{"k8s": "pod/mongo-0:27017"}},
		},
	}
	t.Cleanup(func() { _ = s.Down(r) })

	if err := s.Up(r); err != nil {
		t.Fatalf("Up: %v", err)
	}

	log := readLog(t, logFile)
	if !strings.Contains(log, "--context redcat") || !strings.Contains(log, "-n delta") {
		t.Fatalf("log missing --context/-n baseArgs: %q", log)
	}
	if !strings.Contains(log, "port-forward svc/appservice") {
		t.Fatalf("log missing service port-forward: %q", log)
	}
	if !strings.Contains(log, "port-forward pod/mongo-0") {
		t.Fatalf("log missing resource port-forward: %q", log)
	}

	fwds, err := ka.loadForwards()
	if err != nil {
		t.Fatalf("loadForwards: %v", err)
	}
	if len(fwds) != 2 {
		t.Fatalf("got %d forwards, want 2: %+v", len(fwds), fwds)
	}
	if fwds[0].Name != "appservice" || fwds[1].Name != "mongo" {
		t.Fatalf("forward order = %s,%s; want appservice,mongo", fwds[0].Name, fwds[1].Name)
	}
	for _, f := range fwds {
		if f.LocalPort == 0 || f.PID == 0 {
			t.Fatalf("forward %+v missing LocalPort/PID", f)
		}
		waitDialable(t, fmt.Sprintf("127.0.0.1:%d", f.LocalPort), 3*time.Second)
	}

	ep := s.(Endpoints)
	hp, err := ep.Endpoint("appservice")
	if err != nil || hp != fmt.Sprintf("127.0.0.1:%d", fwds[0].LocalPort) {
		t.Fatalf("Endpoint(appservice) = %q, %v", hp, err)
	}
	if _, err := ep.Endpoint("no-such-resource"); err == nil {
		t.Fatal("Endpoint(no-such-resource) should error")
	}

	// Ready resolves the ${endpoints.<name>} placeholder against the recorded
	// forward and probes the real (fake-forwarded) listener.
	r.Run.Ready = manifest.Probe{TCP: "${endpoints.appservice}", Timeout: "5s", Interval: "50ms"}
	if err := s.Ready(r); err != nil {
		t.Fatalf("Ready: %v", err)
	}

	if err := s.Down(r); err != nil {
		t.Fatalf("Down: %v", err)
	}
	for _, f := range fwds {
		waitNotDialable(t, fmt.Sprintf("127.0.0.1:%d", f.LocalPort), 3*time.Second)
	}
	if _, err := os.Stat(ka.forwardsFile()); !os.IsNotExist(err) {
		t.Fatalf("forwards file not removed by Down: %v", err)
	}
	if err := s.Down(r); err != nil { // idempotent: file already gone
		t.Fatalf("second Down: %v", err)
	}
}

func TestK8sAttachUpAssertLiveFailureReapsOpenedForwards(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not in PATH")
	}
	newFakeKubectl(t)
	t.Setenv("PB_K8S_NAMESPACE", "delta")
	t.Setenv("PB_FAKE_FAIL_NAME", "mongo-0") // the pod locator's name, not the resource key

	pidFile := filepath.Join(t.TempDir(), "forward.pid")
	t.Setenv("PB_FAKE_FORWARD_PIDFILE", pidFile)

	dir := t.TempDir()
	s, err := New(KindK8sAttach, dir)
	if err != nil {
		t.Fatal(err)
	}
	ka := s.(*k8sAttach)
	r := &manifest.Ready{
		Service: "appservice",
		Sources: map[string]string{"k8s": "svc/appservice:8080"}, // opens first, succeeds
		Resources: map[string]manifest.Resource{
			"mongo": {Type: "mongodb", Via: map[string]string{"k8s": "pod/mongo-0:27017"}}, // fails assertLive
		},
	}

	err = s.Up(r)
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !strings.Contains(err.Error(), "mongo") || !strings.Contains(err.Error(), "pod/mongo-0") {
		t.Fatalf("error %q does not name the failing resource/locator", err.Error())
	}

	// Nothing is persisted on a failed Up.
	if _, err := os.Stat(ka.forwardsFile()); !os.IsNotExist(err) {
		t.Fatalf("forwards file should not exist after failed Up: %v", err)
	}

	// The forward opened for the service (before the failure) must have been
	// reaped, not leaked.
	pid := readPidFile(t, pidFile)
	waitPidDead(t, pid, 3*time.Second)
}

func TestK8sAttachUpOpenForwardTimeoutNoLeak(t *testing.T) {
	newFakeKubectl(t)
	t.Setenv("PB_K8S_NAMESPACE", "delta")
	t.Setenv("PB_FAKE_FORWARD_MODE", "timeout") // shim never binds the port

	pidFile := filepath.Join(t.TempDir(), "forward.pid")
	t.Setenv("PB_FAKE_FORWARD_PIDFILE", pidFile)

	dir := t.TempDir()
	s, err := New(KindK8sAttach, dir)
	if err != nil {
		t.Fatal(err)
	}
	ka := s.(*k8sAttach)
	r := &manifest.Ready{
		Service: "appservice",
		Sources: map[string]string{"k8s": "svc/appservice:8080"},
	}

	start := time.Now()
	err = s.Up(r) // openForward's hardcoded 15s deadline; this test is intentionally slow
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !strings.Contains(err.Error(), "never came up") {
		t.Fatalf("error %q missing 'never came up'", err.Error())
	}
	if elapsed < 15*time.Second {
		t.Fatalf("returned after %s, want >= 15s (openForward's deadline)", elapsed)
	}

	if _, err := os.Stat(ka.forwardsFile()); !os.IsNotExist(err) {
		t.Fatalf("forwards file should not exist after timeout: %v", err)
	}

	pid := readPidFile(t, pidFile)
	waitPidDead(t, pid, 3*time.Second)
}

func TestK8sAttachUpNoKubectlOnPath(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // empty: no kubectl anywhere
	t.Setenv("PB_K8S_NAMESPACE", "delta")
	s, err := New(KindK8sAttach, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Up(&manifest.Ready{}); err == nil || !strings.Contains(err.Error(), "kubectl not found in PATH") {
		t.Fatalf("got %v", err)
	}
}

func TestK8sAttachUpNoTargets(t *testing.T) {
	newFakeKubectl(t)
	t.Setenv("PB_K8S_NAMESPACE", "delta")
	s, err := New(KindK8sAttach, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	err = s.Up(&manifest.Ready{}) // no sources.k8s, no resources
	if err == nil || !strings.Contains(err.Error(), "no k8s locators to forward") {
		t.Fatalf("got %v", err)
	}
}

// ----------------------------------------------------------------- Down

func TestK8sAttachDownKillsForwardsAndIsIdempotent(t *testing.T) {
	logFile := newFakeKubectl(t)
	t.Setenv("PB_K8S_NAMESPACE", "delta")

	dir := t.TempDir()
	s, err := New(KindK8sAttach, dir)
	if err != nil {
		t.Fatal(err)
	}
	ka := s.(*k8sAttach)

	// A recorded forward with a real, live process in its own group — Down
	// must reap it by pid without ever shelling out to kubectl.
	cmd := exec.Command("sleep", "30")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	// Reap it like openForward's goroutine does, so a killed process actually
	// disappears (kill(pid,0) still finds a zombie otherwise).
	go func() { _ = cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })

	if err := ka.saveForwards([]forward{
		{Name: "appservice", Locator: "svc/appservice", LocalPort: 19999, PID: pid},
	}); err != nil {
		t.Fatal(err)
	}

	if err := s.Down(&manifest.Ready{}); err != nil {
		t.Fatalf("Down: %v", err)
	}
	waitPidDead(t, pid, 3*time.Second)
	if _, err := os.Stat(ka.forwardsFile()); !os.IsNotExist(err) {
		t.Fatalf("forwards file not removed: %v", err)
	}

	if err := s.Down(&manifest.Ready{}); err != nil { // idempotent, forwards file already gone
		t.Fatalf("second Down: %v", err)
	}

	// Down never shells out to kubectl (it only signals recorded pids) —
	// "touches nothing unlabeled".
	if log := readLog(t, logFile); strings.TrimSpace(log) != "" {
		t.Fatalf("Down invoked kubectl unexpectedly: %q", log)
	}
}

// --------------------------------------------------- DeriveEnv / resolvePod

func TestK8sAttachDeriveEnv(t *testing.T) {
	tests := []struct {
		name        string
		r           *manifest.Ready
		podName     string // PB_FAKE_POD_NAME for "get pods -l ..."
		execOut     string
		execFail    bool
		wantEnv     []string
		wantErr     string
		wantLogHas  string // substring that must appear in the kubectl log
		wantLogMiss string // substring that must NOT appear in the kubectl log
	}{
		{
			name: "nil derive spec is a no-op",
			r:    &manifest.Ready{},
		},
		{
			name: "empty derive.from is a no-op",
			r: &manifest.Ready{Run: manifest.RunSpec{Local: manifest.LocalRun{
				Env: manifest.EnvSpec{Derive: &manifest.DeriveSpec{}},
			}}},
		},
		{
			name: "unsupported derive.from errors",
			r: &manifest.Ready{Run: manifest.RunSpec{Local: manifest.LocalRun{
				Env: manifest.EnvSpec{Derive: &manifest.DeriveSpec{From: "aws-ssm"}},
			}}},
			wantErr: "unsupported env.derive.from",
		},
		{
			name: "default selector uses service name",
			r: &manifest.Ready{
				Service: "appservice",
				Run: manifest.RunSpec{Local: manifest.LocalRun{
					Env: manifest.EnvSpec{Derive: &manifest.DeriveSpec{From: "k8s-pod"}},
				}},
			},
			podName:    "appservice-7f8-abcde",
			execOut:    "FOO=1\n\ngarbage\nBAR=2\n",
			wantEnv:    []string{"FOO=1", "BAR=2"},
			wantLogHas: "-l app=appservice",
		},
		{
			name: "deploy/ selector resolves via app label",
			r: &manifest.Ready{
				Run: manifest.RunSpec{Local: manifest.LocalRun{
					Env: manifest.EnvSpec{Derive: &manifest.DeriveSpec{From: "k8s-pod", Pod: "deploy/metadata-service"}},
				}},
			},
			podName:    "metadata-service-9-xyz",
			execOut:    "A=1\n",
			wantEnv:    []string{"A=1"},
			wantLogHas: "-l app=metadata-service",
		},
		{
			name: "arbitrary label selector passed through",
			r: &manifest.Ready{
				Run: manifest.RunSpec{Local: manifest.LocalRun{
					Env: manifest.EnvSpec{Derive: &manifest.DeriveSpec{From: "k8s-pod", Pod: "role=worker"}},
				}},
			},
			podName:    "worker-0",
			execOut:    "B=2\n",
			wantEnv:    []string{"B=2"},
			wantLogHas: "-l role=worker",
		},
		{
			name: "bare pod name used as-is, no resolution call",
			r: &manifest.Ready{
				Run: manifest.RunSpec{Local: manifest.LocalRun{
					Env: manifest.EnvSpec{Derive: &manifest.DeriveSpec{From: "k8s-pod", Pod: "my-pod-0"}},
				}},
			},
			execOut:     "C=3\n",
			wantEnv:     []string{"C=3"},
			wantLogHas:  "exec my-pod-0",
			wantLogMiss: "get pods",
		},
		{
			name: "no pod matches selector",
			r: &manifest.Ready{
				Run: manifest.RunSpec{Local: manifest.LocalRun{
					Env: manifest.EnvSpec{Derive: &manifest.DeriveSpec{From: "k8s-pod", Pod: "role=ghost"}},
				}},
			},
			podName: "", // shim reports no match
			wantErr: "no pod matched",
		},
		{
			name: "exec failure surfaces the pod name",
			r: &manifest.Ready{
				Run: manifest.RunSpec{Local: manifest.LocalRun{
					Env: manifest.EnvSpec{Derive: &manifest.DeriveSpec{From: "k8s-pod", Pod: "my-pod-1"}},
				}},
			},
			execFail: true,
			wantErr:  "derive env from my-pod-1",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logFile := newFakeKubectl(t)
			t.Setenv("PB_K8S_NAMESPACE", "delta")
			t.Setenv("PB_FAKE_POD_NAME", tt.podName)
			t.Setenv("PB_FAKE_EXEC_ENV_OUT", tt.execOut)
			if tt.execFail {
				t.Setenv("PB_FAKE_EXEC_FAIL", "1")
			}
			s, err := New(KindK8sAttach, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			ka := s.(*k8sAttach)

			env, err := ka.DeriveEnv(tt.r)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("got env=%v err=%v, want error containing %q", env, err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("DeriveEnv: %v", err)
			}
			// both nil/empty is fine; otherwise the contents must match.
			if !(len(tt.wantEnv) == 0 && len(env) == 0) && !equalStrings(env, tt.wantEnv) {
				t.Fatalf("got env %v, want %v", env, tt.wantEnv)
			}

			log := readLog(t, logFile)
			if tt.wantLogHas != "" && !strings.Contains(log, tt.wantLogHas) {
				t.Fatalf("log %q missing %q", log, tt.wantLogHas)
			}
			if tt.wantLogMiss != "" && strings.Contains(log, tt.wantLogMiss) {
				t.Fatalf("log %q unexpectedly contains %q", log, tt.wantLogMiss)
			}
		})
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// --------------------------------------------------------- workspaceContext

func TestWorkspaceContextFromFixture(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "fixtures", "k8s-attach", "workspace.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "workspace.yaml"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	kctx, ns, ok := workspaceContext(dir)
	if !ok || kctx != "redcat" || ns != "redcat" {
		t.Fatalf("workspaceContext(fixture) = %q,%q,%v; want redcat,redcat,true", kctx, ns, ok)
	}
}
