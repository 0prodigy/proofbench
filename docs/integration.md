# pb-integration-v1 — integrating Proofbench into a pipeline

The frozen input surface (`pb-recipe-v1` + an agent-proposed walk, CLAUDE.md pattern 4)
is also the integration contract: this document teaches an engineer wiring pb into a
pipeline or platform exactly what's shipped, exactly what's swappable, and exactly what
a verdict looks like on the wire. Nothing here is aspirational — every field, provider,
and exit code is traced to the source file that implements it.

## What pb is

pb is the verification layer between an AI agent's claim of "done" and a human's (later:
policy's) approval to deploy. An agent proposes what to try; a deterministic harness
disposes — it executes the walk, reads the persisted effect out-of-band, seals the
evidence, and computes a tri-state verdict (`WORKS` / `DOES_NOT_WORK` /
`COULD_NOT_DETERMINE`) by fixed rules the agent cannot influence. pb never implements a
change and never deploys one; it only tells you, with sealed replayable evidence, whether
a real user can do the thing.

## The recipe contract (`pb-recipe-v1`)

A recipe is `<recipeDir>/recipe.json`, loaded and validated by `loadRecipe` in
[`src/recipe.mjs`](../src/recipe.mjs). Loading is fail-fast and loud: the first
missing/invalid field throws immediately, naming itself — a recipe never half-loads.
Field reference below is derived directly from that loader (validator semantics
included); the worked example throughout is
[`recipes/documenso-envelope-fields-pr3031/recipe.json`](../recipes/documenso-envelope-fields-pr3031/recipe.json)
(compose conjure, Postgres tap, browser drive — the richest of the four committed
recipes). A simpler single-container/sqlite recipe is
[`recipes/n8n-respondwebhook-formtrigger-pr9157/recipe.json`](../recipes/n8n-respondwebhook-formtrigger-pr9157/recipe.json).

### Identity

- `kind` — must be the literal string `"pb-recipe-v1"`.
- `name` — non-empty string.
- `notes` — optional human notes (e.g. how a front-door placeholder is minted, or the
  live diff between merge and parent SHA).
- `intent` — optional prose sentence the proposing agent's claim is checked against;
  required only when the discriminating behavior isn't "persists an execution" (the
  generic default). Never a DSL — the walk itself stays agent-proposed, never recipe
  data.

### `code_identity` — what SHA/image the verdict is bound to (invariant 5)

Discriminated union on `mode`:

