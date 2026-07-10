// Package honesty implements the tamper-RESISTANT spine (ADR-0015): the oracle
// that decides a verdict — the check definitions and the sealed manifest — is
// content-hash-pinned and signed by a principal whose key lives OUTSIDE the
// agent's write surface. It provides ed25519 key custody, detached signatures
// reused for both the check lock (ready.lock, R1) and the sealed manifest
// (manifest.sig, R6), and the canonical check-set hashing that makes any drift
// in what a check exercises or asserts detectable.
//
// This package depends only on the manifest model and the standard library;
// it never imports evidence, so evidence can sign its manifest through it
// without an import cycle.
package honesty

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strings"

	"github.com/0prodigy/proofbench/internal/manifest"
)

// Environment inputs and defaults for principal identity and key custody.
const (
	// EnvSigner names the generation (signing) principal recorded in a lock.
	EnvSigner = "PB_SIGNER"
	// EnvPrincipal names the executing principal a verify run carries; equal
	// to the signer means self-judged (ADR-0015 R2).
	EnvPrincipal = "PB_PRINCIPAL"
	// EnvSigningKey points at the ed25519 seed file (hex). Defaults to
	// DefaultKeyFile under the manifest dir — keep it out of the agent's write
	// surface for the guarantee to hold.
	EnvSigningKey = "PB_SIGNING_KEY"
	// EnvRequirePin, set to "1", makes a missing lock refuse every check
	// (not-run) rather than falling back to legacy un-pinned behavior.
	EnvRequirePin = "PB_REQUIRE_PIN"

	// DefaultKeyFile is the signing key's default location, relative to the dir.
	DefaultKeyFile = ".pb/signing.key"
	// LockFile is the signed check-set pin written next to ready.yaml.
	LockFile = "ready.lock"
)

// Signer is a signing principal: an id plus its ed25519 private key.
type Signer struct {
	ID   string
	Priv ed25519.PrivateKey
}

// Sig is a detached signature — who signed, their public key, and the
// signature — all hex-encoded. Reused verbatim for the check lock and the
// sealed-manifest signature.
type Sig struct {
	Signer    string `json:"signer"`
	PublicKey string `json:"publicKey"`
	Signature string `json:"signature"`
}

// SignMessage signs msg with s and returns a detached Sig carrying s's public
// key so a verifier can check it without a separate key exchange.
func SignMessage(s Signer, msg []byte) Sig {
	pub := s.Priv.Public().(ed25519.PublicKey)
	return Sig{
		Signer:    s.ID,
		PublicKey: hex.EncodeToString(pub),
		Signature: hex.EncodeToString(ed25519.Sign(s.Priv, msg)),
	}
}

// Verify checks that sig is a valid ed25519 signature over msg by the public
// key it carries. A valid return proves the signed content is intact and
// self-consistent; the trust that this public key belongs to a non-agent
// principal is what R2 (principal split) and R6 (external anchor) establish.
func (sig Sig) Verify(msg []byte) error {
	pub, err := hex.DecodeString(sig.PublicKey)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("honesty: invalid public key")
	}
	raw, err := hex.DecodeString(sig.Signature)
	if err != nil {
		return fmt.Errorf("honesty: invalid signature encoding")
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), msg, raw) {
		return fmt.Errorf("honesty: signature does not verify")
	}
	return nil
}

// LoadKey reads a hex ed25519 seed from path into a private key. A missing or
// malformed seed is an error — never a silently disabled signature.
func LoadKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	seed, derr := hex.DecodeString(strings.TrimSpace(string(data)))
	if derr != nil || len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("honesty: %s is not a valid ed25519 seed", path)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// LoadOrCreateKey loads the key at path, generating and persisting a fresh
