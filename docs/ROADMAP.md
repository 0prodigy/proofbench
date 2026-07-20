# Proofbench Roadmap — the only allowed work

*Binding. Sessions work on the CURRENT gate only (see CLAUDE.md scope court). A gate is
passed when every checkbox has an executed run with committed evidence — never on a
report. Decisions logged here are settled; do not reopen them.*

**North star (fixed):** companies run pb every day in their jira-to-deploy pipeline.
Agents implement; pb verifies with unfakeable evidence; a human (later: policy) approves;
prod deploys. pb is the verification layer — it never implements, never owns the deploy.

**Where we are (2026-07-20, honest):** the honesty core is done, frozen, and green
(tests + gate + typecheck). One full differential Catch has executed live — n8n #7130,
an additive PR whose parent lands CND. Nothing else has ever produced a real verdict:
the effect observable and confirm leg are hardcoded to n8n (`catch.mjs:64,472-483`),
documenso is drive-deferred, the Lyric/argo path's store tap throws, orgconfig is
unwired, the package is unpublishable (`private:true`), and the landing page shows a
green PASS with raw SHAs instead of the product's actual promise (the catch). The
enterprise substrate is designed on paper with zero running code; all pipeline glue was
explicitly cut from v1. Full issue register at the bottom.

---

## R0 — Truth reset (days) · GATE G0

Make every claim match reality; land the catch with teeth.

- [ ] **Execute n8n #9157** (`pb prove recipes/n8n-respondwebhook-formtrigger-pr9157`) —
      the first modifying-PR differential where parent = DOES NOT WORK (walk runs, row
      missing). This is the product's first real CATCH. Commit the recipe dir (currently
      untracked) + the sealed evidence + a case JSON under `site/cases/`.
- [ ] **README truth pass:** delete "Plan only — nothing is built yet"; state exactly
      what is proven (two n8n differentials, engines/classes supported, everything else
      honest-CND) with links to committed evidence.
- [ ] **Site truth pass (minimum):** hero leads with the #9157 CATCH (DOES NOT WORK +
      receipt), not the green PASS; raw SHAs and jargon (CND, kFail, execution_entity)
      move behind progressive disclosure; keep only claims with committed evidence.
- [ ] **Wire-or-delete:** `orgconfig.mjs` (unwired) and `lyric/manifest-adapter.mjs`
      (unwired) — either a CLI path exercises them or they move to `docs/` as design
      notes and out of `src/`. No dead code in src/ (CLAUDE.md pattern 1).
- [ ] Constitution (`CLAUDE.md`) + this roadmap committed.

**G0 passed when:** `pb prove` on #9157 yields merge=WORKS ∧ parent=DOES_NOT_WORK,
evidence committed, README/site contain no claim without evidence.

## R1 — Anyone's compose-runnable repo (2–4 weeks) · GATE G1

The one blocker between "engine" and "product": de-n8n the Catch. A stranger with a
docker/compose-runnable web repo gets a real verdict.

- [ ] **Generic effect binding:** the observable menu comes from the recipe's
      `store_tap.queries` (already recipe-declared data), not `EFFECT_ENTITY`
      (`catch.mjs:64`). Delta relations become engine-shaped (sqlite/postgres row-count,
      max-id, named-scalar), not n8n's autoincrement assumption (`catch.mjs:114-121`).
- [ ] **Generic confirm leg:** replace the n8n REST confirm (`catch.mjs:472-483`) with a
      recipe-declared fresh-session re-observation (front-door or REST steps from the
      recipe, same mint rules). Auth for it = the recipe's existing `auth_preflight` /
      setup surface; cookie-inject lands here (it has a surface now — documenso).
- [ ] **Second engine EXECUTED:** one discriminating Postgres-repo differential live —
      documenso with the multiselect-specific walk, or a better-discriminating PR from
      the 12-PR corpus. `pb prove --random` gate runs the full pool.
- [ ] **Distribution:** publish npm as `proofbench` (name verified free), bin `pb`,
      drop `private:true`, version from git tag. `npx proofbench gate` works cold.
- [ ] **Getting-started doc:** recipe authoring guide with the two shipped recipes as
      worked examples; prerequisites stated (Node 20+, Docker, claude CLI or API key).
- [ ] **Launch page rebuild** around three real case files: the catch (#9157 DNW), the
      earned green (#7130 WORKS), the honest refusal (a real CND) + a supported-stacks
      matrix that says exactly what declines to CND.

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

## Decision log (settled — do not reopen)

- 2026-07-20: npm name `proofbench` (free; `pb` taken), bin stays `pb`.
- 2026-07-20: launch identity = the CATCH (a DNW with a receipt), never a green PASS.
- 2026-07-20: R-gates are strictly ordered; no R3 surface before G1, no R4 before G3.
- 2026-07-18 (founder): repo-agnostic, never overfit to n8n; pool random-pick stays.
- 2026-07-18 (founder): no whole-world deps in pb; SUT deps live in its container.
- Frozen forever: exit codes 0/1/2/3; `false-WORKS = 0` release gate; the 8 invariants.
