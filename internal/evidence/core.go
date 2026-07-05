package evidence

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// validPhases is the set of allowed phase enum values.
// ponytail: simple map lookup; no reflection or generated code.
var validPhases = map[string]bool{
	PhaseRepro:    true,
	PhaseVerify:   true,
	PhaseReverify: true,
	PhaseFix:      true,
	PhaseReport:   true,
}

// validVerdicts is the set of allowed verdict enum values.
var validVerdicts = map[string]bool{
	VerdictPass:         true,
	VerdictFail:         true,
	VerdictInconclusive: true,
}

// validCheckStates is the set of allowed check state enum values.
var validCheckStates = map[string]bool{
	CheckPass:   true,
	CheckFail:   true,
	CheckNotRun: true,
}

// validArtifactTypes is the set of allowed artifact type enum values.
var validArtifactTypes = map[string]bool{
	ArtifactCommand:    true,
	ArtifactSnapshot:   true,
	ArtifactScreenshot: true,
	ArtifactLog:        true,
	ArtifactRecording:  true,
	ArtifactLink:       true,
}

// validProvenances is the set of allowed provenance enum values.
var validProvenances = map[string]bool{
	ProvenanceHarness: true,
	ProvenanceAgent:   true,
}

// New creates a new evidence bundle directory under root, named
// <ts>-<phase> (runId), writes an initial schema:2 manifest with
// StartedAt set to now (RFC3339) and Verdict left empty until SetVerdict,
// and returns the open Bundle. Phase must be a valid phase enum value.
func New(root string, o NewOpts) (*Bundle, error) {
	if !validPhases[o.Phase] {
		return nil, fmt.Errorf("evidence.New: invalid phase %q", o.Phase)
	}

	now := time.Now().UTC()
	ts := now.Format("20060102-150405")
	runID := ts + "-" + o.Phase
	dir := filepath.Join(root, runID)

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("evidence.New: mkdir %s: %w", dir, err)
	}

	m := &Manifest{
		Schema:    2,
		Ticket:    o.Ticket,
		RunID:     runID,
		Claim:     o.Claim,
		Phase:     o.Phase,
		Kind:      o.Kind,
		PairsWith: o.PairsWith,
		Surface:   o.Surface,
		StartedAt: now.Format(time.RFC3339),
		Verdict:   VerdictInconclusive,
		Artifacts: []Artifact{},
	}

	b := &Bundle{Dir: dir, M: m}
	if err := b.Save(); err != nil {
		return nil, fmt.Errorf("evidence.New: initial save: %w", err)
	}
	return b, nil
}

// Open loads an existing bundle from dir by reading its manifest.json.
// It must accept BOTH schema:1 legacy manifests (produced by evidence.sh,
// upgrading them in memory to the v2 shape) and schema:2 manifests.
func Open(dir string) (*Bundle, error) {
	path := filepath.Join(dir, "manifest.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("evidence.Open: read manifest: %w", err)
	}

	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("evidence.Open: parse manifest: %w", err)
	}

	// Upgrade schema:1 in memory — v1 has same field names, just missing v2-only
	// fields (checks, proofLevel, pins, provenance on artifacts).
	// We normalise nulls written by evidence.sh (path:null / sha256:null on link artifacts).
	if m.Schema == 1 {
		m.Schema = 2
		for i := range m.Artifacts {
			if m.Artifacts[i].Provenance == "" {
				m.Artifacts[i].Provenance = ProvenanceAgent
			}
		}
	}

	if m.Artifacts == nil {
		m.Artifacts = []Artifact{}
	}

	return &Bundle{Dir: dir, M: &m}, nil
}

// Save writes the in-memory manifest back to <Dir>/manifest.json
// (pretty-printed JSON, atomic replace).
func (b *Bundle) Save() error {
	data, err := json.MarshalIndent(b.M, "", "  ")
	if err != nil {
		return fmt.Errorf("evidence.Save: marshal: %w", err)
	}

	// ponytail: atomic write via temp file + rename to avoid partial reads.
	tmp := filepath.Join(b.Dir, ".manifest.tmp")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("evidence.Save: write tmp: %w", err)
	}
	dst := filepath.Join(b.Dir, "manifest.json")
	if err := os.Rename(tmp, dst); err != nil {
		return fmt.Errorf("evidence.Save: rename: %w", err)
	}
	return nil
}

