package agentruntime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Environment variables claudeCodeRuntime reads. ADR-0014: we shell out to
// the customer's own `claude` install and let it read its own auth
// environment — proofbench never inspects or forwards credential values,
// only whether these two happen to both be set (a genuine ambiguity in the
// customer's own environment, not our secret).
const (
	envClaudeBin        = "PB_CLAUDE_BIN"
	envAnthropicAPIKey  = "ANTHROPIC_API_KEY"
	envClaudeOAuthToken = "CLAUDE_CODE_OAUTH_TOKEN"
)

const (
	defaultRoundTimeout = 15 * time.Minute
	killGracePeriod     = 10 * time.Second
	preflightTimeout    = 5 * time.Second
	preflightWaitDelay  = 2 * time.Second
)

// roundLogFile and roundStderrFile are the on-disk names RunRound writes a
// round's raw stdout/stderr to inside RoundOpts.OutDir — never held in
// memory, and named in reasons so a human can go inspect them.
const (
	roundLogFile    = "claude-round.jsonl"
	roundStderrFile = "claude-round.stderr"
)

// maxRoundLogLine bounds how much of a single stream-json line RunRound will
// buffer while re-reading the round log. A line beyond this is tolerated —
// skipped rather than buffered in full or treated as a fatal read error.
const maxRoundLogLine = 1 << 20 // 1MB

// claudeCodeRuntime shells out to the genuine `claude` binary. It never
// forks a fresh identity: no --bare (skips OAuth env reads, breaking
// subscription auth) and no --dangerously-skip-permissions.
type claudeCodeRuntime struct {
	bin      string
	version  string
	warnings []string
}

// Warnings returns non-blocking Preflight conditions worth surfacing (e.g.
// the API-key/OAuth-token ambiguity). Populated only after Preflight runs;
// discovered via type assertion, mirroring substrate's optional Endpoints
// capability — Runtime itself stays frozen.
func (r *claudeCodeRuntime) Warnings() []string { return r.warnings }

// Version returns the "claude --version" string captured during Preflight,
// "" if Preflight has not run yet.
func (r *claudeCodeRuntime) Version() string { return r.version }

// Preflight requires the binary to be found and to answer --version. If
// both an API key and an OAuth token are present it does NOT fail — in -p
// mode the API key silently outranks the subscription token, which is a
// surprise-metered-spend risk rather than a reason to refuse the round — so
// it is recorded as a warning instead.
func (r *claudeCodeRuntime) Preflight() error {
	bin, err := resolveClaudeBin()
	if err != nil {
		return fmt.Errorf("agentruntime: claude-code preflight: %w (install Claude Code / set %s)", err, envClaudeBin)
	}

	ctx, cancel := context.WithTimeout(context.Background(), preflightTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, bin, "--version")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = preflightWaitDelay
	cmd.Cancel = func() error {
		killGroup(cmd, syscall.SIGKILL)
		return nil
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("agentruntime: claude-code preflight: %q --version: %w (install Claude Code / set %s)", bin, err, envClaudeBin)
	}

	r.bin = bin
	r.version = strings.TrimSpace(string(out))

	r.warnings = nil
	if os.Getenv(envAnthropicAPIKey) != "" && os.Getenv(envClaudeOAuthToken) != "" {
		r.warnings = append(r.warnings, fmt.Sprintf(
			"both %s and %s are set — in -p mode the API key silently outranks the subscription token, risking surprise metered spend",
			envAnthropicAPIKey, envClaudeOAuthToken))
	}
	return nil
}

// resolveClaudeBin honors PB_CLAUDE_BIN, else looks up "claude" on PATH.
func resolveClaudeBin() (string, error) {
	if v := os.Getenv(envClaudeBin); v != "" {
		if _, err := exec.LookPath(v); err != nil {
			return "", fmt.Errorf("%s=%q: %w", envClaudeBin, v, err)
		}
		return v, nil
	}
	bin, err := exec.LookPath("claude")
	if err != nil {
		return "", fmt.Errorf("claude: %w", err)
	}
	return bin, nil
}

