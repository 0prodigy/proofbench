# pb Extensibility Foundation — Org-Config → Sandbox-Acquisition Contract + Per-Phase Providers + CI-Integration Contract

**Status:** DESIGN / ADR **v2** — for human approval. No code in this document; nothing here is implemented or committed. (v2 hardens v1 with: honesty guarantees reframed as *mint preconditions*, the `pb-buildrecord-v1` CI-integration contract + local-build provider replacing the old "push Lyric to attest" framing, an explicit single-repo-spine multi-repo rollup model, and a second adversarial pass on the CI contract.)
**Scope:** The foundation that lets pb acquire and verify a test sandbox from **untrusted org-maintained config**, prove **one repo's PR works end-to-end** as the non-negotiable spine, integrate an org's **own CI build pipeline** through a thin contract (pb never owns the build), and add per-phase provider adapters (Argo CD, CI) over time — keeping native single-service `from_tree`/local-docker as the zero-integration default, and Lyric (ENG-17397) as the first pure-configuration enterprise instance.
**Non-negotiable:** false-WORKS = 0. No provider — however dishonest or misconfigured — may manufacture a WORKS or hide a DNW. **Single-repo PR validation is the spine and must not regress** (`pb prove recipes/n8n-form-trigger-pr7130` stays byte-identical, `mode:"from_tree"`, tier 1).

Grounding note: every pb citation below is verified against the tree at branch `product-v1`. Seam-map corrections carried into v2: `verdict.mjs` `satisfies()` is at 102-103 and `satisfiesPersisted()` at 115-116 (the circulating "102-104 / 115-117" figures are off by one); `Receipt.kind` is typed `ReceiptKind | string` (types.mjs:93) and conjure's `fingerprint` kind already lives **outside** the frozen enum — so new provider receipt kinds are open data and the frozen core needs **zero** changes for this entire design. The `code_identity` discriminated union is recipe.mjs:197 (`from_tree`) / 202 (`pinned_image`) / 206-209 (`else`→`bad`, the reject branch a third mode extends). The Lyric single-repo-SHA gap note is `src/lyric/manifest-adapter.mjs:161` (not 162), and `artifactProvenance()`'s MIN-of-declared-and-derived law is lines 92-105.

---

## 1. Problem + Goal

pb today answers "does this change actually work for a real user?" for a system **it conjures itself** — it git-clones at a SHA, `docker build`s or pulls a pinned image, drives a browser walk, taps the store out-of-band, and emits a tri-state differential verdict bound to the exact code that ran (`src/catch.mjs` `runCatch` 531-660; `src/conjure.mjs` 497-634). That is the zero-integration default and it must stay first-class.

**This single-repo, one-PR, end-to-end differential is the spine of the product.** Proving one repo's PR works is the baseline value — good enough for most open source *and* most work inside an org. Everything else in this doc is additive around that spine; nothing may bury it, over-abstract it, or regress it.

The gap: an enterprise does not always hand pb a git URL and a Dockerfile. It runs its own platform — a cluster, an Argo CD, a **CI system that already builds the artifact**, a provisioning brain — and it wants pb to test a change **in a sandbox that platform already knows how to produce**, against **the artifact its own pipeline already built**. Two consequences shape the whole design:

- **pb does not build the org's images.** pb defines a **CI-integration contract** each CI implements; the org's build pipeline stays entirely its own. pb only needs to (1) *know* what artifact (image/wheel/digest) was built for the SHA under test, and (2) **independently confirm** that artifact actually *contains* the change under test. The **native default remains a LOCAL docker build** via pb's existing `from_tree` path — kept first-class; the contract is the *extensibility path* for artifacts pb did not build.
- **pb does not require cross-service orchestration.** A ticket spanning N repos is validated as **N independent single-repo validations**, aggregated into a per-ticket rollup (§7). A full cross-service E2E is a cherry on top, never a prerequisite.

**Goal.** Turn pb's five run phases into a **provider model**, driven by two documents plus one contract:

1. an **org config** (`pb-org-v1`) — the minimal, honest declaration an org maintains so pb can *obtain and verify* a sandbox;
2. an **extended recipe** — per-phase provider selection for a specific change under test; and
3. the **CI-integration contract** (`pb-buildrecord-v1`) — the tiny CI-agnostic locator an org's CI exposes so pb can independently re-derive code-identity for an artifact it did not build.

From that foundation:
- **Local docker build** is the native, zero-integration implementation of the Code-Identity contract (tier 1; containment moot — pb built it).
- **Argo CD** becomes the first Environment + Readiness adapter (is the sandbox up, is the code-under-test actually deployed?).
- **CI (GitHub Actions / GitLab / Jenkins)** becomes the first *code-identity source* through `pb-buildrecord-v1` — pb does the verifying, the CI only exposes a locator.
- **New integrations are added per phase over time** as additive adapters — never a core edit.
- **Lyric** falls out as *one configuration* of the framework, not a special case.

The five phases (named consistently from here on), mapped to today's code:

| Phase | What it establishes | Today's code |
|---|---|---|
| **Environment** | A reachable SUT exists | `conjure.mjs` bring-up (442-479 compose, 516-540 run dispatch) |
| **Readiness** | The SUT is actually up | `conjure.mjs` ready-signal poll (543-557) |
| **Code-Identity** | *This* SHA's artifact is what's running | `conjure.mjs` `resolveImage` (376-423) + `fingerprint` mint (597-609) |
| **Drive** | A user-facing walk executes | `browserdrive.mjs` (263-383) + `catch.mjs` `executeWalk` (359-385) |
| **Tap** | Ground-truth store read, out-of-band | `storetap.mjs` engine dispatch (111-120) |

---

## 2. The Provider / Adapter Model Per Phase

### 2.1 The one architectural invariant

> **Providers attest; only the harness verifies and mints. A provider may LOWER or ROUTE; only the harness may RAISE.**

