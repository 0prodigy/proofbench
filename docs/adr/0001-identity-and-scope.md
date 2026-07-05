# Identity and scope: system of record for agent proof

Proofbench's category is the **system of record for agent proof**: a vendor-neutral spec + harness that proves AI-agent changes work, with the OSS harness as the permanent trust anchor. We materialize in sequence (per the accepted ruling, `docs/research/product-shape-ruling.md`, 2026-07-06): (1) OSS harness wedge now, (2) paid verification agent as the first revenue product — design partners recruited during stage 1, (3) ledger/compliance control plane built only on customer pull. Agents are a metered capability, never the brand.

## Sequence gates (summarized; the ruling is authoritative)

- **Stage 1 → 2 advance:** ≥3 non-Lyric teams running `pb verify` weekly in anger AND an ENG-20190-class replay passing runtime-selected. Kill: 0 external weekly actives at day 90 → keep the harness as private infrastructure, go agents-direct.
- **Stage 2 → 3 advance:** 10 paying teams / ~$25k MRR AND >50% of verdicts observably change merge behavior. Kill (quality): <~50% of explore-generated tests survive without human rewrite → demote agent to manifest/spec-generator. Kill (business): pilots won't convert → sell the capability or exit to an agent vendor.
- **Stage 3 trigger:** ≥3 paying stage-2 customers independently ask where bundles live / for auditor access. Kill: 6 months of paid stage 2 with no such pull → do not build it.

## Amendment to PLAN §2

The non-goal is **human test-authoring tools**, not test generation: agent-generated durable automation (committed checks/specs) verified by the harness is explicitly in scope. This resolves the PLAN §2 contradiction between "not a test-generation vendor" and self-evolving tests.
