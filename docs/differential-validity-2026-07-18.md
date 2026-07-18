# Differential validity — n8n #7130 parent=CND is HONEST, not a hollow Catch

**Date:** 2026-07-18 · **Branch:** `product-v1` · **Verifies:** the `DIFFERENTIAL: PASS`
emitted by `node src/cli.mjs prove recipes/n8n-form-trigger-pr7130`
(merge `3ddc176d`=WORKS ∧ parent `869b8f14`=CND).

---

## The challenge

pb's first executed differential reports the parent leg as **CND** with the reason
`Node not found: n8n-nodes-base.formTrigger` (the workflow will not activate). The challenge:
does "Node not found" on the parent mean **pb itself is broken** — i.e. the parent leg fails
for a *harness* reason (a **false CND**), making the whole differential **hollow** rather than a
real behavioral distinction between merge and parent?

## Verdict

**The differential is real. parent=CND is a GENUINE feature-absent condition, honestly
classified — not a false FAIL and not a harness artifact.** The `merge=WORKS ∧ parent=CND`
PASS stands.

## Ground truth that refutes a bug

PR **[#7130](https://github.com/n8n-io/n8n/pull/7130)** = `feat(n8n Form Trigger Node): New node`
(merged 2023-10-17). Established from GitHub, not from pb's own output:

- **Single parent.** Merge commit `3ddc176dfa2d3d99a328a29a3a8613e35ff456a0` has **exactly one
  parent**, `869b8f14caaf334f011bcd87d3928dc8ab41f62e`. The differential's two legs are adjacent
  SHAs, so nothing but this PR's diff distinguishes them.
- **The PR ADDS the node.** GitHub's `/files` for #7130 shows
  `packages/nodes-base/nodes/Form/FormTrigger.node.ts` plus `FormTrigger.node.json`, `form.svg`,
  `interfaces.ts`, and `utils.ts` **all with status `added`**, and it **MODIFIES `package.json`**
  to register the new node in the nodes-base manifest.
- **The source is ABSENT at the parent.** The GitHub contents API for
  `packages/nodes-base/nodes/Form/FormTrigger.node.ts` at ref `869b8f14` returns **HTTP 404** —
  the file does not exist on the parent. The node type `n8n-nodes-base.formTrigger` is therefore
  unregistered at that SHA.
- **Why CND surfaces at activation.** n8n validates node types **at workflow activation, not at
  creation**. The recipe's `POST /rest/workflows` succeeds on both legs (creation does not
  resolve node types); the `PATCH …{active:true}` on the parent leg then fails with
  `Node not found: n8n-nodes-base.formTrigger`. The form front door never comes up, so the
  agent-proposed walk **cannot execute**.