A provider is a **pure data adapter**: untrusted JSON in, untrusted JSON out. It never imports `src/harness.mjs`, never reaches `mint()`, and can never construct a `tool`/`harness` receipt — the module-private `Symbol('pb.harness.minted')` brand (harness.mjs:17,25,67) already enforces this by construction, and `evidence.mjs` `newBundle()` forces any un-minted receipt's provenance to `'agent'` (78-82). For every provider attestation, a **pb-owned phase runner** independently re-derives the fact and mints a HARNESS receipt whose *data* records `{attested, observed, match}`. This is exactly the `selfAttested` precedent already in Lyric's schema-2 evidence.

Consequence: **the frozen core is byte-identical after this work.** No new provenance rank, no verdict-rule change. Attestations live *inside* harness receipt data, never beside it as a fourth trust level.

### 2.2 The provider interface

The interface is not invented here — it is a promotion of the injectable seams the code **already proves out**. `runCatch(opts)` (catch.mjs:518-529) accepts `conjureFn`, `openBrowserFn`, `tapStoreFn`, `fetchFn`, `llmFn`, `proposal`, `runDir`. Today these are test seams passed by hand. The foundation promotes them to a **declared registry keyed by config**.

Each phase provider is a module exposing two functions:

```
// A provider is a pair: an untrusted read, then a harness-owned verify.
// The provider NEVER mints. The runner (pb-owned) mints.

attest(config, ctx)  -> Attestation        // untrusted JSON; provider's claim
                                            // (may be empty for native providers)

verify(attestation, config, ctx) -> Observation
                                            // pb-owned: re-derives the fact itself.
                                            // The PHASE RUNNER (not the provider) then
                                            // mint()s a HARNESS receipt carrying
                                            // { attested, observed, match, verified: bool }
```

A **phase runner** (pb-owned, one per phase, lives beside the frozen core but is not frozen) calls `attest` → `verify` → `mint`. Mint call-sites **do not move**: conjure's runner still mints `fingerprint`+`bringup` (conjure.mjs:597-624), storetap still solely mints `delta` (storetap.mjs:196-207), browserdrive still mints TOOL `attempt` (browserdrive.mjs:402-416). Providers slot *upstream* of those mints, feeding them observations to bind.

### 2.3 Per-phase application

**Environment** — provider decides *how a SUT comes to exist*.
- Native providers (register the existing paths): `local-docker` (conjure.mjs `run` mode), `compose` (conjure.mjs `bringUpCompose` 442-479).
- New provider: `k8s-attach` — pb did **not** build this SUT; it attaches to a running workload the org's platform deployed. `verify` runs pb's **own** front-door reachability probe. Teardown semantics invert: for things pb owns, destroy; for an attached sandbox pb doesn't own, **release + record** (never destroy someone else's cluster resources).

**Readiness** — provider decides *how "up" is judged*, but never *replaces* pb's probe.
- Native: the existing `ready_signal` poll (conjure.mjs:543-557) always runs.
- New provider: `argocd` — reads Application sync/health as a **routing/fail-fast gate only** (§4.1). Not-Healthy ⇒ skip the expensive drive and CND with a minted reason. Healthy ⇒ *permission to attempt* — pb's own probe still runs.

**Code-Identity** — provider *corroborates*; the harness *derives*.
- Native: `from_tree` (pb builds → digest↔SHA airtight, tier 1) and `pinned_image` (pb pulls + digest-verifies against `ci.image_digest`, conjure.mjs:379-394).
- New mode: `ci_attested` — consumes the `pb-buildrecord-v1` locator (§4.2), pulls the artifact **by immutable digest**, reads the manifest digest itself, and runs an **independent differential-content / signed-provenance containment check** to set a binding tier. CI is only asked *where the artifact is*; pb does 100% of the verifying, and any weak/absent signal only LOWERs (§4.2, §4.3).

**Drive** — the seam that must finally be *dispatched on*.
- `recipe.drive.mode` is validated (recipe.mjs:285-295) but **never read at runtime** — catch.mjs always drives via `openBrowser`/`executeWalk` regardless. This foundation closes that gap: `browser` | `http` | `note-lifecycle` become registered drive providers selected by `drive.mode`, with absent ⇒ `deferred` (honest CND). No behavior change for the n8n recipe (its `browser` path stays identical).

**Tap** — already provider-shaped; extend the registry.
- Native: `sqlite`, `postgres` (storetap.mjs:111-120).
- New engine: `k8s-exec` (e.g. `kubectl exec … mongosh`) — same out-of-band `docker exec psql` shape, still the **sole** minter of `delta` receipts, still inside the trust boundary.

### 2.4 What stays FROZEN (unchanged, verified)

- `src/verdict.mjs` — relation adjudication, tri-state rules, `satisfies()` (102-103, requires rank ≥ TOOL), `satisfiesPersisted()` (115-116, requires rank ≥ HARNESS). Confirmed: the verdict **never reads** the `fingerprint` receipt or any `binding`/`tier` field — it dispatches only on claim kinds and delta/attempt/fresh-session/egress/nav receipts.
- `src/harness.mjs` — the `mint()` boundary and its module-private Symbol brand.
- `src/evidence.mjs` — seal / persist / re-read; tamper ⇒ UNVERIFIED.
- `src/types.mjs` — the `Object.freeze`d Provenance/Verdict enums.

Everything new is **additive**: new provider modules under `src/providers/`, new registry wiring, new open-string receipt `kind`s, new recipe/org-config fields. **Any milestone that "needs" a frozen-core edit is mis-designed — stop and re-plan.**

---

## 3. Honesty Guarantees as MINT PRECONDITIONS (the hardening reframe)

v1 phrased its honesty guarantees as "the runner does X." That is too weak: a bug in "the runner does X" could still mint a satisfying receipt. **v2 reframes I2/I3/I4 as preconditions enforced by construction — the runner DECLINES to mint a satisfying receipt unless the fact is verified.** The frozen four stay byte-identical: `mint()` is unchanged; the *caller declines to call it*. An unverified precondition ⇒ no satisfying leg is ever minted ⇒ `verdict.mjs` returns CND on its own. This is the trust rule made physical: providers LOWER or ROUTE, only the harness RAISEs, and "raise" is literally "the runner chooses to call `mint()` for a satisfying leg."

The seven mint-precondition fixes from the first adversarial pass:

