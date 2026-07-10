package evidence

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/0prodigy/proofbench/internal/honesty"
)

// validPhases is the set of allowed phase enum values.
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
	ProvenanceTool:    true,
}

// validKinds is the set of allowed kind enum values: "" (bundle stands
// alone) or a before/after pairing role (spec/v0/evidence-v2.schema.json).
var validKinds = map[string]bool{
	"":       true,
	"before": true,
	"after":  true,
}

// New creates a new evidence bundle directory under root, named
// <ts>-<phase> (runId), writes an initial schema:2 manifest with
// StartedAt set to now (RFC3339) and Verdict left empty until SetVerdict,
// and returns the open Bundle. Phase must be a valid phase enum value; Kind,
// if set, must be "before" or "after".
func New(root string, o NewOpts) (*Bundle, error) {
	if !validPhases[o.Phase] {
		return nil, fmt.Errorf("evidence.New: invalid phase %q", o.Phase)
	}
	if !validKinds[o.Kind] {
		return nil, fmt.Errorf("evidence.New: invalid kind %q", o.Kind)
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

	// Only schema 1 (legacy, upgraded below) and schema 2 (current) are
	// understood; anything else (including a missing/zero schema) is a
	// bundle Open cannot safely interpret, never a silent pass-through.
	if m.Schema != 1 && m.Schema != 2 {
		return nil, fmt.Errorf("evidence.Open: unsupported schema %d (want 1 or 2)", m.Schema)
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

	// Atomic write via temp file + rename to avoid partial reads.
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
	if !validArtifactTypes[typ] {
		return fmt.Errorf("evidence.Add: invalid artifact type %q", typ)
	}
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

// File claims a driver-produced file (trace, screenshot, video, session
// probe) as an artifact of the given type and name, recording provenance
// "tool" (ADR-0013) — the harness directed the tool but did not tee the
// bytes. Copy-in, sequence-prefix, and sha256 behaviour match Add; only the
// provenance differs, so a driver-captured artifact is distinguishable from
// an agent-supplied one.
func (b *Bundle) File(typ, name, srcPath string, meta map[string]any) error {
	if !validArtifactTypes[typ] {
		return fmt.Errorf("evidence.File: invalid artifact type %q", typ)
	}
	abs, err := filepath.Abs(srcPath)
	if err != nil {
		return fmt.Errorf("evidence.File: abs path: %w", err)
	}
	bundleDir, err := filepath.Abs(b.Dir)
	if err != nil {
		return fmt.Errorf("evidence.File: abs bundle dir: %w", err)
	}

	var destPath string
	if strings.HasPrefix(abs, bundleDir+string(os.PathSeparator)) || abs == bundleDir {
		destPath = abs
	} else {
		seq := b.nextSeq()
		destName := fmt.Sprintf("%02d-%s", seq, filepath.Base(abs))
		destPath = uniquePath(filepath.Join(bundleDir, destName))
		if err := copyFile(abs, destPath); err != nil {
			return fmt.Errorf("evidence.File: copy %s -> %s: %w", abs, destPath, err)
		}
	}

	sum, err := sha256File(destPath)
	if err != nil {
		return fmt.Errorf("evidence.File: sha256 %s: %w", destPath, err)
	}
	rel, err := filepath.Rel(bundleDir, destPath)
	if err != nil {
		return fmt.Errorf("evidence.File: rel path: %w", err)
	}

	b.M.Artifacts = append(b.M.Artifacts, Artifact{
		Type:       typ,
		Name:       name,
		Path:       rel,
		SHA256:     sum,
		Provenance: ProvenanceTool,
		Meta:       meta,
	})
	return b.Save()
}

// Exec satisfies Capture by delegating to Run (a teed subprocess, provenance
// harness).
func (b *Bundle) Exec(name string, argv []string, shell bool) (int, error) {
	return b.Run(name, argv, shell)
}

// BundleDir satisfies Capture, returning the bundle directory. Named
// BundleDir because Bundle.Dir is a frozen field.
func (b *Bundle) BundleDir() string { return b.Dir }

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

// Seal scans the bundle directory RECURSIVELY for files present on disk but
// absent from the manifest (excluding manifest.json and .manifest.tmp) and
// registers each as an artifact of type log with provenance agent, so
// nothing in the bundle is untracked at verdict time — including a driver's
// subdirectory (e.g. playwright-<check>/trace.zip), not just the top level.
// A subdir file's artifact Path is its path relative to the bundle dir.
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

	// WalkDir visits entries in lexical order at each directory level, so
	// artifact append order stays deterministic without an extra sort.
	err = filepath.WalkDir(bundleDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return fmt.Errorf("evidence.Seal: walk %s: %w", path, walkErr)
		}
		if d.IsDir() {
			return nil
		}
		rel, rerr := filepath.Rel(bundleDir, path)
		if rerr != nil {
			return fmt.Errorf("evidence.Seal: rel %s: %w", path, rerr)
		}
		if rel == "manifest.json" || rel == ".manifest.tmp" || rel == manifestSigFile {
			return nil
		}
		if registered[path] {
			return nil
		}

		sum, serr := sha256File(path)
		if serr != nil {
			return fmt.Errorf("evidence.Seal: sha256 %s: %w", path, serr)
		}

		b.M.Artifacts = append(b.M.Artifacts, Artifact{
			Type:       ArtifactLog,
			Name:       strings.TrimSuffix(filepath.Base(rel), filepath.Ext(rel)),
			Path:       rel,
			SHA256:     sum,
			Provenance: ProvenanceAgent,
		})
		return nil
	})
	if err != nil {
		return err
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

// ValidateOpts carries the verifier-supplied expectations for an anchored
// manifest seal (ADR-0015). When ExpectedIdentity is set, the sealed verdict
// artifact (manifest.sig) MUST be a Sigstore keyless signature verifying against
// this Fulcio cert identity (exact, or regexp when IdentityRegexp); an absent
// seal is then INVALID and a self-held-key seal is rejected as the wrong signer.
type ValidateOpts struct {
	ExpectedIdentity string
	IdentityRegexp   bool
	OIDCIssuer       string
	// Cosign injects the cosign runner for keyless-seal verification (tests); nil
	// uses the real cosign binary, mirroring honesty.CosignAnchor.Run.
	Cosign func(args ...string) error
}

// anchorExpected reports whether the verifier pinned an expected Sigstore
// identity the manifest seal must verify against.
func (o ValidateOpts) anchorExpected() bool { return o.ExpectedIdentity != "" }

// Validate checks a bundle on disk: the manifest parses (schema 1 or 2),
// all enum fields (phase, kind, verdict, check states, artifact types, provenance)
// hold valid values, every artifact path exists in the bundle directory
// (link artifacts excepted), and each recorded sha256 matches the file's
// current content. It verifies a present manifest seal but expects no anchor;
// use ValidateWithAnchor to require a verifier-supplied Sigstore identity.
func Validate(dir string) error {
	return ValidateWithAnchor(dir, ValidateOpts{})
}

// ValidateWithAnchor is Validate with anchored-seal expectations (ADR-0015): when
// o.ExpectedIdentity is set, the manifest seal is re-verified against the
// verifier-supplied Sigstore identity, and an absent or self-held-key seal is
// treated as INVALID.
func ValidateWithAnchor(dir string, o ValidateOpts) error {
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
	if !validKinds[m.Kind] {
		return fmt.Errorf("evidence.Validate: invalid kind %q", m.Kind)
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

	// ADR-0015 R6: if the manifest was signed, verify the detached signature
	// over its verdict + sha-set. Editing a recorded sha to re-anchor the
	// ledger to a swapped artifact (E1 R3b) changes the signed digest and is
	// caught here, even though the per-artifact sha check above would pass.
	if err := validateManifestSig(b, o); err != nil {
		return err
	}

	return nil
}

// manifestSigFile is the detached manifest signature written next to
// manifest.json (excluded from Seal so it never sweeps itself in).
const manifestSigFile = "manifest.sig"

// manifestDigest is the canonical digest the manifest signature covers: EVERY
// trust-bearing manifest field, so a persisted bundle cannot be edited to
// mislead while the seal still verifies. It folds in the claim; the earned proof
// level (with its self-attested flag and provenance rung); the verdict; the
// run's surface (substrate/cluster/env/anchor/... ) and pins (repo SHA, image
// digests) — the source/image identity a re-pointing attack would swap; each
// check's name+state+level+observed; and every artifact's path+sha256+provenance
// +type+name. Field groups are sorted canonically so ordering does not affect
// the digest, yet ANY edit to a claim, a pin, a surface value, a level, a check's
// state/observed, an artifact's sha/provenance, or the verdict breaks the seal.
func (b *Bundle) manifestDigest() []byte {
	h := sha256.New()
	fmt.Fprintf(h, "claim=%s\n", b.M.Claim)
	fmt.Fprintf(h, "verdict=%s\n", b.M.Verdict)
	fmt.Fprintf(h, "proofLevel=%s\n", b.M.ProofLevel)
	fmt.Fprintf(h, "selfAttested=%t\n", b.M.SelfAttested)
	fmt.Fprintf(h, "provenanceRung=%s\n", b.M.ProvenanceRung)

	// Surface (substrate/cluster/env/anchor/provenance/...) — sorted by key so
	// ordering is canonical; re-pointing the run to a different substrate/env
	// breaks the seal.
	for _, k := range sortedKeys(b.M.Surface) {
		fmt.Fprintf(h, "surface=%s:%s\n", k, b.M.Surface[k])
	}

	// Pins (repo commit, image.<name> digests, cluster context/namespace, ...) —
	// sorted by key; swapping the pinned source/image after signing breaks the seal.
	for _, k := range sortedKeys(b.M.Pins) {
		fmt.Fprintf(h, "pin=%s:%s\n", k, b.M.Pins[k])
	}

	// Checks — name+state+level+observed, sorted canonically so check ordering
	// does not affect the digest.
	checkLines := make([]string, 0, len(b.M.Checks))
	for _, c := range b.M.Checks {
		checkLines = append(checkLines, fmt.Sprintf("check=%s:%s:%s:%s", c.Name, c.State, c.Level, c.Observed))
	}
	sort.Strings(checkLines)
	for _, l := range checkLines {
		fmt.Fprintln(h, l)
	}

	// Artifacts — path+sha256+provenance+type+name, sorted canonically.
	artLines := make([]string, 0, len(b.M.Artifacts))
	for _, a := range b.M.Artifacts {
		artLines = append(artLines, fmt.Sprintf("artifact=%s:%s:%s:%s:%s", a.Path, a.SHA256, a.Provenance, a.Type, a.Name))
	}
	sort.Strings(artLines)
	for _, l := range artLines {
		fmt.Fprintln(h, l)
	}
	return h.Sum(nil)
}

// sortedKeys returns m's keys in sorted order so a map contributes to the
// manifest digest canonically (ordering does not affect the seal).
func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// manifestSeal is the parsed manifest.sig. Exactly one arm is populated: the
// embedded honesty.Sig (self-held ed25519 detached signature — the self-attested
// path, whose signer/publicKey/signature fields sit at the JSON top level,
// on-disk shape unchanged) OR Anchor (a Sigstore KEYLESS cosign bundle over the
// manifest digest — the anchored path). Anchor != nil selects the keyless arm.
type manifestSeal struct {
	honesty.Sig
	Anchor *honesty.AnchorSig `json:"anchor,omitempty"`
}

// SignManifest signs the sealed manifest's digest with the principal's SELF-HELD
// key and writes a detached <bundle>/manifest.sig (ADR-0015 R6). Used only on the
// self-attested path (capped L3); an anchored run seals keyless via
// SignManifestKeyless instead. Call it after SetVerdict, once the sha-set is
// final.
func (b *Bundle) SignManifest(s honesty.Signer) error {
	seal := manifestSeal{Sig: honesty.SignMessage(s, b.manifestDigest())}
	return b.writeSeal(seal)
}

// SignManifestKeyless seals the manifest's digest with a Sigstore KEYLESS
// signature via bs (the run's installed anchor), writing the cosign bundle to
// <bundle>/manifest.sig (ADR-0015). This anchors the VERDICT ARTIFACT under the
// run's identity — the identity the agent cannot assume — so editing the sealed
// level/verdict/sha-set breaks a signature the agent cannot re-forge. Call it
// after SetVerdict, once the sha-set is final.
func (b *Bundle) SignManifestKeyless(bs honesty.BlobKeylessSigner) error {
	anchor, err := bs.SignBlobKeyless(b.manifestDigest())
	if err != nil {
		return err
	}
	return b.writeSeal(manifestSeal{Anchor: anchor})
}

func (b *Bundle) writeSeal(seal manifestSeal) error {
	data, err := json.MarshalIndent(seal, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(b.Dir, manifestSigFile), data, 0o644)
}

// validateManifestSig verifies <bundle>/manifest.sig against the current manifest
// digest (ADR-0015 R6). An anchored (keyless) seal is re-verified via cosign; a
// self-held ed25519 seal is verified with the key it carries.
//
// When an anchor is EXPECTED (o.anchorExpected — the verifier supplied
// --expected-identity), the seal MUST be a Sigstore keyless signature that
// verifies against the verifier-supplied identity: an ABSENT manifest.sig is
// INVALID (an unsealed verdict cannot be trusted under an expected anchor), and a
// self-held-key seal is REJECTED as the wrong signer (not the pinned Sigstore
// identity). When no anchor is expected, an absent seal is not an error (un-pinned
// bundles stay valid) and a keyless seal is checked for authenticity only (the
// signature covers the current digest) since no identity was supplied to pin.
func validateManifestSig(b *Bundle, o ValidateOpts) error {
	data, err := os.ReadFile(filepath.Join(b.Dir, manifestSigFile))
	if os.IsNotExist(err) {
		if o.anchorExpected() {
			return fmt.Errorf("evidence.Validate: %s absent but an anchor was expected (--expected-identity) — an unsealed verdict is INVALID", manifestSigFile)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("evidence.Validate: read %s: %w", manifestSigFile, err)
	}
	var seal manifestSeal
	if uerr := json.Unmarshal(data, &seal); uerr != nil {
		return fmt.Errorf("evidence.Validate: parse %s: %w", manifestSigFile, uerr)
	}

	if seal.Anchor != nil {
		ca := &honesty.CosignAnchor{
			ExpectedIdentity: o.ExpectedIdentity,
			IdentityRegexp:   o.IdentityRegexp,
			OIDCIssuer:       o.OIDCIssuer,
			Run:              o.Cosign,
		}
		if !o.anchorExpected() {
			// No verifier-supplied identity to pin against: confirm the keyless
			// signature is genuine over the current digest (any identity), which
			// still catches a tampered level/verdict/sha-set.
			ca.ExpectedIdentity, ca.IdentityRegexp = ".*", true
		}
		if verr := ca.VerifyBlobBundle(seal.Anchor.Bundle, b.manifestDigest()); verr != nil {
			return fmt.Errorf("evidence.Validate: keyless manifest seal rejected against identity %q — wrong signer or a sealed level/sha was edited after signing: %w", ca.ExpectedIdentity, verr)
		}
		return nil
	}

	// Self-held ed25519 seal.
	if o.anchorExpected() {
		return fmt.Errorf("evidence.Validate: manifest seal is a self-held-key signature, not the pinned Sigstore identity %q (--expected-identity) — wrong signer", o.ExpectedIdentity)
	}
	if verr := seal.Sig.Verify(b.manifestDigest()); verr != nil {
		return fmt.Errorf("evidence.Validate: manifest signature invalid — a recorded sha, level, or verdict was edited after signing: %w", verr)
	}
	return nil
}

// SealStatus reports whether a bundle's verdict may be rendered as TRUSTED
// (ADR-0015): true only when the caller PINNED a signer identity
// (o.ExpectedIdentity) and the bundle's manifest.sig is a Sigstore keyless seal
// that validates against it (and the on-disk artifacts still match). An absent
// seal, a self-held-key seal, an identity mismatch, or NO pinned identity all
// return false with a human-legible reason — so a report/hub renderer never
// presents an unverified verdict as clean/green. It never errors: an unverifiable
// bundle is simply UNVERIFIED.
func SealStatus(dir string, o ValidateOpts) (verified bool, detail string) {
	if !o.anchorExpected() {
		if _, err := os.Stat(filepath.Join(dir, manifestSigFile)); os.IsNotExist(err) {
			return false, "no verdict seal (manifest.sig absent)"
		}
		return false, "no signer identity pinned (pass --expected-identity to verify the seal)"
	}
	if err := ValidateWithAnchor(dir, o); err != nil {
		return false, err.Error()
	}
	return true, "sealed, verified against " + o.ExpectedIdentity
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
