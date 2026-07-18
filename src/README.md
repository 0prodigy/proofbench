# pb — proof-of-work for AI change (the honesty core + the executed Catch)

pb answers one question about a change: **does it actually work, for a real user, and is
the change itself *why*?** It brings the real system up from a recipe, drives its front
door as a visitor would, reads ground truth *out of band*, seals the evidence, and lets a
**frozen, deterministic verdict** decide `WORKS` / `DOES_NOT_WORK` / `COULD_NOT_DETERMINE`
— a lying prosecutor cannot manufacture a `WORKS`. See `docs/phase-3-theory.md` (§0–§2, §7)
for the property (P′) this encodes and `docs/pb-extensibility-foundation.md` for the recipe/
org-config/provider model.

## The honesty core (frozen)

The deterministic spine every other module flows through. It is **off-limits** to feature
work — nothing may reach a `WORKS` except by producing evidence this core accepts.

| File | Role |
|---|---|
| `types.mjs` | Frozen enums + JSDoc typedefs: `Provenance` (agent < tool < harness, `rankOf`), `Verdict` (tri-state + `UNVERIFIED`), `ClaimState`, `Receipt`, `Claim`, `EffectCheck`, `EvidenceBundle`, `Reproduce`. |
| `harness.mjs` | `mint()` — the **only** constructor of `tool`/`harness` provenance, guarded by a module-private brand no proposer can reach. Every other path forces `agent`. |
| `evidence.mjs` | `contentAddress` (sha256), `newBundle`, `sealBundle`/`verifySeal` — a real ed25519 seal over a manifest digest of intent + claims + receipts. Any post-seal mutation ⇒ `verifySeal` false ⇒ `UNVERIFIED`. |
| `verdict.mjs` | `verdict(bundle)` — pure, deterministic. State is set **last from receipts**, never from a claim's own assertion. Rules 1–7 below. |
| `e1/drivers.mjs` | `MALICIOUS_DRIVERS` (one per cheat) + `HONEST_DRIVER` — hand-built evidence bundles, no real app. |
| `e1/gate.mjs` | `runGate()` — every malicious driver must be **not** `WORKS` (a tampered seal ⇒ `UNVERIFIED`); the honest driver must be `WORKS`. |

## Bringing up a real system + capturing ground truth

| File | Role |
|---|---|
| `recipe.mjs` | `pb-recipe-v1` loader/validator (fail-fast, names the first bad field). A recipe discloses how to bind **code-identity** (`from_tree`@SHA / `pinned_image`@digest, optional `parent_sha` baseline), how to **conjure** (`mode: run|compose`, env, ports, `ready_signal`, disclosed build/setup overlays), the **fresh-world** strategy, the REST **setup** steps, the user-facing **front door** URL template, the out-of-band **store_tap** (`engine: sqlite|postgres`, named queries), and an optional **drive** mode. The walk is *not* recipe data (it stays agent-proposed — no Gherkin grave). |
| `orgconfig.mjs` | `pb-org-v1` loader/validator — the org half of the model: one provider per phase from an **enumerated** set only (`acquire`, optional `readiness`, `identity`, optional `tap`). Pure-data validation, never evals an org string; a missing tap is valid but warns (effect claims then cap at CND). Returns `{ config, warnings }`. |
| `conjure.mjs` | `conjure(recipeDir, {buildSha?})` — brings a **real** SUT up from a recipe and returns a live handle. Mode-aware: `run` `docker run`s one container (n8n); `compose` clones the tree and `docker compose up -d --build`s the service graph (documenso). Resolves code-identity (builds `from_tree`@SHA — `buildSha` overrides it for the differential parent — or pulls+verifies a pinned digest), polls the disclosed `ready_signal`, applies overlays, walks the REST setup through a cookie jar, and `mint()`s the code-identity **fingerprint** + bring-up receipt. `teardownSut()` reaps it. |
| `storetap.mjs` | `tapStore()` + `mintStoreDelta()` — the §1.1 persisted leg (harness provenance): a `docker exec … <client>` reading the store **directly** (`sqlite3 -json` inside the container, or `psql -At` against the DB container), **never** the app's own API. Throws rather than fall back to an app read. |
| `browserdrive.mjs` | `openBrowser()` + `mintDriveAttempt()` — the repo-agnostic drive leg (TOOL provenance). Boots a pinned `selenium/standalone-chromium` sidecar and drives the front door over W3C WebDriver as plain `fetch` JSON (no browser dep). Primitive ops the caller scripts: `navigate/find/click/type/text/execute/clickAt/pointer` (`clickAt`/`pointer` are the coordinate escape hatch for a `<canvas>` surface). |
| `argoworkflows.mjs` | `openWorkflowRun()` + `k8sExecTap()` + `mintWorkflowAttempt()` — the `drive.mode: 'argo-workflows'` leg: submit a nonce-stamped Workflow CR, observe **that** run to terminal, bind the step-pod imageID to the disclosed digest, and tap the store nonce-scoped out of band. |

## The Catch, the agent seam, and the runners