// keypair (0600) there if absent — so `pb pin` bootstraps a principal on first
// use. The key file is the principal's custody root.
func LoadOrCreateKey(path string) (ed25519.PrivateKey, error) {
	priv, err := LoadKey(path)
	if err == nil {
		return priv, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	_, gen, gerr := ed25519.GenerateKey(rand.Reader)
	if gerr != nil {
		return nil, gerr
	}
	if mkerr := os.MkdirAll(filepath.Dir(path), 0o755); mkerr != nil {
		return nil, mkerr
	}
	if werr := os.WriteFile(path, []byte(hex.EncodeToString(gen.Seed())), 0o600); werr != nil {
		return nil, werr
	}
	return gen, nil
}

// KeyPath resolves the signing key's path: PB_SIGNING_KEY when set, else
// DefaultKeyFile under dir.
func KeyPath(dir string) string {
	if v := os.Getenv(EnvSigningKey); v != "" {
		return v
	}
	return filepath.Join(dir, DefaultKeyFile)
}

// SignerID returns the signing (generation) principal id: PB_SIGNER, else the
// OS username, else "unknown".
func SignerID() string { return principalOr(EnvSigner) }

// ExecutorID returns the executing principal id: PB_PRINCIPAL, else the OS
// username, else "unknown".
func ExecutorID() string { return principalOr(EnvPrincipal) }

func principalOr(env string) string {
	if v := os.Getenv(env); v != "" {
		return v
	}
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	return "unknown"
}

// LoadSigner resolves the signing principal (id + key) for a signing
// operation. When create is true the key is generated if absent (pin's
// first-use bootstrap); when false a missing key is an error.
func LoadSigner(dir string, create bool) (Signer, error) {
	path := KeyPath(dir)
	var priv ed25519.PrivateKey
	var err error
	if create {
		priv, err = LoadOrCreateKey(path)
	} else {
		priv, err = LoadKey(path)
	}
	if err != nil {
		return Signer{}, err
	}
	return Signer{ID: SignerID(), Priv: priv}, nil
}

// CheckHash is the canonical content hash of one check's oracle — its LABELS
// (name, level, driver, exercise, expect, requires, artifacts) AND its
// BEHAVIOR: the fully-resolved drive verb body it indirects through (Run +
// Identity + Output), the sha256 of every on-disk script/spec file it runs, and
// the human gate that governs it. Folding behavior, not just labels, closes
// E1's gut-the-drive-body attack — rewriting Drive[verb].Run to `exit 0` or
// emptying a referenced script moves this hash even when the exercise string is
// unchanged, so the runner refuses the drifted check.
//
// dir roots relative file references; r resolves the drive verb and gate. A
// referenced script/spec file missing at pin/verify time is an error (surfaced
// as not-run), never a silent skip — pin and verify MUST hash the same bytes,
// so both call this one function and can never diverge on what "the oracle" is.
func CheckHash(r *manifest.Ready, c manifest.CheckSpec, dir string) (string, error) {
	h := sha256.New()
	fmt.Fprintf(h, "name=%s\nlevel=%s\ndriver=%s\nexercise=%s\n", c.Name, c.Level, c.Driver, c.Exercise)
	for _, e := range c.Expect {
		fmt.Fprintf(h, "expect=%s\n", strings.TrimSpace(e))
	}
	for _, req := range c.Requires {
		fmt.Fprintf(h, "requires=%s\n", strings.TrimSpace(req))
	}
	for _, a := range c.Artifacts {
		fmt.Fprintf(h, "artifact=%s\n", strings.TrimSpace(a))
	}
	// BEHAVIOR: the fully-resolved drive verb body when the exercise indirects
	// through drive.<verb>. The raw Run string (not endpoint-substituted, so the
	// hash is substrate-independent) is also what the file check below inspects.
	exercise := c.Exercise
	if verb, isDrive := DriveRef(c.Exercise); isDrive {
		v, ok := r.Drive[verb]
		if !ok {
			return "", fmt.Errorf("honesty: check %q references unknown drive verb %q", c.Name, verb)
		}
		fmt.Fprintf(h, "drive.verb=%s\ndrive.run=%s\ndrive.identity=%s\ndrive.output=%s\n",
			verb, v.Run, v.Identity, v.Output)
		exercise = v.Run
	}
	// BEHAVIOR: the sha256 of the on-disk script/spec file the exercise runs, so
	// emptying or rewriting that file drifts the hash. Uses the same file-
	// reference detection the runner uses (ExerciseFilePath), so the hashed file
	// and the exercised file are always the same one.
	if path, ok := ExerciseFilePath(c.Driver, exercise); ok {
		sum, err := fileSHA(dir, path)
		if err != nil {
			return "", fmt.Errorf("honesty: check %q references file %q: %w", c.Name, path, err)
		}
		fmt.Fprintf(h, "file=%s\nfilesha=%s\n", path, sum)
	}
	// The human gate that governs this check (PLAN §3.7) is part of the oracle:
	// removing or weakening the gate that blocks a destructive step drifts the
	// hash.
	if g, gated := MatchGate(r, c); gated {
		fmt.Fprintf(h, "gate.on=%s\ngate.reason=%s\n", g.On, g.Reason)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// CheckSetHash returns the canonical hash over the whole check set plus the
// per-check hash map. Checks are folded in sorted by name so manifest ordering
// (and reordering) never changes the result; the set of referenced drive verbs
// is folded in too, so adding or dropping a verb reference moves the set hash.
func CheckSetHash(r *manifest.Ready, dir string) (string, map[string]string, error) {
	hashes := make(map[string]string, len(r.Checks))
	names := make([]string, 0, len(r.Checks))
	verbs := map[string]bool{}
	for _, c := range r.Checks {
		hsh, err := CheckHash(r, c, dir)
		if err != nil {
			return "", nil, err
		}
		hashes[c.Name] = hsh
		names = append(names, c.Name)
		if verb, isDrive := DriveRef(c.Exercise); isDrive {
			verbs[verb] = true
		}
	}
	return hex.EncodeToString(setDigest(hashes, names, verbs)), hashes, nil
}

func setDigest(hashes map[string]string, names []string, verbs map[string]bool) []byte {
	sort.Strings(names)
	h := sha256.New()
	for _, n := range names {
		fmt.Fprintf(h, "%s=%s\n", n, hashes[n])
	}
	verbNames := make([]string, 0, len(verbs))
	for v := range verbs {
		verbNames = append(verbNames, v)
	}
	sort.Strings(verbNames)
	for _, v := range verbNames {
		fmt.Fprintf(h, "verb=%s\n", v)
	}
	return h.Sum(nil)
}

// DriveRef reports whether an exercise indirects through a drive verb
// ("drive.<verb>") and, if so, the verb name. It is the single place that
// decision is made, so pin, verify, and the gate/hash paths never disagree on
// what a check exercises.
func DriveRef(exercise string) (verb string, isDrive bool) {
	return strings.CutPrefix(exercise, "drive.")
}

// MatchGate reports the manifest gate (PLAN §3.7 "human gates as schema")
// governing c, if any: a gates[].on naming either c's own name or the drive
// verb its exercise indirects through. Manifests with no gates always report no
// match. Shared by the runner (which records not-run for a gated check) and
// CheckHash (which folds the gate into the oracle), so the gate the runner
// honors is exactly the gate the lock pins.
func MatchGate(r *manifest.Ready, c manifest.CheckSpec) (manifest.Gate, bool) {
	if len(r.Gates) == 0 {
		return manifest.Gate{}, false
	}
	verb, _ := strings.CutPrefix(c.Exercise, "drive.")
	for _, g := range r.Gates {
		if g.On == c.Name || (verb != "" && g.On == verb) {
			return g, true
		}
	}
	return manifest.Gate{}, false
}

// ExerciseFilePath reports whether exercise (a drive verb's Run string or a raw
// exercise, already endpoint-resolved by the caller) is unambiguously a bare
// file reference, and if so the path. The playwright driver's exercise IS a
// spec file by construction; the exec driver's exercise only qualifies when it
// is a single whitespace-free token free of shell metacharacters that also
// looks like a path (a "/" or a recognized script/spec extension). An ambiguous
// shell string ("npm test", "curl ...") is left alone. Shared by the runner's
// preflight (missing file => not-run) and CheckHash (sha the referenced file),
// so the exercised file and the hashed file are the same.
//
// The driver-kind literals mirror the ready.yaml `driver` enum
// (spec/v0/ready.schema.json) / checkdriver.Kind*; they are re-declared here,
// not imported, because honesty must not import checkdriver (evidence→honesty
// would cycle).
func ExerciseFilePath(driver, exercise string) (string, bool) {
	const (
		driverExec       = "exec"
		driverPlaywright = "playwright"
	)
	trimmed := strings.TrimSpace(exercise)
	if trimmed == "" {
		return "", false
	}
	if driver == driverPlaywright {
		return trimmed, true
	}
	if driver != "" && driver != driverExec {
		return "", false
	}
	if strings.ContainsAny(trimmed, " \t\n|&;()<>$`\\*?[]{}'\"#~") {
		return "", false
	}
	if strings.Contains(trimmed, "/") || hasScriptExt(trimmed) {
		return trimmed, true
	}
	return "", false
}

// hasScriptExt reports whether s ends in a common test/script extension —
// part of ExerciseFilePath's "clear file reference" heuristic.
func hasScriptExt(s string) bool {
	for _, ext := range []string{".spec.ts", ".spec.js", ".test.ts", ".test.js", ".sh", ".py", ".js", ".ts"} {
		if strings.HasSuffix(s, ext) {
			return true
		}
	}
	return false
}

// fileSHA returns the hex sha256 of the file at path (joined under dir when
// relative). A missing/unreadable file is an error — never a silent skip.
func fileSHA(dir, path string) (string, error) {
	full := path
	if !filepath.IsAbs(full) {
		full = filepath.Join(dir, full)
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// Lock is the signed pin over a manifest's check set (ready.lock): the set
// hash, each check's individual hash (for per-check drift detection), and a
// detached signature over the canonical lock content.
type Lock struct {
	CheckSetHash string            `json:"checkSetHash"`
	CheckHashes  map[string]string `json:"checkHashes"`
	Sig          Sig               `json:"sig"`
	// Anchor, when present, is a Sigstore KEYLESS signature over the same
	// lockMessage as Sig (ADR-0015 R2 / ADR-0016 shared anchor): a `pb pin` run
	// under CI OIDC signs the lock with the workflow identity, and the runner
	// treats the lock as externally anchored only when Anchor verifies against a
	// VERIFIER-SUPPLIED expected identity (CosignAnchor), never the identity
	// Anchor itself records. Absent on a self-attested (self-held-key) lock.
	Anchor *AnchorSig `json:"anchor,omitempty"`
}

// AnchorSig is a Sigstore keyless signature over the lock's canonical message,
// carrying the cosign bundle (signature + Fulcio certificate + Rekor entry)
// emitted by `cosign sign-blob --bundle`. Identity/Issuer are recorded for
// audit and display ONLY — verification pins against a verifier-supplied
// expected identity (CosignAnchor), never these self-described values, so an
// agent cannot promote its own lock by writing its own identity here.
type AnchorSig struct {
	// Identity is the Fulcio cert SAN observed at signing (the CI workflow
	// ref), recorded for the verifier to pin against out-of-band.
	Identity string `json:"identity,omitempty"`
	// Issuer is the OIDC issuer observed at signing (the GH Actions issuer).
	Issuer string `json:"issuer,omitempty"`
	// Bundle is the cosign sign-blob --bundle output (the offline-verifiable
	// Fulcio cert + signature, plus the Rekor entry when the tlog was reached).
	Bundle string `json:"bundle"`
}

// Message returns the canonical byte string a lock's signature (self-held Sig
// or keyless Anchor) covers — the set hash plus every check hash, sorted by
// name. Exported so an AnchorVerifier can present the exact signed blob to
// `cosign verify-blob`; the signature never covers the embedded Sig/Anchor.
func (l Lock) Message() []byte { return lockMessage(l.CheckSetHash, l.CheckHashes) }

// lockMessage is the canonical byte string the lock signature covers: the set
// hash plus every check hash, sorted by name — never the embedded Sig itself.
func lockMessage(setHash string, hashes map[string]string) []byte {
	names := make([]string, 0, len(hashes))
	for n := range hashes {
		names = append(names, n)
	}
	sort.Strings(names)
	var b strings.Builder
	fmt.Fprintf(&b, "checkSetHash=%s\n", setHash)
	for _, n := range names {
		fmt.Fprintf(&b, "%s=%s\n", n, hashes[n])
	}
	return []byte(b.String())
}

// SignLock pins and signs r's check set with s, rooting relative file
// references (whose bytes are folded into each check hash) at dir. An error
// (e.g. a referenced script missing) means the set cannot be honestly pinned.
func SignLock(r *manifest.Ready, dir string, s Signer) (Lock, error) {
	setHash, hashes, err := CheckSetHash(r, dir)
	if err != nil {
		return Lock{}, err
	}
	return Lock{
		CheckSetHash: setHash,
		CheckHashes:  hashes,
		Sig:          SignMessage(s, lockMessage(setHash, hashes)),
	}, nil
}

// Verify checks the lock's signature over its own recorded content. A valid
// return means the lock is internally authentic — its recorded hashes have not
// been edited without the key — not that its signer is trusted (R2/R6).
func (l Lock) Verify() error {
	return l.Sig.Verify(lockMessage(l.CheckSetHash, l.CheckHashes))
}

// SelfAttestedCap is the highest proof rung a SELF-ATTESTED run may claim
// (ADR-0015). A lock signed by a self-generated/local key proves the check set
// is internally authentic but NOT that its signer is an external identity the
// running agent cannot assume — so the verdict is honestly capped at L3,
// regardless of any env toggle. This closes E1's pin-your-own-key attack by
// TRUTH (the run is labeled self-attested and ceilinged) rather than by crypto:
// the agent can freely mint a key, but a self-minted key can never lift the cap.
const SelfAttestedCap = "L3"

// AnchorVerifier decides whether a lock's signer is an EXTERNALLY-ANCHORED
// identity the running agent cannot assume — the only basis on which a run may
// exceed SelfAttestedCap (L3). The default recognizes no external anchor, so
// every valid local lock is SELF-ATTESTED.
//
// The Sigstore keyless slice (ADR-0012 / ADR-0015 R2, de-risked by the CI
// identity-isolation PoC, Unknown #1) is implemented by CosignAnchor (anchor.go):
// it verifies the lock's keyless signature (lock.Anchor) chains to a Fulcio cert
// whose subject matches a VERIFIER-SUPPLIED expected identity (CI OIDC → Fulcio +
// Rekor), NEVER the identity the lock carries — sharing ADR-0016 R4's trust
// anchor. It is wired in via SetAnchorVerifier without touching any caller of
// Anchored.
type AnchorVerifier interface {
	// Anchored reports whether lock is signed under an externally-anchored,
	// non-agent identity.
	Anchored(lock Lock) bool
}

// AnchorReasoner is an OPTIONAL AnchorVerifier capability (discovered by type
// assertion, like substrate.Pinner): it explains the most recent Anchored
// decision — WHY a lock was or was not treated as externally anchored — for the
// verdict surface. A verifier that does not implement it reports no reason.
type AnchorReasoner interface {
	AnchorReason() string
}

// AnchorAuthenticator is an OPTIONAL AnchorVerifier capability: it reports
// whether a keyless lock's signature is GENUINE (a real Sigstore signature over
// the lock message, any identity) — internal authenticity independent of the
// pinned identity. It is what lets a genuine but non-pinned keyless lock be
// SELF-ATTESTED (capped L3) rather than refused; a forged/tampered bundle fails
// it and the lock is refused. A verifier that does not implement it treats a
// keyless lock as inauthentic (only an ed25519 self-held-key lock is authentic
// without it).
type AnchorAuthenticator interface {
	Authentic(lock Lock) bool
}

// BlobKeylessSigner is an OPTIONAL AnchorVerifier capability: it seals an
// arbitrary blob (the sealed-manifest digest) with the SAME cosign keyless
// path/identity used to verify the lock anchor, so the verdict artifact
// (manifest.sig) is anchored under the run's identity — never the self-held key
// (ADR-0015). A verifier that does not implement it leaves the seal to the
// self-held path. CosignAnchor implements it.
type BlobKeylessSigner interface {
	SignBlobKeyless(msg []byte) (*AnchorSig, error)
}

// AnchorBlobSigner returns the installed verifier as a BlobKeylessSigner when it
// implements one (an anchored run), so the runner can keyless-seal the manifest
// under the run's identity. The default self-held-key verifier does not, so a
// self-attested run never keyless-seals.
func AnchorBlobSigner() (BlobKeylessSigner, bool) {
	bs, ok := anchorVerifier.(BlobKeylessSigner)
	return bs, ok
}

// AnchorReducedAssurance reports whether the installed verifier is in
// --insecure-ignore-tlog reduced-assurance mode, so the runner can cap the proof
// ladder below the top rung (ADR-0015). False for a verifier that does not
// expose it (including the self-held-key default).
func AnchorReducedAssurance() bool {
	if r, ok := anchorVerifier.(interface{ ReducedAssurance() bool }); ok {
		return r.ReducedAssurance()
	}
	return false
}

// selfHeldKeyAnchor is the default AnchorVerifier: it recognizes no external
// anchor, so a lock signed with a self-generated/local key is never anchored
// and the run stays self-attested (capped at L3).
type selfHeldKeyAnchor struct{}

func (selfHeldKeyAnchor) Anchored(Lock) bool { return false }

var anchorVerifier AnchorVerifier = selfHeldKeyAnchor{}

// SetAnchorVerifier installs the external-anchor verifier (the Sigstore slice's
// entry point). nil resets to the self-held-key default. Not safe for
// concurrent use with verification; call once at startup.
func SetAnchorVerifier(v AnchorVerifier) {
	if v == nil {
		v = selfHeldKeyAnchor{}
	}
	anchorVerifier = v
}

// Anchored reports whether lock is signed under an externally-anchored identity
// per the installed AnchorVerifier. With the default self-held-key verifier this
// is always false, so every run is self-attested and capped at SelfAttestedCap;
// only an installed CosignAnchor (SetAnchorVerifier) can clear the cap.
func Anchored(lock Lock) bool { return anchorVerifier.Anchored(lock) }

// AnchorReason returns why the installed verifier made its most recent Anchored
// decision, when the verifier implements AnchorReasoner (else ""). Surfaced by
// the runner so a not-anchored (still self-attested) run records WHY.
func AnchorReason() string {
	if r, ok := anchorVerifier.(AnchorReasoner); ok {
		return r.AnchorReason()
	}
	return ""
}

// LockAuthentic reports whether lock's recorded hashes are cryptographically
// intact — its self-held ed25519 signature verifies, OR (for a keyless lock) the
// installed verifier confirms a genuine Sigstore signature over the lock message
// via AnchorAuthenticator. It is the internal-authenticity gate the runner uses
// to decide whether a lock's hashes can be trusted at all (self-attested), a
// weaker bar than Anchored (external anchor, L4/L5). A keyless lock with no
// authenticating verifier is not authentic ⇒ refused, never silently trusted.
func LockAuthentic(lock Lock) bool {
	if lock.Verify() == nil {
		return true
	}
	if lock.Anchor == nil {
		return false
	}
	if a, ok := anchorVerifier.(AnchorAuthenticator); ok {
		return a.Authentic(lock)
	}
	return false
}

// WriteLock writes l to <dir>/ready.lock (pretty JSON).
func WriteLock(dir string, l Lock) error {
	data, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, LockFile), data, 0o644)
}

// LoadLock reads <dir>/ready.lock. present is false (no error) when the file is
// absent; a malformed lock returns an error.
func LoadLock(dir string) (lock Lock, present bool, err error) {
	data, rerr := os.ReadFile(filepath.Join(dir, LockFile))
	if os.IsNotExist(rerr) {
		return Lock{}, false, nil
	}
	if rerr != nil {
		return Lock{}, false, rerr
	}
	if uerr := json.Unmarshal(data, &lock); uerr != nil {
		return Lock{}, false, fmt.Errorf("honesty: parse %s: %w", LockFile, uerr)
	}
	return lock, true, nil
}

// WriteSig writes a detached Sig to path (pretty JSON).
func WriteSig(path string, sig Sig) error {
	data, err := json.MarshalIndent(sig, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
