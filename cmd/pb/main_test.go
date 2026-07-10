package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// captureStdout runs fn with os.Stdout redirected to a pipe and returns
// everything fn wrote to it.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stdout
	os.Stdout = w
	fn()
	w.Close()
	os.Stdout = orig

	var buf bytes.Buffer
	if _, err := io.Copy(&buf, r); err != nil {
		t.Fatalf("read captured stdout: %v", err)
	}
	return buf.String()
}

// captureStderr runs fn with os.Stderr redirected to a pipe and returns
// everything fn wrote to it.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stderr
	os.Stderr = w
	fn()
	w.Close()
	os.Stderr = orig

	var buf bytes.Buffer
	if _, err := io.Copy(&buf, r); err != nil {
		t.Fatalf("read captured stderr: %v", err)
	}
	return buf.String()
}

// TestRunLint exercises "pb lint" through run(args): a valid manifest exits
// 0, and each internal/manifest/testdata/invalid_*.yaml fixture exits 1 —
// proving manifest.Load's validation errors surface as a nonzero lint exit.
func TestRunLint(t *testing.T) {
	cases := []struct {
		name     string
		manifest string
		wantExit int
	}{
		{"valid", "../../internal/manifest/testdata/valid.yaml", 0},
		{"invalid_bad_mode", "../../internal/manifest/testdata/invalid_bad_mode.yaml", 1},
		{"invalid_dangling_seed_ref", "../../internal/manifest/testdata/invalid_dangling_seed_ref.yaml", 1},
		{"invalid_duplicate_check", "../../internal/manifest/testdata/invalid_duplicate_check.yaml", 1},
		{"invalid_unknown_field", "../../internal/manifest/testdata/invalid_unknown_field.yaml", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := run([]string{"lint", "--manifest", tc.manifest})
			if got != tc.wantExit {
				t.Errorf("run(lint --manifest %s) = %d, want %d", tc.manifest, got, tc.wantExit)
			}
		})
	}
}

// TestRunLintRejectsPositionalArgs proves "pb lint file.yaml" errors out
// instead of silently linting the default --manifest path.
func TestRunLintRejectsPositionalArgs(t *testing.T) {
	got := run([]string{"lint", "--manifest", "../../internal/manifest/testdata/valid.yaml", "stray.yaml"})
	if got != 1 {
		t.Errorf("run(lint --manifest valid.yaml stray.yaml) = %d, want 1", got)
	}
}

// TestRunExploreRequiresExperimentalFlag proves "pb explore" exits 2 and
// never touches the manifest when PB_EXPERIMENTAL is not "1".
func TestRunExploreRequiresExperimentalFlag(t *testing.T) {
	t.Setenv("PB_EXPERIMENTAL", "0")
	got := run([]string{"explore", "--manifest", "../../internal/manifest/testdata/valid.yaml"})
	if got != 2 {
		t.Errorf("run(explore) without PB_EXPERIMENTAL = %d, want 2", got)
	}
}

// TestRunVerifyUnknownSubstrateFailsFast confirms the CLI surfaces
// verify.Run's fail-fast on an unknown --substrate as a nonzero exit (the
// bugfix slice made verify.Run validate the substrate kind up front instead
// of silently degrading).
func TestRunVerifyUnknownSubstrateFailsFast(t *testing.T) {
	got := run([]string{
		"verify",
		"--manifest", "../../internal/manifest/testdata/valid.yaml",
		"--substrate", "bogus",
		"--evidence-root", t.TempDir(),
	})
	if got == 0 {
		t.Errorf("run(verify --substrate bogus) = 0, want nonzero")
	}
}

