# RULING — Product Materialization (2026-07-06)

## Verdict
**Sequenced combo: (a) harness → (b) agents as the paid wedge → (c) full product on pull.** Identity is fixed on day one: **the system of record for agent proof** (Growth CEO's category). The harness is the OSS distribution wedge and permanent trust anchor; the verification agent is the first *revenue* product, sold PAYG against the QA/verification budget line (Skeptic's wallet, Architect's architecture: **agent proposes, harness proves**); the ledger/compliance control plane is built only when paying customers pull for it. This satisfies every founder constraint (OSS+self-hosted+cloud, sub+PAYG, docker+k8s, shapes A+B, auth matrix, self-evolving tests, multi-agent-ready) without making a two-person team carry Devin's cost structure as an identity.

## Sequence with advance/kill criteria

**Stage 1 — OSS harness wedge (now → ~M3).** Execute PLAN.md P0–P2: `pb` CLI + MCP + spec/v0 + evidence v2; docker/compose GA, `k8s-attach` at P2 exit; GitHub App posting bundle comments (the viral surface); shape (A) only; `pb explore` prototyped behind a flag on Lyric tickets. Launch with the SetupBench headline.
- **Advance:** ≥3 non-Lyric teams running `pb verify` weekly in anger (the only metric that matters — not stars, not manifest counts) AND the ENG-20190-class replay passes runtime-selected.
- **Kill:** 0 external weekly actives at day 90 → freeze the spec, keep the harness as private infrastructure, go agents-direct on it.

**Stage 2 — Paid verification agent (M3 → M9), recruited during Stage 1, not after.** GitHub App: every AI-authored PR gets bring-up → drive → evidence bundle → verdict → **proposed fix**. One exploratory computer-use round (Peekaboo local / Playwright cloud) whose *only durable output* is committed automation — Playwright specs + `checks[]` in ready.yaml — verified thereafter by the deterministic harness. Shape (B) = the agent driving the same pb verbs. Onboarding = per-repo ready.yaml generation. Auth: basic/API-key/cookie (storageState) at launch; SSO brokering is enterprise-tier, not launch. Pricing: PAYG per verified run + team subscription.
- **Advance:** 10 paying teams / ~$25k MRR AND >50% of verdicts observably change merge behavior (blocked or fixed a PR — the verdict is load-bearing).
- **Kill (agent quality):** after 2 design-partner cycles, <~50% of explore-generated tests survive without human rewrite → demote agent to manifest/spec-generator only.
- **Kill (business):** pilots run it but won't convert → verification-as-agent was a feature; sell the capability, jump to Stage 3 compliance-direct or exit to an agent vendor.

**Stage 3 — System of record (on pull, est. M9+).** Hosted retained ledger, RBAC, diff-two-bundles, DSSE attestations, SOC2/ISO change-management exports, evidence-gated merge policy, managed BYOC connectors.
- **Trigger to build:** ≥3 paying Stage-2 customers independently ask "where do bundles live / can my auditor see this."
- **Kill:** 6 months of paid Stage 2 with no such pull → stay agent + OSS + support; do not build faith-based capex.

## Where each lens is right / wrong (strongest point overruled, and why)

**Growth CEO** — *Right:* the category name and destination (proof ledger, PR-comment-as-ad, compile targets as distribution, spec-layer network effects); agents must never be the brand. *Overruled — his strongest point:* "defer agents to M8+; layer 2 is only a feature inside layer 3." Overruled because it parks the one asset with an existing budget line (QA spend) and the founder's most demo-able capability for 6+ months, exactly his own risk #3, while the ledger buyer runs 9-month compliance cycles. Revenue sequencing flips: agent pays for the ledger, not vice versa.

**Skeptic VC** — *Right:* the wallet analysis (eng leaders pay TODAY for "AI PRs stop breaking prod"; devs never pay for proof), the anti-vanity metric, per-verified-PR pricing, and ledger-on-pull. *Overruled — his strongest point:* "incumbents get verification free, so a neutral layer competes with their existential roadmap item; only (b) is fundable." Overruled because an agent vendor grading its own homework is structurally untrustable — neutrality + harness-anchored, provenance-flagged evidence is the counter-position, and it only exists if the harness/spec stays the identity. Pure (b) also inherits SetupBench's 39–57% env bring-up as its SLA (Architect's decisive fact) and lands us seat-to-seat with Devin/QA Wolf with no distribution edge. We take his wedge and his meter, not his identity.

**Pragmatic Architect** — *Right:* the trust architecture (deterministic harness anchors verdicts; flaky env = honest `not-run`, not an outage; SSO deferred; k8s-attach before k8s-orchestrate; control plane earned). This ruling adopts his machine wholesale. *Overruled — his strongest point:* "harness IS the product for two quarters; agent is a bolted-on feature." Overruled because two quarters of OSS-only monetization is his own named risk #1 (Cursor/Devin ship good-enough built-in proof and capture the value); the agent is the PAYG SKU and design partners are recruited in Stage 1. Sell the agent, anchor on the harness.

## 5 decisions for immediate ADRs

*Note: numbering below is the ruling's own; as filed these map to docs/adr/ 0001 (identity), 0002 (trust), 0004 (pricing), 0006 (launch matrix), 0009 (agent runtime).*

1. **ADR-001 Identity & scope:** Category = system of record for agent proof; agents are a metered capability, never the brand. Amend PLAN §2: the non-goal is *human test-authoring tools*, not test generation — agent-generated durable automation verified by the harness is explicitly in scope (resolves the §2 contradiction the Skeptic caught). Spec + harness Apache-2.0 forever.
2. **ADR-002 Trust boundary:** Agent proposes, harness proves. Agent-supplied artifacts carry provenance flags and can never anchor a verdict; the exploratory round's only durable output is committed ready.yaml `checks[]` / Playwright specs replayed deterministically.
3. **ADR-003 Pricing:** PAYG meter = verdict-bearing verified run (per-PR), + team subscription for retention/RBAC/hosted hub; compute passed through near cost (E2B/Daytona commoditized); no seat pricing (market moving off seats: Copilot, Bugbot, Devin).
4. **ADR-004 Launch matrix:** docker/compose GA + k8s-attach at P2 (both founder deployment modes); shapes A and B on the same pb verbs, per-repo config = onboarding; auth basic/API-key/cookie(storageState) in OSS, SSO credential-brokering enterprise-tier only; BuildKit rootless for shape-B builds (kaniko archived).
5. **ADR-005 Agent runtime:** Claude Agent SDK first, isolated behind a process-boundary adapter outside the Apache-2.0 core (proprietary ToS; no Go SDK exists for any candidate, so the adapter shape is multi-agent-ready by construction); MCP is the neutral inbound surface for third-party agents.
