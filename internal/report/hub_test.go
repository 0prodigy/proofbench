package report

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/launchwings/proofbench/internal/evidence"
)

// ─── helpers ─────────────────────────────────────────────────────────────────

// newBundle builds a hand-crafted Bundle for testing without touching disk.
func newBundle() *evidence.Bundle {
	return &evidence.Bundle{
		Dir: "/evidence/20260704-101500-reverify",
		M: &evidence.Manifest{
			Schema:     2,
			Ticket:     "ENG-20190",
			RunID:      "20260704-101500-reverify",
			Claim:      "sync(verse) propagates to sequenceNote on release",
			Phase:      "reverify",
			Kind:       "after",
			PairsWith:  "20260702-144606-verify",
			ProofLevel: "L4",
			Surface: map[string]string{
				"substrate": "k8s-attach",
				"cluster":   "delta-akash",
				"env":       "delta",
			},
			StartedAt:  "2026-07-04T10:15:00Z",
			FinishedAt: "2026-07-04T10:15:41Z",
			Checks: []evidence.Check{
				{
					Name:      "order-roundtrip",
					State:     evidence.CheckPass,
					Expect:    "db.orders.rows > @before",
					Observed:  "42 > 17",
					Artifacts: []string{"03-fire.log"},
				},
				{
					Name:   "e2e-ui",
					State:  evidence.CheckNotRun,
					Reason: "gate: cluster deploy pending",
				},
			},
			Artifacts: []evidence.Artifact{
				{
					Type:       evidence.ArtifactCommand,
					Name:       "03-fire",
					Path:       "03-fire.log",
					SHA256:     "abc123",
					Provenance: evidence.ProvenanceHarness,
					Meta: map[string]any{
						"cmd":         "./lyric-fire-execution.sh",
						"exitCode":    float64(0),
						"durationSec": float64(41),
					},
				},
				{
					Type:       evidence.ArtifactSnapshot,
					Name:       "sn-post",
					Path:       "sn-post.json",
					Provenance: evidence.ProvenanceHarness,
				},
			},
			Verdict: evidence.VerdictPass,
			Note:    "set last, from artifacts",
		},
	}
}

// ─── Markdown tests ───────────────────────────────────────────────────────────

func TestMarkdown_Header(t *testing.T) {
	b := newBundle()
	md, err := Markdown(b)
	if err != nil {
		t.Fatalf("Markdown: %v", err)
	}
	if !strings.HasPrefix(md, "✅ **PASS**") {
		t.Errorf("expected header to start with '✅ **PASS**', got: %q", md[:min(len(md), 60)])
	}
	if !strings.Contains(md, "sync(verse) propagates to sequenceNote on release") {
		t.Error("claim missing from header")
	}
}

func TestMarkdown_MetaLine(t *testing.T) {
	b := newBundle()
	md, err := Markdown(b)
	if err != nil {
		t.Fatalf("Markdown: %v", err)
	}
	// proof level, phase, kind
	for _, want := range []string{"proof level L4", "phase reverify", "kind after"} {
		if !strings.Contains(md, want) {
			t.Errorf("meta line missing %q\nfull output:\n%s", want, md)
		}
	}
	// surface keys are sorted: cluster=delta-akash, env=delta, substrate=k8s-attach
	if !strings.Contains(md, "cluster=delta-akash") {
		t.Error("surface cluster missing from meta line")
	}
	if !strings.Contains(md, "env=delta") {
		t.Error("surface env missing from meta line")
	}
}

func TestMarkdown_ChecksTable(t *testing.T) {
	b := newBundle()
	md, err := Markdown(b)
	if err != nil {
		t.Fatalf("Markdown: %v", err)
	}
	if !strings.Contains(md, "| check | state | expect | observed |") {
		t.Error("checks table header missing")
	}
	if !strings.Contains(md, "order-roundtrip") {
		t.Error("check name missing from table")
	}
	if !strings.Contains(md, "pass") {
		t.Error("check state 'pass' missing from table")
	}
	// not-run check should show reason as observed
	if !strings.Contains(md, "gate: cluster deploy pending") {
		t.Error("not-run reason missing from observed column")
	}
	if !strings.Contains(md, "db.orders.rows > @before") {
		t.Error("expect missing from table")
	}
}

