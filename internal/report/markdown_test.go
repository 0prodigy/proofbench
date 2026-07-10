package report

import (
	"strings"
	"testing"

	"github.com/0prodigy/proofbench/internal/evidence"
)

// TestMarkdownStampsUnverified is acceptance (2): a bundle hand-edited to claim
// proofLevel L5 with no signer identity pinned (unsigned/unpinned) must render
// with an explicit UNVERIFIED stamp, never a bare trusted "L5" — a human reading
// a PR/hub comment must not mistake an unchecked verdict for a trusted one.
func TestMarkdownStampsUnverified(t *testing.T) {
	dir := t.TempDir()
	b, err := evidence.New(dir, evidence.NewOpts{Claim: "unsigned claim", Phase: evidence.PhaseVerify})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Hand-edit the earned level up to L5 on an unsigned bundle, then seal the
	// verdict without any manifest.sig (unsigned/unpinned).
	b.M.ProofLevel = "L5"
	if err := b.SetVerdict(evidence.VerdictPass, ""); err != nil {
		t.Fatalf("SetVerdict: %v", err)
	}

	// No --expected-identity, no seal ⇒ not verified.
	verified, detail := evidence.SealStatus(dir, evidence.ValidateOpts{})
	if verified {
		t.Fatal("an unsigned/unpinned bundle must not be reported verified")
	}

	md, err := Markdown(b, verified, detail)
	if err != nil {
		t.Fatalf("Markdown: %v", err)
	}
	if !strings.Contains(md, "UNVERIFIED") {
		t.Errorf("report did not stamp the unverified verdict UNVERIFIED:\n%s", md)
	}
	if strings.Contains(md, "proof level L5\n") || strings.Contains(md, "proof level L5 ·") {
		t.Errorf("report rendered a bare trusted 'proof level L5' with no UNVERIFIED stamp:\n%s", md)
	}
}

// TestMarkdownVerifiedIsClean confirms the positive path: when the seal is
// verified, the report carries no UNVERIFIED banner and renders the level plainly.
func TestMarkdownVerifiedIsClean(t *testing.T) {
	dir := t.TempDir()
	b, err := evidence.New(dir, evidence.NewOpts{Claim: "sealed claim", Phase: evidence.PhaseVerify})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	b.M.ProofLevel = "L4"
	if err := b.SetVerdict(evidence.VerdictPass, ""); err != nil {
		t.Fatalf("SetVerdict: %v", err)
	}
	md, err := Markdown(b, true, "sealed, verified against ci-oracle")
	if err != nil {
		t.Fatalf("Markdown: %v", err)
	}
	if strings.Contains(md, "UNVERIFIED") {
		t.Errorf("verified report should not carry an UNVERIFIED stamp:\n%s", md)
	}
	if !strings.Contains(md, "proof level L4") {
		t.Errorf("verified report should render the proof level:\n%s", md)
	}
}
