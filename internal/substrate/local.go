package substrate

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/launchwings/proofbench/internal/manifest"
)

// localSubstrate runs the service as bare processes on the host
// (process-compose semantics), sourcing env from run.local.env.
// NOTE: unix-only (process groups via syscall); Windows is out of scope.
type localSubstrate struct {
	dir string
}

// Up starts the service via run.local.start with the resolved environment.
func (s *localSubstrate) Up(r *manifest.Ready) error {
	start := r.Run.Local.Start
	if start == "" {
		return errors.New("local: run.local.start is not set")
	}

	env := os.Environ()
	if f := r.Run.Local.Env.File; f != "" {
		if !filepath.IsAbs(f) {
			f = filepath.Join(s.dir, f)
		}
		fileEnv, err := parseEnvFile(f)
		if err != nil {
			return err
		}
		for _, kv := range fileEnv {
			env = setEnv(env, kv)
		}
	}
	keys := make([]string, 0, len(r.Run.Local.Env.Overrides))
	for k := range r.Run.Local.Env.Overrides {
		keys = append(keys, k)
	}
	sort.Strings(keys) // deterministic apply order
	for _, k := range keys {
		env = setEnv(env, k+"="+r.Run.Local.Env.Overrides[k])
	}

	pbDir := filepath.Join(s.dir, ".pb")
	if err := os.MkdirAll(pbDir, 0o755); err != nil {
		return err
	}
	logf, err := os.Create(filepath.Join(pbDir, serviceName(r)+".log"))
	if err != nil {
		return err
	}
	defer logf.Close()

	cmd := exec.Command("bash", "-lc", start)
	cmd.Dir = s.dir
	cmd.Env = env
	cmd.Stdout = logf
	cmd.Stderr = logf
	// Detached process group so Down can kill the whole tree.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("local up: %w", err)
	}
	// Reap when it dies so tests/long-lived embedders don't collect zombies.
	go func() { _ = cmd.Wait() }()

	pid := cmd.Process.Pid
	// NOTE: no liveness check on an existing pidfile — a second Up
	// overwrites it and orphans the first process group.
	if err := os.WriteFile(s.pidfile(r), []byte(strconv.Itoa(pid)+"\n"), 0o644); err != nil {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		return err
	}
	return nil
}

// Ready polls the manifest's readiness probe until it passes or times out.
func (s *localSubstrate) Ready(r *manifest.Ready) error {
	return waitProbe(s.dir, r.Run.Ready)
}

// Seed runs the manifest's seed steps in dependency order on the host.
func (s *localSubstrate) Seed(r *manifest.Ready) error {
	return runSeed(s.dir, r)
}

// Down stops the processes Up started. Stale or missing pidfiles are not
// errors — Down is idempotent.
func (s *localSubstrate) Down(r *manifest.Ready) error {
	pidPath := s.pidfile(r)
	data, err := os.ReadFile(pidPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer os.Remove(pidPath)
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return nil // stale garbage pidfile
	}
	// Guard against a stale pidfile naming a recycled, unrelated pid: only
	// signal when the pid is alive and its command line still looks like
	// what Up started (the manifest's start command, or its bash -lc
	// wrapper). Otherwise just drop the pidfile.
	// NOTE: ceiling — a command-line heuristic; a recycled pid running a
	// same-looking command still matches, and an argv-rewriting exec of an
	// argument-less start slips past it (leaked, not mis-killed). Real
	// ownership needs process start-time or pidfd tracking.
	out, psErr := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if psErr != nil {
		return nil // pid not alive — stale pidfile, removed by the defer
	}
	if !cmdlineLooksLikeStart(string(out), r.Run.Local.Start) {
		return nil // an unrelated process owns this pid now
	}
	// NOTE: SIGTERM, fixed 200ms grace, SIGKILL — no configurable drain.
	// Any SIGTERM errno (including EPERM) is ignored here rather than treated
	// as "group already gone": only the SIGKILL + pidGone check below gets to
	// decide that, so a real leak still surfaces loudly.
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	time.Sleep(200 * time.Millisecond)
	_ = syscall.Kill(-pid, syscall.SIGKILL)

	// Confirm the kill actually landed: a leaked process (pid survives
	// SIGKILL) must not be indistinguishable from a clean stop.
	if !pidGone(pid) {
		return fmt.Errorf("local.Down: pid %d survived SIGKILL — kill it manually", pid)
	}
	return nil
}

// pidGone polls pid's liveness (signal 0) up to 3 times, 100ms apart,
// returning true as soon as the OS reports no such process. It gives a
// just-SIGKILLed process a short window to actually exit before Down
// declares it leaked.
func pidGone(pid int) bool {
	for i := 0; i < 3; i++ {
		if syscall.Kill(pid, 0) == syscall.ESRCH {
			return true
		}
		if i < 2 {
			time.Sleep(100 * time.Millisecond)
		}
	}
	return false
}