func TestMarkdown_ArtifactsList(t *testing.T) {
	b := newBundle()
	md, err := Markdown(b)
	if err != nil {
		t.Fatalf("Markdown: %v", err)
	}
	if !strings.Contains(md, "**Artifacts**") {
		t.Error("artifacts section header missing")
	}
	// command artifact: name, exit N, Ns
	if !strings.Contains(md, "`03-fire`") {
		t.Error("command artifact name missing")
	}
	if !strings.Contains(md, "exit 0") {
		t.Error("exit code missing from command artifact line")
	}
	if !strings.Contains(md, "41s") {
		t.Error("duration missing from command artifact line")
	}
	// snapshot artifact
	if !strings.Contains(md, "`sn-post`") {
		t.Error("snapshot artifact name missing")
	}
	if !strings.Contains(md, "(snapshot)") {
		t.Error("snapshot type missing from artifact line")
	}
}

func TestMarkdown_Footer(t *testing.T) {
	b := newBundle()
	md, err := Markdown(b)
	if err != nil {
		t.Fatalf("Markdown: %v", err)
	}
	if !strings.Contains(md, "/evidence/20260704-101500-reverify") {
		t.Error("bundle dir missing from footer")
	}
	if !strings.Contains(md, "20260704-101500-reverify") {
		t.Error("runId missing from footer")
	}
}

func TestMarkdown_Deterministic(t *testing.T) {
	b := newBundle()
	md1, err := Markdown(b)
	if err != nil {
		t.Fatalf("first Markdown: %v", err)
	}
	md2, err := Markdown(b)
	if err != nil {
		t.Fatalf("second Markdown: %v", err)
	}
	if md1 != md2 {
		t.Error("Markdown output is not deterministic")
	}
}

func TestMarkdown_NilBundle(t *testing.T) {
	_, err := Markdown(nil)
	if err == nil {
		t.Error("expected error for nil bundle")
	}
}

func TestMarkdown_PipeEscaping(t *testing.T) {
	b := newBundle()
	b.M.Checks = []evidence.Check{
		{
			Name:     "pipe|check",
			State:    evidence.CheckPass,
			Expect:   "a|b",
			Observed: "x|y",
		},
	}
	md, err := Markdown(b)
	if err != nil {
		t.Fatalf("Markdown: %v", err)
	}
	// Pipe characters in table cells must be escaped so the table isn't broken.
	if strings.Contains(md, "| a|b |") {
		t.Error("unescaped pipe in expect column would break Markdown table")
	}
	if !strings.Contains(md, `a\|b`) {
		t.Error("escaped pipe expected in expect column")
	}
}

// ─── WriteHub tests ───────────────────────────────────────────────────────────

// writeManifest writes a manifest.json into dir (created if needed).
func writeManifest(t *testing.T, dir string, m *evidence.Manifest) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0o644); err != nil {
		t.Fatalf("write manifest.json: %v", err)
	}
}

