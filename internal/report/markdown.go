package report

import (
	"fmt"
	"sort"
	"strings"

	"github.com/0prodigy/proofbench/internal/evidence"
)

// verdictEmoji returns the emoji for a verdict string.
func verdictEmoji(v string) string {
	switch v {
	case evidence.VerdictPass:
		return "✅"
	case evidence.VerdictFail:
		return "❌"
	default:
		return "⚠️"
	}
}

// checkEmoji returns a short symbol for a check state.
func checkEmoji(state string) string {
	switch state {
	case evidence.CheckPass:
		return "pass"
	case evidence.CheckFail:
		return "fail"
	default:
		return "not-run"
	}
}

// sortedKV returns the keys of m in sorted order, so output is deterministic.
func sortedKV(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Markdown renders b as a Markdown report suitable for PR/Jira comments:
//
//   - header: verdict emoji + verdict + claim
//   - UNVERIFIED banner when the verdict seal was not checked/pinned
//   - meta line: proof level, phase, kind, surface key=value pairs
//   - checks table: name | state | expect | observed
//   - artifacts list: command artifacts rendered as name, exit N, Ns
//   - footer: bundle dir + runId
//
// sealVerified/sealDetail come from evidence.SealStatus: when the seal was not
// verified against a pinned signer identity, the verdict and proof level are
// stamped UNVERIFIED rather than presented as a clean trusted result — a human
// must never read a bare trusted "L5" off a bundle whose seal was not checked.
//
// Output ordering is deterministic (surface keys sorted, checks/artifacts
// in manifest order).
func Markdown(b *evidence.Bundle, sealVerified bool, sealDetail string) (string, error) {
	if b == nil || b.M == nil {
		return "", fmt.Errorf("report: nil bundle or manifest")
	}
	m := b.M
	var sb strings.Builder

	// ---- header ----
	emoji := verdictEmoji(m.Verdict)
	fmt.Fprintf(&sb, "%s **%s** — %s\n\n", emoji, strings.ToUpper(m.Verdict), m.Claim)

	// ---- UNVERIFIED banner ----
	// A verdict whose seal was not verified against a pinned signer identity is
	// stamped, unmissably, so it is never read as a trusted result.
	if !sealVerified {
		fmt.Fprintf(&sb, "> ⚠️ **UNVERIFIED** — %s\n\n", sealDetail)
	}

	// ---- meta line ----
	// proof level, phase, kind, then surface key=value pairs (sorted keys)
	var meta []string
	if m.ProofLevel != "" {
		pl := "proof level " + m.ProofLevel
		if !sealVerified {
			pl += " — UNVERIFIED: " + sealDetail
		}
		meta = append(meta, pl)
	}
	if m.Phase != "" {
		meta = append(meta, "phase "+m.Phase)
	}
	if m.Kind != "" {
		meta = append(meta, "kind "+m.Kind)
	}
	for _, k := range sortedKV(m.Surface) {
		meta = append(meta, k+"="+m.Surface[k])
	}
	if len(meta) > 0 {
		fmt.Fprintf(&sb, "%s\n\n", strings.Join(meta, " · "))
	}

	// ---- checks table ----
	if len(m.Checks) > 0 {
		sb.WriteString("| check | state | expect | observed |\n")
		sb.WriteString("|---|---|---|---|\n")
		for _, c := range m.Checks {
			expect := escMD(c.Expect)
			observed := escMD(c.Observed)
			if c.Reason != "" && observed == "" {
				observed = escMD(c.Reason)
			}
			fmt.Fprintf(&sb, "| %s | %s | %s | %s |\n",
				escMD(c.Name), checkEmoji(c.State), expect, observed)
		}
		sb.WriteString("\n")
	}

	// ---- artifacts list ----
	if len(m.Artifacts) > 0 {
		sb.WriteString("**Artifacts**\n\n")
		for _, a := range m.Artifacts {
			if a.Type == evidence.ArtifactCommand {
				// render as: name, exit N, Ns
				exitCode := artifactExitCode(a)
				dur := artifactDuration(a)
				line := fmt.Sprintf("- `%s`", a.Name)
				if exitCode != "" {
					line += ", exit " + exitCode
				}
				if dur != "" {
					line += ", " + dur + "s"
				}
				sb.WriteString(line + "\n")
			} else {
				fmt.Fprintf(&sb, "- `%s` (%s)\n", a.Name, a.Type)
			}
		}
		sb.WriteString("\n")
	}

	// ---- footer ----
	fmt.Fprintf(&sb, "---\n`%s` · run `%s`\n", b.Dir, m.RunID)

	return sb.String(), nil
}

// escMD replaces pipe characters in s to avoid breaking Markdown tables.
func escMD(s string) string {
	return strings.ReplaceAll(s, "|", "\\|")
}

// artifactExitCode extracts the exitCode from a command artifact's Meta.
func artifactExitCode(a evidence.Artifact) string {
	if a.Meta == nil {
		return ""
	}
	v, ok := a.Meta["exitCode"]
	if !ok {
		return ""
	}
	switch n := v.(type) {
	case int:
		return fmt.Sprintf("%d", n)
	case int64:
		return fmt.Sprintf("%d", n)
	case float64:
		return fmt.Sprintf("%d", int(n))
	default:
		return fmt.Sprintf("%v", v)
	}
}

// artifactDuration extracts durationSec from a command artifact's Meta.
func artifactDuration(a evidence.Artifact) string {
	if a.Meta == nil {
		return ""
	}
	v, ok := a.Meta["durationSec"]
	if !ok {
		return ""
	}
	switch n := v.(type) {
	case int:
		return fmt.Sprintf("%d", n)
	case int64:
		return fmt.Sprintf("%d", n)
	case float64:
		// show as int if whole, else 1 decimal
		if n == float64(int(n)) {
			return fmt.Sprintf("%d", int(n))
		}
		return fmt.Sprintf("%.1f", n)
	default:
		return fmt.Sprintf("%v", v)
	}
}
