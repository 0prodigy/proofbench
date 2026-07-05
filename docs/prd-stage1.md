# PRD — Stage 1: OSS Harness Wedge (now → ~M3)

Scope: Stage 1 of the accepted sequencing ruling (`docs/research/product-shape-ruling.md`);
identity and stage gates per ADR-0001. Nights-and-weekends OSS effort. Everything here is
shape A only (ADR-0006): the user or their CI builds; Proofbench proves.

## Problem Statement

Teams adopting AI coding agents can't trust "done." The agent produces code fast, but a
human still has to decide whether it actually works — review overload, not generation, is
the bottleneck. Agents report "tests passing" regardless of real codebase state, and they
fail at environment bring-up on realistic services (SetupBench: 38.9–57.4% repo setup).
There is no vendor-neutral, repo-resident way to declare how a service becomes runnable
and testable, and no portable, tamper-evident format for the proof that a change worked.
Every agent vendor grades its own homework inside its own walled UI.

## Solution

An Apache-2.0 harness any agent or human drives: a per-repo readiness manifest
(`ready.yaml`, published as `spec/v0` JSON Schemas) brings the service up on a
runtime-selected substrate, drives real entrypoints, evaluates declared checks, and emits
a schema'd evidence bundle (v2 — tri-state checks, pairing, provenance, pins; v0 exists
and works). The `pb` CLI and an embedded MCP server are the two agent surfaces. A GitHub
App/Action posts the evidence-bundle report as a PR comment — the viral surface: every
verified PR advertises the format. docker/compose substrates are GA during the stage;
`k8s-attach` lands at stage exit, proven by an ENG-20190-class replay. Launch is Show HN
with a SetupBench-anchored headline ("agents with readiness manifests: X% → Y% setup
success"). Advance/kill criteria are recorded in ADR-0001 and not restated here.

## User Stories

1. As an **engineering lead**, I want every AI-written PR to carry an evidence bundle with a verdict and proof-ladder rung, so that I can gate merges on proof instead of the agent's narration.
2. As an **engineering lead**, I want the PR comment to show which checks passed, failed, or did not run (never default-green), so that an honest `not-run` is visible before I approve.
3. As an **engineering lead**, I want bundle pins (SHAs, images) recorded per run, so that I can reproduce exactly what was verified.
4. As a **platform engineer**, I want to declare in `ready.yaml` how my service — which needs a dozen cluster-side dependencies and cannot run locally — becomes testable via `k8s-attach`, so that agents can verify against our own cluster instead of a look-alike.
5. As a **platform engineer**, I want the same manifest to work on `local`, `compose`, or `k8s-attach` with the substrate chosen at run time, so that I maintain one spec, not three.
6. As a **platform engineer**, I want `pb init` to auto-detect my repo (compose file, Procfile, scripts, AGENTS.md) and propose a manifest, so that onboarding is generation, not authoring (ADR-0006).
7. As an **AI coding agent**, I want to call Proofbench over MCP to bring the service up, seed it, and run verification, so that I can prove my own change works before reporting done.
8. As an **AI coding agent**, I want the verify result to name the proof-ladder rung reached and the failing check's observed value, so that I can fix and re-verify instead of guessing.
9. As **Akash (customer #0)**, I want to run a real Lyric ticket end-to-end through `pb verify` — including a `k8s-attach` replay of an ENG-20190-class verification, runtime-selected — so that nothing ships that a real ticket hasn't exercised.
10. As **Akash**, I want `pb explore` behind a flag to prototype exploratory verification on Lyric tickets, so that Stage-2 agent quality data accumulates without touching the GA surface.
11. As an **OSS adopter**, I want `spec/v0` published as versioned JSON Schemas, so that I can implement or emit the formats without using the CLI.
12. As an **OSS adopter**, I want a local hub index over my evidence bundles, so that I can browse past runs without any hosted service.
13. As a **prospective Stage-2 design partner**, I want to see the harness verifying my PRs during Stage 1, so that I can evaluate the paid verification agent before it exists.

## Implementation Decisions

- **Modules:** manifest parsing/auto-detect, substrate drivers, verify engine, evidence
  writer, report renderer, and the `pb` CLI — plus the embedded MCP server (`pb mcp`) as
  the second surface over the same verbs. Single static Go binary (ADR-0012).
- **Driver families** per ADR-0005: substrates, check drivers, build strategies, auth
  providers — small frozen interfaces, `New(kind, ...)` selectors; substrate choice never
  baked into the manifest.
- **Launch matrix** per ADR-0006: docker/compose GA; `k8s-attach` at stage exit; shape A
  only in this stage; OSS auth = basic / API-key / cookie (`storageState`).
- **Evidence v2** evolves the working v0 bundle format: machine-checkable `checks[]`
  predicates, tri-state results, before/after pairing by run ID, provenance flags
  (harness-collected vs agent-supplied, per ADR-0002), proof-ladder level, run pins.
- **GitHub App/Action** is a publisher, not an engine: it runs `pb verify` (or receives a
  bundle from CI) and posts the rendered report as a PR comment. Same report the CLI
  prints — no second rendering path.
- **`pb explore`** ships behind an explicit flag, exercised only on Lyric tickets; its
  durable output is committed automation (checks/specs) replayed deterministically —
  agent proposes, harness proves (ADR-0002, ADR-0001 amendment).
- **Stage-2 design-partner recruitment happens during Stage 1**: the PR-comment surface
  and dogfood results double as the recruiting pipeline; no separate build artifact.

## Testing Decisions

Minimal seams — the ideal number is one, and the highest available:

- **Harness e2e = `examples/basic`.** The harness's own end-to-end test runs `pb init/up/
  seed/verify/report` against the example service and asserts on external behavior only:
  exit codes, verdicts, rungs, and the bundle validating against `spec/v0` schemas.
- **GitHub App/Action** is tested against a dedicated fixture repo — a real PR gets a
  real comment; assertion is on the posted comment body, not internals.
- **Evidence v2** is regression-tested against the real ENG-20190 v0 bundles as fixtures
  (no behavior loss on port).
- Existing package-level Go tests continue; no new test infrastructure or mocks of
  substrates — a check that can't run reports `not-run`, which is itself testable.

## Out of Scope

- **Stage 2:** the paid verification agent, shape B (agent builds/deploys), computer-use
  drivers, SSO credential-brokering, pricing/metering.
- **Stage 3:** hosted evidence ledger, RBAC, DSSE attestations, compliance exports,
  fleet/evidence-gated merge policies, managed BYOC connectors.
- Windows computer-use.
- Dagger (as substrate or build strategy).
- k8s-orchestrate (we attach to clusters; we never schedule on them in this stage).

## Further Notes

- **Launch:** Show HN + SetupBench-anchored headline; public fixture repo with manifests.
- **Gates:** advance = ≥3 non-Lyric teams running `pb verify` weekly in anger AND the
  ENG-20190-class replay passing runtime-selected; kill = 0 external weekly actives at
  day 90 (ADR-0001 — the ruling is authoritative).
- **Dogfood covenant:** Lyric is customer #0; every milestone exit is a real ticket.
- Per the adopted method (`docs/research/adr-method.md`), this PRD feeds `to-issues`
  vertical slices next; tracker publication is deferred pending the tracker decision.