// cmdlineLooksLikeStart reports whether a ps command line plausibly belongs
// to the process group Up started for the given start command: the start
// string itself, its bash -lc wrapper, or — because an exec shim can rewrite
// argv[0] (e.g. macOS python3) — the start command's arguments.
func cmdlineLooksLikeStart(cmdline, start string) bool {
	start = strings.TrimSpace(start)
	if strings.Contains(cmdline, "bash") {
		return true
	}
	if start == "" {
		return false
	}
	if strings.Contains(cmdline, start) {
		return true
	}
	if _, args, ok := strings.Cut(start, " "); ok && strings.TrimSpace(args) != "" {
		return strings.Contains(cmdline, strings.TrimSpace(args))
	}
	return false
}

func (s *localSubstrate) pidfile(r *manifest.Ready) string {
	return filepath.Join(s.dir, ".pb", serviceName(r)+".pid")
}

func serviceName(r *manifest.Ready) string {
	if r.Service != "" {
		return r.Service
	}
	return "service" // NOTE: unnamed manifest still gets a pid/log file
}

// parseEnvFile reads KEY=VAL lines, ignoring blank lines and # comments.
// An optional "export " prefix is stripped; any other malformed line errors.
func parseEnvFile(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("env file: %w", err)
	}
	var out []string
	for i, line := range strings.Split(string(data), "\n") {
		l := strings.TrimSpace(line)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		l = strings.TrimPrefix(l, "export ")
		if !strings.Contains(l, "=") {
			return nil, fmt.Errorf("env file %s:%d: expected KEY=VAL, got %q", path, i+1, line)
		}
		out = append(out, l)
	}
	return out, nil
}

// setEnv returns env with kv (KEY=VAL) applied, replacing an existing KEY.
func setEnv(env []string, kv string) []string {
	k, _, _ := strings.Cut(kv, "=")
	for i, e := range env {
		if strings.HasPrefix(e, k+"=") {
			env[i] = kv
			return env
		}
	}
	return append(env, kv)
}

// ---------------------------------------------------------------- probes
// Shared by the local and compose substrates.

// waitProbe polls the declared probe every interval until it passes or the
// timeout elapses; the failure error names the probe.
func waitProbe(dir string, p manifest.Probe) error {
	what, attempt, err := probeFn(dir, p)
	if err != nil {
		return err
	}
	timeout, interval, err := probeTiming(p)
	if err != nil {
		return err
	}
	return poll(timeout, interval, what, attempt)
}

// poll retries attempt every interval until it returns nil or timeout
// elapses; the failure error names what was being waited for.
func poll(timeout, interval time.Duration, what string, attempt func() error) error {
	deadline := time.Now().Add(timeout)
	for {
		err := attempt()
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s: not ready after %s: %w", what, timeout, err)
		}
		time.Sleep(interval)
	}
}

func probeTiming(p manifest.Probe) (timeout, interval time.Duration, err error) {
	timeout, interval = 60*time.Second, time.Second // NOTE: fixed defaults
	if p.Timeout != "" {
		if timeout, err = time.ParseDuration(p.Timeout); err != nil {
			return 0, 0, fmt.Errorf("ready.timeout: %w", err)
		}
	}
	if p.Interval != "" {
		if interval, err = time.ParseDuration(p.Interval); err != nil {
			return 0, 0, fmt.Errorf("ready.interval: %w", err)
		}
	}
	return timeout, interval, nil
}

// probeFn returns a probe name (for error messages) and a single-attempt
// function for the exactly-one declared probe.
func probeFn(dir string, p manifest.Probe) (what string, attempt func() error, err error) {
	declared := 0
	for _, v := range []string{p.HTTP, p.TCP, p.Exec} {
		if v != "" {
			declared++
		}
	}
	if declared == 0 {
		return "", nil, errors.New("no readiness probe declared (run.ready needs one of http|tcp|exec)")
	}
	if declared > 1 {
		return "", nil, errors.New("readiness probe must declare exactly one of http|tcp|exec")
	}
	switch {
	case p.HTTP != "":
		url := httpProbeURL(p.HTTP)
		client := &http.Client{Timeout: 2 * time.Second}
		return fmt.Sprintf("http probe %s", p.HTTP), func() error {
			resp, err := client.Get(url)
			if err != nil {
				return err
			}
			resp.Body.Close()
			if resp.StatusCode < 200 || resp.StatusCode > 299 {
				return fmt.Errorf("status %d", resp.StatusCode)
			}
			return nil
		}, nil
	case p.TCP != "":
		addr := p.TCP
		if strings.HasPrefix(addr, ":") {
			addr = "localhost" + addr
		}
		return fmt.Sprintf("tcp probe %s", p.TCP), func() error {
			c, err := net.DialTimeout("tcp", addr, 2*time.Second)
			if err != nil {
				return err
			}
			return c.Close()
		}, nil
	default: // p.Exec != ""
		return fmt.Sprintf("exec probe %q", p.Exec), func() error {
			cmd := exec.Command("bash", "-lc", p.Exec)
			cmd.Dir = dir
			out, err := cmd.CombinedOutput()
			if err != nil {
				return fmt.Errorf("%w: %s", err, bytes.TrimSpace(out))
			}
			return nil
		}, nil
	}
}

// httpProbeURL normalizes k8s-style probe shorthand (":8080/healthz") into a
// dialable URL.
func httpProbeURL(raw string) string {
	u := raw
	if strings.HasPrefix(u, ":") {
		u = "localhost" + u
	}
	if !strings.Contains(u, "://") {
		u = "http://" + u
	}
	return u
}
