# PLAN — Agent Proof Harness (**Proofbench**, home: launchwings — see §10)

**Status (2026-07-06):** The v0 harness is **built and validated against ENG-20190**. Product shape is **decided** (accepted ruling: `docs/research/product-shape-ruling.md`): a sequenced combo — **OSS harness wedge → paid verification agent → control plane on pull** — with identity fixed on day one as the **system of record for agent proof**. Locked founder decisions live as ADRs in `docs/adr/` (identity/scope ADR-0001, pricing meter ADR-0004, driver architecture ADR-0005, and others); the Stage-1 spec is `docs/prd-stage1.md`, working context is `CONTEXT.md`, and the execution queue is `docs/backlog.md`. §7 and §9 below are reconciled to the ruling; the research content elsewhere is preserved as written.

**One-liner:** An open-source harness that lets any AI coding agent **prove its changes work — functionally, end-to-end — on any company's setup.** Two pillars:

1. **Readiness manifest** — a per-repo/service declarative spec of how that service becomes *runnable and testable*: dependencies (other services, DBs, queues), setup, seed data, health/readiness, entry points, validation surfaces. Substrate-polymorphic: the same manifest brings the service up locally, in containers, or **attached to the org's own cluster (BYOC)** — chosen at runtime.
2. **Evidence engine** — a capture harness that produces a **schema'd, portable, tamper-evident evidence bundle**: command logs with exit codes, before/after data snapshots, API responses, execution IDs, UI screenshots/video — attached to the PR/ticket and rendered by a hub. The harness collects the evidence, not the agent's narration.

Bring your own agent (Claude Code, Cursor, Codex, OpenHands, Devin) and your own compute (laptop, compose, `delta-akash`/`redcat`-style BYOC clusters, or a sandbox provider). OSS core; hosted cloud later as the moat.

---

## 1. Why this, why now (research summary, 2026-07)

