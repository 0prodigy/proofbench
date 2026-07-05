package report

import (
	_ "embed"
	"fmt"
	"html/template"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/launchwings/proofbench/internal/evidence"
)

//go:embed hub.tmpl.html
var hubTmpl string

// hubBundle is the template-facing view of one evidence bundle.
type hubBundle struct {
	// header
	Verdict      string
	VerdictClass string // pass | fail | inconclusive | unknown
	Claim        string
	RunID        string
	MetaSub      string // phase · kind · cluster · env

	// body
	Checks    []hubCheck
	Artifacts []hubArtifact

	// sort key (newest first): startedAt falling back to dir name
	sortKey string
}

type hubCheck struct {
	Name             string
	State            string
	StateClass       string // pass | fail | notrun
	Expect           string
	Observed         string
	Reason           string
	ObservedOrReason string
}

type hubArtifact struct {
	Name    string
	ArtType string
	RelPath string // path from the hub page's directory — used for img src / href

	// command fields
	IsCommand   bool
	CmdString   string
	HasExitCode bool
	ExitOK      bool
	ExitCode    int
	Duration    string

	// screenshot flag
	IsScreenshot bool
}

// hubData is the top-level template context.
type hubData struct {
	GeneratedAt string
	Bundles     []hubBundle
	Skipped     []string
}

// WriteHub scans root for */manifest.json (schema 1 and 2 via evidence.Open),
// renders a self-contained static index.html to outFile (inline CSS, zero JS
// deps, zero external requests). Bundles are shown newest-first. Malformed
// manifests are skipped with a note — never a crash.
func WriteHub(root, outFile string) error {
	// Ensure output directory exists.
	if err := os.MkdirAll(filepath.Dir(outFile), 0o755); err != nil {
		return fmt.Errorf("hub: mkdir %s: %w", filepath.Dir(outFile), err)
	}

	var bundles []hubBundle
	var skipped []string

	// Walk root looking for */manifest.json at depth 1 (immediate children).
	entries, err := os.ReadDir(root)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("hub: read root %s: %w", root, err)
	}
	// Sort entries so iteration order is defined; we re-sort by sortKey below.
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		mpath := filepath.Join(dir, "manifest.json")
		if _, serr := os.Stat(mpath); os.IsNotExist(serr) {
			continue // no manifest — not a bundle dir, skip silently
		}
		b, oerr := evidence.Open(dir)
		if oerr != nil {
			skipped = append(skipped, fmt.Sprintf("%s — %s", e.Name(), oerr.Error()))
			continue
		}
		hb := buildHubBundle(b, dir, outFile)
		bundles = append(bundles, hb)
	}

	// Also do a deeper walk to find nested manifests (grandchild dirs).
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return nil // skip unreadable entries
		}
		if !d.IsDir() {
			return nil
		}
		// Skip the root itself and immediate children (already handled above).
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil || rel == "." {
			return nil
		}
		parts := strings.Split(rel, string(filepath.Separator))
		if len(parts) <= 1 {
			return nil // immediate child — already handled
		}
		mpath := filepath.Join(path, "manifest.json")
		if _, serr := os.Stat(mpath); os.IsNotExist(serr) {
			return nil
		}
		// Check we haven't already added this dir (immediate-child scan).
		already := false
		for _, hb := range bundles {
			// Compare abs paths via the dir we stored in sortKey.
			if filepath.Clean(hb.sortKey) == filepath.Clean(path) {
				already = true
				break
			}
		}
		if already {
			return fs.SkipDir
		}
		b, oerr := evidence.Open(path)
		if oerr != nil {
			skipped = append(skipped, fmt.Sprintf("%s — %s", rel, oerr.Error()))
			return fs.SkipDir
		}
		hb := buildHubBundle(b, path, outFile)
		bundles = append(bundles, hb)
		return fs.SkipDir
	})

	// Sort newest-first by startedAt (RFC3339 lexicographic ≡ chronological),
	// falling back to directory name.
	sort.Slice(bundles, func(i, j int) bool {
		return bundles[i].sortKey > bundles[j].sortKey
	})

	// Parse and execute template.
	tmpl, err := template.New("hub").Parse(hubTmpl)
	if err != nil {
		return fmt.Errorf("hub: parse template: %w", err)
	}

	data := hubData{
		GeneratedAt: time.Now().UTC().Format("2006-01-02 15:04:05 UTC"),
		Bundles:     bundles,
		Skipped:     skipped,
	}

	f, err := os.Create(outFile)
	if err != nil {
		return fmt.Errorf("hub: create %s: %w", outFile, err)
	}
	defer f.Close()

	if err := tmpl.Execute(f, data); err != nil {
		return fmt.Errorf("hub: execute template: %w", err)
	}
	return nil
}

