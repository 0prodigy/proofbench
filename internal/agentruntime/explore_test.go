package agentruntime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/0prodigy/proofbench/internal/manifest"
)

func testManifest() *manifest.Ready {
	return &manifest.Ready{
		Service: "orders-api",
		Role:    "backend",
		Checks: []manifest.CheckSpec{
			{Name: "health", Level: "L1"},
		},
		Drive: map[string]manifest.DriveVerb{
			"place-order": {Run: "scripts/place-order.sh"},
		},
		Resources: map[string]manifest.Resource{
			"mongo": {Type: "mongodb"},
		},
	}
}

func TestExploreHappyPath(t *testing.T) {
	writeFakeClaude(t, versionStub+`
cat <<'EOF'
{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess-9","total_cost_usd":0.1,"duration_ms":500,"num_turns":1,"structured_output":{"checks":[{"name":"cancel-order","level":"L3","exercise":"curl :8080/cancel","expect":["exitCode(cancel-order)==0"],"driver":"exec","rationale":"cancellation path is uncovered"}]}}
EOF
`)

	dir := t.TempDir()
	outDir := filepath.Join(t.TempDir(), "round-out")

	res, err := Explore(testManifest(), dir, outDir, KindClaudeCode, 3)
	if err != nil {
		t.Fatalf("Explore: %v", err)
	}
	if res.Status != StatusProposed {
		t.Fatalf("Status = %q, want %q (reason %q)", res.Status, StatusProposed, res.Reason)
	}

	proposedPath := filepath.Join(outDir, "proposed-checks.json")
	data, err := os.ReadFile(proposedPath)
	if err != nil {
		t.Fatalf("proposed-checks.json not written: %v", err)
	}
	var p proposal
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatalf("proposed-checks.json is not valid JSON: %v", err)
	}
	if len(p.Checks) != 1 || p.Checks[0].Name != "cancel-order" {
		t.Fatalf("got proposal %+v, want one check named cancel-order", p)
	}

	roundPath := filepath.Join(outDir, "round.json")
	rd, err := os.ReadFile(roundPath)
	if err != nil {
		t.Fatalf("round.json not written: %v", err)
	}
	var ra roundArtifact
	if err := json.Unmarshal(rd, &ra); err != nil {
		t.Fatalf("round.json is not valid JSON: %v", err)
	}
	if ra.Status != StatusProposed {
		t.Errorf("round.json status = %q, want %q", ra.Status, StatusProposed)
	}
	if ra.SessionID != "sess-9" {
		t.Errorf("round.json sessionId = %q, want sess-9", ra.SessionID)
	}
	if ra.RuntimeVersion == "" {
		t.Error("round.json runtimeVersion should be populated from claude --version")
	}

	if _, err := os.Stat(filepath.Join(dir, "ready.yaml")); !os.IsNotExist(err) {
		t.Fatalf("Explore must never write ready.yaml, got err=%v", err)
	}
}

func TestExploreMalformedProposal(t *testing.T) {
	// structured_output is present but a check is missing required fields
	// (no "expect"), so it must be rejected as malformed rather than proposed.
	writeFakeClaude(t, versionStub+`
cat <<'EOF'
{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess-10","total_cost_usd":0.1,"duration_ms":500,"num_turns":1,"structured_output":{"checks":[{"name":"cancel-order","level":"L3"}]}}
EOF
`)

	dir := t.TempDir()
	outDir := filepath.Join(t.TempDir(), "round-out")

	res, err := Explore(testManifest(), dir, outDir, KindClaudeCode, 3)
	if err != nil {
		t.Fatalf("Explore: %v", err)
	}
	if res.Status != StatusInconclusive {
		t.Fatalf("Status = %q, want %q", res.Status, StatusInconclusive)
	}
	if !strings.Contains(res.Reason, "malformed proposal") {
		t.Errorf("Reason = %q, want it to name malformed proposal", res.Reason)
	}
	if _, err := os.Stat(filepath.Join(outDir, "proposed-checks.json")); !os.IsNotExist(err) {
		t.Errorf("proposed-checks.json must not be written for a malformed proposal, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(outDir, "round.json")); err != nil {
		t.Errorf("round.json should still be written on a malformed proposal: %v", err)
	}
}

func TestExploreMissingBinary(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	dir := t.TempDir()
	outDir := filepath.Join(t.TempDir(), "round-out")

	res, err := Explore(testManifest(), dir, outDir, KindClaudeCode, 3)
	if err != nil {
		t.Fatalf("Explore: %v", err)
	}
	if res.Status != StatusNotRun {
		t.Fatalf("Status = %q, want %q", res.Status, StatusNotRun)
	}
	if _, err := os.Stat(filepath.Join(outDir, "round.json")); err != nil {
		t.Errorf("round.json should still be written when the runtime is unavailable: %v", err)
	}
}

func TestValidProposal(t *testing.T) {
	tests := []struct {
		name string
		data string
		want bool
	}{
		{"valid single check", `{"checks":[{"name":"a","level":"L1","exercise":"x","expect":["exitCode(a)==0"]}]}`, true},
		{"valid empty checks", `{"checks":[]}`, true},
		{"missing checks key", `{}`, false},
		{"null checks", `{"checks":null}`, false},
		{"check missing expect", `{"checks":[{"name":"a","level":"L1","exercise":"x"}]}`, false},
		{"not json", `not json`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := validProposal([]byte(tt.data)); got != tt.want {
				t.Errorf("validProposal(%s) = %v, want %v", tt.data, got, tt.want)
			}
		})
	}
}