// RunRound execs the round and maps its stream-json output honestly. It
// never returns an error for a runtime-observed condition (missing binary,
// auth, rate limit, budget, protocol) — only for a genuine harness failure
// (bad opts, unwritable OutDir).
func (r *claudeCodeRuntime) RunRound(o RoundOpts) (*RoundResult, error) {
	if strings.TrimSpace(o.Prompt) == "" {
		return nil, fmt.Errorf("agentruntime: claude-code RunRound: empty prompt")
	}
	if o.OutDir == "" {
		return nil, fmt.Errorf("agentruntime: claude-code RunRound: empty OutDir")
	}
	if o.MaxTurns <= 0 {
		return nil, fmt.Errorf("agentruntime: claude-code RunRound: MaxTurns must be > 0, got %d", o.MaxTurns)
	}

	bin := r.bin
	if bin == "" {
		// Preflight was not called (or failed silently upstream) — resolve
		// now so RunRound stays usable standalone; a miss here is a
		// runtime-observed condition, not a harness error.
		b, err := resolveClaudeBin()
		if err != nil {
			return &RoundResult{Status: StatusNotRun, Reason: "runtime unavailable: " + err.Error()}, nil
		}
		bin = b
	}

	if err := os.MkdirAll(o.OutDir, 0o755); err != nil {
		return nil, fmt.Errorf("agentruntime: claude-code RunRound: mkdir OutDir: %w", err)
	}

	timeout := o.Timeout
	if timeout <= 0 {
		timeout = defaultRoundTimeout
	}

	// The CLI's --json-schema flag takes the schema as inline JSON text, not
	// a file path — Explore already wrote the same bytes to schemaPath for
	// the evidence record; RunRound re-reads and compacts them for the argv
	// value rather than passing the path itself.
	schemaPath := filepath.Join(o.OutDir, ProposalSchemaFile)
	schemaRaw, err := os.ReadFile(schemaPath)
	if err != nil {
		return nil, fmt.Errorf("agentruntime: claude-code RunRound: read %s: %w", schemaPath, err)
	}
	var schemaJSON bytes.Buffer
	if err := json.Compact(&schemaJSON, schemaRaw); err != nil {
		return nil, fmt.Errorf("agentruntime: claude-code RunRound: %s is not valid JSON: %w", schemaPath, err)
	}

	argv := []string{
		bin,
		"-p", o.Prompt,
		"--output-format", "stream-json",
		"--verbose",
		"--max-turns", strconv.Itoa(o.MaxTurns),
		"--permission-mode", "dontAsk",
		"--allowedTools", "Read,Glob,Grep",
		"--disallowedTools", "WebFetch,WebSearch",
		"--json-schema", schemaJSON.String(),
		"--no-session-persistence",
	}

	logPath := filepath.Join(o.OutDir, roundLogFile)
	logFile, err := os.Create(logPath)
	if err != nil {
		return nil, fmt.Errorf("agentruntime: claude-code RunRound: create %s: %w", logPath, err)
	}
	defer logFile.Close()

	stderrPath := filepath.Join(o.OutDir, roundStderrFile)
	stderrFile, err := os.Create(stderrPath)
	if err != nil {
		return nil, fmt.Errorf("agentruntime: claude-code RunRound: create %s: %w", stderrPath, err)
	}
	defer stderrFile.Close()

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = o.Dir
	// Both are real files, not pipes — exec writes to them directly, so
	// Wait() never blocks on a copy goroutine reading a pipe that an escaped
	// descendant (outside the pgid) might still hold open.
	cmd.Stdout = logFile
	cmd.Stderr = stderrFile
	// Own process group so a timeout kill reaches every descendant, mirroring
	// evidence.Run (run.go:71).
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// Belt-and-suspenders bound on however long Wait() is willing to wait
	// after the process is gone.
	cmd.WaitDelay = killGracePeriod / 2

	start := time.Now()
	timedOut, waitErr, startErr := runWithGracefulTimeout(cmd, timeout)
	dur := time.Since(start)

	if startErr != nil {
		return &RoundResult{Status: StatusNotRun, Reason: "runtime unavailable: " + startErr.Error()}, nil
	}
	if timedOut {
		return &RoundResult{Status: StatusInconclusive, Reason: "wall-clock timeout", DurationMS: dur.Milliseconds()}, nil
	}

	return classifyRoundLog(logPath, stderrPath, waitErr, dur), nil
}

