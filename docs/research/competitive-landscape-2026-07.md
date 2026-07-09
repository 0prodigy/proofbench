# Competitive Landscape — 2026-07-10

**Date:** 2026-07-10
**Status:** Research complete — informs positioning, not an ADR
**Scope:** Agent-Field/pr-af teardown, wider agent-verification landscape sweep, and the positioning moves this implies for Proofbench (`docs/PLAN.md`, `docs/adr/0001-identity-and-scope.md`).

---

## 1. Agent-Field/pr-af teardown

**What it is:** [Agent-Field/pr-af](https://github.com/Agent-Field/pr-af) ("#1 open-source code reviewer on Code-Review-Bench") is a real, active, autonomous PR-review system — an agentic **code reviewer**, not an execution-verification harness. It is adjacent to Proofbench, not a direct competitor: it never builds, tests, or deploys the code it reviews.

- **Architecture — 7-phase static pipeline, zero runtime execution:** intake triage → anatomy (diff parsing, import-graph blast radius) → planner (meta-prompted, PR-specific review dimensions) → N parallel LLM reviewer agents (default 8, up to 3 reference hops, 2 child harnesses) → cross-ref/adversary resolver + coverage gate → deterministic scoring → GitHub inline comments (APPROVE/COMMENT/REQUEST_CHANGES). Nothing executes the reviewed code. ([ARCHITECTURE.md](https://github.com/Agent-Field/pr-af/blob/main/docs/ARCHITECTURE.md))
- **"Evidence" means grep/AST, never infrastructure:** `evidence.py`'s only subprocess calls are `grep -RInE` (10s timeout) plus AST snippet extraction; findings carry evidence as prose strings. Docker/k8s appear only as pr-af's own deployment targets and as an intake keyword list — the code under review never runs on any substrate. ([evidence.py](https://github.com/Agent-Field/pr-af/blob/main/src/pr_af/evidence.py))
- **LLM stack:** BYOK via OpenRouter through an `opencode` CLI harness, default `kimi-k2.5`, GLM-5.2 for its benchmark claim, Opus-class optional; ~$2/review, 35-50 min latency; budget-capped (`PR_AF_MAX_COST_USD`). Apache-2.0 badged but ships no LICENSE file (`license: null` via GitHub API). ([.env.example](https://github.com/Agent-Field/pr-af/blob/main/.env.example))
- **Traction:** 184 stars, 19 forks, 4 contributors (effectively 2-person), active weekly commits. Backing org **Agent-Field** (agentfield.ai) is the real signal: 14 repos incl. the AgentField Go control plane (2,328 stars, "observable, auditable, identity-aware" agents). ([org](https://github.com/orgs/Agent-Field/repositories))

**Proofbench's four pillars vs. pr-af — all uncontested:**

| Pillar | pr-af | Gap |
|---|---|---|
| Tamper-evident evidence provenance | Unhashed, unsigned prose strings inside finding JSON; nothing detects fabrication | Absent ([ARCHITECTURE.md](https://github.com/Agent-Field/pr-af/blob/main/docs/ARCHITECTURE.md)) |
| Substrate polymorphism / BYOC k8s-attach | Only "substrate" is the git checkout box (Compose/Railway/Actions runner); no customer-cluster attach | Absent by design ([docker-compose.yml](https://github.com/Agent-Field/pr-af/blob/main/docker-compose.yml)) |
| Vendor-neutral, repo-resident spec | Configured via env vars + `agentfield-package.yaml` for `af install` registration; requires running their control plane (curl\|bash, API keys, Postgres) | Absent; ecosystem lock-in instead ([agentfield-package.yaml](https://github.com/Agent-Field/pr-af/blob/main/agentfield-package.yaml)) |
| Tri-state proof ladder (proven/disproven/unproven) | Closest philosophical overlap (adversary reviewer, falsifiability gate) but `merge_gate.py` **fails open** (`blocking=False` default on failure); no "could not check" state; all verdicts are LLM opinions on code text | Binary, fails open ([merge_gate.py](https://github.com/Agent-Field/pr-af/blob/main/src/pr_af/merge_gate.py)) |

**The real watch items are not pr-af itself:**

- **sec-af** (171 stars) — tagline "proves exploitability with verdicts, traces, and actionable evidence": the org's own product already speaks Proofbench's vocabulary (prove/verdict/evidence). ([sec-af](https://github.com/Agent-Field/sec-af))
- **SWE-AF** (911 stars) — "plan, code, test, and ship" production PRs: the agent fleet that would need a Proofbench-like proof layer if wired through runtime verification.
- **The AgentField control plane** itself (2,328 stars) markets "cryptographic identity, verifiable authority, governed execution" — identity-of-the-agent today, but the nearest thing in this ecosystem to Proofbench's provenance story, and extensible toward evidence integrity.

If Agent-Field wires SWE-AF output through a runtime-verification stage on the AgentField control plane, they converge on Proofbench's territory with an existing 2.3k-star distribution channel. Track sec-af and SWE-AF quarterly, not pr-af.

---

## 2. Landscape

The 2026 field validates the thesis — "verification is the bottleneck" is now the dominant industry narrative (agent PRs merge at roughly half the human rate; GitHub processed 43M+ PRs/month in 2025) — but no one owns Proofbench's exact combination: OSS harness + attach-to-real-infra + schema'd evidence bundles + GitHub-App per-PR verdict.

| Project | URL | One-line threat assessment |
|---|---|---|
| **Qovery Agent** | [qovery.com/blog/coding-agents-broken-loop](https://www.qovery.com/blog/coding-agents-broken-loop) | HIGH — commercial, funded, ships an ephemeral full-stack env on the *customer's own* K8s cluster with deploy+E2E+preview-URL; markets "who verifies agent code works?" but is Linear-triggered (not automatic per-PR), no schema'd evidence bundle or machine verdict. |
| **Proliferate (YC S25)** | [github.com/proliferate-ai/proliferate](https://github.com/proliferate-ai/proliferate) | HIGH on OSS mindshare — 100% AGPL-3.0, self-hostable incl. control plane, "sandboxed environments, event triggers, verification workflows"; verification is human-observational (watch the session), not evidence-bundle/verdict-based, and sandboxes are its own cloud/local model, not real k8s/EC2 attach. |
| **Autonoma AI** | [getautonoma.com/blog/autonomous-testing-platform](https://getautonoma.com/blog/autonomous-testing-platform) | MEDIUM-HIGH — commercial per-PR pipeline (plan → generate → replay → review) with per-step verification against a full-stack preview runtime; managed envs (not customer infra), no portable evidence artifact, closed source. |
| **Anvil (burkeholland)** | [github.com/burkeholland/anvil](https://github.com/burkeholland/anvil) | MEDIUM conceptually / LOW architecturally — OSS, owns the "evidence bundle" term (SQLite, baseline-vs-after, exit codes, verdicts); single-agent, local/CLI, build+unit-test level only, no real-infra bring-up, no schema/standard. |
| **GitHub native (Copilot coding agent, agent apps, session audit)** | [github.blog/changelog/2026-07-02-copilot-agent-session-streaming-is-now-in-public-preview](https://github.blog/changelog/2026-07-02-copilot-agent-session-streaming-is-now-in-public-preview/) | HIGH as distribution/absorption risk — GitHub owns agent audit trails at the platform level (Agent-Logs-Url trailers, agent-apps marketplace, enterprise SIEM streaming); its "environment" is a CI VM, not real infra, and there's no works-end-to-end verdict. Also Proofbench's best distribution channel. |
| **kubernetes-sigs/agent-sandbox** | [github.com/kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) | LOW as competitor, plumbing not verification — but will commoditize the k8s-attach substrate layer; adopt as a substrate rather than hand-roll isolation. |
| **Agent Receipts / OATR / ProofAgent Harness** | [arxiv.org/html/2605.24134](https://arxiv.org/html/2605.24134) | LOW-MEDIUM individually, signals an evidence-format standards race is starting (Ed25519/W3C VC "receipts," attestation registries); none bind evidence to real-system execution the way schema'd bundles do — whoever ships the de-facto schema first wins the integration graph. |
| **AI E2E test-gen (Momentic, QA Wolf, Meticulous, Bug0, DevAssure, mabl)** | [momentic.ai](https://momentic.ai/) | MEDIUM — verdict-on-PR products, but browser/UI regression testing only; none capture agent evidence or attach to arbitrary real infra; will claim "we test every PR" mindshare. |
| **Agent audit-trail / compliance vendors (TierZero, miniOrange)** | [tierzero.ai/blog/ai-agent-audit-trail](https://www.tierzero.ai/blog/ai-agent-audit-trail/) | LOW as competitors (ops/compliance logging, not code verification) but a strong tailwind: EU AI Act enforcement Aug 2, 2026 (Art. 19, 6-month log retention) + NIST AI RMF 1.1 audit guidance. |
| **Security/pentest AI (XBOW, Horizon3 NodeZero, RunSybil)** | [xbow.com/platform](https://xbow.com/platform) | None direct, but proves buyer demand for "verified evidence of what agents did" — each hand-rolls its own validation layer; prime design-partner targets. |
| **Environment bring-up benchmarks (SetupBench, EnvBench, DeployBench)** | [arxiv.org/pdf/2507.09063](https://arxiv.org/pdf/2507.09063) | Benchmarked, not productized — no shipped product converts this into reusable per-repo readiness manifests. Proofbench's currently-unoccupied lane. |

---

## 3. Implications — five positioning moves

1. **Own the evidence schema as an open standard, not a harness feature.** "Evidence bundle" language is spreading (Anvil, Agent Receipts, OATR) but nobody has a portable, signed, infra-grounded schema for "this PR was proven working on real systems." Publish the bundle schema as a versioned spec, make it emit in-toto/Sigstore-compatible attestations attachable via GitHub artifact attestations, reference-implement Ed25519 signing. Whoever defines the format gets the integration graph.
2. **"Attach to YOUR infra" vs. everyone else's "our environment."** Qovery needs its platform on the customer's cluster; Autonoma/Bug0/Momentic run managed preview/cloud envs; Copilot's env is an Actions VM. Proofbench's k8s-attach/docker/EC2 substrates are the differentiated wedge (Qovery's own blog concedes code sandboxes can't hit real databases). Adopt kubernetes-sigs/agent-sandbox as a first-class substrate rather than rebuilding isolation.
3. **Ship on GitHub's rails.** Register as an agent app in the June-2026 agent-apps marketplace, post verdicts as Checks, link bundles from commits via the same trailer pattern GitHub established (Agent-Logs-Url). GitHub owns session-level audit (what the agent did); Proofbench owns outcome-level proof (that the change works) — complementary, and the marketplace is the cheapest distribution channel to the merge decision.
4. **Cut a compliance story before Aug 2, 2026.** EU AI Act Article 19 log retention and NIST AI RMF 1.1 audit guidance make schema'd, retained, tamper-evident evidence bundles a compliance artifact, not just dev convenience — add retention config, redaction, signed-bundle export. Court security-AI companies (XBOW/Horizon3/RunSybil-class) as design partners: they already sell "verified findings" and each hand-rolls a validation layer Proofbench could standardize.
5. **Make E2E-test-gen tools evidence producers, not rivals.** Momentic/QA Wolf/Meticulous/Autonoma answer "did the UI regress?"; Proofbench answers "did the agent prove its change works end-to-end on the real system, with portable evidence?" Don't compete on browser-test generation — expose an adapter so their test runs feed INTO a Proofbench evidence bundle.
