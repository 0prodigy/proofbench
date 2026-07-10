package honesty

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/0prodigy/proofbench/internal/manifest"
)

// Sigstore keyless signing shell-out per ADR-0012 (CAPABILITY, not embedded):
// pb shells out to `cosign` for lock signature identity verification, exactly
// as it shells out to kubectl/npx elsewhere. cosign absent, an unreachable
// Rekor tlog, or an identity mismatch degrades HONESTLY (not anchored ⇒ the run
// stays self-attested and capped at L3), never a fake pass.
//
// ponytail: in-process sigstore-go is the upgrade path if the cosign runtime
// dependency ever becomes unacceptable — it would replace runCosign/CosignAnchor
// without touching the AnchorVerifier seam, at the cost of +~15MB and a Go bump
// (ADR-0012 single-static-binary), which is why we shell out today.

// CI OIDC environment: GitHub Actions exposes ACTIONS_ID_TOKEN_REQUEST_URL to a
// job granted `id-token: write`, which is exactly what cosign keyless signing
// consumes to mint a Fulcio certificate bound to the workflow identity.
const (
	envActionsIDTokenURL = "ACTIONS_ID_TOKEN_REQUEST_URL"
	// The Fulcio SAN for a GitHub Actions keyless signature is this prefix plus
	// GITHUB_WORKFLOW_REF (<owner>/<repo>/.github/workflows/<wf>@<ref>); the OIDC
	// issuer is the GH Actions token issuer. Recorded for audit only.
	githubSANPrefix      = "https://github.com/"
	githubActionsIssuer  = "https://token.actions.githubusercontent.com"
	envGithubWorkflowRef = "GITHUB_WORKFLOW_REF"
)

// DefaultOIDCIssuer is the expected OIDC issuer default for verification: the
// GitHub Actions token issuer the PoC confirmed on the Fulcio cert.
const DefaultOIDCIssuer = githubActionsIssuer

// InCIOIDC reports whether pb runs under a CI OIDC issuer cosign can use for
// keyless signing (GitHub Actions with id-token: write). When false, `pb pin`
// keeps its self-held-key self-attested path unchanged.
func InCIOIDC() bool { return os.Getenv(envActionsIDTokenURL) != "" }

// ErrCosignAbsent marks cosign not being installed — the honest not-run/cap
// signal (ADR-0012 capability), distinct from a real verification rejection. A
// caller (or an injected CosignAnchor.Run) can return it to model absence.
var ErrCosignAbsent = errors.New("honesty: cosign not found in PATH")

// runCosign runs `cosign <args...>` and returns nil iff cosign exits 0. A
// missing cosign binary is ErrCosignAbsent (capability absent), not a
// verification failure. Combined output is wrapped into any error for the
// recorded reason.
func runCosign(args ...string) error {
	if _, err := exec.LookPath("cosign"); err != nil {
		return ErrCosignAbsent
	}
	out, err := exec.Command("cosign", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("cosign %s: %w: %s", args[0], err, strings.TrimSpace(string(out)))
	}
	return nil
}

// CosignAnchor is the AnchorVerifier that treats a lock as externally anchored
// ONLY when its Sigstore keyless signature (lock.Anchor) verifies via
// `cosign verify-blob` against a VERIFIER-SUPPLIED expected identity and OIDC
// issuer — NEVER the identity the lock records. A branch/PR signature carries
// `@refs/heads/<branch>` in its Fulcio SAN, which an agent cannot forge into
// the protected-main identity, so a branch lock is REJECTED and stays capped at
// L3. Absent cosign, a missing anchor, an unreachable tlog (unless IgnoreTlog),
// or any identity mismatch ⇒ not anchored ⇒ self-attested (honest degradation),
// with the reason recorded for the verdict surface.
type CosignAnchor struct {
	// ExpectedIdentity is the Fulcio cert SAN the verifier requires (exact, or a
	// regexp when IdentityRegexp). Verifier-supplied, never read from the lock.
	ExpectedIdentity string
	IdentityRegexp   bool
	// OIDCIssuer is the required cert issuer (default DefaultOIDCIssuer).
	OIDCIssuer string
	// IgnoreTlog mirrors `cosign --insecure-ignore-tlog`: off by default. When
	// on, verification degrades to REDUCED ASSURANCE (offline Fulcio-cert
	// identity binding only, no Rekor inclusion proof) rather than failing where
	// the environment MITMs/blocks rekor.sigstore.dev — a clearly-recorded
	// reduced mode, never a silent pass. Its use is stamped into AnchorReason.
	IgnoreTlog bool
	// Run executes `cosign <args...>` and returns nil iff cosign accepts. Nil
	// defaults to runCosign (the real binary); it is the dependency-injection
	// seam for tests (a deterministic cosign) and the in-process-sigstore-go
	// upgrade path. The CLI always leaves it nil, so verification always uses the
	// real cosign in production.
	Run func(args ...string) error

	reason string
}