func TestWriteHub_OneV2OneMalformed(t *testing.T) {
	root := t.TempDir()

	// --- valid v2 bundle ---
	goodDir := filepath.Join(root, "20260704-101500-reverify")
	writeManifest(t, goodDir, &evidence.Manifest{
		Schema:     2,
		RunID:      "20260704-101500-reverify",
		Claim:      "sync(verse) propagates to sequenceNote on release",
		Phase:      "reverify",
		Kind:       "after",
		ProofLevel: "L4",
		StartedAt:  "2026-07-04T10:15:00Z",
		Surface:    map[string]string{"cluster": "delta-akash", "env": "delta"},
		Checks: []evidence.Check{
			{Name: "order-roundtrip", State: evidence.CheckPass, Expect: "db.orders.rows > @before", Observed: "42 > 17"},
			{Name: "e2e-ui", State: evidence.CheckNotRun, Reason: "gate pending"},
		},
		Artifacts: []evidence.Artifact{
			{
				Type: evidence.ArtifactCommand, Name: "03-fire", Path: "03-fire.log",
				Meta: map[string]any{"cmd": "./fire.sh", "exitCode": float64(0), "durationSec": float64(41)},
			},
			{
				Type: evidence.ArtifactScreenshot, Name: "ui-after", Path: "04-shot.png",
			},
		},
		Verdict: evidence.VerdictPass,
	})

	// --- malformed bundle: not valid JSON ---
	badDir := filepath.Join(root, "20260703-000000-bad")
	if err := os.MkdirAll(badDir, 0o755); err != nil {
		t.Fatalf("mkdir bad: %v", err)
	}
	if err := os.WriteFile(filepath.Join(badDir, "manifest.json"), []byte("not json {{{"), 0o644); err != nil {
		t.Fatalf("write bad manifest: %v", err)
	}

	// write hub
	outFile := filepath.Join(t.TempDir(), "index.html")
	if err := WriteHub(root, outFile); err != nil {
		t.Fatalf("WriteHub: %v", err)
	}

	data, err := os.ReadFile(outFile)
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	html := string(data)

	// must contain the good bundle's claim
	if !strings.Contains(html, "sync(verse) propagates to sequenceNote on release") {
		t.Error("good bundle claim not in hub HTML")
	}
	// must contain a verdict badge for pass
	if !strings.Contains(html, "verdict-pass") {
		t.Error("pass verdict badge class not in hub HTML")
	}
	// must contain runId
	if !strings.Contains(html, "20260704-101500-reverify") {
		t.Error("runId not in hub HTML")
	}
	// must contain checks
	if !strings.Contains(html, "order-roundtrip") {
		t.Error("check name not in hub HTML")
	}
	// must contain exit chip for the command artifact
	if !strings.Contains(html, "exit 0") {
		t.Error("exit code chip not in hub HTML")
	}
	// screenshot href/src must resolve from the hub page's directory, not be
	// the bundle-relative path verbatim (which would 404 from .pb/hub/).
	wantRel, err := filepath.Rel(filepath.Dir(outFile), goodDir)
	if err != nil {
		t.Fatalf("rel outFile->goodDir: %v", err)
	}
	wantHref := filepath.Join(wantRel, "04-shot.png")
	if !strings.Contains(html, `src="`+wantHref+`"`) {
		t.Errorf("screenshot src %q not in hub HTML", wantHref)
	}
	if strings.Contains(html, `src="04-shot.png"`) {
		t.Error("screenshot src is the bundle-relative path verbatim")
	}
	// malformed dir must appear in skipped section — not a crash
	if !strings.Contains(html, "20260703-000000-bad") {
		t.Error("malformed bundle dir not in skipped section")
	}
	// must not contain JS imports or external URLs
	if strings.Contains(html, "cdn.") || strings.Contains(html, "unpkg.") || strings.Contains(html, "<script src") {
		t.Error("hub HTML contains external script/CDN reference")
	}
}

func TestWriteHub_EmptyRoot(t *testing.T) {
	root := t.TempDir()
	out := filepath.Join(t.TempDir(), "sub", "index.html")
	if err := WriteHub(root, out); err != nil {
		t.Fatalf("WriteHub with empty root: %v", err)
	}
	if _, err := os.Stat(out); err != nil {
		t.Fatalf("output file not created: %v", err)
	}
}

func TestWriteHub_MissingRoot(t *testing.T) {
	// A root that does not exist should not crash — treat as empty.
	out := filepath.Join(t.TempDir(), "index.html")
	if err := WriteHub("/nonexistent/path/xyz", out); err != nil {
		t.Fatalf("WriteHub with missing root should not error: %v", err)
	}
}

func TestWriteHub_NewestFirst(t *testing.T) {
	root := t.TempDir()

	for _, tc := range []struct {
		dir       string
		startedAt string
		claim     string
	}{
		{"older", "2026-07-01T10:00:00Z", "older claim"},
		{"newer", "2026-07-04T10:00:00Z", "newer claim"},
	} {
		writeManifest(t, filepath.Join(root, tc.dir), &evidence.Manifest{
			Schema:    2,
			RunID:     tc.dir,
			Claim:     tc.claim,
			Phase:     "verify",
			StartedAt: tc.startedAt,
			Verdict:   evidence.VerdictPass,
			Artifacts: []evidence.Artifact{},
		})
	}

	out := filepath.Join(t.TempDir(), "index.html")
	if err := WriteHub(root, out); err != nil {
		t.Fatalf("WriteHub: %v", err)
	}
	html, _ := os.ReadFile(out)
	olderIdx := strings.Index(string(html), "older claim")
	newerIdx := strings.Index(string(html), "newer claim")
	if newerIdx > olderIdx {
		t.Error("expected newer bundle to appear before older bundle in hub")
	}
}