// buildHubBundle converts an open Bundle into a hubBundle view model.
// outFile is the hub page being written: artifact hrefs are resolved from
// its directory, not from the bundle dir.
func buildHubBundle(b *evidence.Bundle, dir, outFile string) hubBundle {
	m := b.M

	// Artifact paths in the manifest are bundle-relative, but the hub page
	// lives elsewhere (e.g. .pb/hub/index.html): link via the relative path
	// from the page's directory to the bundle, falling back to the absolute
	// bundle dir when Rel fails.
	hrefBase, aerr := filepath.Abs(dir)
	if aerr != nil {
		hrefBase = dir
	}
	if outDir, oerr := filepath.Abs(filepath.Dir(outFile)); oerr == nil {
		if rel, rerr := filepath.Rel(outDir, hrefBase); rerr == nil {
			hrefBase = rel
		}
	}

	// sortKey: prefer startedAt (RFC3339 lexsort = chrono), then dir name.
	sortKey := m.StartedAt
	if sortKey == "" {
		sortKey = filepath.Base(dir)
	}

	// verdict class for CSS
	vc := verdictClass(m.Verdict)

	// meta sub-line: phase · kind · surface values (cluster, env, substrate, ...)
	var metaParts []string
	if m.Phase != "" {
		metaParts = append(metaParts, m.Phase)
	}
	if m.Kind != "" {
		metaParts = append(metaParts, m.Kind)
	}
	// surface keys in a priority order, then alphabetical remainder
	for _, k := range []string{"cluster", "env", "substrate"} {
		if v, ok := m.Surface[k]; ok {
			metaParts = append(metaParts, v)
		}
	}
	for _, k := range sortedKV(m.Surface) {
		if k == "cluster" || k == "env" || k == "substrate" {
			continue
		}
		metaParts = append(metaParts, m.Surface[k])
	}
	metaSub := strings.Join(metaParts, " · ")

	// checks
	checks := make([]hubCheck, 0, len(m.Checks))
	for _, c := range m.Checks {
		sc := stateClass(c.State)
		obs := c.Observed
		if obs == "" {
			obs = c.Reason
		}
		checks = append(checks, hubCheck{
			Name:             c.Name,
			State:            c.State,
			StateClass:       sc,
			Expect:           c.Expect,
			Observed:         c.Observed,
			Reason:           c.Reason,
			ObservedOrReason: obs,
		})
	}

	// artifacts
	arts := make([]hubArtifact, 0, len(m.Artifacts))
	for _, a := range m.Artifacts {
		ha := hubArtifact{
			Name:    a.Name,
			ArtType: a.Type,
		}
		if a.Path != "" {
			if filepath.IsAbs(a.Path) {
				ha.RelPath = a.Path
			} else {
				ha.RelPath = filepath.Join(hrefBase, a.Path)
			}
		}
		switch a.Type {
		case evidence.ArtifactCommand:
			ha.IsCommand = true
			if a.Meta != nil {
				if cmd, ok := a.Meta["cmd"].(string); ok {
					ha.CmdString = cmd
				}
				exitCode, hasExit := extractInt(a.Meta, "exitCode")
				if hasExit {
					ha.HasExitCode = true
					ha.ExitCode = exitCode
					ha.ExitOK = exitCode == 0
				}
				dur, hasDur := extractFloat(a.Meta, "durationSec")
				if hasDur {
					if dur == float64(int(dur)) {
						ha.Duration = fmt.Sprintf("%d", int(dur))
					} else {
						ha.Duration = fmt.Sprintf("%.1f", dur)
					}
				}
			}
		case evidence.ArtifactScreenshot:
			ha.IsScreenshot = true
		}
		arts = append(arts, ha)
	}

	return hubBundle{
		Verdict:      m.Verdict,
		VerdictClass: vc,
		Claim:        m.Claim,
		RunID:        m.RunID,
		MetaSub:      metaSub,
		Checks:       checks,
		Artifacts:    arts,
		sortKey:      sortKey,
	}
}

// verdictClass maps a verdict string to a CSS class fragment.
func verdictClass(v string) string {
	switch v {
	case evidence.VerdictPass:
		return "pass"
	case evidence.VerdictFail:
		return "fail"
	case evidence.VerdictInconclusive:
		return "inconclusive"
	default:
		return "unknown"
	}
}

// stateClass maps a check state to a CSS class fragment.
func stateClass(s string) string {
	switch s {
	case evidence.CheckPass:
		return "pass"
	case evidence.CheckFail:
		return "fail"
	default:
		return "notrun"
	}
}

// extractInt pulls an integer-ish value from a map[string]any.
func extractInt(m map[string]any, key string) (int, bool) {
	v, ok := m[key]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	}
	return 0, false
}

// extractFloat pulls a float64 value from a map[string]any.
func extractFloat(m map[string]any, key string) (float64, bool) {
	v, ok := m[key]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}
