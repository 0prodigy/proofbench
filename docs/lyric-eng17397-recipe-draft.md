# Lyric ENG-17397 — draft `pb-recipe-v1` (k8s-attach class) + the `recipe.mjs` growth it forces

*Lyric build step **(a)** of the queued dogfood phase (RESUME.md §NEXT.6, cheapest-failure-first
order). This is the **paper translate** of the already-completed gap recon: it turns
`~/lyric/.tickets/ENG-17397/appservice/ready.yaml` into a concrete draft recipe and enumerates the
exact `src/recipe.mjs` growth that recipe forces. **Read-only wrt code.** This doc changes nothing
in `src/` or `recipes/`; it is the spec the next slices execute.*

Source of truth for the mapping + confirmed primitives + 8 ranked gaps: `docs/RESUME.md` §NEXT.6
("GAP RECON DONE"). This doc **builds on** that recon — it does not redo it.

## Two decisions already defaulted (applied as given, per RESUME §NEXT.6)

1. **Reproduce model = new note/exec per iteration.** A shared BYOC cluster cannot be torn down and
   recreated, so `fresh_world:recreate` does not map. Each reproduce iteration **fires a fresh
   throwaway note-execution** (the `fire-*` verbs mint a new parent+child exec every run) — this
   preserves the `reproduce.k >= 2` / `kFail >= 2` contract against *independent* executions, never a
   re-read of one cached result.
2. **v1 drive surface = appservice REST API + mongo tap.** The end-user leg (`ui-monorepo`) is **not**
   built/fingerprinted today, so v1 drives the product's own REST entrypoint (`POST /executions`, the
   same endpoint lyric-py drives in-pod) and reads ground truth out-of-band from mongo. The fingerprint
   is derived **from files, not prose**.

> **This draft does not validate against today's `src/recipe.mjs`.** It intentionally uses enum values
> and fields the current loader rejects (`code_identity.mode:"multi_repo"`, `conjure.mode:"k8s-attach"`,
> `store_tap.engine:"mongo"`, `fresh_world.strategy:"new_note_per_iteration"`). §2 is the growth that
> makes it loadable. Provenance/verdict trust core (`verdict.mjs`, `harness.mjs`) stays **frozen**.

---

## A material finding that shapes `code_identity`: the versions-disagree trap is LIVE

RESUME §NEXT.6 warned "RESUME/prose versions disagree — derive the fingerprint from FILES." Confirmed,
and it is worse than a prose typo: the **main dev worktrees** (the files the task named) and the
**ticket worktrees** (checked out on the ENG-17397 branches, co-located with the SHAs below) carry
**different** dev-wheel versions.

| value | main worktree `~/lyric/…` | ticket worktree `~/lyric/.tickets/ENG-17397/…` |
|---|---|---|
| `lyric_py_version.py` → `LYRIC_PY_VERSION` | `1.3.39.dev17398` | **`1.3.40.dev17398`** |
| `lyric_py_version.py` → `MDS_SDK_VERSION`  | `2.0.2.dev17397` | **`2.0.4.dev17399`** |
| `metadata-service/sdk-versions.json` → `python` | `1.8.1.dev17397` | **`2.0.4.dev17399`** |

The ticket worktree is **internally coherent** (runner's `MDS_SDK_VERSION` `2.0.4.dev17399` ==
`metadata-service/sdk-versions.json` `python` `2.0.4.dev17399`); the main worktree is stale relative to
the bound SHAs. RESUME §NEXT.6 also mislabeled `MDS_SDK_VERSION 2.0.2.dev17397` as "runner" — the
runner package's own version is **not** declared in that file (the "26.2.4.dev17398" seen in evidence
is a `selfAttested`, unsealed string → not authoritative).

**Decision (high-bar rule for `code_identity`):** the fingerprint MUST bind the **ticket-worktree**
values co-located with the bound SHAs; a fingerprint mixing main-worktree wheels with ticket-worktree
SHAs is incoherent. Enforced not by trusting the recipe string but by conjure **re-reading** the SHA
(`git rev-parse` in the checkout) and the version files at build time — the recipe values are a *claim*
until the harness confirms them against the tree (same stance as OSS M3, where `conjure` mints the
fingerprint from the actual build, RESUME §NEXT.4).