// TestRunVerifyExamplesBasicPass drives the real "up" -> "ready" -> "verify"
// sequence against examples/basic (per its README: run from that directory
// so relative manifest/artifact paths, e.g. orders.json, resolve against the
// service's own cwd) and asserts the verify exit-code contract: pass -> 0.
func TestRunVerifyExamplesBasicPass(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	exampleDir, err := filepath.Abs(filepath.Join(wd, "..", "..", "examples", "basic"))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	if err := os.Chdir(exampleDir); err != nil {
		t.Fatalf("chdir %s: %v", exampleDir, err)
	}
	t.Cleanup(func() {
		run([]string{"down", "--manifest", "ready.yaml"})
		os.RemoveAll(".pb")
		os.Remove("orders.json")
		if err := os.Chdir(wd); err != nil {
			t.Errorf("chdir back to %s: %v", wd, err)
		}
	})

	if got := run([]string{"up", "--manifest", "ready.yaml"}); got != 0 {
		t.Fatalf("run(up) = %d, want 0", got)
	}
	if got := run([]string{"ready", "--manifest", "ready.yaml"}); got != 0 {
		t.Fatalf("run(ready) = %d, want 0", got)
	}
	if got := run([]string{"verify", "--manifest", "ready.yaml", "--evidence-root", t.TempDir()}); got != 0 {
		t.Fatalf("run(verify) = %d, want 0 (pass)", got)
	}
}

// TestRunVerifyPrintsFailureReason drives "pb verify" against examples/basic
// without bringing the service up first, so its checks fail against a
// connection nothing is listening on, and proves the failing check's reason
// (verify.Summary.Lines, preformatted "[state] name — reason") reaches
// stdout instead of being swallowed into a bare "[state] name" line.
func TestRunVerifyPrintsFailureReason(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	exampleDir, err := filepath.Abs(filepath.Join(wd, "..", "..", "examples", "basic"))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	if err := os.Chdir(exampleDir); err != nil {
		t.Fatalf("chdir %s: %v", exampleDir, err)
	}
	t.Cleanup(func() {
		os.RemoveAll(".pb")
		os.Remove("orders.json")
		if err := os.Chdir(wd); err != nil {
			t.Errorf("chdir back to %s: %v", wd, err)
		}
	})

	out := captureStdout(t, func() {
		got := run([]string{"verify", "--manifest", "ready.yaml", "--evidence-root", t.TempDir()})
		if got == 0 {
			t.Fatalf("run(verify) = 0, want nonzero (service was never brought up)")
		}
	})
	if !strings.Contains(out, "[fail] up —") {
		t.Errorf("run(verify) stdout = %q, want a failing check line with a reason (\"[fail] up — ...\")", out)
	}
}

// TestRunUpReadyPrintSuccessLines proves "pb up" and "pb ready" each print a
// one-line success confirmation — two cold-onboarding e2e runs found both
// commands printed nothing on success even though the quickstart promises
// output.
func TestRunUpReadyPrintSuccessLines(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	exampleDir, err := filepath.Abs(filepath.Join(wd, "..", "..", "examples", "basic"))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	if err := os.Chdir(exampleDir); err != nil {
		t.Fatalf("chdir %s: %v", exampleDir, err)
	}
	t.Cleanup(func() {
		run([]string{"down", "--manifest", "ready.yaml"})
		os.RemoveAll(".pb")
		os.Remove("orders.json")
		if err := os.Chdir(wd); err != nil {
			t.Errorf("chdir back to %s: %v", wd, err)
		}
	})

	var upOut, readyOut string
	upOut = captureStdout(t, func() {
		if got := run([]string{"up", "--manifest", "ready.yaml"}); got != 0 {
			t.Fatalf("run(up) = %d, want 0", got)
		}
	})
	if want := "up: basic-orders (local)\n"; upOut != want {
		t.Errorf("run(up) stdout = %q, want %q", upOut, want)
	}

	readyOut = captureStdout(t, func() {
		if got := run([]string{"ready", "--manifest", "ready.yaml"}); got != 0 {
			t.Fatalf("run(ready) = %d, want 0", got)
		}
	})
	if want := "ready: http :8391/healthz ok\n"; readyOut != want {
		t.Errorf("run(ready) stdout = %q, want %q", readyOut, want)
	}
	if !strings.HasSuffix(readyOut, " ok\n") {
		t.Errorf("run(ready) stdout = %q, want a trailing ' ok' confirmation", readyOut)
	}
}