// runWithGracefulTimeout starts cmd and waits up to timeout, then sends
// SIGTERM to the whole process group and, if it is still alive after
// killGracePeriod, SIGKILL — mirroring evidence.Run's process-group
// discipline (run.go:68-81) but with a graceful stage first, since an agent
// round may be mid-write on a proposal file.
func runWithGracefulTimeout(cmd *exec.Cmd, timeout time.Duration) (timedOut bool, waitErr error, startErr error) {
	if err := cmd.Start(); err != nil {
		return false, nil, err
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case err := <-done:
		return false, err, nil
	case <-time.After(timeout):
	}

	timedOut = true
	killGroup(cmd, syscall.SIGTERM)

	select {
	case err := <-done:
		return true, err, nil
	case <-time.After(killGracePeriod):
	}

	killGroup(cmd, syscall.SIGKILL)
	return true, <-done, nil
}

// killGroup signals the whole process group cmd started, tolerating the
// group already being gone (ESRCH) same as evidence.Run's Cancel (run.go:73-77).
func killGroup(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, sig)
}

// resultRecord is the final {"type":"result",...} line of claude's
// stream-json output.
type resultRecord struct {
	Type              string             `json:"type"`
	Subtype           string             `json:"subtype"`
	IsError           bool               `json:"is_error"`
	Result            string             `json:"result"`
	SessionID         string             `json:"session_id"`
	TotalCostUSD      float64            `json:"total_cost_usd"`
	DurationMS        int64              `json:"duration_ms"`
	NumTurns          int                `json:"num_turns"`
	StructuredOutput  json.RawMessage    `json:"structured_output"`
	PermissionDenials []permissionDenial `json:"permission_denials"`
	Errors            []string           `json:"errors"`
}

type permissionDenial struct {
	ToolName string `json:"tool_name"`
	Reason   string `json:"reason"`
}

// systemRecord is a {"type":"system",...} line; only api_retry lines carry
// an error category worth watching (auth / rate-limit signals can arrive
// here even when the final result's own subtype is generic).
type systemRecord struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
	Error   string `json:"error"`
}

// scanRoundLog re-reads logPath (the round's on-disk stream-json output,
// never an in-memory copy of stdout) and extracts the last result record
// plus any api_retry error categories observed mid-stream. A single line
// beyond maxRoundLogLine is tolerated — skipped, not fatal — so one runaway
// line can't take down classification of an otherwise-good round.
func scanRoundLog(logPath string) (last *resultRecord, categories map[string]bool, hadAnyLine bool, err error) {
	f, err := os.Open(logPath)
	if err != nil {
		return nil, nil, false, fmt.Errorf("agentruntime: claude-code: open %s: %w", logPath, err)
	}
	defer f.Close()

	categories = map[string]bool{}

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), maxRoundLogLine)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		hadAnyLine = true
		var probe struct{ Type, Subtype string }
		if err := json.Unmarshal(line, &probe); err != nil {
			continue // not a JSON record this protocol version defines
		}
		switch probe.Type {
		case "result":
			var rr resultRecord
			if err := json.Unmarshal(line, &rr); err == nil {
				rr2 := rr
				last = &rr2
			}
		case "system":
			if probe.Subtype == "api_retry" {
				var sr systemRecord
				if err := json.Unmarshal(line, &sr); err == nil && sr.Error != "" {
					categories[sr.Error] = true
				}
			}
		}
	}
	// A too-long line stops Scan() with bufio.ErrTooLong; tolerate it and use
	// whatever was already scanned rather than failing the whole round over
	// one runaway line.
	if serr := sc.Err(); serr != nil && !errors.Is(serr, bufio.ErrTooLong) {
		return last, categories, hadAnyLine, fmt.Errorf("agentruntime: claude-code: scan %s: %w", logPath, serr)
	}
	return last, categories, hadAnyLine, nil
}