// Add registers srcPath as an artifact of the given type and name.
// If srcPath is not already inside the bundle directory, it is copied in
// under a zero-padded sequence prefix (NN-<basename>); files already inside
// the bundle are registered in place. The artifact records the file's
// sha256 and provenance "agent", with meta attached verbatim.
func (b *Bundle) Add(srcPath, typ, name string, meta map[string]any) error {
	abs, err := filepath.Abs(srcPath)
	if err != nil {
		return fmt.Errorf("evidence.Add: abs path: %w", err)
	}

	bundleDir, err := filepath.Abs(b.Dir)
	if err != nil {
		return fmt.Errorf("evidence.Add: abs bundle dir: %w", err)
	}

	var destPath string
	if strings.HasPrefix(abs, bundleDir+string(os.PathSeparator)) || abs == bundleDir {
		// File is already inside the bundle — register in place.
		destPath = abs
	} else {
		// Copy into the bundle with a sequence prefix, uniquified so an
		// existing artifact file is never overwritten.
		seq := b.nextSeq()
		base := filepath.Base(abs)
		destName := fmt.Sprintf("%02d-%s", seq, base)
		destPath = uniquePath(filepath.Join(bundleDir, destName))
		if err := copyFile(abs, destPath); err != nil {
			return fmt.Errorf("evidence.Add: copy %s -> %s: %w", abs, destPath, err)
		}
	}

	sum, err := sha256File(destPath)
	if err != nil {
		return fmt.Errorf("evidence.Add: sha256 %s: %w", destPath, err)
	}

	rel, err := filepath.Rel(bundleDir, destPath)
	if err != nil {
		return fmt.Errorf("evidence.Add: rel path: %w", err)
	}

	b.M.Artifacts = append(b.M.Artifacts, Artifact{
		Type:       typ,
		Name:       name,
		Path:       rel,
		SHA256:     sum,
		Provenance: ProvenanceAgent,
		Meta:       meta,
	})

	return b.Save()
}

// Link registers an execution reference (e.g. a run/execution ID plus a URL
// to an external system) as a link-type artifact with provenance agent.
func (b *Bundle) Link(executionID, url string) error {
	meta := map[string]any{
		"executionId": executionID,
		"url":         url,
	}
	b.M.Artifacts = append(b.M.Artifacts, Artifact{
		Type:       ArtifactLink,
		Name:       "link",
		Path:       "",
		Provenance: ProvenanceAgent,
		Meta:       meta,
	})
	return b.Save()
}

// Seal scans the bundle directory for files present on disk but absent from
// the manifest (excluding manifest.json itself) and registers each as an
// artifact of type log with provenance agent, so nothing in the bundle is
// untracked at verdict time.
func (b *Bundle) Seal() error {
	bundleDir, err := filepath.Abs(b.Dir)
	if err != nil {
		return fmt.Errorf("evidence.Seal: abs bundle dir: %w", err)
	}

	// Build a set of paths already registered (as absolute paths).
	registered := map[string]bool{}
	for _, a := range b.M.Artifacts {
		if a.Path == "" {
			continue
		}
		var ap string
		if filepath.IsAbs(a.Path) {
			ap = a.Path
		} else {
			ap = filepath.Join(bundleDir, a.Path)
		}
		registered[ap] = true
	}

	entries, err := os.ReadDir(bundleDir)
	if err != nil {
		return fmt.Errorf("evidence.Seal: readdir: %w", err)
	}

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if e.Name() == "manifest.json" || e.Name() == ".manifest.tmp" {
			continue
		}

		abs := filepath.Join(bundleDir, e.Name())
		if registered[abs] {
			continue
		}

		sum, err := sha256File(abs)
		if err != nil {
			return fmt.Errorf("evidence.Seal: sha256 %s: %w", abs, err)
		}

		b.M.Artifacts = append(b.M.Artifacts, Artifact{
			Type:       ArtifactLog,
			Name:       strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())),
			Path:       e.Name(),
			SHA256:     sum,
			Provenance: ProvenanceAgent,
		})
	}

	return b.Save()
}