---

## 1. DRAFT `pb-recipe-v1` (k8s-attach)

Annotated (JSONC) so every value carries its source or a `TODO(reason)`. Inline `// <-` is the cite,
not part of the contract.

```jsonc
{
  "kind": "pb-recipe-v1",
  "name": "Lyric Actions & Controls (ENG-17397, k8s-attach)",   // <- ready.yaml:1-9 (service+role)
  "notes": "Attach-only (ADR-0011 Shape-A): pb port-forwards, never creates cluster objects. Discriminating claim = the stuck-`queued` control-expiry DNW: merge SHA expires stage controls on terminal + fires the user-action-required email + honors ack-proceed (WORKS); parent SHA leaves the control stuck `queued` (DNW). Cluster context/namespace are OPERATOR-SUPPLIED — even the ticket's own artifacts disagree (ready.yaml:12-14 says redcat/redcat; evidence/20260710-164002 manifest.json says akashpathak/delta), so they must never be baked.",

  // === CODE IDENTITY — NEW multi-source shape (7 repos + dev wheels + deployed images) ===
  "code_identity": {
    "mode": "multi_repo",                                        // <- NEW enum (today: from_tree|pinned_image, recipe.mjs:196-207)
    "repos": [
      { "repo": "appservice",                    "sha": "f38fa648c5378f0aaf574bdbd1da573af640c17b", "branch": "ENG-17397-action-and-interrupts",     "base": "staging" },                         // <- git rev-parse .tickets/ENG-17397/appservice; branch/base branches.json:3
      { "repo": "metadata-service",              "sha": "e7d543288696dea150f509b3996559896d46d85a", "branch": "ENG-17397-action-and-controls",       "base": "eng-0001-updating-python-to-3.10" }, // <- git rev-parse; branches.json:4-5
      { "repo": "mosaic-function-scenario",      "sha": "e5a1660076208afaec6120da196d4db1a42a838f", "branch": "ENG-17397-scenario-selected-action",  "base": "staging" },                         // <- git rev-parse; branches.json:6
      { "repo": "mosaic-function-stage-control", "sha": "894ce3d981ab9466814d996d99e2ea7054da29bf", "branch": "ENG-17397-action-and-controls",       "base": "staging" },                         // <- git rev-parse; branches.json:7 (new repo, PR #1)
      { "repo": "lyric-py",                      "sha": "3d52c2610fd83e0903c05cbc47352118bf3c58a6", "branch": "ENG-17398-action-and-controls",       "base": "staging" },                         // <- git rev-parse; branches.json:8
      { "repo": "lyric-runner-py",               "sha": "dac218ffac1756465be67f276f8f76e47e11c307", "branch": "ENG-17398-action-and-controls",       "base": "staging" },                         // <- git rev-parse; branches.json:9
      { "repo": "db-migrations",                 "sha": "578660e1d44d84eac7ea70cb86cf7de6a45c8b09", "branch": "ENG-17397-user-action-email",         "base": "staging" }                          // <- git rev-parse; branches.json:10
    ],
    "wheels": [
      { "package": "lyric-py",              "version": "1.3.40.dev17398", "source": ".tickets/ENG-17397/lyric-runner-py/lyric_runner/lyric_py_version.py:1 (LYRIC_PY_VERSION)" },
      { "package": "mds-sdk-python",        "version": "2.0.4.dev17399", "source": ".tickets/ENG-17397/lyric-runner-py/lyric_runner/lyric_py_version.py:4 (MDS_SDK_VERSION) == .tickets/…/metadata-service/sdk-versions.json python" },
      { "package": "clickhouse-utils",      "version": "1.3.6",          "source": ".tickets/ENG-17397/lyric-runner-py/lyric_runner/lyric_py_version.py:2" },
      { "package": "lyric-datatype-utils",  "version": "2.0.0",          "source": ".tickets/ENG-17397/lyric-runner-py/lyric_runner/lyric_py_version.py:3" },
      { "package": "lyric-runner-py",       "version": "TODO(own package version not declared in lyric_py_version.py; evidence '26.2.4.dev17398' is selfAttested/unsealed — read from the built wheel at conjure time)" }
    ],
    "images": [
      { "ref": "us-docker.pkg.dev/development-367210/lyric/appservice",       "digest": "TODO(read the DEPLOYED digest AT DRIVE TIME; evidence pin sha256:a31e0593… is at OLD repo SHA 04cfa9b9, not this tip — F2/F3)" }, // <- ref: evidence/20260710-164002 manifest.json pins.image.appservice
      { "ref": "us-docker.pkg.dev/development-367210/lyric/metadata-service", "digest": "TODO(drive-time)" },                                                                                                                          // <- ref: evidence/20260706-225606 manifest.json artifact 07
      { "ref": "TODO(mosaic-function-stage-control Nuclio image ref — not in read artifacts)", "digest": "TODO(drive-time)" },
      { "ref": "TODO(mosaic-function-scenario Nuclio image ref — not in read artifacts)",      "digest": "TODO(drive-time)" }
    ]
  },

  // === CONJURE — NEW k8s-attach mode (attach a live BYOC deploy; NOT local run/compose) ===
  "conjure": {
    "mode": "k8s-attach",                                        // <- NEW enum (today: run|compose, recipe.mjs:222-228)
    "cluster": {
      "context": "TODO(operator-supplied PB_K8S_CONTEXT; ready.yaml:12-14 says redcat, evidence says akashpathak — disagree → never baked)",
      "namespace": "TODO(operator-supplied PB_K8S_NAMESPACE; ready.yaml redcat vs evidence delta)"
    },
    "attach": {                                                  // <- ready.yaml resources.*.via.k8s (:55-81) — port-forward targets, attach-only
      "appservice": "svc/appservice:8000",                       // <- ready.yaml:36,59
      "mongo":      "svc/mongodb-svc:27017",                      // <- ready.yaml:62-63
      "mds":        "svc/nuclio-metadata-service:8080",           // <- ready.yaml:73-75
      "redis":      "svc/lyrikey-valkey-primary:6379",            // <- ready.yaml:79-81 (backs stage-control signalling)
      "kafka":      "svc/kafka-cluster-kafka-brokers:9092"        // <- ready.yaml:66-68
    },
    "ready_signal": { "tcp_target": "appservice", "timeout_s": 60, "interval_s": 2 }, // <- ready.yaml:48-53 (TCP on forwarded appservice port; L3 /health is a check, not a run-container ready poll)
    "base_coherence_preflight": "TODO(hard L3 gate before drive — lyric-devops base-skew F3 + reconcile-revert F2 de-risk; live cluster, §4)"
  },

  // === FRESH WORLD — NEW per-iteration strategy (recreate is impossible on a shared cluster) ===
  "fresh_world": {
    "strategy": "new_note_per_iteration",                        // <- NEW enum (today: recreate only, recipe.mjs:231-233); Decision 1
    "notes": "each reproduce iteration fires a fresh throwaway parent+child note-exec (fire-default/fire-override); k>=2 runs over INDEPENDENT executions, never a re-read of one."
  },

  // === SETUP — operator-supplied ids, NOT a REST bootstrap dance (the scenario/note pre-exist) ===
  "setup": {
    "operator_env": [                                            // <- ready.yaml:102-106 (operator-supplied env) + gates rationale
      "PB_K8S_CONTEXT", "PB_K8S_NAMESPACE",
      "PB_SCENARIO_ID", "PB_SEQUENCE_ID", "PB_SEQ_NOTE_ID",
      "PB_DEFAULT_ACTION", "PB_OVERRIDE_ACTION", "PB_EXPECTED_IMAGE"
    ],
    "capture_expectations": "printf-echo the PB_* expectation env back to stdout so ratify re-captures them as exports (substituteExports expands $VAR in predicates only for CAPTURED exports)"  // <- ready.yaml:113-121
  },

  // === FRONT DOOR — appservice REST base, NOT a single minted-id URL page ===
  "front_door": {
    "mode": "rest",                                              // <- Decision 2 (today front_door requires url_template w/ {placeholder}, recipe.mjs:260-264)
    "base_url_template": "http://{appservice_host}:{appservice_port}", // <- resolved from the attach port-forward (ready.yaml:51,138)
    "entrypoint": "POST /executions?scenarioId={PB_SCENARIO_ID}&sequenceId={PB_SEQUENCE_ID}&sequenceNoteId={PB_SEQ_NOTE_ID}", // <- ready.yaml:135-139 (ids in QUERY STRING; body-only POST 500s, known_walls:350-356)
    "serves": "the same appservice API lyric-py drives in-pod; the minted id is the parent execution _id from the fire response"
  },

  // === STORE TAP — NEW mongo engine, wrapping the out-of-band lyric-mongo.sh (HARNESS provenance) ===
  "store_tap": {
    "engine": "mongo",                                           // <- NEW enum (today: sqlite|postgres, recipe.mjs:271-281)
    "pod": "mongodb-0",                                          // <- lyric-mongo.sh:61,92,98 (kubectl exec mongodb-0)
    "container": "mongod",                                       // <- lyric-mongo.sh:61 (-c mongod)
    "db": "lyric",                                               // <- ready.yaml:174 (--db lyric)
    "tap_script": "~/.claude/skills/lyric-qa/scripts/lyric-mongo.sh", // <- ready.yaml:173 (the OUT-OF-BAND tap: kubectl exec into mongodb-0 → mongosh → {ok,db,result}; NOT the appservice API)
    "queries": {
      "child_execution": "db.executions.findOne({_id:ObjectId('$PB_CHILD_*')},{subActions:1,stages:1,logState:1,status:1})", // <- ready.yaml:196,203 (subActions is select:false in Mongoose but a raw mongosh read returns it)
      "parent_notes":    "db.executions.findOne({_id:ObjectId('$PB_PARENT_*')},{notes:1})",                                    // <- ready.yaml:175 (child = parent.notes[0])
      "stage_controls":  "db.stagecontrols.find({executionId:'$PB_CHILD_*'}).toArray()"                                        // <- lyric-note-actions-controls skill: `stagecontrols` collection is the queued→expired ground truth for the discriminating claim
    },
    "future_engines": ["clickhouse", "redis"],                   // <- clickhouse-driver reads + `stage-controls:{executionId}` Redis stream are out-of-band taps for later behavioral legs
    "notes": "harness-provenance: reads mongo directly via kubectl-exec, never through appservice. A read via the app's REST API would be agent/tool provenance and cannot ground a WORKS."
  },

  // === DRIVE — note-lifecycle (already in the enum), API+mongo per Decision 2 ===
  "drive": {
    "mode": "note-lifecycle",                                    // <- ALREADY in enum (recipe.mjs:289) — EXTENDS, not new
    "surface": "appservice-api+mongo",                           // <- Decision 2
    "claim": "stuck-`queued` control-expiry differential (WORKS on merge SHA, DNW on parent SHA)",
    "verbs": "capture-expectations, fire-default, resolve-child-default, read-default, fire-override, resolve-child-override, read-override, drive-stage-machine, drive-illegal-transition", // <- ready.yaml:85-91,107-242 (12-op lyric-qa flow; the WALK stays agent-proposed, NOT recipe data)
    "reason": "server-side note lifecycle driven over the appservice REST API + mongo tap; end-user ui-monorepo leg deferred (Decision 2)"
  }
}
```