// classifyRoundLog maps the round's on-disk log to a RoundResult per the
// tri-state mapping: never pass/fail, always a status honestly derived from
// what was observed (or not observed).
func classifyRoundLog(logPath, stderrPath string, waitErr error, dur time.Duration) *RoundResult {
	last, categories, hadAnyLine, err := scanRoundLog(logPath)
	if err != nil {
		return &RoundResult{
			Status:     StatusInconclusive,
			Reason:     protocolErrorReason(logPath, stderrPath, err, waitErr),
			DurationMS: dur.Milliseconds(),
		}
	}
	return classifyResult(last, categories, hadAnyLine, logPath, stderrPath, waitErr, dur)
}

func classifyResult(last *resultRecord, categories map[string]bool, hadAnyLine bool, logPath, stderrPath string, waitErr error, dur time.Duration) *RoundResult {
	// A terminal success with structured output wins unconditionally — a
	// mid-stream api_retry that recovered (e.g. a transient 529/rate-limit)
	// must not reclassify a good round as not-run.
	if last != nil && last.Subtype == "success" && !last.IsError && len(last.StructuredOutput) > 0 {
		res := resultToRoundResult(last, dur)
		res.Status = StatusProposed
		res.Proposal = []byte(last.StructuredOutput)
		return res
	}

	if last != nil {
		for _, e := range last.Errors {
			categories[e] = true
		}
	}

	// Auth and rate-limit categories are the actionable reason only when the
	// round never reached a successful terminal result.
	if categories["authentication_failed"] || categories["oauth_org_not_allowed"] {
		return &RoundResult{Status: StatusNotRun, Reason: "auth invalid — run `claude setup-token` or `/login`", DurationMS: dur.Milliseconds()}
	}
	if categories["rate_limit"] || categories["overloaded"] || categories["billing_error"] {
		return &RoundResult{Status: StatusNotRun, Reason: "rate-limited: subscription window exhausted; retry after the 5-hour window", DurationMS: dur.Milliseconds()}
	}

	if last == nil {
		// No result record and no turn count observed at all: this can be a
		// genuine mid-round death (inconclusive) or the CLI never accepting
		// the invocation in the first place (not-run) — e.g. an arg-parse
		// error printed to stderr before a single stream-json line was
		// written. Only the latter gets reclassified; a round that emitted
		// any stdout at all is presumed to have actually started.
		if reason, ok := notRunReason(hadAnyLine, dur, stderrPath); ok {
			return &RoundResult{Status: StatusNotRun, Reason: reason, DurationMS: dur.Milliseconds()}
		}
		return &RoundResult{Status: StatusInconclusive, Reason: protocolErrorReason(logPath, stderrPath, waitErr), DurationMS: dur.Milliseconds()}
	}

	res := resultToRoundResult(last, dur)
	switch {
	case last.Subtype == "error_max_turns":
		res.Status = StatusInconclusive
		res.Reason = "budget exhausted (max turns)"
	case last.Subtype == "error_during_execution", last.Subtype == "error_initialization", last.Subtype == "error_interrupted":
		res.Status = StatusInconclusive
		res.Reason = "runtime error: " + last.Result
	default:
		// Includes success-without-structured_output — the agent finished
		// but broke the --json-schema contract; that is a protocol failure,
		// not a proposal.
		res.Status = StatusInconclusive
		res.Reason = protocolErrorReason(logPath, stderrPath, waitErr)
	}
	return res
}