// TestRunVersionAliases proves "pb --version" and "pb -v" behave exactly
// like "pb version" — the cold-start audit found only the bare "version"
// subcommand worked, and the flag-shaped aliases exited 2 with a usage wall.
func TestRunVersionAliases(t *testing.T) {
	want := captureStdout(t, func() {
		if got := run([]string{"version"}); got != 0 {
			t.Fatalf("run(version) = %d, want 0", got)
		}
	})
	for _, alias := range []string{"--version", "-v"} {
		out := captureStdout(t, func() {
			if got := run([]string{alias}); got != 0 {
				t.Errorf("run(%s) = %d, want 0", alias, got)
			}
		})
		if out != want {
			t.Errorf("run(%s) stdout = %q, want %q", alias, out, want)
		}
	}
}

// TestRunHelpPerCommand proves both "pb help <cmd>" and "pb <cmd> --help"/"-h"
// print a per-command help (description + one example invocation) and exit
// 0, instead of the global usage wall or a bare flag-defaults dump exiting 2.
func TestRunHelpPerCommand(t *testing.T) {
	for _, cmd := range []string{"verify", "lint", "up", "init", "hub", "report", "evidence", "version"} {
		h, ok := cmdHelpTable[cmd]
		if !ok {
			t.Fatalf("cmdHelpTable has no entry for %q", cmd)
		}

		t.Run("help "+cmd, func(t *testing.T) {
			out := captureStdout(t, func() {
				if got := run([]string{"help", cmd}); got != 0 {
					t.Errorf("run(help %s) = %d, want 0", cmd, got)
				}
			})
			if !strings.Contains(out, h.example) {
				t.Errorf("run(help %s) stdout = %q, want it to contain example %q", cmd, out, h.example)
			}
		})

		t.Run(cmd+" --help", func(t *testing.T) {
			out := captureStdout(t, func() {
				if got := run([]string{cmd, "--help"}); got != 0 {
					t.Errorf("run(%s --help) = %d, want 0", cmd, got)
				}
			})
			if !strings.Contains(out, h.example) {
				t.Errorf("run(%s --help) stdout = %q, want it to contain example %q", cmd, out, h.example)
			}
		})

		t.Run(cmd+" -h", func(t *testing.T) {
			out := captureStdout(t, func() {
				if got := run([]string{cmd, "-h"}); got != 0 {
					t.Errorf("run(%s -h) = %d, want 0", cmd, got)
				}
			})
			if !strings.Contains(out, h.example) {
				t.Errorf("run(%s -h) stdout = %q, want it to contain example %q", cmd, out, h.example)
			}
		})
	}
}

// TestRunHelpBareIsGlobalUsage proves bare "pb help" still prints the global
// usage (unchanged) and exits 0.
func TestRunHelpBareIsGlobalUsage(t *testing.T) {
	out := captureStdout(t, func() {
		if got := run([]string{"help"}); got != 0 {
			t.Fatalf("run(help) = %d, want 0", got)
		}
	})
	if out != rootUsage {
		t.Errorf("run(help) stdout = %q, want the global usage %q", out, rootUsage)
	}
}

// TestRunMissingManifestFriendlyError proves a command that fails because
// ready.yaml does not exist prints a friendly, actionable message instead of
// the raw "manifest.Load: cannot read ...: open ...: no such file or
// directory" Go-internals error the cold-start audit flagged.
func TestRunMissingManifestFriendlyError(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(t.TempDir()); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(wd); err != nil {
			t.Errorf("chdir back to %s: %v", wd, err)
		}
	})

	const want = "pb: no ready.yaml found in this directory — run 'pb init' to generate one, or pass --manifest PATH\n"
	stderr := captureStderr(t, func() {
		if got := run([]string{"lint"}); got != 1 {
			t.Errorf("run(lint) = %d, want 1", got)
		}
	})
	if stderr != want {
		t.Errorf("run(lint) stderr = %q, want %q", stderr, want)
	}
}