---

## 2. `recipe.mjs` growth spec — diff-shaped checklist

Each item is a surgical extension of the current validator. The **high-bar rule** is the honesty
invariant the new field must clear or it can manufacture a false WORKS.

**G1 — `code_identity` += `multi_repo` mode.** In the discriminated union (`recipe.mjs:194-207`) add a
third `else if (ci.mode === 'multi_repo')` branch requiring: `repos[]` non-empty, each `{repo, sha,
branch}` string-required (`base` optional); `wheels[]` non-empty, each `{package, version}`
string-required (`version` may be a `TODO(...)` sentinel that flags the identity as incomplete →
downstream must not claim a bound fingerprint); `images[]` optional, each `{ref}` required, `digest`
optional (drive-time). Keep `from_tree`/`pinned_image` unchanged.
- **High bar:** the recipe's SHA/version/digest strings are a *claim*. Conjure MUST re-derive them from
  the checked-out tree (`git rev-parse`, re-read version files) before they seal any identity — files
  over prose (the live versions-disagree trap above). A `TODO` version means the fingerprint is
  incomplete → honest CND, never a silent bound-identity.

**G2 — `conjure` += `k8s-attach` mode.** At the mode gate (`recipe.mjs:222-223`) allow
`'run'|'compose'|'k8s-attach'`. For `k8s-attach`: require `cluster{context,namespace}` (both strings —
but see high bar), require `attach{}` non-empty (name → `svc/<name>:<port>` string), require
`ready_signal` (tcp form: `tcp_target` naming an attach key + numeric `timeout_s`/`interval_s`);
**forbid** `compose_file`/`compose_overlays`/`service` and the single-container `container_port`/
`published_port`/`env` (attach owns no container — it port-forwards a live deploy). `base_coherence_preflight`
optional string.
- **High bar:** attach-only (ADR-0011) — the validator must reject any field that would *create* a
  cluster object. The sealed code identity is the **drive-time** deployed image digest, not the recipe
  pin (F2 reconcile-revert / F3 base-skew can silently swap the image out from under a pre-run pin).

