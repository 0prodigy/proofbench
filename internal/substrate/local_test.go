package substrate

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/launchwings/proofbench/internal/manifest"
)

// TestLocalUpDeadOnArrivalStart proves BUG A is fixed: a start command that
// exits on its own within the grace window must fail Up (not report false
// success), naming the exit code and pointing at the manifest's start:.
func TestLocalUpDeadOnArrivalStart(t *testing.T) {
	tests := []struct {
		name  string
		start string
		want  string
	}{
		{name: "exit 0", start: "echo TODO: set your start command", want: "exit 0"},
		{name: "nonzero exit", start: "exit 3", want: "exit 3"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			s, err := New(KindLocal, dir)
			if err != nil {
				t.Fatal(err)
			}
			r := &manifest.Ready{Service: "web", Run: manifest.RunSpec{Local: manifest.LocalRun{Start: tt.start}}}
			err = s.Up(r)
			if err == nil {
				t.Fatal("want error for a dead-on-arrival start command, got nil")
			}
			if !strings.Contains(err.Error(), "start command exited immediately ("+tt.want+")") {
				t.Fatalf("got %v, want it to name %q", err, tt.want)
			}
			if !strings.Contains(err.Error(), "check the start: command in ready.yaml") {
				t.Fatalf("got %v, want the ready.yaml hint", err)
			}
			// No pidfile should be left behind for a process that never lived.
			ls := s.(*localSubstrate)
			if _, statErr := os.Stat(ls.pidfile(r)); !os.IsNotExist(statErr) {
				t.Fatalf("pidfile written for a dead-on-arrival start: %v", statErr)
			}
		})
	}
}

// TestLocalUpSecondWhileRunningErrors proves BUG B is fixed: a second Up
// while the first process is still alive must refuse rather than overwrite
// the pidfile and orphan the first process group.
func TestLocalUpSecondWhileRunningErrors(t *testing.T) {
	dir := t.TempDir()
	s, err := New(KindLocal, dir)
	if err != nil {
		t.Fatal(err)
	}
	r := &manifest.Ready{Service: "web", Run: manifest.RunSpec{Local: manifest.LocalRun{Start: "sleep 5"}}}
	t.Cleanup(func() { _ = s.Down(r) })

	if err := s.Up(r); err != nil {
		t.Fatalf("first Up: %v", err)
	}
	ls := s.(*localSubstrate)
	firstPID := readPidFileLocal(t, ls.pidfile(r))

	err = s.Up(r)
	if err == nil {
		t.Fatal("want error on second Up while the first is still running, got nil")
	}
	if !strings.Contains(err.Error(), "web already running (pid "+strconv.Itoa(firstPID)+")") {
		t.Fatalf("got %v, want it to name the running pid %d", err, firstPID)
	}
	if !strings.Contains(err.Error(), "run pb down first") {
		t.Fatalf("got %v, want the pb down hint", err)
	}
	// The original pidfile/process must be untouched by the refused second Up.
	if got := readPidFileLocal(t, ls.pidfile(r)); got != firstPID {
		t.Fatalf("pidfile pid changed after refused second Up: got %d, want %d", got, firstPID)
	}
}

// TestLocalUpStalePidfileCleanedAndProceeds proves a pidfile naming a dead
// pid is treated as stale (removed) rather than blocking Up.
func TestLocalUpStalePidfileCleanedAndProceeds(t *testing.T) {
	dir := t.TempDir()
	s, err := New(KindLocal, dir)
	if err != nil {
		t.Fatal(err)
	}
	r := &manifest.Ready{Service: "web", Run: manifest.RunSpec{Local: manifest.LocalRun{Start: "sleep 5"}}}
	t.Cleanup(func() { _ = s.Down(r) })

	ls := s.(*localSubstrate)
	pidPath := ls.pidfile(r)
	if err := os.MkdirAll(filepath.Dir(pidPath), 0o755); err != nil {
		t.Fatal(err)
	}
	deadPID := deadPidLocal(t)
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(deadPID)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := s.Up(r); err != nil {
		t.Fatalf("Up with a stale pidfile: %v", err)
	}
	got := readPidFileLocal(t, pidPath)
	if got == deadPID {
		t.Fatalf("pidfile still names the stale dead pid %d", deadPID)
	}
}

// TestLocalDownReportsNotRunning proves Down prints one observable line when
// there is nothing to kill (no pidfile at all).
func TestLocalDownReportsNotRunning(t *testing.T) {
	dir := t.TempDir()
	s, err := New(KindLocal, dir)
	if err != nil {
		t.Fatal(err)
	}
	r := &manifest.Ready{Service: "ghost"}
	out := captureStdout(t, func() {
		if err := s.Down(r); err != nil {
			t.Fatalf("Down: %v", err)
		}
	})
	if !strings.Contains(out, "down: ghost not running") {
		t.Fatalf("stdout %q missing the not-running line", out)
	}
}

// TestLocalDownReportsStopped proves Down prints one observable line naming
// the pid it actually stopped.
func TestLocalDownReportsStopped(t *testing.T) {
	dir := t.TempDir()
	s, err := New(KindLocal, dir)
	if err != nil {
		t.Fatal(err)
	}
	r := &manifest.Ready{Service: "web", Run: manifest.RunSpec{Local: manifest.LocalRun{Start: "sleep 5"}}}
	if err := s.Up(r); err != nil {
		t.Fatalf("Up: %v", err)
	}
	ls := s.(*localSubstrate)
	pid := readPidFileLocal(t, ls.pidfile(r))

	out := captureStdout(t, func() {
		if err := s.Down(r); err != nil {
			t.Fatalf("Down: %v", err)
		}
	})
	if !strings.Contains(out, "down: web (pid "+strconv.Itoa(pid)+") stopped") {
		t.Fatalf("stdout %q missing the stopped line for pid %d", out, pid)
	}
}

// ------------------------------------------------------------------ helpers

func readPidFileLocal(t *testing.T, path string) int {
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

// deadPidLocal returns a pid guaranteed to be dead (a short-lived process,
// run to completion and reaped).
func deadPidLocal(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Fatalf("run true: %v", err)
	}
	return cmd.Process.Pid
}
