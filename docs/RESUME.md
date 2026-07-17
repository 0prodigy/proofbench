# RESUME — read this first to continue with zero loss

*Living checkpoint. Update it at the end of every working session. Git is the durable
checkpoint (every milestone is committed); this doc is the human/agent handoff on top of it.*

**Last updated:** 2026-07-17 · **Branch:** `product-v1` · **Tip:** run `git log --oneline -1`.

---

## The goal (what we are building)

A tool that, when an AI agent says a change is done, returns **proof — not the agent's word —
that a real user can do the thing, across every service it touches**: a tri-state verdict
(WORKS / DOES NOT WORK / COULD NOT DETERMINE) the writing agent **cannot fake**, backed by
replayable evidence. One-stop, three phases: **code works → deployed & healthy → works as
intended (behavioral)**. Runs on the user's own infra; onboarding is agentic. Full vision:
`docs/product-plan.md`. This branch is greenfield — do NOT resurrect the old code on `main`.

## The soul (principles — must stay baked into the code, not prose)

1. **Propose / dispose.** The agent *proposes* (interpretation, actions, narration — fallible);
   a deterministic harness *disposes* (executes, captures out-of-band, seals, computes the
   verdict). The agent can never write the verdict, forge harness evidence, or touch the seal.
2. **Asymmetry.** Agent unreliability can *cost* a WORKS (→ CND) but must **never manufacture a
   false WORKS**. `false-WORKS = 0` is the one release-blocking metric.
3. **Honest by default.** CND unless proven; reproduce k/N to convict; verdict set LAST from
   sealed, harness-provenance receipts only.
4. **Every line earns its place.** No stubs, no one-off scripts, no filler. An honest CND is
   fine; a fake value is not.

Full property + the six mandatory mechanizations (M1–M6) and the false-WORKS vector list
(FW-1…FW-20): `docs/phase-3-theory.md` (§0–§2 property + mechanisms; §7 M1–M6; §8 readiness).

## What is DONE and VERIFIED (by hand, not just builder claims)

- **Honesty core + E1 gate** (`src/`): evidence/verdict/seal, zero-dependency (Node built-ins).
  Deterministic tri-state verdict; real ed25519 seal (tamper → UNVERIFIED). Commit `cffcb7b`.
- **Phase runners + fixtures + adversarial suite**: `src/phases/phase{1,2,3}.mjs`,
  `fixtures/shop-{honest,lying}`, `test/adversarial/`. Commit `41614e9`.
- **Propose/dispose made STRUCTURAL** (`src/harness.mjs` mint + `newBundle` forces `agent`): a
  fabricated `'harness'`-labelled receipt is downgraded to `agent` → verdict CND; the new
  `forge-harness-provenance` driver proves it. Fresh-session confirm leg content-bound (MUST-2);
  type gate runnable + green (MUST-3). Commit `086dbfb`. A surgical audit found propose/dispose
  was only *conventional* (a fabricated `'harness'` receipt reached WORKS); this pass closed it —
  the "principles in the soul, not prose" bar.
- **Verified:** `node --test` → **30/30**; `node src/cli.mjs gate` → **PASS** (9 malicious
  drivers held ≤ not-WORKS; honest → WORKS). `pb phase3 fixtures/shop-lying` →
  **DOES_NOT_WORK** naming the response-vs-store mismatch; `shop-honest` → **WORKS** (k=2).
  Adversarial attacks (lying cache-read, forged delta, owner-shadow, vacuous negative,
  async-rollback) all held — no false-WORKS.
- **Corpus** (`corpus/`): the 12 blind battle-test cases; `false-WORKS = 0` = release gate.
- **Proof arc, all committed:** `86826eb` clean scratch → theory `9d8efed` → battle-test #1
  `1bc4d27` → campaign `f289c00` (12 blind PRs, honesty 12/12) → corpus `5bf6200` → core
  `cffcb7b` → runners `41614e9`.

## Architecture (where things live)

```
src/types.mjs      typed contracts + provenance ranks (agent<tool<harness)
src/evidence.mjs   content-address (sha256), bundle, seal/verifySeal (ed25519)
src/verdict.mjs    the deterministic tri-state truth-table (the honesty spine)
src/e1/            malicious-driver suite (drivers.mjs) + gate (gate.mjs)
src/phases/        phase1 (repo tests) · phase2 (compose health) · phase3 (HTTP-driven Catch)
src/cli.mjs        `pb` dispatcher: gate | phase1 | phase2 | phase3
fixtures/          shop-honest / shop-lying (two-service HTTP app w/ a planted coupon bug)
test/              verdict, e1, phase1, phase3 + test/adversarial/
```

## How to VERIFY (any session, from repo root)

```
node --test                  # expect 30/30
node src/cli.mjs gate         # expect GATE: PASS (9 malicious held incl. forge-harness-provenance=CND)
npm i && npm run typecheck    # authoritative type gate — pinned @types/node 20.19.43 → clean
node src/cli.mjs phase3 fixtures/shop-lying  --intent "coupon SAVE20 => total 20% less"  # DOES_NOT_WORK
node src/cli.mjs phase3 fixtures/shop-honest --intent "coupon SAVE20 => total 20% less"  # WORKS (k=2)
```

**Type gate authority:** `npm run typecheck` (pinned `@types/node` 20.19.43 + lockfile) is the
green, authoritative gate. Editor LSP diagnostics from a *different* ambient `@types/node`
(e.g. `phase3` `child.on`, a fixture's `IncomingMessage.signal`) are version-mismatch artifacts,
not defects — point the editor at the workspace TypeScript/types to silence them.

## NEXT (the bounded v1 — finishable; do NOT chase breadth)

1. **Core-fundamentals surgical pass — DONE** (`086dbfb`): the audit confirmed the fix; whether the
   structure *embodies* propose/dispose (harness/disposer vs driver/proposer boundary), flags
   any non-contributing line, and the remaining diagnostics. Apply the MINIMAL surgical set;
   keep 29/29 + gate PASS. No churn-for-taste.
2. **The Catch on the tractable real-repo class** (web front-door, compose-conjurable) — the
   real conjure+drive for phase 3, one stack done well before the next.
3. **Phases 1–2 to production shape** (code-works, deployed-healthy) on the same class.

**Deferred = scale-later (honest CND until built):** universal conjure of arbitrary systems
(the open-ended part — CONJURE is "never proven complete, only progressively hardened"),
native-client drive (AppFlowy), giant multi-service apps (PostHog/Sentry), the corpus
breadth-validation across all repos, the hosted ledger. Open vectors: FW-12 (fixture-world
divergence), FW-14 (config divergence), O1–O4 in `docs/phase-3-theory.md` §7.

## Operating constraints (live)

- **Spend limit** has interrupted background builds twice — always use **resumable workflows**
  and commit each verified slice immediately, so a kill loses nothing.
- Fable runs only as a subagent; Sonnet is the intended production driver (the theory must stay
  Sonnet-executable — that's what M1–M6 are for).
- reddit.com / x.com are blocked to the web crawler.

## Cross-session memory

The durable index is `~/.claude/.../memory/product-experience-first-pivot.md` (points here).
Update both this file and that memory at the end of a session.