// cosign returns the cosign runner (the injected seam, else runCosign).
func (c *CosignAnchor) cosign() func(args ...string) error {
	if c.Run != nil {
		return c.Run
	}
	return runCosign
}

// Anchored verifies lock.Anchor over the lock's canonical message against the
// verifier-supplied expected identity/issuer, recording why for AnchorReason.
// True ⇒ the lock is externally anchored (L4/L5 reachable).
func (c *CosignAnchor) Anchored(lock Lock) bool {
	if lock.Anchor == nil || lock.Anchor.Bundle == "" {
		c.reason = "self-attested: lock carries no Sigstore keyless anchor (sign with `pb pin` under CI OIDC)"
		return false
	}
	if c.ExpectedIdentity == "" {
		c.reason = "self-attested: no verifier-supplied --expected-identity to pin the Fulcio cert against"
		return false
	}
	tlog := "with Rekor tlog inclusion proof"
	if c.IgnoreTlog {
		tlog = "REDUCED ASSURANCE: --insecure-ignore-tlog (offline Fulcio-cert identity binding only, no Rekor proof)"
	}
	if err := c.verifyBlob(lock, c.ExpectedIdentity, c.IdentityRegexp); err != nil {
		if errors.Is(err, ErrCosignAbsent) {
			c.reason = "self-attested: cosign not installed — cannot verify the anchor (capability absent, ADR-0012)"
		} else {
			c.reason = fmt.Sprintf("self-attested: anchor rejected against identity %q: %v", c.ExpectedIdentity, err)
		}
		return false
	}
	c.reason = fmt.Sprintf("anchored: lock keyless signature verified against identity %q (issuer %s), %s",
		c.ExpectedIdentity, c.issuer(), tlog)
	return true
}

// Authentic implements AnchorAuthenticator: whether lock.Anchor is a GENUINE
// Sigstore keyless signature over the lock message from the expected issuer,
// accepting ANY certificate identity. It is internal authenticity independent
// of the pinned identity — what lets a genuine but non-pinned (e.g. a branch,
// or an agent's own-identity) keyless lock be SELF-ATTESTED (capped L3) rather
// than refused, while a tampered/forged bundle fails here and is refused. Does
// not touch the recorded reason, so Anchored's decision is what surfaces.
func (c *CosignAnchor) Authentic(lock Lock) bool {
	if lock.Anchor == nil || lock.Anchor.Bundle == "" {
		return false
	}
	return c.verifyBlob(lock, ".*", true) == nil
}

// verifyBlob verifies lock.Anchor over the lock's canonical message against
// identity (exact, or regexp when isRegexp). Delegates to verifyBlobBundle.
func (c *CosignAnchor) verifyBlob(lock Lock, identity string, isRegexp bool) error {
	return c.verifyBlobBundle(lock.Anchor.Bundle, lock.Message(), identity, isRegexp)
}

// VerifyBlobBundle verifies a cosign keyless bundle over msg against this
// anchor's expected identity/issuer (exact, or regexp when IdentityRegexp),
// mirroring --insecure-ignore-tlog. Exported so the evidence package can
// re-verify a keyless manifest seal (manifest.sig) against a VERIFIER-SUPPLIED
// expected identity, never one read from the bundle. nil ⇒ cosign accepted.
func (c *CosignAnchor) VerifyBlobBundle(bundle string, msg []byte) error {
	return c.verifyBlobBundle(bundle, msg, c.ExpectedIdentity, c.IdentityRegexp)
}