// TestRunLintInvalidYAMLDropsGoTypeName proves a strict-decode yaml error
// (e.g. an unknown field) surfaces the yaml line info but drops the Go type
// name yaml.v3 embeds (e.g. "manifest.Ready") — the cold-start audit flagged
// this as Go-internals leaking into a user-facing error.
func TestRunLintInvalidYAMLDropsGoTypeName(t *testing.T) {
	stderr := captureStderr(t, func() {
		got := run([]string{
			"lint",
			"--manifest", "../../internal/manifest/testdata/invalid_unknown_field.yaml",
		})
		if got != 1 {
			t.Errorf("run(lint) = %d, want 1", got)
		}
	})
	if !strings.HasPrefix(stderr, "pb: ready.yaml is invalid: ") {
		t.Errorf("run(lint) stderr = %q, want prefix %q", stderr, "pb: ready.yaml is invalid: ")
	}
	if strings.Contains(stderr, "manifest.Ready") {
		t.Errorf("run(lint) stderr = %q, want no Go type name (manifest.Ready)", stderr)
	}
	if !strings.Contains(stderr, "line 8") {
		t.Errorf("run(lint) stderr = %q, want it to keep the yaml line info", stderr)
	}
}

// TestRunSeedPrintsMessage proves "pb seed" prints a one-line confirmation
// instead of nothing on success — matching "pb up"/"pb ready"'s existing
// success-line convention, for both the declared-steps and no-steps cases.
func TestRunSeedPrintsMessage(t *testing.T) {
	dir := t.TempDir()
	withSteps := filepath.Join(dir, "seed.yaml")
	if err := os.WriteFile(withSteps, []byte(`service: seed-svc
run:
  modes: [local]
  local:
    start: "sleep 9999"
seed:
  - name: step-one
    run: "true"
  - name: step-two
    run: "true"
`), 0o644); err != nil {
		t.Fatalf("write %s: %v", withSteps, err)
	}

	noSteps := filepath.Join(dir, "noseed.yaml")
	if err := os.WriteFile(noSteps, []byte(`service: seed-svc
run:
  modes: [local]
  local:
    start: "sleep 9999"
`), 0o644); err != nil {
		t.Fatalf("write %s: %v", noSteps, err)
	}

	out := captureStdout(t, func() {
		if got := run([]string{"seed", "--manifest", withSteps}); got != 0 {
			t.Errorf("run(seed --manifest %s) = %d, want 0", withSteps, got)
		}
	})
	if want := "seed: done (2 steps)\n"; !strings.HasSuffix(out, want) {
		t.Errorf("run(seed) stdout = %q, want suffix %q", out, want)
	}

	out = captureStdout(t, func() {
		if got := run([]string{"seed", "--manifest", noSteps}); got != 0 {
			t.Errorf("run(seed --manifest %s) = %d, want 0", noSteps, got)
		}
	})
	if want := "seed: no seed steps declared\n"; out != want {
		t.Errorf("run(seed) stdout = %q, want %q", out, want)
	}
}

// TestRunInitPrintsNextSteps proves "pb init" prints a next-steps block after
// writing ready.yaml (the cold-start audit found init otherwise looked like
// it did nothing), but skips it when writing to stdout via --out -.
func TestRunInitPrintsNextSteps(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "ready.yaml")
	stdout := captureStdout(t, func() {
		if got := run([]string{"init", "--out", out, dir}); got != 0 {
			t.Fatalf("run(init) = %d, want 0", got)
		}
	})
	if !strings.Contains(stdout, "next steps:") {
		t.Errorf("run(init) stdout = %q, want it to contain a next-steps block", stdout)
	}

	stdout = captureStdout(t, func() {
		if got := run([]string{"init", "--out", "-", dir}); got != 0 {
			t.Fatalf("run(init --out -) = %d, want 0", got)
		}
	})
	if strings.Contains(stdout, "next steps:") {
		t.Errorf("run(init --out -) stdout = %q, want no next-steps block when writing to stdout", stdout)
	}
}