**G3 — `store_tap` += `mongo` engine.** In the engine gate (`recipe.mjs:271-281`) add
`else if (st.engine === 'mongo')` requiring `pod`, `container`, `db`, `tap_script` (all non-empty
strings) and the existing `queries` (non-empty). `busy_timeout_ms` stays sqlite-only. Optionally
reserve `clickhouse`/`redis` as declared-but-not-yet-built engines that validate the descriptor but
make `drive` honest-CND (mirrors the `deferred` drive pattern). Update the union typedef
(`recipe.mjs:106-125`).
- **High bar:** a `mongo` tap is ground truth ONLY because `lyric-mongo.sh` reads mongo out-of-band
  (`kubectl exec mongodb-0 -c mongod -- mongosh`, lyric-mongo.sh:61,98) = HARNESS provenance. The
  validator/store-tap must guarantee the query path never routes through the appservice API; an
  app-sourced read is `agent`/`tool` provenance and is downgraded before the verdict
  (`evidence.mjs:78-83,107-113`; ranks in `types.mjs`).

**G4 — `fresh_world` += `new_note_per_iteration` strategy.** At `recipe.mjs:233` allow
`'recreate'|'new_note_per_iteration'`. New strategy needs no teardown fields; it declares that each
reproduce iteration mints a fresh note-exec.
- **High bar:** reproduce `k`/`kFail` must count **independent** fresh executions, never re-reads of one
  cached exec — otherwise the reproduce gate is a replay tautology (the same class of bug as the fixed
  null-delta / seed-match false WORKS, `verdict.mjs` §12.8). The harness must confirm each iteration's
  execution `_id` differs.