| File | Role |
|---|---|
| `proposer.mjs` | The **agent seam** — the only place a driving agent's judgement enters: `proposeWalkAndClaim()` turns an intent + a harness-owned introspection snapshot into a validated `{walk, claim}`, and `validateProposal()` makes the untrusted proposal safe (claim `entity` must be a harness-enumerated observable — FW-P1-C; walk ops are the browser vocabulary **minus** `execute`/`navigate` — FW-P1-D). No mint/seal import (mint-boundary). `llmFn` is the seam: the Anthropic Messages API over `fetch`, or `claudeCliLlmFn` shelling to the local `claude` CLI (subscription OAuth, no API key). |
| `registry.mjs` | The **provider registry** — config-keyed default wiring that promotes runCatch's injectable seams to declared providers. `environmentProvider`/`tapProvider` resolve `conjure`/`tapStore` by `conjure.mode`+`code_identity.mode` / `store_tap.engine`; `driveProvider` **dispatches on `drive.mode`** (`browser|http|note-lifecycle|deferred` → `openBrowser`, grandfathered so #7130 stays browser-driven; `argo-workflows` → `openWorkflowRun`). An unknown key is an honest fail-fast error; an explicitly injected seam **wins** over the default. |
| `pool.mjs` | The anti-overfit recipe pool: `listRecipes()` discovers every loadable recipe on disk (a malformed dir is skipped, never breaks the pool) and `pickRandom()` chooses one per run — so which SUT pb proves against is not baked in. Backs `pb conjure --random` / `pb prove --random`. |
| `reaper.mjs` | The interrupt reaper: conjure registers a best-effort SUT reap on bring-up and de-registers it on normal teardown; one-time `SIGINT`/`SIGTERM` handlers drain the registry (reaping containers / compose graphs / temp checkouts) then exit 130/143, so a Ctrl-C / orchestrator kill can't leak a SUT. Best-effort by nature — `SIGKILL` is uncatchable (a Ryuk-style sidecar is the upgrade path). |
| `catch.mjs` | `runCatch()` — the **executed** Catch, end-to-end on a real conjured SUT across fresh worlds: conjure → store-tap BEFORE → navigate + introspect → propose (frozen once) → execute the walk → settle → store-tap AFTER → fresh-session REST re-read (confirm leg) → teardown. It assembles a bundle mirroring phase3, **seals** it, persists it, and computes the verdict by **re-reading the on-disk sealed artifact** — never a loose in-memory object. `assembleCatchBundle`/`assembleArgoBundle` are pure. It never writes the tri-state and never decides the differential (`cli.mjs` does). |
| `phases/phase1.mjs` | Phase 1 — intent → promise via the repo's **own** committed test suite (npm/go/pytest), run in fresh child processes ≥2× (the "zero-tests hole" is refused). |
| `phases/phase2.mjs` | Phase 2 — environment/readiness via docker-compose, proven by pb's **own** front-door HTTP requests (never trusting compose healthchecks). A readiness failure is CND, not `DOES_NOT_WORK`. |
| `phases/phase3.mjs` | Phase 3 — the Catch against a bundled two-service fixture app with a fresh per-reproduction JSON store; drives the front door and captures the write-set-bound store delta + a fresh-session confirm leg. |
| `lyric/manifest-adapter.mjs` | Ingests a Lyric schema-2 (`selfAttested`, unsealed) manifest and maps it onto pb's frozen provenance lattice, so the two evidence models unify without laundering self-attestation into a false `WORKS`. Pure; the caller seals + judges via the frozen core. |
| `cli.mjs` | `pb` dispatcher — commands below. |

## The verdict rules (in order)

1. Only `tool|harness` receipts satisfy a claim; `agent` receipts corroborate only.
2. A `FALSIFIED` claim ⇒ `DOES_NOT_WORK` **only if the failure reproduced** (`kFail ≥ 2`);
   a single unreproduced failure is "observed once, could not reproduce" ⇒ CND.
3. An effect claim is `CONFIRMED` only if its `EffectCheck` binds a delta receipt that is
   harness-provenance **and** not `sourcePR` **and** has a confirm leg (fresh-session, or
   content-bound egress §1.5); else `NOT_EXECUTED`.
4. A negative claim is `CONFIRMED` only with **both** a null delta **and** an attempt receipt (M1); else `NOT_EXECUTED`.
5. Quantifier lint (§1.4/FW-11): a quantified claim needs ≥2 `CONFIRMED` instantiations with
   **distinct identity ≠ actorIdentity**, plus ≥1 `CONFIRMED` negative; else `NOT_EXECUTED`.
6. `WORKS` requires ≥1 `CONFIRMED` effect claim, all declared claims `CONFIRMED` (or
   justified-N/A), and `reproduce.k ≥ 2` — a single walk is never `WORKS` (FW-6).
7. Else nothing falsified but something `NOT_EXECUTED`/missing ⇒ `COULD_NOT_DETERMINE`, naming what + why.

A sealed bundle whose seal does not verify is `UNVERIFIED` — its contents are not judged on their merits at all.

## CLI

```
pb gate                          # the E1 malicious-driver gate (deterministic; exit 0=pass)
pb phase1 <dir>                  # the repo's own test suite            → WORKS/DOES_NOT_WORK/CND
pb phase2 <dir>                  # docker-compose up + front-door proof → READY/CND
pb phase3 <dir> [--intent "…"]   # HTTP-drive the fixture app + confirm the effect persists
pb conjure <recipeDir>|--random [--keep]   # bring a real SUT up + mint its code-identity fingerprint
pb prove <recipeDir>|--random    # the DIFFERENTIAL Catch → PASS iff merge=WORKS ∧ parent≠WORKS
```

`--random` picks a recipe from the pool (anti-overfit). Phase commands exit 0 only on `WORKS`;
`prove` exits 0 only on the differential PASS (a `from_tree` recipe with a `parent_sha` is required).

## Run it

```
node --test            # verdict rules 1-7, the E1 gate, and every pure-helper suite
node src/cli.mjs gate  # the gate as a table, with an exit code
tsc -p jsconfig.json   # typecheck (JS + JSDoc, strict)
```
