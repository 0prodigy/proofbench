# Proofbench Roadmap — the only allowed work

*Binding. Sessions work on the CURRENT gate only (see CLAUDE.md scope court). A gate is
passed when every checkbox has an executed run with committed evidence — never on a
report. Decisions logged here are settled; do not reopen them.*

**North star (fixed):** companies run pb every day in their jira-to-deploy pipeline.
Agents implement; pb verifies with unfakeable evidence; a human (later: policy) approves;
prod deploys. pb is the verification layer — it never implements, never owns the deploy.

**Where we are (2026-07-21, honest):** the honesty core is done, frozen, and green
(tests + gate + typecheck, 189/189). FOUR differential Catches have executed live:
n8n #7130 (additive PR, parent lands CND), n8n #9157 (the first parent=DOES_NOT_WORK
catch — a real regression, not absent code), linkding #1170 (the first non-n8n
stack — Django/sqlite — parent=DOES_NOT_WORK), and documenso #3031 (the SECOND ENGINE
— Postgres tap + a real Konva canvas browser drive — parent=DOES_NOT_WORK, kFail=2/2:
the same frozen shift-click-multiselect walk left 2 fields instead of 1 without the
PR's selection-extend fix). The effect observable and confirm leg are no longer
n8n-hardcoded: `catch.mjs`/`recipe.mjs` now resolve them from the recipe's own
`store_tap.observables` + `confirm[]` (engine-shaped delta relations, not n8n's
autoincrement assumption). README and site now lead with the #9157 catch, not a
green PASS, with all four cases linked to committed `site/cases/*.json` evidence.
`docs/getting-started.md` and a launch-page supported-stacks matrix are both done.
Distribution is staged (package.json + prepack version-gate + tag committed, cold
tarball install verified) but `npm publish`/`git push` are HELD for the founder. Still
open: the Lyric/argo path's store tap throws. The enterprise substrate is designed on
paper with zero running code; all pipeline glue was explicitly cut from v1. Full issue
register at the bottom.

---

## Adoption metrics (binding at every gate from G1 — added 2026-07-20 product audit)

`false-WORKS = 0` is honesty. Honesty alone does not make a daily habit — these four do.
A gate does not pass on honesty alone; each gate reports all four.

1. **Named-unblock rate = 100%.** Every CND names the ONE action that unblocks it
   (rustc bar; IC-7/DP-11 already promise this). A CND without a named unblock is a bug,
   filed and fixed with the same severity as a false-WORKS. CND-spam is how verification
   tools get uninstalled.
2. **CND rate, measured.** % of pool runs landing CND, reported per gate. High early is
   fine; unmeasured is not — it must be visibly falling or the habit never forms.
3. **Verdict wall-clock, measured.** Minutes per leg, cold conjure vs warm, reported per
   gate. Target (target, not gate): warm merge-leg verdict ≤ 15 min — the PR-review
   attention window. The differential is 2× cost by construction; see the R2 CI-mode
   decision.
4. **Time-to-first-verdict on a NEW repo.** G1: ≤ 1 hour hand-authored (already the
   gate). G2: ≤ 15 min with `pb init` proposing the recipe.

## R0 — Truth reset (days) · GATE G0

Make every claim match reality; land the catch with teeth.

- [x] **Execute n8n #9157** (`pb prove recipes/n8n-respondwebhook-formtrigger-pr9157`) —
      the first modifying-PR differential where parent = DOES NOT WORK (walk runs, row
      missing). This is the product's first real CATCH. Commit the recipe dir (currently
      untracked) + the sealed evidence + a case JSON under `site/cases/`.
      Executed `655c794` (merge=WORKS ∧ parent=DOES_NOT_WORK, kFail=2/2); re-gated
      post-migration `faeee96` with fresh sealed receipts, same verdicts.
- [x] **README truth pass:** delete "Plan only — nothing is built yet"; state exactly
      what is proven (two n8n differentials, engines/classes supported, everything else
      honest-CND) with links to committed evidence.
      Done `caca762`.
