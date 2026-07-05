package evidence

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Run executes argv (argv[0] is the program; when shell is true the single
// command string is run via `bash -lc` instead), teeing combined
// stdout+stderr live to the terminal AND to NN-<name>.log inside the bundle
// (NN is the next zero-padded sequence number, shared with Add; if the name
// is already taken the file is uniquified — an existing artifact is never
// truncated). It then appends a command-type artifact for the log with
// provenance "harness" and meta {cmd, exitCode, durationSec}, saves the
// manifest, and returns the process's real exit code (124 when the
// PB_RUN_TIMEOUT deadline killed it — timeout(1) convention). The error is
// non-nil only for harness failures (spawn/capture problems, a bad
// PB_RUN_TIMEOUT), not for a nonzero exit of the command itself.
//
// ponytail: combined stdout+stderr; split streams when someone needs them.
func (b *Bundle) Run(name string, argv []string, shell bool) (int, error) {
	// Parse optional timeout from the environment up front: an unparseable
	// PB_RUN_TIMEOUT is a harness error, never a silently disabled timeout.
	timeout, err := parsePBRunTimeout()
	if err != nil {
		return 0, fmt.Errorf("run: %w", err)
	}

	// Determine the log file path using the next sequence number (shared
	// with Add via nextSeq), uniquified so an existing file is never
	// truncated; O_EXCL guarantees it.
	logName := fmt.Sprintf("%02d-%s.log", b.nextSeq(), name)
	logPath := uniquePath(filepath.Join(b.Dir, logName))
	logName = filepath.Base(logPath)

	logFile, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return 0, fmt.Errorf("run: create log file: %w", err)
	}
	defer logFile.Close()

	ctx := context.Background()
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	// Build the full command string for recording in meta.
	var cmdStr string
	var cmd *exec.Cmd
	if shell {
		cmdStr = strings.Join(argv, " ")
		cmd = exec.CommandContext(ctx, "bash", "-lc", cmdStr)
	} else {
		cmdStr = strings.Join(argv, " ")
		cmd = exec.CommandContext(ctx, argv[0], argv[1:]...)
	}

	// Start the process in its own process group; on timeout Cancel kills
	// the whole group. Cancel only fires while Wait is still running, so a
	// recycled pgid can't be killed after a normal exit.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if err == syscall.ESRCH {
			return os.ErrProcessDone
		}
		return err
	}
	// Bound the wait on stragglers holding the output pipe open after exit.
	cmd.WaitDelay = 10 * time.Second

	// Tee combined stdout+stderr to both the terminal and the log file.
	w := io.MultiWriter(os.Stdout, logFile)
	cmd.Stdout = w
	cmd.Stderr = w

	start := time.Now()
	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("run: spawn %q: %w", cmdStr, err)
	}
	waitErr := cmd.Wait()
	dur := time.Since(start)
	timedOut := ctx.Err() == context.DeadlineExceeded

	exitCode := 0
	switch {
	case timedOut:
		exitCode = 124 // timeout(1) convention
	case waitErr != nil:
		var exitErr *exec.ExitError
		switch {
		case errors.As(waitErr, &exitErr):
			exitCode = exitErr.ExitCode()
		case errors.Is(waitErr, exec.ErrWaitDelay):
			// The command exited but something held its output pipe open
			// past WaitDelay; use the recorded exit status.
			exitCode = cmd.ProcessState.ExitCode()
		default:
			// Wait failed for a non-exit reason — a harness error.
			return 0, fmt.Errorf("run: wait %q: %w", cmdStr, waitErr)
		}
	}

	// Build artifact meta.
	meta := map[string]any{
		"cmd":         cmdStr,
		"exitCode":    exitCode,
		"durationSec": dur.Seconds(),
	}
	if timedOut {
		meta["timedOut"] = true
	}

	// Compute sha256 of the log file.
	sha, err := sha256File(logPath)
	if err != nil {
		return 0, fmt.Errorf("run: sha256 log: %w", err)
	}

	b.M.Artifacts = append(b.M.Artifacts, Artifact{
		Type:       ArtifactCommand,
		Name:       name,
		Path:       logName,
		SHA256:     sha,
		Provenance: ProvenanceHarness,
		Meta:       meta,
	})

	if err := b.Save(); err != nil {
		return 0, fmt.Errorf("run: save manifest: %w", err)
	}

	return exitCode, nil
}

// parsePBRunTimeout reads PB_RUN_TIMEOUT from the environment and returns the
// parsed duration. Unset means no timeout (0); an unparseable value is an
// error so a typo can't silently disable the timeout.
func parsePBRunTimeout() (time.Duration, error) {
	v := os.Getenv("PB_RUN_TIMEOUT")
	if v == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("PB_RUN_TIMEOUT %q: %w", v, err)
	}
	return d, nil
}