// verifyBlobBundle stages msg and the cosign bundle to temp files and runs
// `cosign verify-blob` against identity (exact, or regexp when isRegexp) and the
// expected issuer, mirroring --insecure-ignore-tlog. nil ⇒ cosign accepted.
func (c *CosignAnchor) verifyBlobBundle(bundleData string, msg []byte, identity string, isRegexp bool) error {
	dir, err := os.MkdirTemp("", "pb-anchor-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	blob := filepath.Join(dir, "blob.msg")
	bundle := filepath.Join(dir, "bundle.json")
	if err := os.WriteFile(blob, msg, 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(bundle, []byte(bundleData), 0o600); err != nil {
		return err
	}
	idFlag := "--certificate-identity"
	if isRegexp {
		idFlag = "--certificate-identity-regexp"
	}
	args := []string{"verify-blob", "--bundle", bundle, idFlag, identity, "--certificate-oidc-issuer", c.issuer()}
	if c.IgnoreTlog {
		args = append(args, "--insecure-ignore-tlog")
	}
	args = append(args, blob)
	return c.cosign()(args...)
}

// ReducedAssurance reports whether this anchor verifies in --insecure-ignore-tlog
// mode (offline Fulcio-cert identity binding only, no Rekor inclusion proof), so
// the runner can cap the proof ladder below the top rung (ADR-0015). Discovered
// by type assertion, like AnchorReasoner.
func (c *CosignAnchor) ReducedAssurance() bool { return c.IgnoreTlog }

// SignBlobKeyless signs msg with the SAME cosign keyless path this anchor uses
// to verify (its injected runner or the real binary), so the runner can seal the
// verdict artifact (manifest.sig) under the run's identity rather than a
// self-held key. It satisfies BlobKeylessSigner.
func (c *CosignAnchor) SignBlobKeyless(msg []byte) (*AnchorSig, error) {
	return signBlobKeyless(msg, c.cosign())
}

func (c *CosignAnchor) issuer() string {
	if c.OIDCIssuer != "" {
		return c.OIDCIssuer
	}
	return DefaultOIDCIssuer
}

// AnchorReason implements AnchorReasoner: why the last Anchored call decided as
// it did (the identity pinned, or why the run stays self-attested).
func (c *CosignAnchor) AnchorReason() string { return c.reason }

// SignLockKeyless pins r's check set and signs the canonical lock message with
// a Sigstore KEYLESS signature via `cosign sign-blob --yes --bundle` (the CI
// workflow OIDC identity → Fulcio + Rekor). The returned lock carries the
// cosign bundle in Anchor plus the observed signer identity/issuer (recorded
// for the verifier to pin against, never trusted as self-described). Used by
// `pb pin` only under CI OIDC; the local self-held-key path is SignLock,
// unchanged.
func SignLockKeyless(r *manifest.Ready, dir string, run func(args ...string) error) (Lock, error) {
	setHash, hashes, err := CheckSetHash(r, dir)
	if err != nil {
		return Lock{}, err
	}
	anchor, err := signBlobKeyless(lockMessage(setHash, hashes), run)
	if err != nil {
		return Lock{}, err
	}
	return Lock{
		CheckSetHash: setHash,
		CheckHashes:  hashes,
		Anchor:       anchor,
	}, nil
}

// SignBlobKeyless signs msg with a Sigstore KEYLESS signature via
// `cosign sign-blob --yes --bundle` (CI OIDC → Fulcio + Rekor) and returns an
// AnchorSig carrying the cosign bundle plus the observed signer identity/issuer
// (recorded for audit, never trusted as self-described). run defaults to
// runCosign (the real binary); the CLI leaves it nil. It is the shared keyless
// signing path for both the check lock (SignLockKeyless) and the sealed-manifest
// verdict artifact (evidence manifest.sig).
func SignBlobKeyless(msg []byte, run func(args ...string) error) (*AnchorSig, error) {
	return signBlobKeyless(msg, run)
}

func signBlobKeyless(msg []byte, run func(args ...string) error) (*AnchorSig, error) {
	if run == nil {
		run = runCosign
	}
	tmp, err := os.MkdirTemp("", "pb-sign-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	blob := filepath.Join(tmp, "blob.msg")
	bundle := filepath.Join(tmp, "bundle.json")
	if err := os.WriteFile(blob, msg, 0o600); err != nil {
		return nil, err
	}
	if err := run("sign-blob", "--yes", "--bundle", bundle, blob); err != nil {
		return nil, fmt.Errorf("honesty: keyless sign-blob: %w", err)
	}
	data, err := os.ReadFile(bundle)
	if err != nil {
		return nil, fmt.Errorf("honesty: read cosign bundle: %w", err)
	}
	return &AnchorSig{
		Identity: ciWorkflowIdentity(),
		Issuer:   githubActionsIssuer,
		Bundle:   string(data),
	}, nil
}

// ciWorkflowIdentity reconstructs the Fulcio cert SAN a GitHub Actions keyless
// signature carries from GITHUB_WORKFLOW_REF, for audit/display. Empty when the
// env var is unset (recorded as absent, never fabricated).
func ciWorkflowIdentity() string {
	ref := os.Getenv(envGithubWorkflowRef)
	if ref == "" {
		return ""
	}
	return githubSANPrefix + ref
}