Because the code under test is genuinely absent at the parent, the walk cannot run there. pb
classifies "the feature could not even be exercised" as **COULD_NOT_DETERMINE**, which is exactly
the honest tri-state answer — not `DOES_NOT_WORK` (which would falsely assert a behavioral defect
in code that isn't present).

## Why this is honest tri-state, not a false FAIL

- **CND ≠ FAIL.** pb never convicts absent code. In `src/catch.mjs`, a feature-absent
  reproduction (conjure/activation/drive throws) yields `executed:false`, which counts toward
  **neither `k` nor `kFail`** → the leg resolves to **CND**, never a false `DOES_NOT_WORK`.
- **The merge leg is no tautology.** merge=WORKS requires a real non-null delta
  (`op:'increased'` on the `execution_entity` id), reproduced across `k=2` fresh worlds, each with
  a content-bound **fresh REST confirm leg** re-observing the same execution id out-of-band. A
  hollow or replayed signal cannot reach WORKS.
- **The reason is code-grounded, not harness-shaped.** The parent's CND reason *names the cause*
  (`Node not found` at activation) rather than reporting a pb failure (timeout, build break,
  driver error). The distinction between "harness could not run the walk" and "feature is absent"
  is preserved.

## The real limitation this challenge exposes

#7130 is an **ADDITIVE-PR** differential. For a brand-new node, **parent=CND is the strongest
possible result** — absent code cannot be behaviorally tested, so the most honest thing pb can
say about the parent is "could not determine." That is correct, but it is not the differential
with the most teeth.

**pb has NOT yet EXECUTED a MODIFYING/BUGFIX-PR differential** where the parent **RUNS the same
walk** — boots, renders the front door, accepts the input — and produces the **wrong or missing
persisted effect**, i.e. **parent=DOES_NOT_WORK**. That is the differential that proves pb can
catch a *behavioral* regression (the walk ran; the effect went missing), structurally distinct
from feature-absent CND. Recording that as the next proof with teeth.

## Next proof with teeth (judge-chosen 2026-07-18)

**n8n [#9157](https://github.com/n8n-io/n8n/pull/9157)** —
`fix(Respond to Webhook Node): Fix issue stopping form trigger response`.

| Field | Value |
|---|---|
| merge SHA | `6c63cd971162d3f018b210d221ffc2a56535550a` (has the fix) |
| parent SHA | `91e59120c49802bbeb545809527d223af1967f9d` (VERIFIED true single parent — buggy) |
| change kind | **bugfix-existing (MODIFYING, not additive)** |
| diff | `+3/-1` in `RespondToWebhook.node.ts` — adds `n8n-nodes-base.formTrigger` to a new `WEBHOOK_NODE_TYPES` allow-list; buggy branch gated on `if (nodeVersion >= 1.1)` |
| era | ~n8n 1.38.0 (Apr 2024); base `n8nio/base:18` (Alpine) |

**Why it has teeth (parent RUNS the walk, then the effect goes missing):**

- Reuses the **exact proven Form Trigger browser front door** (GET form page → introspect → type
  → click Submit) → **zero new drive capability** needed.
- Builds from-tree via the **identical self-contained `docker/images/n8n-custom/Dockerfile`** the
  proven recipe already builds (verified present + self-contained at both SHAs;
  `ARG N8N_RELEASE_TYPE=dev` present → `conjure.mjs` auto-adds the build-arg). *Build-time residual:*
  this SHA has **no `corepack` line**, so `build_overlay` must be omitted initially (the proven
  overlay anchors on corepack → `overlayDockerfile` would throw); add a corepack anchor only if the
  build hits an integrity-key failure.
- The move that converts the bug into a **store-observable differential**: the workflow's own
  `settings { saveDataErrorExecution:"none", saveDataSuccessExecution:"all" }` turns the parent's
  mid-execution `NodeOperationError` into a **missing `execution_entity` row**:
  - **merge leg:** submit → `RespondToWebhook` recognizes `formTrigger` → run `success` →
    `saveDataSuccessExecution:all` → **new row** → `max_id` increased + fresh-REST confirm →
    `effectHeld` → **WORKS**.
  - **parent leg:** form renders + submit accepted + workflow **STARTS** (`executed:true`) →
    `RespondToWebhook.execute` throws → run `error` → `saveDataErrorExecution:none` → **no row**
    → `countAfter == countBefore` → `"increased"` FALSIFIES → `effectHeld:false` → `kFail=2/2` →
    **DOES_NOT_WORK**.
- **DIFFERENTIAL:** `merge=WORKS ∧ parent=DOES_NOT_WORK` — a **behavioral** failure (walk ran,
  effect went missing), structurally distinct from #7130's feature-absent CND.

**Build:** clone `recipes/n8n-form-trigger-pr7130/` → `recipes/n8n-respondwebhook-formtrigger-pr9157/`,
change only `code_identity` (merge/parent SHAs above) + `workflow.json` (Form Trigger →
RespondToWebhook typeVersion **1.1** with `responseMode:responseNode`; the `saveData*` settings).
Confirm at authoring time: FormTrigger `responseMode` key/value and the `/webhook/{id}/…` suffix at
1.38. Run: `node src/cli.mjs prove recipes/n8n-respondwebhook-formtrigger-pr9157`.

**Fallbacks:** **#10992** (browser-driven Form-Trigger→Wait→RespondToWebhook variant, era 1.61 —
buildable now, but adds a Wait/timing dimension); **#33022** (cleanest *native* row-count
differential, no `saveData` trick — but **not buildable with current pb**: n8n 2.28 dropped the
self-contained Dockerfile for a `COPY ./compiled` model that needs a pre-docker-build compile
stage `conjure.mjs` does not yet perform).

## Second engine + cluster status

- **documenso (2nd engine) — `ready:false`.** The postgres+canvas capability is banked (browser
  drive reaches and manipulates the real Konva canvas; psql tap `"Field"` 0→1 verified live), but a
  real documenso **differential is blocked**: PR #3031 = `feat: add field multiselect` touches only
  the Shift+click multi-select renderer, so a *place-one-field* walk is **non-discriminating**
  (merge=WORKS ∧ parent=WORKS — a fake Catch, correctly reported as no-PASS by `renderDifferential`,
  not a wiring bug). A discriminating documenso Catch needs the multiselect-specific walk (#3031's
  own e2e `runShiftClickMultiSelectFlow`) **plus** new harness surface: cookie-injection in
  `browserdrive.mjs`, a postgres-shaped delta in `catch.mjs` (today's `rows.length`/max-id logic is
  sqlite/n8n-shaped), a documenso confirm leg (the current one calls n8n-only REST routes), and
  multipart bodies + per-step headers + cross-service captures in recipe setup. Not a drop-in.
- **Lyric (ENG-17397) — cluster-gated (not headless-startable).** Headless auth is fully ready (gh
  as `0prodigy`; `mic` decision-engine JWT re-mints headlessly from the gh token; `akashpathak`
  kubeconfig uses a static client-certificate — no interactive auth). The **sole** blocker is that
  the base-coherent lyriclet `akashpathak` (namespace `delta`, substrate `k8s-attach`, ENG-17397
  A&C appservice digest `sha256:a31e0593…97709`) is **HIBERNATED**; waking it requires the mutating,
  confirmation-gated `mic byoc power akashpathak start` — which auto/headless mode cannot authorize.
  Go-path: a human runs `mic byoc power akashpathak start` → `mic byoc status akashpathak --wait` →
  confirm ns `delta` pods are base-coherent → hand to pb `k8s-attach`. The 7 currently-healthy
  lyriclets are **not** valid targets (none carries the ENG-17397 A&C build).