- [x] **Site truth pass (minimum):** hero leads with the #9157 CATCH (DOES NOT WORK +
      receipt), not the green PASS; raw SHAs and jargon (CND, kFail, execution_entity)
      move behind progressive disclosure; keep only claims with committed evidence.
      Done `caca762`: hero + cert lead with #9157, three case blocks (#9157, #1170, #7130)
      each linked to `site/cases/*.json`.
- [x] **Wire-or-delete:** `orgconfig.mjs` (unwired) and `lyric/manifest-adapter.mjs`
      (unwired) — either a CLI path exercises them or they move to `docs/` as design
      notes and out of `src/`. No dead code in src/ (CLAUDE.md pattern 1).
      Done `ffacf74`: both deleted from `src/`, resurrect from `6c1754d` at R3.
- [x] Constitution (`CLAUDE.md`) + this roadmap committed.
      Done `d107bed`.

**G0 passed when:** `pb prove` on #9157 yields merge=WORKS ∧ parent=DOES_NOT_WORK,
evidence committed, README/site contain no claim without evidence.

## R1 — Anyone's compose-runnable repo (2–4 weeks) · GATE G1

The one blocker between "engine" and "product": de-n8n the Catch. A stranger with a
docker/compose-runnable web repo gets a real verdict.

*Empirically grounded 2026-07-20: a cold Sonnet agent attempted linkding PR #1170
(Django/sqlite/session-auth — a normal self-hosted app) with src/ frozen. Blockers hit
for real, ranked by the agent-as-customer: (1) no `docker build --target` (killed the
run — multi-stage Dockerfile whose default stage isn't last), (2) setup steps are
JSON-only → Django CSRF form login returns 403 (needs form encoding + HTML token
capture), (3) setup-session cookies never reach the browser drive → every login-gated
front door lands on the login page, (4) `front_door.url_template` hard-requires a
placeholder (schema theater for static creation forms), (5) the n8n-shaped effect
menu/confirm leg (below) were never even reached. `recipes/linkding-default-mark-shared-
pr1170/` is the R1 proof case: after the fixes, `pb prove` on it must yield merge=WORKS
∧ parent=DOES_NOT_WORK (default_mark_shared absent at parent → persisted shared=0).*

- [x] **Conjure/recipe surface (slice A):** `code_identity.target`, setup-step
      `content_type: form` + HTML-regex capture (CSRF), cookies exposed on the SUT
      handle, optional front-door placeholder, `confirm` schema.
      Done `e7d69eb`/`04e8d21` (branch `r1-slice-a`, now merged — ancestor of HEAD).
- [x] **Generic effect binding:** the observable menu comes from the recipe's
      `store_tap.queries` (already recipe-declared data), not `EFFECT_ENTITY`
      (`catch.mjs:64`). Delta relations become engine-shaped (sqlite/postgres row-count,
      max-id, named-scalar), not n8n's autoincrement assumption (`catch.mjs:114-121`).
      Done `18f579f` + recipe migration `01a9f24`.
- [x] **Generic confirm leg:** replace the n8n REST confirm (`catch.mjs:472-483`) with a
      recipe-declared fresh-session re-observation (front-door or REST steps from the
      recipe, same mint rules). Auth for it = the recipe's existing `auth_preflight` /
      setup surface; cookie-inject lands here (it has a surface now — documenso).
      Done `18f579f` (cookie-inject wired into `runCatch`) + recipe migration `01a9f24`.
- [x] **Second engine EXECUTED:** one discriminating Postgres-repo differential live —
      documenso with the multiselect-specific walk. `pb prove
      recipes/documenso-envelope-fields-pr3031` → merge `97835b8d`=WORKS (k=2, fresh
      worlds, `Field.rows` 0→1, fresh confirm agrees) ∧ parent `977d0733`=DOES_NOT_WORK
      (kFail=2/2 falsified — the SAME frozen shift-click-multiselect walk left
      `Field.rows` at 2, not 1: the parent's field-click handler ignores Shift and
      replaces rather than extends the selection, so the toolbar Remove only drops the
      last-clicked field). Sealed receipts committed at
      `site/cases/documenso-envelope-fields-pr3031.{merge,parent}.json`. Port fix
      `f4f1e56`; three live-diagnosed harness fixes surfaced and fixed en route
      (`822e4f9` canvas-collision + un-clicked-Remove + headless window size,
      `531a8f8` W3C Actions float-coordinate rounding, `5f8af83` viewport-aware
      introspection) — none touched the frozen core. `pb prove --random` (the full-pool
      gate) was NOT run this pass; a bonus, not required for this box.
- [ ] **Distribution:** publish npm as `proofbench` (name verified free), bin `pb`,
      drop `private:true`, version from git tag. `npx proofbench gate` works cold.
      STAGED, not shipped: package.json/prepack version-gate/tag `v0.2.0` committed
      (`f7dd9a9`), cold-install from a packed tarball verified (`npx pb gate` → PASS
      in a fresh empty dir with zero deps beyond itself) — but the real `npm publish`
      is HELD for the founder to run; box stays open until the package is actually on
      the registry.
- [x] **Getting-started doc:** recipe authoring guide with the two shipped recipes as
      worked examples; prerequisites stated (Node 20+, Docker, claude CLI or API key).
      Done: `docs/getting-started.md` — every field derived from `src/recipe.mjs`,
      verdict/exit-code semantics traced to `src/verdict.mjs`/`src/cli.mjs`, honest-CND
      section names today's declines (no-Dockerfile, k8s, serverless, mobile/native).
- [x] **Launch page rebuild** around three real case files: the catch (#9157 DNW), the
      earned green (#7130 WORKS), the honest refusal (a real CND) + a supported-stacks
      matrix that says exactly what declines to CND.
      Three-case layout done `caca762`; supported-stacks matrix (`#stacks` on
      `site/index.html`) added this pass — 5 supported rows (compose conjure, sqlite
      tap, form/session-auth front doors, agent-proposed browser walk, postgres+canvas
      capability honestly marked "no executed differential yet") + 4 honest-CND rows
      (k8s/helm, serverless/managed, mobile/native, no-Dockerfile), each cell linked to
      a committed recipe/case/doc. README has no stacks section to mirror into.

**G1 passed when:** a person who didn't build pb takes a compose-runnable repo pb has
never seen from `npx proofbench` to a real sealed verdict in under an hour, and
`false-WORKS = 0` holds across the full recipe pool.

**Explicit non-goals in R1:** k8s, multi-repo identity, CI trigger, `pb init`
auto-onboarding, any new provider. (DEFERRED.md them.)

## R2 — Daily use in CI (2–4 weeks) · GATE G2

Make pb a habit, not a demo. Smallest pipeline glue that creates daily runs.

- [ ] **Machine verdict:** `--json` verdict document (verdict, fingerprints, case-file
      path, reason) alongside the frozen exit codes 0/1/2/3.
- [ ] **GitHub Action:** runs `pb prove` on a PR, uploads the case file as an artifact,
      posts one PR comment (verdict block + link), sets a commit status. Branch
      protection on that status IS the v1 approval gate — a human merge approval stays
      the ratify step; pb never merges or deploys.
- [ ] **`pb init` (agentic onboarding):** the agent PROPOSES a draft recipe from repo
      inspection (compose file, migrations, routes); the harness validates; the human
      confirms. Propose/dispose applied to onboarding — recipes stop costing days.
- [ ] **Dogfood:** pb's own repo runs pb in CI; recruit 1–3 external OSS repos to run
      the Action weekly. Their catches/CNDs become corpus entries.
- [ ] **Sealed-room minimum (coverage wall for real-company apps):** outbound HTTP from
      the conjured world is default-deny block-and-record; blocked egress becomes a NAMED
      finding/CND cause ("your system tried to reach api.stripe.com; nothing was there"),
      never an unnamed hang/timeout; typed fake creds (`pb_fake_…`) injected at boot when
      the app demands vendor keys, disclosed in the cast list. (DP-07's minimum. Without
      this, most SaaS-calling repos — i.e. most company repos — fail WEIRDLY instead of
      honestly, and the named-unblock metric is unmeetable. Curated doubles stay deferred.)
- [ ] **Intent source for CI (decision + implementation):** the Action takes the intent
      sentence from the PR title/body (linked-ticket ingestion later, IC-14); an
      uncheckable sentence → capture-time CND quoting the blocking words (IC-7). Garbage
      in must land CND, never a guessed WORKS.
- [ ] **CI verdict mode:** `pb prove --merge-only` for the daily PR gate (half the cost,
      inside the attention window); the case file is explicitly labeled NON-differential.
      Full differential stays for catches, launch claims, and a nightly pool run.
- [ ] **Concurrent-run isolation:** two pb runs on one CI runner never collide —
      nonce-scoped container names/ports/run dirs (reaper already nonce-aware; verify
      under real parallel invocation).

**G2 passed when:** pb has run unattended in CI on ≥20 real PRs across ≥2 repos with
zero false-WORKS and ≥1 real catch reported on a PR.

## R3 — The k8s / Lyric class (4–8 weeks) · GATE G3

The enterprise substrate — currently paper. Built strictly in the order that fails
cheapest, each step ending in an executed run. This is where the Lyric blockers
(A1–A8 below) are scheduled — not before.

- [ ] **k8s-exec store tap implemented** (today a hard throw, `argoworkflows.mjs:396`)
      + `mongo` engine wrapping the proven out-of-band read (`lyric-mongo.sh` shape).
- [ ] **k8s-attach conjure:** attach to an existing deployment (port-forward, read
      image digests at DRIVE time and seal those), never creating cluster objects.
- [ ] **Multi-repo code identity** (`code_identity.mode:"multi_repo"`: repos[] +
      wheels[] + images[] per the ENG-17397 draft) with rollup verdict.
- [ ] **Shared-cluster fresh-world:** `fresh_world:"new-instance-per-iteration"`
      (new note/exec per k-iteration, nonce-scoped, iteration ids must differ).
- [ ] **Base-coherence preflight** (hard L3 gate vs base-skew F3 / reconcile-revert F2 —
      the two known ways a cluster manufactures a FALSE DNW before pb runs).
- [ ] **Operator-ratify mode:** destructive/gated steps require same-turn human
      confirmation; pb marks them in the recipe and refuses headless execution.
- [ ] **Lyric dogfood:** ENG-17397 live on a base-coherent lyriclet — merge=WORKS
      (controls expire + ack-proceed) ∧ parent=stuck-queued DNW, sealed from the
      cluster. The first L4/L5 behavioral verdict Lyric has ever had.

**G3 passed when:** one live, sealed, differential verdict exists on the Lyric cluster
with harness provenance (no self-attested manifests) and the base-coherence gate held.

*Note (R0): `orgconfig.mjs` and `lyric/manifest-adapter.mjs` were removed from `src/`
at R0 (dead-code rule); resurrect from git history commit 6c1754d when R3 starts.*

## R4 — The deploy-gate product (after G2 adoption + G3 proof) · GATE G4

Only now does the daily jira-to-deploy vision get built — on proven demand.

- Long-running service / GitHub App (webhook + Jira-transition triggers, queue).
- Approval policy: WORKS → eligible for promote (human or policy ratifies), DNW →
  block with repro bundle, CND → block with the named unblocking action.
- Deploy handoff: pb emits the signed verdict; the org's own CD consumes it. pb still
  never deploys.
- Verdict ledger (the fold over case files TL-5 already provides for).

**Do not design R4 before G3.** One line here is its entire permitted footprint.

---

## Issue register (from the 2026-07-20 four-track audit)

Lyric blockers: A1 k8s-attach substrate (blocker, designed/unbuilt → R3) · A2 multi-repo
identity (blocker → R3) · A3 mongo/k8s-exec tap throws (blocker → R3) · A4 shared-cluster
fresh-world (blocker → R3) · A5 app-user auth for the drive (major → R1 confirm-leg +
R3) · A6 base-skew/reconcile-revert false-DNW (blocker → R3 preflight) · A7 operator-gated
destructive steps (major → R3 ratify) · A8 sealed evidence off-cluster (major → R3).

Stack classes: compose monoliths built (R1 closes the n8n-shaped residue) · k8s/helm →
R3 · SPA gaps (confirm leg, pg delta, cookie-inject, multipart) → R1 · no-Dockerfile
repos need a pre-build compile hook (major, undesigned — DEFERRED until a paying case) ·
serverless/managed and mobile/native = honest CND, stated on the site, no code until a
real user demands it.

Pipeline: CI trigger/PR reporting → R2 · approval gate semantics → R2 (branch protection)
then R4 (policy) · daemon/GitHub App/Jira → R4 only.

Adoption blockers (2026-07-20 product audit — what stops DAILY use even where verdicts
work): B1 recipe authoring cost, days of expert work per repo (→ R2 `pb init`; G2
measures time-to-first-verdict) · B2 verdict latency unmeasured, differential = 2× by
construction (→ metrics block + R2 `--merge-only`) · B3 CND-spam / unnamed failures
erode trust faster than catches build it (→ named-unblock rate = 100%) · B4 sealed room
unscheduled — external-SaaS apps (most company apps) fail unnamed (→ R2 sealed-room
minimum) · B5 intent source undefined for CI (→ R2 decision: PR title/body) · B6
concurrent CI runs collide on docker resources (→ R2 isolation) · B7 enterprise security
posture undocumented — untrusted PR code executes in the conjured world; needs the
"SUT is containerized, default-deny egress, pb holds no secrets, LLM sees intent +
introspection only" page (→ R3, written with the Lyric dogfood).

## Decision log (settled — do not reopen)

- 2026-07-21 (founder, same-turn): G1 build complete; `git push origin product-v1 v0.2.1`
  executed (npm publish pending founder `npm login`). **Lyric lyriclet dogfood (the R3
  subset scoped in `docs/lyric-integration-contract.md`) is pulled AHEAD of G2** — pb
  ships the control surface, Lyric team integrates once, then autopilot; first substrate
  = BYOC lyriclet via decision-engine; target = ENG-17397 live differential. Founder also
  authorized waking the hibernated `akashpathak` lyriclet for this work. G2 items remain
  next after the dogfood.
- 2026-07-20 (founder, product audit): fundamentals CONFIRMED right — the 8 invariants,
  recipe seam, differential Catch stand; the gap is coverage/cost/onboarding, all
  additive. No rewrite, ever. Adoption metrics block above is binding at every gate.
- 2026-07-20: daily CI mode = merge-leg only, explicitly labeled; differential reserved
  for catches, launch claims, nightly pool.
- 2026-07-20: sealed-room MINIMUM (block-and-record + fake creds) scheduled R2; curated
  doubles (payments/email) stay deferred until a real repo demands them.
- 2026-07-20: npm name `proofbench` (free; `pb` taken), bin stays `pb`.
- 2026-07-20: launch identity = the CATCH (a DNW with a receipt), never a green PASS.
- 2026-07-20: R-gates are strictly ordered; no R3 surface before G1, no R4 before G3.
- 2026-07-18 (founder): repo-agnostic, never overfit to n8n; pool random-pick stays.
- 2026-07-18 (founder): no whole-world deps in pb; SUT deps live in its container.
- Frozen forever: exit codes 0/1/2/3; `false-WORKS = 0` release gate; the 8 invariants.
