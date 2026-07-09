package main

import (
	"os"
	"path/filepath"
	"testing"
)

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