**P1 — Code-identity is a mint precondition, not a verdict edit.** When pb attaches instead of builds, the tap runner **MUST NOT mint a satisfying `delta` receipt** unless a *current, single-pod, whole-window-stable* digest↔SHA binding holds (established per §4). Unbound ⇒ no persisted leg minted ⇒ CND by construction. The frozen four stay byte-identical (`mint()` unchanged; the caller declines to call it).

**P2 — Front-door → tap nonce round-trip, as a HARD invariant for any non-isolated environment.** No effect is WORKS unless a **run-scoped, globally-unique nonce**, written *through the driven front door*, is read back **out-of-band by the tap**; the `delta` is not minted without it. This replaces world-isolation on shared clusters. Validation **rejects** a shared-cluster tap query that uses a global `max`/`count` instead of the run-scoped key (that would attribute someone else's write to this run).

**P3 — Pin drive + tap + digest-read to ONE named pod (never a Service/LB).** Require replica cardinality 1 **OR** record the per-pod digest and assert stability across the *whole window* via a watch; freeze/pin any reconciler (Lyric F2 ~5-min re-render) as a recorded precondition or CND the leg. Closes the swap-and-restore TOCTOU and the multi-replica split (drive hits pod A on new code, tap reads pod B on old code).

**P4 — What code-identity qualifies for a live WORKS.** A pb-built digest (`from_tree`, tier 1) **OR** a verifiable binding from the CI-integration contract that pb **independently confirms** (a digest pb read itself + confirmation the change is present, per §4.2). Content-probe / tag-convention may only LOWER (absence/uncertainty ⇒ CND), never raise. *Reconciled with the "pb does not own the build" redirect (§4):* pb does **not** dictate or own an attest workflow; the contract is what the org's CI satisfies, and pb verifies against it.

**P5 — Single-leg external mode carries a DISTINCT, weaker label.** A single-leg (merge-SHA-only, no parent leg) pass is sealed as **`non-differential`** and is never rendered or consumed as the two-leg "the PR is *why* it works" WORKS. Attribution is explicit in the verdict payload so a downstream reader cannot mistake one for the other.

**P6 — Constrain org-config params.** `exec` is **array-argv** (reject shell metacharacters — no string command that a shell could re-interpret); `front_door` is confined to the acquired sandbox ingress; and a **co-location assertion** binds the fingerprinted pod + the driven front door + the tapped store to ONE workload (namespace + release label), proven by the P2 nonce round-trip.

**P7 — Reaper promoted from checklist to ENFORCED precondition.** Globally-unique per-run nonces/labels; **never reuse a label a prior run could have written under.** Leaked identities worsen shared-store misattribution, so the reaper is not optional hygiene — a run that cannot guarantee a fresh, unique identity does not proceed to a persisted leg.

---

## 4. Native Adapters, the CI-Integration Contract, and the Trust Rule

> **The trust rule, crisply: a provider may LOWER or ROUTE; only the harness may RAISE.**
> A provider attestation (org config field, Argo Healthy/Synced, a CI BuildRecord) may (a) **veto** a run before drive (honest CND with reason — cheap fail-fast), or (b) **corroborate** a fact the harness independently re-derives. It becomes verdict-satisfying evidence **only** when the harness re-derives the fact itself and mints a receipt containing both the observation and the attestation. An un-re-derived attestation, if it enters at all, is agent-provenance context — which `satisfies()` already refuses (verdict.mjs:102-103).

### 4.1 Argo CD — Environment + Readiness (gate-only)

**Reads:** the `<svc>-<env>` Application's `status.sync.status` (Synced/OutOfSync), `status.health.status` (Healthy/Progressing/Degraded/…), the **deployed revision** (as a commit SHA), and `observedAt`/resourceVersion. Via `argocd app get`/`kubectl get application -o jsonpath` (read-only), or Argo Notifications as a push surface.

**Returns:** `{ app, syncStatus, healthStatus, peeled_revision, tracked_ref, observedAt }`.

**Harness verify step (what keeps it honest):**
- **Routing only.** not-Healthy/not-Synced ⇒ skip drive, CND with a minted reason receipt. Healthy/Synced ⇒ *permission to attempt*, never a substitute for pb's own front-door ready probe (which always runs — Argo health is the acquired system reporting on itself).
- **tag-peel trap.** `git rev-parse <tag>` returns the annotated-tag object SHA; Argo reports the *peeled* commit SHA. Compare **peeled commit SHAs only**, or a naive compare false-mismatches. (Also: a tag and branch sharing a name resolve the tag under a bare `rev-parse` — read explicit `refs/heads/`·`refs/tags/`.)
- **reconcile-revert trap (Lyric F2, verified 2026-07-07).** Lyric's in-cluster agent re-renders each app ~every 5 min from a ref in the `lyric-agent-state` ConfigMap, silently reverting a `create_release`-only pin — "Synced" can be true against the **wrong** ref. Per P3, the runner reads that tracked ref and **re-verifies the running pod digest immediately before drive and again after the last tap**; drive-time digest ≠ bring-up digest ⇒ CND (the leg is not minted).
- **tag-exists ≠ deployed.** The adapter never treats registry-tag existence as deployment; only the deployed pod's actual image digest is ground truth.

### 4.2 The CI-Integration Contract — `pb-buildrecord-v1` (pb does NOT own the build)

**Decision up front.** pb never owns the build. The org's CI exposes a tiny, CI-agnostic **BuildRecord** (a *locator*, never a *fact*), and pb independently re-derives code-identity from it. The honest containment check that ships as the zero-integration default is **(a) differential-content**; **(b) signed provenance** is the strongest tier and the required floor for transformed artifacts; **(c) tiered strength** is the composition law that makes every weak/absent signal LOWER to CND, never fake a WORKS. This is the **Code-Identity** phase of §2.3/§3, fully specified. It preserves the redirect exactly: local `from_tree`/local-docker build stays the *native default* (tier 1, containment moot — pb built it); the contract is the *extensibility path* for artifacts pb did not build.

**#1 — What the contract exposes for a given SHA.** The org's CI, per source commit SHA, exposes one BuildRecord. It declares *routes to verification*, never verdict-bearing facts:

```jsonc
{
  "schema": "pb-buildrecord-v1",
  "source":   { "repo": "github.com/org/svc", "sha": "<full peeled commit SHA the build consumed>" },
  "artifact": {
    "type":   "oci-image" | "python-wheel" | "npm-tarball" | "generic",
    "ref":    "us-docker.pkg.dev/.../svc:<tag-or-@sha256>",   // PULLABLE locator (pb pulls by DIGEST)
    "digest": "sha256:<manifest-digest>"                       // DECLARED — pb re-reads + cross-checks
  },
  "delivery": {                                                // UNTRUSTED HINTS ONLY (see adversarial fix)
    "ships":    "verbatim" | "transformed",                    // hint; pb derives ships-verbatim per file
    "path_map": [ { "from": "packages/", "to": "/usr/local/lib/node_modules/n8n/packages/" } ]
  },
  "provenance": { "type": "slsa-in-toto" | "cosign" | "none",  // OPTIONAL — strongest tier
                  "ref": "<oci-referrer | rekor-uuid>" }        // pb fetches + verifies ITSELF
}
```

The minimal triple is **(artifact-ref, declared-digest, materials naming the SHA)**. The org is **forbidden from asserting "this artifact contains the change"** — that is the one fact pb derives. `provenance` is opt-in, so its *absence proves nothing either way*. This is the **third `code_identity.mode`** in the recipe union (recipe.mjs:197/202/206-209 today) — add `mode:"ci_attested"`, a strict superset of the `pinned_image` fields, so verification reuses the existing digest-read precedent verbatim (#5).

> **Adversarial fix — never trust `source.sha`.** pb **ignores `BuildRecord.source.sha` as authoritative.** It pins the containment tree to the recipe's own `code_identity.sha` (merge) and `parent_sha`, checks out by that full SHA (git content-addresses the tree, so checkout is self-verifying), and asserts `BuildRecord.source.sha == recipe SHA` — mismatch ⇒ CND.

**#2 — Staying CI-agnostic (GitHub Actions / GitLab / Jenkins).** The contract is agnostic because the CI's only job is to expose a *locator*; pb does 100% of the verifying. Resolution has three mechanisms, each CI implements ≥1:
1. **Registry-attached referrer (preferred, universal).** Push the BuildRecord + any SLSA blob to the OCI registry, referrer-linked to the image digest (OCI 1.1 referrers / `cosign attach`). pb reads it from the registry it already pulls from — works for *any* CI that can `docker push`.
2. **Well-known artifact.** CI writes `.pb/builds/<sha>.json` (repo, GCS/S3 path template, or CI artifact store). pb GETs it by SHA.
3. **Thin CI locator adapter** (enumerated, pb-side: `github-actions`|`gitlab-ci`|`jenkins`) that queries that CI's build API *only to locate* the record.

The common denominator — every CI can push to a registry pb can pull and emit a JSON locator — is what makes it agnostic. Per-CI code, if any, only *finds* the record; the verification core (pull-by-digest → read digest → differential-content / verify-provenance → mint fingerprint) is one shared, CI-independent path. GitHub Actions gets tier 2 nearly free via `actions/attest-build-provenance`; GitLab emits SLSA natively; Jenkins reaches tier 2 with a `cosign attest` step or tier 3 by just pushing the image. None require pb to understand the build.

**#3 — Independent containment (beating baseline-collision).** The naive failure: grep the merge artifact for a changed string → false-positive when the baseline already contains that string. The fix — **differential full-file content-hash.** pb is the differential harness: it checks out **both** the merge SHA and the parent SHA (conjure `buildSha` override, conjure.mjs:397-398, 490-495) and pulls **both** artifacts by digest. For every file `F` in the PR diff, it extracts `F` from each artifact **out-of-band** (`docker create` + `docker cp` — no running app, mirroring the store-tap discipline) and asserts:

```
hash(F@merge-artifact) == hash(F@merge-tree)   AND   hash(F@parent-artifact) == hash(F@parent-tree)
```

using the exact bytes pb already has from the git tree at each SHA. This is immune to baseline-collision **by construction** — it is not "does string X appear anywhere," it is "is this *exact file*, byte-for-byte, the merge-SHA version in the merge artifact and the parent-SHA version in the parent artifact." A baseline that "already contains the string" still carries the *parent* bytes of `F`, so the two artifacts are correctly distinguished. (Added files: absent in parent; deleted files: absent in merge — checked symmetrically.) **Plus a cheap fail-fast guard:** the merge artifact's manifest digest must **not** equal the parent artifact's — digest-identical images under two SHA-shaped tags mean the change was never incorporated ⇒ immediate CND, no drive. (This guard is *necessary but wildly insufficient* — see the adversarial fixes below; any two distinct images pass it.)

**Honest limit (named, not papered):** differential-content on raw source is admissible only for source that **ships verbatim** (Python wheels/images, interpreted JS, config/SQL/YAML). For **transformed** artifacts (TS→JS bundle, compiled binaries) the source file is not shipped byte-for-byte, so full-file content-hash is inadmissible → such artifacts **cap at CND** on differential-content alone; they need tier-2 signed-provenance or tier-1 `from_tree`. This directly shapes the Lyric instance: `lyric-py`/dataservice-Python changes get the strong zero-integration default; `appservice` (TS→JS) requires provenance or `from_tree`.

### 4.3 The binding-strength ladder (how a/b/c compose)

Tiered strength is not an alternative to differential-content or provenance — it is the **law that binds them.** pb sets a `binding` tier from **its own** checks (never an org claim); highest achievable wins:

| Tier | `binding` | How pb establishes it | WORKS-capable? |
|---|---|---|---|
| 1 | `built-by-harness` | pb built it (`from_tree`/local-docker) — digest↔SHA airtight | **Yes (native default)** |
| 2 | `signed-provenance` | SLSA/in-toto/cosign whose **subject digest == pb's independently-read digest** and whose materials name the SHA, signature chained to an **operator-supplied recognized identity** (out-of-band trust root — never from `pb-org-v1` or the BuildRecord) | **Yes (incl. transformed artifacts)** |
| 3 | `differential-content` | §4.2#3 full-file content-hash, **both legs**, verbatim-shipped source, **total diff coverage**, executed-path bound | **Yes (source-shipped zero-integration default)** |
| 4 | `content-probe` | single-sided presence only (no parent leg) — susceptible to collision | **No → caps at CND** |
| 5 | `unbound` | tag-name only, digest mismatch, unlocated changed file, or nothing | **No → CND** |

**Honest defaults:** for the feature overall, **tier 1 (local `from_tree`) is the native default** — "implement local CI first," and it makes containment moot. For the CI-integration path (pb did not build), **tier 3 differential-content is the zero-integration default**, **tier 2 signed-provenance is the preferred/strict upgrade** (and the *only* WORKS-capable tier for transformed artifacts), and **the ladder caps tiers 4-5 at CND.** This answers v1's open Q3 concretely: **tag-convention is *never* WORKS-capable** (it is `unbound`); the zero-integration WORKS floor is differential-content, not tag-convention.

**How the cap holds with the frozen core byte-identical.** `verdict.mjs` never reads the `fingerprint` receipt or any `binding`/`tier` (confirmed). So the cap is a **mint precondition / runner routing gate**, not a verdict rule: the Code-Identity runner treats binding ≥ tier 3 (tier 2 for transformed) as *permission to drive*; a tier-4/5 binding **routes to fail-fast** — no drive, so no satisfying delta is ever minted, so `verdict.mjs` returns CND on its own with a minted reason receipt. Exactly "a provider may LOWER or ROUTE; only the harness may RAISE," with zero edits to the frozen four.

### 4.4 New adversarial fixes on the CI contract (second pass)

The second adversarial pass rated the design **sound-with-fixes, breaksFrozenCore: false.** The differential full-file content-hash genuinely closes the string-collision vector by construction. The remaining vectors and their **required fixes** (all release-gating for the `ci_attested` path):

| Vector | How it would lie | Required fix |
|---|---|---|
| **Org-steered `path_map` / incomplete diff coverage** | `path_map`/`ships` are org-asserted; a lying CI omits the changed file or maps only decoys — pb hashes what it's pointed at, passes, never inspects the real change. | Treat `path_map`/`ships` as **untrusted hints only.** pb independently enumerates **every** file in the PR diff and requires **each** to be located and content-matched against the tree at the pinned SHA. Any changed file that cannot be located ⇒ cannot reach tier 3 ⇒ CND. **Total diff coverage is mandatory; a missing mapping is a hole, never a pass.** |
| **Presence-not-execution (dead copy / cached transform)** | Containment proves bytes exist *somewhere*, not that they *execute*. A TS→JS build shipping a dead `/src` copy, or a cached transform, passes tier 3 against a non-executed copy ⇒ WORKS on code that never runs. | Bind containment to the **runtime-executed path**: assert the matched file sits on the interpreter/module-resolution/entrypoint load path, reject matches to non-loaded copies. `ships:verbatim` must be **pb-derived per file** (tree-byte match admissible only for files proven loaded). Transformed/compiled artifacts stay capped at CND on differential-content — the executed-path check is what makes that cap *real* rather than declared. |
| **SHA-source trust** | The minimal triple takes `source.sha` from the untrusted BuildRecord; a lying CI names a different commit whose tree matches the artifact. | Pin the containment tree to the recipe's `code_identity.sha`/`parent_sha`, checkout by full SHA (self-verifying), assert `BuildRecord.source.sha` equals it — mismatch ⇒ CND. (Restated in §4.2#1.) |
| **Org-declared "recognized identity" for tier-2** | If the trusted signer is declared in `pb-org-v1`/BuildRecord, a malicious org pins its own key, self-signs a blob with the right subject digest + SHA, clears tier 2 ⇒ WORKS on a transformed artifact with zero real binding. | The recognized-identity set is a **trust root, operator-supplied out-of-band** (pb/human config), **never** from `pb-org-v1` or the BuildRecord. Provenance chaining to an org-declared or self-signed key **cannot exceed tier 3**. |
| **Cap enforced by routing, not frozen verdict** | `verdict.mjs` never reads `binding`/`tier`. A buggy/mis-wired runner that drives an unbound artifact anyway mints a real delta ⇒ the frozen verdict returns WORKS, blind to code-identity. The E1 gate is bundle-level and can't catch a lie upstream of bundle assembly. | Make delta-minting **structurally downstream of a passed binding** — the drive/tap runner is *incapable of running* (thus of minting any satisfying receipt) unless the Code-Identity runner produced a WORKS-capable binding (P1). Add a dedicated **containment/runner-layer adversarial gate** (E1-style) proving a forged-BuildRecord / unbound / wrong-artifact input yields **ZERO satisfying receipts ⇒ CND.** Release-blocking: until this gate is green, false-WORKS=0 is unproven for this path. |
| **Wrong-but-good artifact tagged as the SHA** | A misconfigured CI hands pb a different good build tagged as the merge SHA; the digest-inequality guard (merge≠parent) is trivially satisfied by any two distinct images; an unrelated merge=WORKS/parent=CND drive falsely attributes success. | Only caught by the diff-coverage + executed-path fixes above. **Pull by immutable digest (`ref@sha256:…`), never by tag,** to close the tag-repoint TOCTOU; the tag and declared digest are locators — identity comes from containment/provenance, not the declared digest (a tautology when pulling by digest). |
| **Stale/rebound signed provenance** | Replay an old validly-signed provenance for a different build, or one whose non-reproducible inputs differ. | Closed by construction *if* pb reads the manifest digest itself first and requires `subject-digest == pb's independently-read digest` **AND** materials naming the pinned SHA (design already specifies this, correctly using the RepoDigests/manifest digest, not local `.Id`). **Residual:** tier 2 proves *authorization by a recognized signer*, not construction — a compromised-but-recognized CI can sign an arbitrary digest→SHA. Named as an accepted trust-tier limit (§4.5). |
| **Mixed-builder differential legs** | CI builds the PR head but not the parent base; pulling merge from CI while building parent `from_tree` makes the parent leg CND from build-env drift (base-image/dep skew) unrelated to the change ⇒ the differential falsely attributes the delta to the PR. | **Require both differential legs from the SAME builder tier** (both `ci_attested` or both `from_tree`). A mixed CI-merge / pb-parent differential is **inadmissible** — degrade to the honest single-leg `catch` (P5 `non-differential`, WORKS/CND on the merge SHA with drive-time re-verification). |
| **Symlink/layer extraction steering** | `docker create` + `docker cp` can be steered by in-image symlinks/layer tricks to read a decoy path. | Copy **without following symlinks** and verify the resolved path stays inside the artifact's real filesystem before hashing. |

### 4.5 False-WORKS = 0 — adversarial guarantees + accepted residuals

| Attack | Why it yields CND, never WORKS |
|---|---|
| Forged BuildRecord → baseline image tagged as merge SHA | differential-content: parent bytes present, merge bytes absent ⇒ `hash(F@artifact)≠hash(F@merge)` ⇒ `unbound` ⇒ CND |
| Baseline-collision grep bait | full-file content-hash vs tree, differential — not substring search ⇒ distinguished |
| Colliding / rebuilt-baseline tag | tag names are tier-5 `unbound`; only digest/content/provenance count ⇒ CND |
| Green-but-wrong CI ("build succeeded") | "succeeded" is never read as identity — pb's own content/provenance check is the only input ⇒ CND |
| merge-artifact == parent-artifact | digest-identity fail-fast ⇒ CND |
| Self-signed / unrecognized provenance | must chain to an **operator-supplied** recognized identity; else drops below tier 2 ⇒ differential or `unbound` |
| Transformed artifact, no provenance | differential-content inadmissible ⇒ caps at CND until SLSA or `from_tree` |
| Org-steered path_map omits the change | total-diff-coverage requirement: unlocated changed file ⇒ below tier 3 ⇒ CND |
| Dead-copy / cached-transform match | executed-path binding rejects non-loaded copies ⇒ CND |

**Accepted residual risks (named, not papered):**
- The false-WORKS=0 guarantee for the `ci_attested` path lives in **un-frozen runner routing code** (the frozen core is byte-identical but cannot see `binding`/`tier`). This is permanently more fragile than `from_tree` and is re-opened by every future provider extension — it must be defended by the **standing containment/runner adversarial gate** (§4.4), not by the frozen verdict.
- **Tier-2 signed provenance proves authorization by a recognized signer + non-reproducible-build trust, not construction.** A compromised-but-recognized CI key can sign an arbitrary digest→SHA. Accepted as a trust tier, not a guarantee.
- A **wrong-but-good** artifact can *downgrade* a real DNW to CND (suppressing the DNW). Tolerable under false-WORKS=0 but a coverage loss, explicitly named.
- Git object-hash (SHA-1) collision is assumed out of scope for the tree self-verification argument. Noted explicitly.

### 4.6 How it slots into the real code (design, not code)

- **Reuses the digest-read precedent.** `resolveImage` already pulls a pinned image and asserts the declared digest appears in `RepoDigests` (conjure.mjs:379-394). `ci_attested` is the same read — pull `artifact.ref@sha256:…`, read the **manifest** digest itself (RepoDigests-style, the anchor SLSA subjects/OCI referrers key on — **not** local `.Id`), cross-check `artifact.digest` — then add the containment check.
- **Folds into the existing fingerprint mint, as data.** The `fingerprint` receipt (conjure.mjs:597-609; `kind:'fingerprint'` already outside the frozen enum) gains `{ declared, observed, match, binding, tier }`. No new provenance rank, no fourth trust level — attestations live *inside* receipt data.
- **Mirrors the pattern already shipped.** `src/lyric/manifest-adapter.mjs` implements this shape for the Lyric ingest path: `artifactProvenance()` = `MIN(declared, shape-ceiling)` ("pb's analysis can only LOWER the declared value, never raise it," 92-105), and `codeIdentityReceipt()` mints a `fingerprint` carrying pins + `selfAttested`, **referenced by no claim** so it can never satisfy an effect leg. The binding ladder is that same MIN-of-declared-and-derived law applied to code-identity. It also flags the exact gap the multi-repo model closes — **line 161**: *"the manifest pins a SINGLE repo SHA (not per-repo)."*

---

## 5. The Multi-Repo Model — N single-repo validations + optional E2E

**Single-repo PR validation is the spine (§1). Multi-repo is not a new primitive — it is N independent invocations of that same per-repo contract.** The BuildRecord and its verification are defined strictly **per (repo, SHA)**: one PR, one record, one differential-content binding, one existing single-repo differential `catch`. That per-repo unit *is* the spine and does not regress (the n8n golden stays `mode:"from_tree"`, tier 1, and never touches the CI contract → byte-identical at N=1).

**Aggregation model:**
- A ticket spanning M repos runs **M independent single-repo validations**, each producing its own code-identity-bound tri-state verdict.
- Those M verdicts roll up into a **per-ticket rollup** — a simple aggregation, not an orchestration: the ticket is WORKS only if *every* repo leg is WORKS; any DNW ⇒ ticket DNW; any CND (unbound identity, missing tap, degraded leg) ⇒ ticket CND. Each leg keeps its own provenance-bound evidence bundle; the rollup carries no minting authority of its own (it reads sealed per-repo verdicts, never re-mints).
- **A ticket where each repo's PR is individually validated is ~80% of end-to-end confidence.** A full cross-service E2E is an **optional** layer on top — never a prerequisite, and never a blocker for shipping the per-repo rollup.

**What the contract deliberately does NOT carry.** The `pb-buildrecord-v1` contract and the `ci_attested` mode carry **no notion of multi-repo** — which is precisely how they honor the spine: don't over-abstract, don't bury the single-repo path. Cross-service E2E, when built, is a distinct optional recipe type that composes already-validated single-repo sandboxes; it is out of scope for v2's committed surface (partial-failure semantics, sandbox composition, and cross-service nonce propagation are a separate deliverable).

---

## 6. The Lyric ENG-17397 Instance — Pure Configuration

The acid test: *the common-PR → deploy-check → cluster → browser-drive flow must fall out of the roadmap as one configuration, with essentially no new pb code.* If it needs new framework surface, the framework is wrong.

**The flow, expressed as framework config:**

| Step | Framework mechanism | Lyric specifics (from ENG-17397 recon) |
|---|---|---|
| Common PR opened | (out of band — human) | PR against a service repo; SRM must have already run once so privileges/users/workspaces exist |
| Image built for SHA | **CI-integration contract** (`pb-buildrecord-v1`) | `docker_publish` fires a `git_tag_overwrite` tag-push; wheels/images publish to GCP AR under the `dev<ticket>` convention. Lyric's CI exposes the BuildRecord (registry-referrer or `.pb/builds/<sha>.json`); pb pulls **by digest** and runs containment. |
| Deploy-check | **Readiness** `argocd` adapter (gate) | `<svc>-<env>` Application on a Model-B BYOC lyriclet; encode F2 tracked-ref + tag-peel + tag-exists traps |
| Acquire sandbox | **Environment** `k8s-attach` provider | Model-B BYOC lyriclet (personal, no shared-branch contention); `mic byoc power start` + `status --wait` to wake |
| Verify code-identity | Code-Identity runner (`ci_attested`) | pb reads the running pod's imageID **manifest** digest itself; containment via differential-content (**Python services: tier 3 zero-integration**) or, for TS→JS `appservice`, tier-2 provenance or `from_tree` fallback (**caps at CND on differential-content**). Tag name `<cluster>-<sha>` is **`unbound`**, never admissible. |
| Browser drive | **Drive** `browser` provider (existing `browserdrive.mjs`) | drives `ui-monorepo` at the studio subdomain — see gap below |
| Ground-truth tap | **Tap** `k8s-exec` engine | `kubectl exec mongodb-0 -c mongod -- mongosh` out-of-band, array-argv (P6) — **never** the app's own REST read path; run-scoped nonce round-trip (P2) |
| Lineage check | org-config `lineage` assertion (Readiness veto) | Lyric F3 base-skew: a service deployed off the cluster's compatibility set ⇒ readiness CND with F3's named fingerprint |

**Named gaps this instance inherits (honestly recorded):**
- **ui-monorepo has no pb build/fingerprint path today.** v2 binds code-identity to the **service under test only**; the UI is treated as *environment*, not fingerprinted. Explicit assumption — revisit later.
- **Differential on a live cluster is degraded to single-leg** (P3/P5, and the mixed-builder inadmissibility of §4.4): two sequential deploys under a ~5-min reconciler is a false-differential machine. The live path emits an honest **`non-differential`** single-leg `catch` (WORKS/CND on the merge SHA) with drive-time digest re-verification; the two-leg differential stays first-class only when both legs share a builder tier (both `from_tree` or both `ci_attested` with revert-safe pinning).
- **Headless credential** is the hard blocker (§9, Q1): AWS SSO is interactive with no refresh; only the `notprod-lyric-deploy` MCP works headless.

---

## 7. Honesty Invariants + Per-Integration Guardrails (implementation checklist)

The implementation is accepted only if **all** of these hold. false-WORKS = 0 is release-blocking. I2/I3/I4 are stated as **mint preconditions** (§3): the runner declines to mint the satisfying leg unless the fact is verified.

- [ ] **I1 — attestation-lowers-only.** No code path passes provider output into `mint()` as the payload of a fact the harness did not itself observe. Structural: providers live outside `src/{harness,verdict,evidence,types}.mjs` and never import `mint`; only pb-owned phase-runner verify steps mint. Attestations live *inside* receipt data as `{attested, observed, match}`.
- [ ] **I2 — code-identity as a mint precondition (P1/P4).** When pb attaches instead of builds, the tap runner **declines to mint a satisfying `delta`** unless a current, single-pod, whole-window-stable digest↔SHA binding holds, from exactly one of: (a) pb's own build (`from_tree`, tier 1); (b) tier-2 signed provenance whose `subject` digest == pb's independently-read digest, materials name the SHA, signature chains to an **operator-supplied** recognized identity; or (c) tier-3 differential-content (verbatim-shipped, total diff coverage, executed-path bound). Content-probe (tier 4) / tag-name (tier 5) are `unbound` ⇒ caps at CND. **Re-verified at drive time, not just setup** (F2/P3). Unbound ⇒ no leg minted ⇒ CND by construction.
- [ ] **I3 — readiness is pb's probe (P3).** Argo Healthy/Synced is routing input only. Read the deployed revision as the **peeled** commit SHA (tag-peel), compare to the SHA under test; read the live pod digest (I2), pinned to ONE named pod; run pb's **own** front-door probe; mint `bringup` as conjure.mjs:610-615 does today. Attestations carry `observedAt`; staleness beyond a bound ⇒ veto.
- [ ] **I4 — shared-cluster tap honesty (P2/P6/P7).** Where fresh-world isolation can't hold, the harness mints a **run-scoped, globally-unique identity/nonce** it created itself, writes it *through the driven front door*, and the persisted-leg delta query is keyed to that identity **read back out-of-band** — delta attribution replaces world isolation. Validation **rejects** a shared-cluster tap query using a global `max`/`count`. No out-of-band tap ⇒ persisted leg unsatisfiable ⇒ honest CND; an app-REST read is **never** promoted to substitute (verdict.mjs:115-116). k≥2 reproduce semantics degrade **explicitly and recorded**, never silently. Co-location (pod + front door + store = one workload) proven by the nonce round-trip.
- [ ] **I5 — frozen core unchanged.** verdict.mjs / harness.mjs / evidence.mjs / types.mjs are byte-identical. Open `kind` strings + existing Provenance ranks + the mint boundary already suffice. The tier cap is a runner route, not a verdict rule.
- [ ] **I6 — single-leg is labeled `non-differential` (P5).** A single-leg pass is sealed with a distinct, weaker attribution and is never rendered/consumed as the two-leg WORKS.
- [ ] **I7 — CI containment total coverage + executed-path (§4.4).** Every file in the PR diff is located and content-matched against the pinned tree; `path_map`/`ships` are untrusted hints; matches must sit on the runtime-executed path; artifacts pulled by immutable digest; both differential legs share a builder tier.
- [ ] **Adversarial: forged CI / forged BuildRecord ⇒ CND.** Never WORKS, never suppresses a DNW. **A containment/runner-layer adversarial gate** (E1-style) proving forged-BuildRecord / unbound / wrong-artifact ⇒ ZERO satisfying receipts is **release-blocking** for the `ci_attested` path.
- [ ] **Adversarial: stale/wrong-ref Argo ⇒ CND.** A "Synced" against a reverted ref (F2) invalidates the leg via drive-time digest drift.
- [ ] **Golden regression: n8n differential unchanged.** `pb prove recipes/n8n-form-trigger-pr7130` passes identically after seam extraction (tier 1, `from_tree`, byte-identical).
- [ ] **Reaper enforced (P7).** pb-created resources on someone else's cluster are labeled with globally-unique per-run identities and externally reapable; labels are never reused across runs.

---

## 8. Staged Roadmap

**Phase 1 — the contract + the seam extraction + ONE native corroborator.** *(ship this first)*
- **M1 (small):** the honesty spec (trust rule + I1–I7 as mint preconditions) as the acceptance contract, **and** the `pb-org-v1` schema + validators — golden-gated by expressing *both* the unchanged n8n single-repo recipe *and* the Lyric k8s-attach shape. **The identity section of the schema carries the CI-contract fields** (`code_identity.mode:"ci_attested"` + a `pb-buildrecord-v1` reference/resolver). If the schema can't express both shapes, the design is wrong before any runtime work.
- **M2 (medium):** seam extraction — re-house `from_tree`/`local-docker`/`compose`, `sqlite`/`postgres`, and `browser` (now dispatched from `drive.mode`) behind the provider registry, promoting the catch.mjs:518-529 injectable seams. Zero behavior change; n8n differential is the regression gate.

**Phase 2 — the acquire-and-verify integrations.**
- **M3 (medium):** `k8s-attach` Environment provider + the harness-owned independent digest read (I2/P1). The honesty crux — pb's first path to a system it didn't build.
- **M4 (medium):** the `ci_attested` Code-Identity path — `pb-buildrecord-v1` schema + validator, pull-by-digest, differential-content containment (total diff coverage + executed-path), the binding ladder, and the **containment/runner adversarial gate** (release-blocking). Generalizes v1's GitHub-specific corroborator to the CI-agnostic BuildRecord; forged-CI adversarial test is its gate.
- **M5 (medium):** `argocd` Readiness gate with the three traps (F2 reconcile-revert incl. `lyric-agent-state` tracked ref, tag-peel, tag-exists) encoded as named checks.

**Phase 3 — Lyric as one configuration + rollup.**
- **M6 (large; config + one `k8s-exec` tap engine only):** the Lyric org config + recipe. Its pass condition *is* that no new framework surface was needed. Gated on Q1/Q2.
- **M7 (small, optional):** the per-ticket multi-repo rollup (§5) — N single-repo verdicts aggregated; no cross-service orchestration. Cross-service E2E deferred.

### Ponytail note — what NOT to build yet
- **No external plugin/sidecar protocol.** Providers are in-process pb modules shelling out via the existing injectable-runner pattern (proposer.mjs:332-341). Premature until a genuine third-party provider exists.
- **No org-shipped provider code.** Enumerated provider types only — org code executing in pb's process sits on the harness side of the mint boundary and structurally breaks I1. `exec` params are array-argv (P6).
- **No pb-owned build pipeline.** pb integrates via the CI contract; the org's build stays theirs. Local docker (`from_tree`) is the native default, not a takeover.
- **No two-leg differential on live clusters** in v2 — single-leg `non-differential` `catch` until deploy-swap is revert-safe and both legs share a builder tier.
- **No cross-service E2E as a prerequisite** — multi-repo is N single-repo validations + rollup; E2E is an optional later layer.
- **No ui-monorepo fingerprinting** in v2 — UI is environment, not code-identity.
- **No fourth provenance rank.** Attestations are receipt *data*, not a trust level.

---

## 9. Open Questions for the User

1. **Headless cluster credential (blocks every live leg of M3/M5/M6).** AWS SSO is interactive with no refresh; `de-api.sh` raw reads are SSO-gated (401); only the `notprod-lyric-deploy` MCP works headless. pb's phase runners need at minimum headless `kubectl get pod/application` + `kubectl exec` (mongosh tap) on one BYOC lyriclet. **Can a long-lived service-account kubeconfig be provisioned for one lyriclet, and is MCP-only read access acceptable for the Argo/CI attestors?** Nothing in M1/M2/M4 waits on this — but M6-live does.

2. **Differential semantics on an acquired cluster.** Recommendation: the live path ships a **`non-differential` single-leg `catch`** (honest WORKS/CND on the merge SHA) with drive-time digest re-verification, deferring the two-leg differential on live clusters until deploy-swap is revert-safe (pin on the agent-tracked ref first, per F2) **and both legs share a builder tier** (no mixed CI-merge/pb-parent). **Accept single-leg `non-differential` for the Lyric instance, keeping the full differential first-class only when both legs come from the same builder?**

3. **~~Can a fingerprint pb didn't build carry full WORKS weight?~~ — ANSWERED by the binding ladder (§4.3).** Tag-convention is `unbound` and **never** WORKS-capable. The zero-integration WORKS floor is **tier-3 differential-content** (verbatim-shipped source: `lyric-py`/Python get this for free). Transformed artifacts (`appservice` TS→JS) reach WORKS **only** via tier-2 signed provenance or tier-1 `from_tree`. **Remaining decision for Lyric's `appservice`:** push Lyric to add a one-step `actions/attest-build-provenance` (strict tier-2, whole-build binding) **or** accept the `from_tree` fallback (pb builds `appservice` itself). No frozen-core work waits on this.

---

### Assumptions made (not user-stated)
Config-only adapters in v2; single-leg `non-differential` external `catch` in v2; UI excluded from code-identity binding in v2; Lyric target = Model-B BYOC lyriclet; pb's zero-runtime-dep rule extends to all providers; pb is granted at least read-level cluster/registry credentials by any integrating org; the tier-2 recognized-identity trust root is operator-supplied out-of-band. "Design, do not implement" ⇒ this doc is the only artifact produced now.