- **`from_tree`** — build the SUT from source at an exact SHA (highest code-identity).
  Requires `repo`, `sha`, `dockerfile`, `context`. Optional: `parent_sha` (the
  disclosed differential baseline — required for `pb prove`'s anti-tautology check),
  `build_overlay` (string[] of disclosed build-time fixups), `target` (a docker build
  `--target` stage, for a tree whose default/last stage isn't buildable), `version_label`.
- **`pinned_image`** — pin an already-built image by digest. Requires `image_ref`,
  `image_digest`. Optional `version_label`.

Any other `mode` value fails `loadRecipe` naming `code_identity.mode`.

### `conjure` — bringing the SUT up

- `mode` — `'run'` (default; a single container, e.g. n8n) or `'compose'` (a
  multi-service graph brought up via `docker compose`, e.g. documenso's app + postgres +
  inbucket). `mode: 'compose'` requires `compose_file` (relative to the checkout);
  optional `compose_overlays` (string[]) and `service` (the app service name within the
  graph).
- `env` — inline container environment (object).
- `container_port` / `published_port` — numbers; where the SUT listens vs. where pb
  publishes it on the host.
- `ready_signal` — `{ path, expect_status }`, the HTTP path/status pb polls before
  touching the SUT.
- `setup_overlay` — optional string[] of disclosed setup-time fixups (e.g. `apk add
  sqlite` so the out-of-band tap can query the store).

### `fresh_world`

- `strategy` — must be `'recreate'` (the only value v1 supports): tears down/rebuilds
  the whole SUT per iteration so no state bleeds between the k≥2 reproductions a
  WORKS/DOES_NOT_WORK conviction requires.

### `auth_preflight` (optional)

- `{ method, path }` — a request made before setup to mint a bootstrap cookie (e.g. `GET
  /rest/login`).

### `setup` / `confirm` — disclosed REST steps (same schema, validated identically)

Both are arrays of the same step shape; `setup` runs before the drive, `confirm` after
(a recipe-declared fresh-session re-observation). Either may be empty (some SUTs
self-bootstrap, e.g. documenso auto-runs Prisma migrations at boot). Each step:

- `id` — non-empty string.
- `method` / `path` — required unless `exec` is set.
- `body` (inline JSON) XOR `body_file` (path relative to recipeDir, must exist).
- `content_type` — `'json'` (default), `'form'` (URL-encoded, e.g. a Django login form),
  or `'multipart'` (form-data + `files[]`, e.g. documenso's file-upload envelope create).
- `headers` — object of string values, placeholder-resolved.
- `origin` — an absolute `http(s)://host:port` override for this one step
  (placeholder-resolved) — for a cross-service capture (e.g. inbucket on a different
  published port).
- `files` — required when `content_type: 'multipart'`: `[{ field, path, content_type? }]`,
  `path` relative to recipeDir and must exist.
- `capture` — a name → JSONPath string (default, read from a JSON response) or `{ from:
  'html', pattern }` (a regex ≤200 chars with one capture group, read from response
  HTML — e.g. a CSRF token or an inbucket-captured verification link).
- `exec` — an out-of-band, setup-time-only store read (`{ engine: 'postgres', container,
  user, db, query }`), mutually exclusive with every REST-step field. The disclosed
  fallback for a bootstrap value with no REST route (e.g. documenso's team-id lookup,
  which has no exposed API at this SHA). When present, `capture` maps a name to a
  zero-based **column index** into the first returned row — never the `store_tap`
  ground-truth read the verdict binds to.

### `front_door`

- `mode` — `'url'` (default; the only value). A single user-facing URL.
- `url_template` — required string. A `{placeholder}` for a setup-minted id is
  **optional** — a template with none (a static creation form) is used verbatim.
- `serves` — optional human documentation of what the URL renders.

### `store_tap` — the out-of-band, harness-provenance persisted-leg read (invariants 3, 6)

Engine-discriminated; **never an app endpoint** — always a direct read of the SUT's own
datastore, run by the harness, never the agent.

- **`sqlite`** — a store **file** inside the SUT container. Requires `db_path`,
  `busy_timeout_ms` (rollback-journal mode means a reader can collide with a writer — a
  transient "database is locked" is expected and retried, never a SUT failure).
- **`postgres`** — a **separate** DB container, read via `docker exec <container> psql`
  (trust auth over the local unix socket, no password). Requires `container`, `user`,
  `db`. `busy_timeout_ms` optional/unused (MVCC readers never block on writers).

Both require `queries` (a non-empty object of name → read-only SQL string) and accept:

- `observables` — per-query engine-shaped reduction of rows to the one comparable value
  a claim's `entity` binds: `row-count` (rows returned), `max-id` (max of an id-like
  field/column — n8n's autoincrement shape, sqlite's default), `named-scalar` (the sole
  value of the first row's first field/column — a query that already aggregates in SQL,
  postgres's default, e.g. documenso's `SELECT count(*) AS n`). Absent for a given query
  falls back to the engine-honest default (`resolveObservable` in `src/recipe.mjs`), so
  an already-shipped recipe with no `observables` block resolves exactly as it always
  did.
- `transient_lock_is_expected` — boolean.
- `settle` — `{ quiet_ms, max_ms }`: after the observable first moves, keep polling until
  it's unchanged for `quiet_ms` (bounded by `max_ms`) before reading — rides out a
  debounced autosave (e.g. documenso's ~2s field-persist debounce) so the tap never reads
  mid-flight.

Any other `store_tap.engine` value fails `loadRecipe` naming the field.

### `drive` — how the front door is driven

- `mode` — `'http'`, `'browser'`, or `'deferred'`. Absent defaults to `'deferred'` (no
  driver built for this front door → an honest CND, never a forced fit).
- `reason` — optional string, especially useful for `'deferred'`.

## The four substrate selector fields

These are the only points where a recipe selects a swappable seam, and
[`src/registry.mjs`](../src/registry.mjs) is the **single resolution point** for all
four — a recognized value maps to its native provider; an unrecognized value is a
fail-fast, named error (never a silent fallthrough), mirroring `recipe.mjs`'s own `bad()`
helper:

| Selector | Shipped values | Registry-native set |
|---|---|---|
| `conjure.mode` | `run` \| `compose` | `ENVIRONMENT_MODES` |
| `code_identity.mode` | `from_tree` \| `pinned_image` | `IDENTITY_MODES` |
| `store_tap.engine` | `sqlite` \| `postgres` | `TAP_ENGINES` |
| `drive.mode` | `http` \| `browser` \| `deferred` | `BROWSER_DRIVE_MODES` (all three currently resolve to the one shipped browser drive — see below) |

An unknown value anywhere in this table throws `registry: <field> has no registered
<phase> provider (got <value>; native: <list>)` — the same shape whether the mistake is
a typo in a hand-written recipe or an unearned substrate someone tries to wire in ahead
of its live verdict (see invariant 7, next section).

## The adapter contract

`src/registry.mjs` exposes three resolver functions, each returning the **existing**
provider entry point (the registry adds indirection only — it never re-implements or
alters what a provider does):

```js
environmentProvider(recipe) // -> conjure()      (src/conjure.mjs)   — brings the SUT up: code-identity resolution + bring-up + readiness poll
tapProvider(recipe)         // -> tapStore()      (src/storetap.mjs) — the out-of-band store read
driveProvider(recipe)       // -> openBrowser()   (src/browserdrive.mjs) — drives the front door
```

`resolveCatchSeams(opts, recipe)` is the default wiring `runCatch` (`src/catch.mjs`)
consumes: `{ conjureFn, tapStoreFn, openBrowserFn }`, each resolved from the recipe
unless the caller explicitly injects one — an injected seam always wins over the
registry default (this is how pb's own unit tests substitute mocks; it is also the shape
a bring-your-own provider would slot into).

**Today, every `drive.mode` value (`http`, `browser`, `deferred`) resolves to the one
shipped browser drive** — this is current, deliberate, grandfathered behavior
(`registry.mjs`'s own comment: the n8n #7130 recipe declares `drive.mode: "http"` yet is
browser-driven, and must stay so). Dispatching `http` to a raw-HTTP driver, and
`deferred` to an honest CND, is a named, deferred follow-up — not a bug, and not
something an integrator should route around by hand.

**Invariant 7 (CLAUDE.md, verbatim):** *"Substrate is a swappable seam with ONE shipped
default; new substrates earn their way in via an executed live verdict, never ahead of
one."* Docker (`run`/`compose`) is that one shipped default for the environment seam.
The excised Lyric/k8s substrate (`argo-workflows` drive, `k8s-exec` tap, k8s-attach
conjure — removed at commit `b807169`) is resurrectable exactly on those terms: it comes
back at R3 when it has an executed live verdict to earn its slot, not before
(`DEFERRED.md`'s resurrect-refs point at the pre-excision commit `e8a5a75`). Until then,
a recipe naming any of those values fails loudly at the registry, per the table above —
never a silent partial run.

## Consuming verdicts

### Exit codes (`src/cli.mjs`, verified against the current implementation)

`pb prove`/`pb conjure`/`pb gate`/`pb phase1`/`pb phase2`/`pb phase3` today implement
**three** exit codes, not the four-way split CLAUDE.md's frozen contract names as the
target end-state:

- **`0`** — success: `WORKS` (phase commands, `conjure`) or differential `PASS`
  (`merge = WORKS ∧ parent ≠ WORKS`, `prove`).
- **`1`** — not success: `DOES_NOT_WORK`, `COULD_NOT_DETERMINE`, an unconjurable SUT, a
  differential `FAIL`, or an uncaught internal error (`main()`'s top-level catch also
  exits `1`) all currently collapse into this one code.
- **`2`** — a CLI usage problem: a missing/unrecognized `<dir>`/`<recipeDir>`, an unknown
  subcommand, an empty recipe pool for `--random`, or (for `prove`) a recipe with no
  `from_tree` + `parent_sha` to build a differential baseline from — the run never
  started, so there is nothing to verdict.

Splitting `1` into a distinct `DOES_NOT_WORK`/`COULD_NOT_DETERMINE`/internal-failure code
(the `1`/`2`/`3` CLAUDE.md describes as frozen) is tracked as an open ROADMAP R2 item
(`docs/ROADMAP.md`, "Machine verdict: `--json` verdict document ... alongside the frozen
exit codes 0/1/2/3") — an integrator scripting against exit codes **today** should treat
non-zero as "not WORKS, see stdout/stderr for which state," not assume a 4-way split yet.

### `--json` (in progress, parallel slice)

`pb prove <dir> --json` emits one JSON document on stdout, schema `"pb-verdict-v1"`,
while the existing human-readable render moves to stderr (exit codes unchanged from the
table above):

```json
{
  "schema": "pb-verdict-v1",
  "recipe": "...",
  "verdict": "...",
  "exit_code": 0,
  "legs": {
    "merge":  { "sha": "...", "verdict": "...", "reason": "...", "case_file": "..." },
    "parent": { "sha": "...", "verdict": "...", "reason": "...", "case_file": "..." }
  },
  "differential": { "pass": true }
}
```

### The sealed case file (`src/evidence.mjs`)

Every executed leg that produces evidence seals it as an `EvidenceBundle` JSON document
(worked example:
[`site/cases/documenso-envelope-fields-pr3031.merge.json`](../site/cases/documenso-envelope-fields-pr3031.merge.json)):
`intent`, `actorIdentity`, `claims[]`, `receipts[]` (each provenance-stamped
`agent`/`tool`/`harness` — only `tool`/`harness` receipts can satisfy a claim), `reproduce`
(`{ k, n, kFail }`), and a `seal`:

```json
"seal": {
  "algorithm": "ed25519",
  "digest": "<sha256 hex of the canonical, key-sorted manifest: intent + claims + receipts + derived verdict>",
  "signature": "<base64 ed25519 signature over the digest>",
  "publicKey": "<base64 SPKI DER>"
}
```

`verifySeal` recomputes the manifest digest from the bundle's **current** contents and
verifies the signature; any post-seal mutation of intent/claims/receipts (or the verdict
they derive) flips verification to false — the harness reports this as `UNVERIFIED`, a
tampered bundle is never judged on its contents at all. This is tamper-**evident**, not
tamper-**resistant**: a box owner holding the private key can forge at rest, a disclosed
ceiling, not a hidden one.

## CI sketch (description only — the GitHub Action itself is a separate R2 deliverable)

A minimal PR-gate integration: run `pb prove <recipeDir>` (or, once shipped, `--json`)
on the PR's SHA as `code_identity.sha`/`parent_sha`; consume the process exit code for
pass/fail today (see the caveat above), or parse the `--json` document once it lands;
upload the sealed case file (`result.receiptPath` per leg) as a build artifact so a
reviewer can open it and self-verify offline; gate merge on the exit code / `verdict`
field via branch protection. pb never merges, approves, or deploys — it only produces
the verdict + evidence the pipeline's own gate consumes.