// SetVerdict validates verdict against the verdict enum
// (pass|fail|inconclusive), seals the bundle (PLAN §5: unregistered files
// are auto-sealed at verdict time), records the verdict together with the
// optional note, sets FinishedAt to now in RFC3339, and saves the manifest.
// Verdict is set last, derived from artifacts — never before the evidence
// exists.
func (b *Bundle) SetVerdict(verdict, note string) error {
	if !validVerdicts[verdict] {
		return fmt.Errorf("evidence.SetVerdict: invalid verdict %q", verdict)
	}
	if note == "" && (verdict == VerdictFail || verdict == VerdictInconclusive) {
		return fmt.Errorf("evidence.SetVerdict: note required for verdict %q", verdict)
	}

	if err := b.Seal(); err != nil {
		return fmt.Errorf("evidence.SetVerdict: seal: %w", err)
	}

	b.M.Verdict = verdict
	b.M.Note = note
	b.M.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	return b.Save()
}

// Validate checks a bundle on disk: the manifest parses (schema 1 or 2),
// all enum fields (phase, verdict, check states, artifact types, provenance)
// hold valid values, every artifact path exists in the bundle directory
// (link artifacts excepted), and each recorded sha256 matches the file's
// current content.
func Validate(dir string) error {
	b, err := Open(dir)
	if err != nil {
		return fmt.Errorf("evidence.Validate: open: %w", err)
	}
	m := b.M

	if !validPhases[m.Phase] {
		return fmt.Errorf("evidence.Validate: invalid phase %q", m.Phase)
	}
	if m.Verdict != "" && !validVerdicts[m.Verdict] {
		return fmt.Errorf("evidence.Validate: invalid verdict %q", m.Verdict)
	}

	bundleDir, err := filepath.Abs(dir)
	if err != nil {
		return fmt.Errorf("evidence.Validate: abs bundle dir: %w", err)
	}

	for i, c := range m.Checks {
		if !validCheckStates[c.State] {
			return fmt.Errorf("evidence.Validate: check[%d] %q: invalid state %q", i, c.Name, c.State)
		}
	}

	for i, a := range m.Artifacts {
		if !validArtifactTypes[a.Type] {
			return fmt.Errorf("evidence.Validate: artifact[%d] %q: invalid type %q", i, a.Name, a.Type)
		}
		if a.Provenance != "" && !validProvenances[a.Provenance] {
			return fmt.Errorf("evidence.Validate: artifact[%d] %q: invalid provenance %q", i, a.Name, a.Provenance)
		}

		// Link artifacts have no on-disk file.
		if a.Type == ArtifactLink {
			continue
		}
		if a.Path == "" {
			continue
		}

		var ap string
		if filepath.IsAbs(a.Path) {
			ap = a.Path
		} else {
			ap = filepath.Join(bundleDir, a.Path)
		}

		if _, err := os.Stat(ap); err != nil {
			return fmt.Errorf("evidence.Validate: artifact[%d] %q: path %q: %w", i, a.Name, a.Path, err)
		}

		if a.SHA256 != "" {
			got, err := sha256File(ap)
			if err != nil {
				return fmt.Errorf("evidence.Validate: artifact[%d] %q: sha256: %w", i, a.Name, err)
			}
			if got != a.SHA256 {
				return fmt.Errorf("evidence.Validate: artifact[%d] %q: sha256 mismatch (recorded %s, got %s)",
					i, a.Name, a.SHA256, got)
			}
		}
	}

	return nil
}

// ── helpers ──────────────────────────────────────────────────────────────────

// nextSeq returns the next 1-based sequence number for artifact file naming,
// derived from the current number of non-link artifacts.
func (b *Bundle) nextSeq() int {
	n := 0
	for _, a := range b.M.Artifacts {
		if a.Type != ArtifactLink {
			n++
		}
	}
	return n + 1
}

// uniquePath returns path unchanged when nothing exists there; otherwise the
// first "-2", "-3", … suffixed variant (before the extension) that is free,
// so an existing artifact file is never overwritten.
func uniquePath(path string) string {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return path
	}
	ext := filepath.Ext(path)
	stem := strings.TrimSuffix(path, ext)
	for i := 2; ; i++ {
		p := fmt.Sprintf("%s-%d%s", stem, i, ext)
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
	}
}

// sha256File computes the hex-encoded SHA-256 of the file at path.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// copyFile copies src to dst, creating dst if needed.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}