**G5 — `setup` accepts an operator-env object (not just a REST-step array).** Today `setup` is an
array of HTTP steps (`recipe.mjs:243-258`). Add an object form `{ operator_env: string[],
capture_expectations?: string }`; when present, validate `operator_env` is a non-empty string[]. The
Lyric class has no REST bootstrap dance (the scenario/sequence/note pre-exist on the cluster).
- **High bar:** operator-supplied ids/expectations are inputs, not run outputs — a check whose
  `requires:` env is unset MUST record an honest **not-run**, never a pass (ready.yaml:262-263,275,306
  already encodes this; the loader must not let a recipe fabricate a default for a missing PB_* id).

**G6 — `front_door` += `rest` mode (relax the url_template requirement).** Today `url_template` is
required and must carry a `{placeholder}` (`recipe.mjs:260-264`). Add `mode: 'url'|'rest'` (default
`'url'` to keep OSS recipes valid); for `mode:'rest'` require `base_url_template` + `entrypoint`
strings and DROP the `{placeholder}` requirement (the minted id is captured from the fire response, not
carried in a URL).
- **High bar:** the front door must be the **real product entrypoint** (`POST /executions`, the same
  path lyric-py drives in-pod) — not a look-alike. A drive that doesn't hit the production path isn't a
  repro.

