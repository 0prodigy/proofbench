package agentruntime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeFakeClaude writes script as an executable "claude" in a fresh temp
// dir and prepends that dir to PATH, so exec.LookPath("claude") finds it —
// the PATH-shim pattern used by internal/substrate/substrate_test.go.
func writeFakeClaude(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "claude")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return dir
}

// versionStub is prefixed to every fake claude script so Preflight's
// `claude --version` call succeeds before the script's round-specific
// behavior runs.
const versionStub = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Claude Code 1.2.3 (test)"
  exit 0
fi
`

func TestClaudeCodePreflightMissingBinary(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	rt, err := New(KindClaudeCode)
	if err != nil {
		t.Fatal(err)
	}
	err = rt.Preflight()
	if err == nil {
		t.Fatal("want Preflight error when claude is not on PATH")
	}
	if !strings.Contains(err.Error(), "PB_CLAUDE_BIN") || !strings.Contains(err.Error(), "install Claude Code") {
		t.Fatalf("error %q should name the recovery (install Claude Code / set PB_CLAUDE_BIN)", err.Error())
	}
}

func TestClaudeCodePreflightWarnsOnDualAuth(t *testing.T) {
	writeFakeClaude(t, versionStub)
	t.Setenv("ANTHROPIC_API_KEY", "sk-test")
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-test")

	rt, err := New(KindClaudeCode)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Preflight(); err != nil {
		t.Fatalf("Preflight should not fail on dual auth, only warn: %v", err)
	}
	w, ok := rt.(interface{ Warnings() []string })
	if !ok {
		t.Fatal("claude-code runtime must expose Warnings() []string")
	}
	if len(w.Warnings()) == 0 {
		t.Error("want a warning when both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set")
	}
}

func TestClaudeCodeHappyPath(t *testing.T) {
	dir := writeFakeClaude(t, versionStub+`
