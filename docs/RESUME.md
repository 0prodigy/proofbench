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
- **Verified:** `node --test` → **32/32**; `node src/cli.mjs gate` → **PASS** (10 malicious
  drivers held ≤ not-WORKS; honest → WORKS). `pb phase3 fixtures/shop-lying` →
  **DOES_NOT_WORK** naming the response-vs-store mismatch; `shop-honest` → **WORKS** (k=2).
  Adversarial attacks (lying cache-read, forged delta, owner-shadow, vacuous negative,
  async-rollback, **seed-match null-delta**) all held — no false-WORKS.
- **Corpus** (`corpus/`): the 12 blind battle-test cases; `false-WORKS = 0` = release gate.
- **Phase-correctness validation vs the 12-PR corpus** (`docs/phase-validation-2026-07-18.md`):
  ultracode workflow (Fable-5 planned complex/core/product → one rubric; 6 Opus auditors, one per
  contract phase P1–P6; every break adversarially verified). Found ONE **LIVE false-WORKS in the
  built core** — a null-delta `equals`/`unchanged` tautology: `evalEffect` never rejected a no-op
  and `relationHolds('equals')` ignores `before`, so a genuine harness delta with `before==after`
  reached WORKS. The E1 gate missed it because all 9 drivers used `op:'increased'`. **FIXED**
  (`verdict.mjs`: a null delta may FALSIFY but never CONFIRM — "absence is a catch", §12.8,
  preserved & re-verified by the `rule 2` test) + locked by E1 driver `seed-match-null-delta` and
  adversarial `(e)`/`(e-sanity)` tests. `false-WORKS=0` is honest-green again. Full per-phase
  verdict + remaining roadmap in the validation doc.
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
node --test                  # expect 32/32
node src/cli.mjs gate         # expect GATE: PASS (10 malicious held incl. forge-harness-provenance, seed-match-null-delta = CND)
npm i && npm run typecheck    # authoritative type gate — pinned @types/node 20.19.43 → clean
node src/cli.mjs phase3 fixtures/shop-lying  --intent "coupon SAVE20 => total 20% less"  # DOES_NOT_WORK
node src/cli.mjs phase3 fixtures/shop-honest --intent "coupon SAVE20 => total 20% less"  # WORKS (k=2)
```

**Type gate authority:** `npm run typecheck` (pinned `@types/node` 20.19.43 + lockfile) is the
green, authoritative gate. Editor LSP diagnostics from a *different* ambient `@types/node`
(e.g. `phase3` `child.on`, a fixture's `IncomingMessage.signal`) are version-mismatch artifacts,
not defects — point the editor at the workspace TypeScript/types to silence them.

## NEXT (the bounded v1 — finishable; do NOT chase breadth)

1. **Core-fundamentals surgical pass — DONE** (`086dbfb` structural propose/dispose; then the
   2026-07-18 phase-validation found + FIXED the null-delta `equals` tautology, keeping 32/32 +
   gate PASS). No churn-for-taste.
2. **Verdict-contract slices the validation surfaced.** **(a) DNW not k-gated — DONE** (`b9f4325`):
   rule 2 now convicts only when the failure reproduced (`reproduce.kFail >= 2`), else CND; `kFail`
   is a SEPARATE failure count in phase1/phase3 (reusing `reproduce.k`, which counts successes,
   would flip `shop-lying`→CND — that trap is why it's separate). **(b) Owner-shadow on
   non-quantified effects (FW-P1-B) — NOT a verdict-layer fix (tried, reverted, proven unsound).**
   A verdict-only `identity === actorIdentity` floor on non-quantified effects OVER-FIRES on
   legitimate single-actor effects: `phase1`'s `suite-passes` effect runs as `identity:'ci'` under
   `actorIdentity:'ci'`, so the floor flipped an honest WORKS→CND (empirical proof a string floor
   can't tell owner-shadow-masking from a genuine single-actor effect). The right home: **rule 5
   already catches owner-shadow for `quantified` claims** — a *generalizable* user capability should
   be marked `quantified` by the **P1 compiler** (unbuilt); a genuinely non-quantified effect is not
   an owner-shadow risk. So FW-P1-B is a **P1-compiler responsibility + capture-side auth-context**
   (which front door / independent session — the signal that distinguishes the trap from a single
   actor lives on the drive/capture side, not the verdict). Land it WITH that slice, not before.
3. **BUILD ARCHITECTURE — decided 2026-07-18 (Fable-designed, Akash-approved).** Strategic call:
   BUILD THE SURFACE, don't harden the core speculatively (the FW-P1-B revert is empirical proof a
   latent fix ahead of its surface is wrong code; theory §8 wants an *executed* case next; the core
   is honest-green for every reachable path). Dependency rule (Akash): no hard zero-dep rule, but no
   "whole-world" deps in pb — **the project-under-test's own deps live in its conjure/container, not
   in pb**. Concrete (all keep pb's runtime deps at ZERO; trust core `verdict.mjs`/`harness.mjs`
   stays FROZEN):
   - **Store tap (persisted leg):** `docker exec <ctr> sqlite3 -json <db> "<static query>"` (or
     `psql` for Postgres SUTs) — reads the store file out-of-band = HARNESS provenance (NOT the app's
     endpoint, §1.1/§4); sqlite CLI overlaid into the SUT image by the recipe. No pb DB dep.
   - **Browser drive:** a containerized `selenium/standalone-chromium` sidecar driven over **W3C
     WebDriver (JSON over `fetch`)** — browser deps live in a container like the SUT's; customer-
     portable. No pb browser dep (Playwright-as-pb-dep rejected).
   - **Setup recipe:** a per-repo `pb-recipe-v1` JSON (generalizes `fixtures/*/pb-fixture.json`) —
     build-from-tree@SHA, conjure, out-of-band tap cmd, fresh-world recreate, disclosed REST setup,
     front-door URL. The **walk stays agent-proposed** (never recipe data — avoids the Gherkin grave).
   - **REPO-AGNOSTIC, NEVER OVERFIT TO n8n (Akash, 2026-07-18).** n8n is case **#1 of N**, not THE
     case — the pipeline is recipe-driven (no repo hardcoded in `conjure/storetap/drive`) and
     **verification RANDOMLY PICKS a recipe from the corpus pool each run**, so any n8n-specific
     assumption surfaces immediately. Grow the pool across the 12-PR corpus (a SQLite AND a Postgres
     repo, a form AND a CRUD/admin front door). A repo whose surface isn't built yet (canvas =
     documenso, egress = ghost, very-big = posthog/sentry) declines to **honest CND** — never a
     forced n8n-shaped fit. The release gate runs the FULL pool; iteration random-picks.
4. **Real-repo Catch roadmap (M1→M7).** First target **n8n #7130** (single-process, plain-DOM Form
   Trigger, SQLite store; merge SHA `3ddc176dfa2d3d99a328a29a3a8613e35ff456a0`, n8n@1.12.0);
   cal.com is the evidence-picked fallback if conjure is infeasible. **Progress:** M1 spike ✅
   CONJURE FEASIBLE (`m1-n8n/RECIPE-FACTS.md`) · **M2 ✅ `870ffb8`** (`src/recipe.mjs` loader +
   `recipes/n8n-form-trigger-pr7130/`) · **M3 ✅ `fcd2d4d`, hand-verified** (`src/conjure.mjs` +
   `pb conjure`: builds real n8n from-tree, mints code-identity fingerprint = P3-1 landed, form
   serves; note from-tree build is NOT bit-reproducible → git SHA is the stable identity,
   image_digest is a per-build attestation) · **M4 ✅ `0538fa3`** (`src/storetap.mjs`: `docker exec
   sqlite3` out-of-band delta, mints the persisted leg). **ANTI-OVERFIT UNIT ✅ COMPLETE + PROVEN
   LIVE (§3):** pool = **n8n (run/sqlite/http-drive) + documenso (compose/postgres/canvas-drive-
   deferred)**, both conjure LIVE, hand-verified. Slice A ✅ `41c6dca` (recipe contract + psql tap
   generalized off n8n: conjure.mode run|compose, engine-discriminated store_tap sqlite|postgres,
   drive descriptor; documenso recipe) · Slice B ✅ `2d2771e` (`conjure.mjs` mode-aware: `docker
   compose up` for the Postgres class; documenso up live, /api/health 200, psql tap Field=0
   out-of-band) · random-pick ✅ `5c7d799` (`src/pool.mjs` listRecipes/pickRandom + `pb conjure
   --random`). documenso's Konva-canvas drive honestly CNDs. **medusa spike** (3rd repo, Postgres+
   Redis) was still building/paused at pause-time — bonus, not a blocker; fold in if it lands.
   **M5 ✅ DONE + PROVEN LIVE** (`src/browserdrive.mjs` + `test/browserdrive.test.mjs`): containerized
   `selenium/standalone-chromium:4.27.0` sidecar driven over W3C WebDriver as JSON over `fetch` (ZERO pb
   browser dep — Playwright-as-dep stays rejected), repo-agnostic primitive-op client (navigate/find/
   click/type/text/execute/teardown) whose WALK is caller-scripted (agent-proposed, never recipe-baked —
   avoids the Gherkin grave), `localhost`→`host.docker.internal` rewrite so the container reaches the
   host-published SUT, TOOL-provenance minted attempt receipt (ground truth stays the harness store tap).
   **owner-shadow now *testable***. Hand-proven LIVE end-to-end: real chromium → conjured n8n rendered Form
   Trigger → typed+submitted THROUGH the browser → out-of-band sqlite tap showed `execution_entity` 0→1
   status=`success` (row workflowId == conjure's captured workflow_id) → minted tool attempt → clean
   teardown (no orphans, port freed). 76/76 tests + gate PASS + typecheck clean. NEXT → M6 the Catch
   end-to-end on a RANDOM repo (blind→EXECUTED; differential
   merge-SHA=WORKS vs parent-SHA≠WORKS; **M6 TARGET GROUNDED (2026-07-18 via gh):** n8n #7130 =
   `feat(n8n Form Trigger Node): New node` — merge `3ddc176d` HAS the node (form serves → browser-drive
   submit persists an `execution_entity` row → WORKS) vs its SINGLE parent
   `869b8f14caaf334f011bcd87d3928dc8ab41f62e` where the FormTrigger node type does NOT exist → the
   recipe's workflow.json fails to activate / the form 404s → the SAME walk cannot execute → CND ≠ WORKS
   = clean anti-tautology (the PR IS why it works). M6 needs a small `conjure` SHA-override to build the
   parent from-tree; the differential is MEASURED, and if a target ever fails to discriminate, honest-CND
   and pick another corpus PR.) → M7
   adversarial. **Latent fixes land WITH their surface:** seal-stripping @ M6/persist; mint-boundary
   isolation + P1 `quantified` @ M7 proposer. Ponytail: one recipe, ≤2 store adapters, 3 drive
   primitives — generality earned per case. The from-tree SUT image stays cached → warm conjure ~6s.
5. **Phases 1–2 to production shape** (code-works, deployed-healthy) on the same class — after M6.
6. **QUEUED MAJOR PHASE — Lyric k8s-attach dogfood (ENG-17397)** (Akash, 2026-07-18; "after" the OSS
   Catch). Point pb at a REAL Lyric multi-repo + dev-package change: ENG-17397 = Actions/Stages/
   Controls across **7 repos** (appservice `ENG-17397-action-and-interrupts`, metadata-service,
   mosaic-function-stage-control [new], mosaic-function-scenario, lyric-py/lyric-runner-py
   `ENG-17398` dev-pinned wheels, ui-monorepo) + db-migrations + Nuclio functions (see
   `~/lyric/.tickets/ENG-17397/branches.json`). This is the FIRST **Lyric class** (k8s-attach
   substrate), complementing the OSS docker-compose class — same `pb-recipe-v1` contract, new modes.
   **GAP RECON DONE (2026-07-18, architect vs the real tree) — framing CORRECTED:** the Lyric side
   has pb-shaped *shape* (recipe-equivalent `~/lyric/.tickets/ENG-17397/appservice/ready.yaml` with
   attach targets + drive verbs + L3–L5 checks + honest not-run; `lyric-devops/scripts/lyric-mongo.sh`
   = genuine out-of-band Mongo tap; `evidence/*/manifest.json` schema-2 `substrate:k8s-attach` + `pins`
   image-digest/k8s-ctx/repo-SHA + `artifacts` provenance/sha256/exitCode; the `lyric-qa` 12-op drive).
   BUT it is **UNIFY the contract + evidence semantics, REBUILD the execution against the new core** —
   NOT "unify, not build from zero." Because: (i) the schema-2 emitter / k8s-attach substrate exists
   NOWHERE in `~/lyric` source — it is the **external OLD pb v0.1.0**, zero shared code with product-v1;
   (ii) every Lyric manifest is `selfAttested:true` with **NO seal**, provenance a plain string = exactly
   the forgery the new core downgrades to `agent` (`evidence.mjs:78-83,107-113`); (iii) NO L4/L5
   behavioral verdict has EVER executed (all 7 recorded runs are L3-health / phase-1 / cluster-unreachable);
   (iv) `k8s-attach` conjure + `mongo`(+clickhouse/redis) store engine are NEW recipe surface (`recipe.mjs`
   is `from_tree|pinned_image` / `run|compose` / `sqlite|postgres`); `drive:note-lifecycle` is already in
   the enum (EXTENDS, not new); (v) `fresh_world:recreate` + reproduce-k≥2 do NOT map to a shared BYOC
   cluster. **DNW CONFIRMED SOUND + a clean differential (static-verified):** `expireStageControls`
   (`appservice/.../executions.helper.ts:441`) does an unscoped `.filter({executionId,status in
   [queued,running]})`; `metadata-service/.../stage-control.schema.ts` has NO `@AuthValidation` (the
   diagnosis's primary fix LANDED on-branch) → merge-SHA=WORKS (controls expire on terminal + user-action
   email + ack-proceed), parent-SHA=stuck-`queued` DNW. Target the natural-completion terminal path for the
   WORKS leg; cancel-path (parent-vs-note id, `executions.service.ts:478`) + executor-`ack` are SEPARATE
   DNW probes. **BIGGEST RISK = the BYOC substrate itself:** base-skew (known-failures F3) + reconcile-revert
   (F2) can manufacture a FALSE `DOES_NOT_WORK` before pb's logic runs — de-risk FIRST via a `lyric-devops`
   base-coherence preflight (hard L3 gate) + re-read the deployed image digest AT DRIVE TIME and seal THAT,
   not the pre-run pin. **Code-identity: derive the fingerprint from FILES not prose** (`branches.json` +
   `metadata-service/sdk-versions.json` `mds-sdk 1.8.1.dev17397` + `lyric-runner-py/.../lyric_py_version.py`
   `LYRIC_PY 1.3.39.dev17398`, runner `2.0.2.dev17397`) — RESUME/prose versions disagree; `branches.json`
   lists db-migrations NOT ui-monorepo. **TWO HUMAN DECISIONS before the phase starts:** (1) reproduce model
   on a shared cluster — new note/exec per iteration (rec: preserves k≥2) vs relaxed-k; (2) drive surface —
   appservice API + mongo (rec: matches today's assets) vs adding the ui-monorepo end-user leg (not built/
   fingerprinted today). **Cheapest-failure-first order (cluster-free steps do NOT need M5/M6):** (a) paper
   translate `ready.yaml`→`pb-recipe-v1` JSON [small]; (b) adapter schema-2 artifacts → minted+sealed
   receipts, proven on ONE existing manifest, no cluster [small — but land it WITH the M6-proven receipt
   pattern to avoid rework]; (c) `k8s-attach` conjure + `mongo` engine [medium]; (d) operator-supervised
   live `pb verify --ratify` on a base-coherent cluster [medium, destructive-gated]. NOT before the OSS
   pipeline is proven end-to-end (M5/M6).

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