func resultToRoundResult(last *resultRecord, dur time.Duration) *RoundResult {
	res := &RoundResult{
		SessionID:         last.SessionID,
		CostUSD:           last.TotalCostUSD,
		NumTurns:          last.NumTurns,
		DurationMS:        last.DurationMS,
		PermissionDenials: denialStrings(last.PermissionDenials),
	}
	if res.DurationMS == 0 {
		res.DurationMS = dur.Milliseconds()
	}
	return res
}

// notRunProcessThreshold bounds how quickly a process must have exited,
// with zero stdout lines observed, to be treated as never having started a
// round at all (vs. a slow protocol-breaking death mid-round).
const notRunProcessThreshold = 1 * time.Second

// cliUsageErrMarkers are stderr substrings (checked case-insensitively) the
// claude binary itself emits when it rejects an invocation before running
// any round — arg parsing, unknown flags, malformed flag values — as
// distinct from an in-round failure.
var cliUsageErrMarkers = []string{
	"is not valid json",
	"unknown option",
	"unknown argument",
	"unrecognized argument",
	"invalid option",
	"invalid argument",
	"usage:",
}

// notRunReason reports whether a round with no result record should be
// classified StatusNotRun rather than StatusInconclusive: either stderr's
// first line matches a known CLI usage/arg-parse rejection, or the process
// exited near-instantly (notRunProcessThreshold) having emitted no stdout
// lines at all — both signal the runtime never actually started a round.
func notRunReason(hadAnyLine bool, dur time.Duration, stderrPath string) (string, bool) {
	firstLine := firstStderrLine(stderrPath)
	switch {
	case firstLine != "" && looksLikeCLIUsageError(firstLine):
		return firstLine + " — runtime rejected invocation", true
	case !hadAnyLine && dur < notRunProcessThreshold:
		if firstLine != "" {
			return firstLine + " — runtime rejected invocation", true
		}
		return "runtime rejected invocation (exited immediately with no output)", true
	default:
		return "", false
	}
}

// looksLikeCLIUsageError reports whether line reads like the claude binary
// rejecting its own invocation (bad flag, bad flag value) rather than a
// failure that occurred once a round was underway.
func looksLikeCLIUsageError(line string) bool {
	low := strings.ToLower(line)
	for _, m := range cliUsageErrMarkers {
		if strings.Contains(low, m) {
			return true
		}
	}
	return false
}

// firstStderrLine returns the first non-empty trimmed line of the file at
// stderrPath, or "" if it can't be read or is empty — never a fatal error,
// since this is only used to enrich a reason string.
func firstStderrLine(stderrPath string) string {
	f, err := os.Open(stderrPath)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), maxRoundLogLine)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line != "" {
			return line
		}
	}
	return ""
}

// protocolErrorReason names where the raw evidence lives (the round log and
// its stderr sibling) plus any non-nil error worth surfacing (a log-scan
// failure, or the process's own discarded-until-now Wait error), instead of
// discarding that context into an unread buffer.
func protocolErrorReason(logPath, stderrPath string, errs ...error) string {
	reason := fmt.Sprintf("protocol error — raw output at %s", filepath.Base(logPath))
	if stderrPath != "" {
		reason += fmt.Sprintf(" (stderr: %s)", filepath.Base(stderrPath))
	}
	for _, e := range errs {
		if e != nil {
			reason += fmt.Sprintf("; %v", e)
		}
	}
	return reason
}

func denialStrings(ds []permissionDenial) []string {
	if len(ds) == 0 {
		return nil
	}
	out := make([]string, 0, len(ds))
	for _, d := range ds {
		out = append(out, d.ToolName+": "+d.Reason)
	}
	return out
}