**G7 (extend, not new) — `drive.mode:'note-lifecycle'` required sub-fields.** `note-lifecycle` is
already in the enum (`recipe.mjs:289`) but carries no required fields. When
`mode==='note-lifecycle'`, require `surface` (`'appservice-api+mongo'` for v1) and keep the walk
**out** of the recipe (agent-proposed — avoids the Gherkin grave, RESUME).
- **High bar:** the verbs list is orchestration scaffolding; the WALK (what to type/assert) stays
  agent-proposed and is never recipe data.

---

## 3. Fields with NO clean mapping + the decision each needs

- **`fresh_world` (shared cluster can't `recreate`).** A BYOC cluster is shared and long-lived; there
  is no per-run teardown/recreate. **Decision (RESUME Decision 1):** `strategy:"new_note_per_iteration"`
  — the "world" that is made fresh is scoped to the **proof's own note/exec docs**, not the cluster.
  Each iteration's `fire-default`/`fire-override` creates a brand-new parent+child execution; the
  reproduce `k>=2` runs over these independent execs. Nothing pre-existing is mutated for the WORKS
  leg beyond the throwaway execs the run itself creates (the `drive-stage-machine` PATCH mutates only
  the run's own override child — gated as destructive, ready.yaml:327-347).

- **`front_door` (no single user URL).** There is no minted-id page like n8n's
  `/webhook/{id}/n8n-form`. **Decision (RESUME Decision 2):** `front_door.mode:"rest"` — the door is the
  appservice REST base resolved from the attach port-forward, and the entrypoint is
  `POST /executions?scenarioId&sequenceId&sequenceNoteId` (all three ids in the QUERY STRING — a
  body-only POST 500s, ready.yaml known_walls:350-356). The "minted id" is the parent execution `_id`
  captured from the fire response, then `parent.notes[0]` resolves the child that carries the
  subActions/stages (ready.yaml:170-186).

- **`setup` (operator-supplied ids, no REST dance).** The scenario/sequence/note already exist on the
  cluster; there is nothing to POST-bootstrap. **Decision:** `setup.operator_env[]` names the required
  PB_* inputs (`PB_K8S_CONTEXT/NAMESPACE`, `PB_SCENARIO_ID`, `PB_SEQUENCE_ID`, `PB_SEQ_NOTE_ID`,
  `PB_DEFAULT_ACTION`, `PB_OVERRIDE_ACTION`, `PB_EXPECTED_IMAGE`). A `capture-expectations` verb echoes
  the expectation env back to stdout so ratify re-captures it as exports (ready.yaml:113-121); any
  unset required input yields an honest **not-run**, never a fabricated pass.

- **(bonus) `conjure.cluster{context,namespace}` cannot be baked.** Even the ticket's own artifacts
  disagree — ready.yaml:12-14 prose says `redcat`/`redcat`; `evidence/20260710-164002/manifest.json`
  pins `akashpathak`/`delta`. **Decision:** both are **operator-supplied** (`PB_K8S_CONTEXT`/
  `PB_K8S_NAMESPACE`), consistent with `workspace.yaml`, never a recipe literal.

---

## 4. What this draft does NOT resolve

Everything gated on a **live cluster / lyric-devops** or on **OSS M6** is out of scope for step (a) and
stays honest-CND until built: the base-coherence preflight (F3 base-skew as a hard L3 gate) and the
reconcile-revert guard (F2) that must run *before* pb's logic to avoid a manufactured false
`DOES_NOT_WORK`; the **drive-time image-digest re-read** that seals the actually-deployed digest rather
than the pre-run pin; and the operator-supervised, destructive-gated live `pb verify --ratify` run that
executes the L4/L5 behavioral legs (which **no ENG-17397 run has ever executed** — every recorded
manifest is L3-health or L4/L5 `not-run`). Separately gated on **OSS M6**: the seal-adapter receipt
pattern that turns the existing schema-2, `selfAttested:true`, plain-string-`provenance` artifacts
(`evidence/*/manifest.json`) into minted-and-sealed harness receipts — this must land **with** the
M6-proven receipt pattern (RESUME §NEXT.6 step (b)) to avoid rework, not before it.