echo "$@" > "$ARGV_FILE"
cat <<'EOF'
{"type":"system","subtype":"init","session_id":"sess-1"}
{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess-1","total_cost_usd":0.042,"duration_ms":1234,"num_turns":2,"structured_output":{"checks":[{"name":"new-check","level":"L2","exercise":"curl :8080/x","expect":["exitCode(new-check)==0"]}]},"permission_denials":[],"errors":[]}
EOF
`)
	argvFile := filepath.Join(dir, "argv.txt")
	t.Setenv("ARGV_FILE", argvFile)

	rt, err := New(KindClaudeCode)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Preflight(); err != nil {
		t.Fatalf("Preflight: %v", err)
	}

	outDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outDir, ProposalSchemaFile), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := rt.RunRound(RoundOpts{Dir: t.TempDir(), Prompt: "explore", MaxTurns: 3, OutDir: outDir})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if res.Status != StatusProposed {
		t.Fatalf("Status = %q, want %q (reason %q)", res.Status, StatusProposed, res.Reason)
	}
	if res.SessionID != "sess-1" {
		t.Errorf("SessionID = %q, want sess-1", res.SessionID)
	}
	if res.CostUSD != 0.042 {
		t.Errorf("CostUSD = %v, want 0.042", res.CostUSD)
	}
	if res.NumTurns != 2 {
		t.Errorf("NumTurns = %d, want 2", res.NumTurns)
	}
	if res.DurationMS != 1234 {
		t.Errorf("DurationMS = %d, want 1234", res.DurationMS)
	}
	if len(res.Proposal) == 0 {
		t.Error("want non-empty Proposal")
	}
	if _, err := os.Stat(filepath.Join(outDir, "claude-round.jsonl")); err != nil {
		t.Errorf("claude-round.jsonl not written: %v", err)
	}

	argv, err := os.ReadFile(argvFile)
	if err != nil {
		t.Fatalf("fake claude did not receive argv: %v", err)
	}
	argvStr := string(argv)
	if strings.Contains(argvStr, "--bare") {
		t.Errorf("argv must never contain --bare: %s", argvStr)
	}
	if strings.Contains(argvStr, "--dangerously-skip-permissions") {
		t.Errorf("argv must never contain --dangerously-skip-permissions: %s", argvStr)
	}
	if !strings.Contains(argvStr, "--max-turns 3") {
		t.Errorf("argv missing --max-turns 3: %s", argvStr)
	}
	if !strings.Contains(argvStr, "--permission-mode dontAsk") {
		t.Errorf("argv missing --permission-mode dontAsk: %s", argvStr)
	}
	if !strings.Contains(argvStr, "--no-session-persistence") {
		t.Errorf("argv missing --no-session-persistence: %s", argvStr)
	}

	fields := strings.Fields(argvStr)
	schemaIdx := -1
	for i, f := range fields {
		if f == "--json-schema" {
			schemaIdx = i
			break
		}
	}
	if schemaIdx == -1 || schemaIdx+1 >= len(fields) {
		t.Fatalf("argv missing --json-schema value: %s", argvStr)
	}
	if !json.Valid([]byte(fields[schemaIdx+1])) {
		t.Errorf("--json-schema value must be inline JSON, not a path, got %q", fields[schemaIdx+1])
	}
}

func TestClaudeCodeAuthFailure(t *testing.T) {
	writeFakeClaude(t, versionStub+`
cat <<'EOF'
{"type":"system","subtype":"api_retry","error":"authentication_failed"}
{"type":"result","subtype":"error_during_execution","is_error":true,"result":"auth failed","session_id":"sess-2","total_cost_usd":0,"duration_ms":10,"num_turns":0,"errors":["authentication_failed"]}
EOF
exit 1
`)
	rt, err := New(KindClaudeCode)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Preflight(); err != nil {
		t.Fatalf("Preflight: %v", err)
	}

	outDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outDir, ProposalSchemaFile), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := rt.RunRound(RoundOpts{Dir: t.TempDir(), Prompt: "explore", MaxTurns: 3, OutDir: outDir})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if res.Status != StatusNotRun {
		t.Fatalf("Status = %q, want %q", res.Status, StatusNotRun)
	}
	if !strings.Contains(res.Reason, "auth invalid") {
		t.Errorf("Reason = %q, want it to name auth invalid", res.Reason)
	}
}

func TestClaudeCodeMaxTurnsExhausted(t *testing.T) {
	writeFakeClaude(t, versionStub+`
cat <<'EOF'
{"type":"result","subtype":"error_max_turns","is_error":true,"result":"max turns reached","session_id":"sess-3","total_cost_usd":0.5,"duration_ms":9000,"num_turns":5}
EOF
`)
	rt, err := New(KindClaudeCode)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Preflight(); err != nil {
		t.Fatalf("Preflight: %v", err)
	}

	outDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outDir, ProposalSchemaFile), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := rt.RunRound(RoundOpts{Dir: t.TempDir(), Prompt: "explore", MaxTurns: 5, OutDir: outDir})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if res.Status != StatusInconclusive {
		t.Fatalf("Status = %q, want %q", res.Status, StatusInconclusive)
	}
	if !strings.Contains(res.Reason, "budget exhausted") {
		t.Errorf("Reason = %q, want it to name budget exhausted", res.Reason)
	}
}

func TestClaudeCodeApiRetryThenSuccess(t *testing.T) {
	// A transient api_retry (e.g. an overloaded/529 that recovered) must not
	// reclassify a subsequent successful terminal result as not-run.
	writeFakeClaude(t, versionStub+`
cat <<'EOF'
{"type":"system","subtype":"api_retry","error":"overloaded"}
{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess-4","total_cost_usd":0.01,"duration_ms":100,"num_turns":1,"structured_output":{"checks":[]}}
EOF
`)
	rt, err := New(KindClaudeCode)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Preflight(); err != nil {
		t.Fatalf("Preflight: %v", err)
	}

	outDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outDir, ProposalSchemaFile), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := rt.RunRound(RoundOpts{Dir: t.TempDir(), Prompt: "explore", MaxTurns: 3, OutDir: outDir})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if res.Status != StatusProposed {
		t.Fatalf("Status = %q, want %q (reason %q) — a recovered api_retry must not override a successful result", res.Status, StatusProposed, res.Reason)
	}
}

func TestClaudeCodeRateLimitNoSuccess(t *testing.T) {
	writeFakeClaude(t, versionStub+`
cat <<'EOF'
{"type":"result","subtype":"error_during_execution","is_error":true,"result":"rate limited","session_id":"sess-5","total_cost_usd":0,"duration_ms":10,"num_turns":0,"errors":["rate_limit"]}
EOF
exit 1
`)
	rt, err := New(KindClaudeCode)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Preflight(); err != nil {
		t.Fatalf("Preflight: %v", err)
	}

	outDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outDir, ProposalSchemaFile), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := rt.RunRound(RoundOpts{Dir: t.TempDir(), Prompt: "explore", MaxTurns: 3, OutDir: outDir})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if res.Status != StatusNotRun {
		t.Fatalf("Status = %q, want %q", res.Status, StatusNotRun)
	}
	if !strings.Contains(res.Reason, "rate-limited") {
		t.Errorf("Reason = %q, want it to name rate-limited", res.Reason)
	}
}

func TestClaudeCodeWallClockTimeout(t *testing.T) {
	writeFakeClaude(t, versionStub+`
sleep 5
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess-6","structured_output":{"checks":[]}}'
`)
	rt, err := New(KindClaudeCode)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Preflight(); err != nil {
		t.Fatalf("Preflight: %v", err)
	}

	outDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outDir, ProposalSchemaFile), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	res, err := rt.RunRound(RoundOpts{Dir: t.TempDir(), Prompt: "explore", MaxTurns: 3, OutDir: outDir, Timeout: 200 * time.Millisecond})
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if res.Status != StatusInconclusive {
		t.Fatalf("Status = %q, want %q", res.Status, StatusInconclusive)
	}
	if !strings.Contains(res.Reason, "wall-clock timeout") {
		t.Errorf("Reason = %q, want it to name wall-clock timeout", res.Reason)
	}
	if elapsed > 5*time.Second {
		t.Errorf("RunRound took %v after a 200ms timeout, want a prompt return (< 5s)", elapsed)
	}
}

func TestClaudeCodeArgRejected(t *testing.T) {
	// Reproduces the real-world moat-blocker: the CLI rejects the invocation
	// itself (a bad --json-schema value) before a single round begins — no
	// stream-json line is ever written, only a stderr usage/arg error. This
	// must classify as StatusNotRun ("the round never produced a result"),
	// not StatusInconclusive ("ran but produced no proposal").
	writeFakeClaude(t, versionStub+`
echo "Error: --json-schema is not valid JSON: JSON Parse error: Unexpected token '.'" >&2
exit 1
`)
	rt, err := New(KindClaudeCode)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Preflight(); err != nil {
		t.Fatalf("Preflight: %v", err)
	}

	outDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outDir, ProposalSchemaFile), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := rt.RunRound(RoundOpts{Dir: t.TempDir(), Prompt: "explore", MaxTurns: 3, OutDir: outDir})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if res.Status != StatusNotRun {
		t.Fatalf("Status = %q, want %q (reason %q)", res.Status, StatusNotRun, res.Reason)
	}
	if !strings.Contains(res.Reason, "runtime rejected invocation") {
		t.Errorf("Reason = %q, want it to name runtime rejected invocation", res.Reason)
	}
	if !strings.Contains(res.Reason, "not valid JSON") {
		t.Errorf("Reason = %q, want it to quote the stderr first line", res.Reason)
	}
}

func TestClaudeCodeGarbageStdout(t *testing.T) {
	writeFakeClaude(t, versionStub+`
echo "not json at all"
echo "{broken"
`)
	rt, err := New(KindClaudeCode)
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Preflight(); err != nil {
		t.Fatalf("Preflight: %v", err)
	}

	outDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outDir, ProposalSchemaFile), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := rt.RunRound(RoundOpts{Dir: t.TempDir(), Prompt: "explore", MaxTurns: 3, OutDir: outDir})
	if err != nil {
		t.Fatalf("RunRound: %v", err)
	}
	if res.Status != StatusInconclusive {
		t.Fatalf("Status = %q, want %q", res.Status, StatusInconclusive)
	}
	if !strings.Contains(res.Reason, "protocol error") {
		t.Errorf("Reason = %q, want it to name protocol error", res.Reason)
	}
}