**The pain is loud and unowned:**
- Verification, not generation, is the bottleneck. HN/Stack Overflow consensus: "the agent can produce code quickly, but someone still has to decide whether the output is trustworthy"; review overload is "the defining technical risk of the current moment" ([SO blog](https://stackoverflow.blog/2026/05/21/coding-agents-are-giving-everyone-decision-fatigue/), [Addy Osmani](https://addyo.substack.com/p/the-80-problem-in-agentic-coding)).
- Agents fabricate completion. "Agents generate completion language ('tests passing') regardless of actual codebase state" ([dev.to](https://dev.to/moonrunnerkc/ai-coding-agents-lie-about-their-work-outcome-based-verification-catches-it-12b4)); Cognition builds internal guardrails against agents faking UI evidence via JS manipulation ([Cognition](https://cognition.com/blog/testing-development)).
- Agents fail at environment bring-up: SetupBench shows 38.9–57.4% on repo setup and 20–53% on DB setup ([arXiv 2507.09063](https://arxiv.org/abs/2507.09063)); EnvBench, Multi-Docker-Eval confirm. **These benchmarks are both our eval harness and our pitch.**

**Two gaps nobody covers (validated across ~50 projects):**
- **No open, repo-resident spec** combines: cross-repo service deps + seed data + readiness + declared validation surfaces + substrate polymorphism. Closest: Ona `automations.yaml` (proprietary, CDE-bound), Devin blueprints (closed), Okteto cross-repo `dependencies`, Garden's action DAG (company failed), compose (single-project). Codex/Jules/Devin/Cursor all lock env config in *their* UI — repo-resident + vendor-neutral is the open flank, and the AAIF/Linux-Foundation wave (AGENTS.md, MCP) is the adoption window.
- **Evidence capture has zero prior art in any spec.** Crabbox (OpenClaw's runner) has artifacts/`desktop proof` but generic files, no schema, no data snapshots, and *explicitly refuses to own environment semantics*. Devin's reports are closed. The only articulation of a schema'd bundle is academic ("Merge-Readiness Packs", [arXiv 2605.20456](https://arxiv.org/html/2605.20456)).

**We're not starting from zero.** The Lyric-internal setup is a working v0: `evidence.sh` (bundle writer with manifest.json, sha256'd artifacts, verdict-set-last) is already org-agnostic; the `:8787` hub renders bundles; ENG-20190 produced 7 real bundles (including honest fails — proof the model works); `per-repo-setup.md`/`port-forward-deps.md`/LOCAL-RUN-* docs are a hand-written prototype of the readiness manifest.

## 2. What we are NOT building

- **Not a sandbox/runtime** (E2B, Daytona, Modal, microsandbox) — we *run on* them via providers.
- **Not a remote-runner control plane** (crabbox/Crabfleet) — interop target, not competitor. Crabbox ships bytes to a box; we own what it punts on: environment semantics + schema'd evidence.
- **Not a human test-authoring tool** (Momentic, QA Wolf, Meticulous, Shiplight) — they're UI-first and own human authoring; we're the substrate + proof layer (they could emit into our bundles). Per ADR-0001 the non-goal is *human test-authoring tools*, not test generation: agent-generated durable automation (committed `checks[]`/specs) verified by the harness is explicitly in scope.
- **Not CI** — we run inside the agent loop pre-merge; CI can also invoke us (`verify` in a workflow).
- **Not an agent** — agent-agnostic by design; that's the differentiation vs Devin/Cursor built-ins.

## 3. Core concepts

1. **Readiness manifest** (`ready.yaml` per repo; `workspace.yaml` org-level graph). Declares how the service becomes runnable/testable. **Derive, don't restate:** points into existing truth (compose files, devcontainer.json, Makefile, AGENTS.md, Backstage `dependsOn`) instead of duplicating it. Earthly's post-mortem is the rule: a spec that "requires integration work + replicates existing work + new syntax" dies.
2. **Substrate drivers.** Same manifest, runtime-selected substrate: `local` (bare processes via process-compose semantics) · `compose` · `k8s-attach` (BYOC: port-forward profiles, optionally mirrord/Signadot-style traffic borrowing — the answer to "my service needs 12 others") · `remote` (delegate to E2B/Daytona/crabbox providers). Score-style typed resources + `${resources.db.host}` placeholders resolve per substrate.
3. **Drive verbs.** The org's "how to exercise my product" commands (e.g. Lyric's `lyric-fire-execution.sh`), declared with identity injection and structured output — validation drives *real entrypoints*, not look-alikes.
4. **Proof ladder.** Every report names the rung reached — never "done": `L0 static-valid → L1 builds/loads → L2 unit-green → L3 up+healthy → L4 effect-verified (data/API/UI probe) → L5 end-to-end observed`. Encodes the builder-copilot lessons: "schema-valid ≠ runs; wired ≠ runs"; **verify the effect, not the exit status**; validate against the declared contract, not the tool's own report.
5. **Evidence bundle v2.** Evolves the proven `evidence.sh` schema. New in v2: machine-checkable `checks[]` (predicates: `exitCode==0`, `rows>0`, `http==200`, `diff.empty`), **tri-state** results (`pass|fail|not-run` — never default-green), before/after bundle pairing by ID, **provenance flags** (harness-collected vs agent-supplied — anti-fabrication), proof-ladder level, run pinning (SHAs/versions of everything exercised).
6. **Attestations (later).** DSSE/in-toto-style signed envelope over the bundle — the supply-chain idiom applied to *functional* verification. Nobody has done this; it's the tamper-evidence + compliance story.
7. **Human gates as schema.** Destructive/irreversible steps (deploys, prod writes, expensive seeds) declared in the manifest with named gates; an unreachable verification yields an honest `inconclusive` naming the gate (never a fake pass) — plus a **pre-authorization protocol** so an approved verification run isn't blocked mid-flow by the agent harness's own write policy.

## 4. Readiness manifest — spec sketch (v0)

```yaml
# ready.yaml  (schema: proofbench/spec v0)
service: orders-api
role: REST API for order lifecycle

sources:                     # derive, don't restate
  compose: ./docker-compose.yml        # deps/healthchecks read from here
  devcontainer: .devcontainer/devcontainer.json
  agentsmd: ./AGENTS.md

run:
  modes: [local, compose, k8s-attach]  # what this service supports
  local:
    start: npm run dev
    env:
      file: .env.local
      derive: { from: k8s-pod, name: orders-api }   # pull live config, don't hand-write
      overrides: { DB_HOST: "${resources.db.host}" }
  ready: { http: ":8080/healthz", timeout: 60s }     # k8s probe vocabulary

resources:                   # Score-style typed deps, resolved per substrate
  db:    { type: postgres, via: { compose: postgres, k8s: svc/orders-db } }
  queue: { type: kafka,    via: { k8s: svc/kafka },  optional: false }
  auth-svc: { type: service, repo: ../auth-service, via: { k8s: svc/auth } }

seed:
  - name: schema     ; run: npm run db:migrate ; after: [db]
  - name: fixtures   ; run: npm run db:seed -- --tiny ; after: [schema]

drive:                       # real entrypoints to exercise the product
  create-order: { run: ./scripts/create-order.sh, identity: env:USER_EMAIL, output: json }

checks:                      # declared validation surfaces (skaffold-verify heritage)
  - name: order-roundtrip
    level: L4                              # proof-ladder rung this check proves
    exercise: drive.create-order
    expect: [ "exitCode == 0", "http.status == 201", "db.orders.rows > @before" ]
    requires: [PB_EXECUTION_ID]             # unset => the check records not-run, not a hard fail
  - name: e2e-ui
    level: L5
    exercise: playwright tests/e2e/order.spec.ts
    expect: [ "exitCode == 0" ]
    artifacts: [screenshot, recording]

gates:                       # human gates, structural
  - { on: deploy, reason: "cluster release is irreversible" }

known_walls:                 # trap + why + recovery (builder-copilot pattern)
  - symptom: "401 from artifact registry"
    cause: "token expiry"
    recover: gcloud auth print-access-token | docker login ...
```

`workspace.yaml` at org level composes repos into a graph (seed it from Backstage `dependsOn` where present) and names cluster contexts/credentials recipes for `k8s-attach`.

**Zero-config day one:** with no `ready.yaml`, the CLI auto-detects (compose file, Procfile, package.json scripts, AGENTS.md) and proposes a generated manifest — value on first run, no rewrite tax.

*Decided architecture (ADR-0005):* substrates are pluggable **driver families** selected at run time — the manifest names what a service supports, never bakes in the choice.

## 5. Evidence bundle v2 — schema sketch

```jsonc
// evidence/<ts>-<phase>/manifest.json
{
  "schema": 2,
  "ticket": "ENG-20190", "runId": "20260704-101500-reverify",
  "claim": "sync(verse) propagates to sequenceNote on release",
  "phase": "reverify", "kind": "after", "pairsWith": "20260702-144606-verify",
  "surface": { "substrate": "k8s-attach", "cluster": "delta-akash", "env": "delta" },
  "pins": { "repo": "appservice@abc123", "image": "dataservice:redcat@sha256:..." },
  "proofLevel": "L4",
  "checks": [
    { "name": "order-roundtrip", "state": "pass", "expect": "db.orders.rows > @before",
      "observed": "42 > 17", "artifacts": ["03-fire.log", "sn-post.json"] },
    { "name": "e2e-ui", "state": "not-run", "reason": "gate: cluster deploy pending" }
  ],
  "artifacts": [
    { "type": "command", "name": "03-fire", "path": "03-fire.log", "sha256": "...",
      "provenance": "harness",                       // harness-collected vs agent-added
      "meta": { "cmd": "...", "exitCode": 0, "durationSec": 41 } }
  ],
  "verdict": "pass", "note": "set last, from artifacts"
}
```

v1→v2 fixes (each one is a gap observed in real ENG-20190 bundles): checks are machine-evaluated, `not-run` is explicit, bundles pair by ID not convention, phase enum validated, unregistered files auto-sealed at verdict time, provenance recorded, pins make the run reproducible.

*Decided architecture (ADR-0005):* check execution (exec, Playwright, computer-use) is a pluggable driver family — a new check type is a new driver, not a schema fork.

## 6. Architecture

```
 repo/ready.yaml  workspace.yaml  (+compose/devcontainer/AGENTS.md as sources)
        │
   ┌────▼─────┐   substrate adapters    ┌──────────────┐
   │  engine  │──local│compose│k8s-attach│remote────────▶ running target
   └────┬─────┘                          └──────────────┘
        │ up / seed / drive / check
   ┌────▼─────┐
   │ capture  │  wraps every command (tee+exit code), snapshots declared
   └────┬─────┘  observations before/after, screenshots via Playwright
        │
   evidence/<run>/manifest.json + artifacts   ──▶ hub (local, read-only)
        │                                      ──▶ PR/Jira comment (publisher)
        └─ (later) DSSE attestation           ──▶ hosted hub (cloud)

 agent surface: CLI (`pb up|seed|verify|evidence|report`) + MCP server
 compile targets: copilot-setup-steps.yml · .cursor/environment.json ·
                  .openhands/setup.sh · AGENTS.md section  (generated from ready.yaml)
```

**Implementation choices:** Go single static binary for CLI/engine/capture (runs inside arbitrary repos and sandboxes with zero runtime deps; crabbox precedent). JSON-Schema-published formats so anyone can implement. Hub: generalize the existing Next.js `_hub`. MCP server embedded in the same binary (`pb mcp`).

*Decided architecture (ADR-0005):* substrate adapters, check drivers, build strategies, and auth providers are all pluggable driver families behind small frozen interfaces, selected per run.

## 7. Roadmap (Stage structure per the accepted ruling, `docs/research/product-shape-ruling.md`)

**Stage 1 — OSS harness wedge (now → ~M3).** Absorbs P0–P3: the harness wedge, GitHub App bundle comments, `k8s-attach`, `pb explore` prototyped behind a flag, and design-partner recruitment for Stage 2 (recruited during Stage 1, not after).

- **P0 — Extract & port (the seed). DONE (v0 built).**
  Port `evidence.sh` → `pb evidence` (Go), schema v2, with assert/seal/pairing. Generalize the `:8787` hub (config-driven roots, drop Lyric coupling). Exit: existing Lyric skills call `pb evidence` instead of `evidence.sh` with zero behavior loss.
- **P1 — Manifest v0 + local/compose substrates. DONE (v0 built).**
  `ready.yaml` parser + auto-detect generator; `pb up/seed/verify` on `local` and `compose`; checks with predicates; ambient capture (every `pb`-run command lands in the bundle automatically). Exit (dogfood): manifests for 2–3 Lyric services (dataservice, metadata-service, triggerservice — content already exists in `per-repo-setup.md`), and one real ticket verified through `pb verify` end-to-end.
- **P2 — BYOC attach + before/after machinery. Partially done:** bundle pairing shipped in v0. **Remaining:** `k8s-attach` substrate: port-forward profiles (generalize `pf.sh`/`keep-forwards.sh`), env derivation from live pods (`pod-env-to-local.sh` idea), optional mirrord mode; snapshot primitives (`@before`/`@after` observations). Exit: **replay an ENG-20190-class verification entirely through the framework against `delta-akash`/`redcat`, runtime-selected** — the acceptance test the user named.
- **P3 — Agent surface + publishing + public launch.**
  MCP server; vendor compile targets (killer adoption feature); **GitHub App posting bundle comments (the viral surface)**; PR/Jira publishers (verdict + proof-ladder rung + artifact links); docs site; public fixture repo (e.g. a fork of a well-known microservices demo with manifests); `pb explore` prototyped behind a flag on Lyric tickets. Launch: Show HN + a SetupBench/EnvBench result — *"agents with readiness manifests: X% → Y% setup success"* — the headline that markets itself.

**Advance:** ≥3 non-Lyric teams running `pb verify` weekly in anger (the only metric that matters — not stars, not manifest counts) AND the ENG-20190-class replay passes runtime-selected. **Kill:** 0 external weekly actives at day 90 → freeze the spec, keep the harness as private infrastructure, go agents-direct on it.

**Stage 2 — Paid verification agent (M3 → M9).** GitHub App: every AI-authored PR gets bring-up → drive → evidence bundle → verdict → **proposed fix**. One exploratory computer-use round whose *only durable output* is committed automation — Playwright specs + `checks[]` in ready.yaml — verified thereafter by the deterministic harness. Shape (B) = the agent driving the same pb verbs. Onboarding = per-repo ready.yaml generation. Pricing per ADR-0004: **PAYG per verdict-bearing verified run + team subscription**.

**Advance:** 10 paying teams / ~$25k MRR AND >50% of verdicts observably change merge behavior (blocked or fixed a PR — the verdict is load-bearing). **Kill (agent quality):** after 2 design-partner cycles, <~50% of explore-generated tests survive without human rewrite → demote agent to manifest/spec-generator only. **Kill (business):** pilots run it but won't convert → sell the capability, jump to Stage 3 compliance-direct or exit to an agent vendor.

**Stage 3 — System of record (on pull, est. M9+).** Absorbs P4 (trust & cloud): hosted retained ledger, RBAC, diff-two-bundles, DSSE attestations + `pb attest verify`, SOC2/ISO change-management exports, evidence-gated merge policy, managed BYOC connectors, crabbox interop (emit our bundle from crabbox runs; use their providers as `remote` substrate).

**Trigger to build:** ≥3 paying Stage-2 customers independently ask "where do bundles live / can my auditor see this." **Kill:** 6 months of paid Stage 2 with no such pull → stay agent + OSS + support; do not build faith-based capex.

## 8. OSS strategy

- **License:** Apache-2.0. **Layout:** monorepo — `spec/` (versioned JSON Schemas — the standard others can implement), `engine/`, `cli/`, `mcp/`, `hub/`, `adapters/`, `docs/`, `fixtures/`.
- **Spec as the flag:** publish `spec/v0` early, invite implementations; long-term aim it at AAIF (where AGENTS.md/MCP live) — Devfile's stagnation shows a spec needs a flagship consumer, so the CLI+MCP is that consumer from day one.
- **Allies, not clones:** PR crabbox to emit our bundle format; read Ona/compose/devcontainer; emit vendor configs. Every interop is distribution.
- **Community manifest registry:** `ready.yaml` recipes for common stacks (Rails+PG, Next+Supabase, Spring+Kafka…) — the "awesome list" flywheel and the SEO surface.
- **Dogfood covenant:** Lyric is customer #0; nothing ships that a real Lyric ticket hasn't exercised.

## 9. Cloud hosting as moat

The bundle format stays open and portable (that's the trust story). The moat is the **ledger and everything around it** — but per the ruling this control plane is **Stage 3, built only on pull** (≥3 paying Stage-2 customers independently asking where bundles live / for auditor access), never as faith-based capex:

1. **Hosted evidence ledger** — org-wide, retained, searchable, RBAC'd; PR/Jira/Slack integrations; diff-two-bundles view.
2. **Compliance product** — signed attestations + exports mapped to SOC2/ISO change-management: *"an audit trail of what AI agents did to your codebase and the proof it worked."* This is the enterprise wedge; no vendor owns it.
3. **Readiness scores & analytics** — per-repo agent-readiness scoring (SetupBench-style), flaky-verification detection, org dashboards ("% of merged agent PRs with L4+ evidence").
4. **Managed BYOC connectors** — runner-in-cluster (pull model, least privilege, evidence-out only; ADR-0011) plus managed remote runners via provider partners.
5. **Fleet features** — Crabfleet-style supervision with evidence-gated merge policies (`fix_until_green_and_merge` but green = evidence bundle, not just CI).

Pricing (ADR-0004): free forever local/OSS. The PAYG meter is the **verdict-bearing verified run** — one per-PR invocation that executes the manifest's checks and produces an evidence bundle with a verdict — plus a **team subscription** for retention, RBAC, and the hosted hub; compute is passed through near cost as a separate visible line item. **Explicitly no seat pricing** — the market is moving off seats, and a seat meter would pay us less the more autonomous customers' agents become. The sticky asset is the accumulated evidence ledger + integrations — exporting the data is easy (open format), leaving the workflow is not.

## 10. Naming

Avoid entirely: crustaceans (crabbox/Crabfleet/clawbench — reads as an OpenClaw satellite, and Anthropic already forced one rename there), "Harness" (Harness.io), "Evidence" (Evidence.dev), "Momentic-style 'agentic verification'" phrasing (their marketing), "Dashcam" (TestDriver).
**Decided (2026-07-06):** the project keeps the name **Proofbench**. Home is the founder's **launchwings** brand/org (owned domain): repo `github.com/launchwings/proofbench`. The repo stays private until the Show HN launch (Stage-1 launch checklist, docs/backlog.md #20), which is when the GitHub org/npm/pkg availability checks finalize.
Positioning language to claim early (currently academic-only): **"evidence bundle"** and **"merge-readiness"**.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Spec cold-start (Earthly death: integration work + new syntax) | Auto-detect + derive from compose/devcontainer/AGENTS.md; value with zero manifest on first run; generators not rewrites |
| Vendors bundle verification (Devin/Cursor/Copilot built-ins) | Vendor-neutral + repo-resident + BYOC is the counter-position; their configs are our compile targets |
| Incumbents bundle verification **free** — it's an existential roadmap item for them | Neutrality + harness-anchored, provenance-flagged evidence: an agent vendor grading its own homework is structurally untrustable; a neutral proof layer is the only verdict a third party can trust |
| Crabbox expands into env semantics | Interop early (bundle emitter PR), stay ahead on data-plane evidence + BYOC attach |
| Agents game the evidence | Provenance flags, harness-collected capture, attestation signing; guardrail patterns from Cognition |
| Config burden lands on teams who don't feel the pain (Garden's failure) | The buyer is whoever runs agents at scale; manifests generated by the agent itself on first run, humans only review |
| Scope creep into CI/test-gen | §2 non-goals enforced in roadmap reviews |

## 12. Prior art shortlist (full research in agent reports)

| Steal from | What |
|---|---|
| Ona automations.yaml | services `start/ready` + seed tasks + `dependsOn` (closest prior art) |
| Score | typed resources + `${resources.*}` placeholder resolution (BYOC key) |
| Skaffold `verify` / Devin `post-build` | declared post-deploy validation with exit-code semantics |
| Devin blueprints | initialize / maintenance / knowledge / post-build taxonomy |
| Heroku app.json | env-var metadata, typed addons, `postdeploy` seed |
| compose | `depends_on.condition: service_healthy` + healthcheck grammar (baseline) |
| k8s probes | readiness vocabulary verbatim |
| crabbox | provider list, config cascade, `desktop proof` UX, capsule/replay |
| Codex cloud | citation discipline (terminal logs as ground truth), setup/maintenance split |
| Cognition | test-plan-first, assertion timeline, anti-cheat guardrails, chaptered video |
| builder-copilot skills | typed artifact bus, tri-state "Done when", proof ladder, traps-with-why, honest-outcome reporting |
| Meticulous | base-vs-head double-replay = before/after pattern |
| in-toto/SLSA | signed attestation envelope idiom |

## 13. Upgrade the local Lyric setup now (dogfood-before-generalize)

*Status 2026-07-06: items 1–3 are done, superseded by the Go port (`pb evidence` ships the phase enum, seal, assert, and pairing — see docs/backlog.md #14 for the Lyric cutover, which also folds in item 5); items 4–9 remain open as skill follow-ups.*

Each item fixes an observed gap AND prototypes a framework feature:

1. **evidence.sh:** validate `--phase` (add `fix` to enum); `seal` step at verdict time auto-registering untracked files; support pipelines in `run` (`bash -c`); optional stdout/stderr split. → becomes `pb evidence` P0.
2. **Machine checks:** add `checks[]` + `evidence.sh assert` (exitCode/nonempty/diff predicates). → schema v2.
3. **Bundle pairing:** `--pairs-with <runId>`. → v2 pairing.
4. **De-duplicate doctrine:** single source in the `evidence` skill; fix the port-convention drift (8200/8201 vs 8000/3113) in `lyric-local-dev` vs `per-repo-setup.md`.
5. **Retire `_dashboard/dashboard.py`** (two hubs contend for :8787).
6. **Write `ready.yaml` v0 for dataservice + metadata-service + triggerservice** from `per-repo-setup.md`/`port-forward-deps.md` — first real manifests, doubles as framework fixture.
7. **Pre-authorization protocol** for verification mutations (the ENG-20190 permission-classifier collision): a per-run allowlist the orchestrator grants before reverify.
8. **Adopt builder-copilot patterns in validator/lyric-qa contracts:** tri-state check reporting + proof-ladder rung named in every report.
9. **Security:** rotate the plaintext GitHub PAT referenced in lyric-platform-skills `.claude/CLAUDE.md`; remove committed `__pycache__` from that repo.

## 14. Day-1 bootstrap checklist

*Status 2026-07-06: steps 2–4 are done (spec/v0, Go port, hub) and step 6's README is written minus the demo GIF; step 1 is decided (Proofbench @ github.com/launchwings — §10, availability checks at publish); step 5 (Lyric ready.yaml + public sample repo) remains — see docs/backlog.md #15, #19, #20.*

1. Pick name (checks per §10) → create GitHub org/repo, Apache-2.0.
2. `spec/v0`: JSON Schemas for `ready.yaml` + evidence manifest v2 (start from §4/§5).
3. Port `evidence.sh` → Go `pb evidence` with tests against the 7 real ENG-20190 bundles as fixtures.
4. Generalize `_hub` → `hub/` (config-driven root).
5. Hand-write `ready.yaml` for one Lyric service + the auto-detect generator for a public sample repo.
6. README with the one-liner, proof ladder, and a 60-second demo GIF (PR comment with evidence bundle).
