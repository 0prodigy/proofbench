# Getting started with Proofbench

A recipe-authoring guide for a stranger with a compose-runnable repo. Following it end to
end — writing a `recipe.json`, running `pb prove` — gets you a real sealed verdict in
under an hour. This is G1's bar (`docs/ROADMAP.md`); this doc is the path.

For what pb is and why the tri-state verdict is trustworthy, see [README.md](../README.md).
For the integration contract (recipe field reference, substrate selectors, exit codes,
`--json`), see [docs/integration.md](integration.md). For the full phase contract (an
internal engineering doc, not user-facing), see
[docs/internal/phase-contracts.md](internal/phase-contracts.md). This doc only teaches
the recipe surface and the CLI you run against it.

## Prerequisites

- **Node 20+** (pb has zero runtime dependencies — no `npm install` needed to run `pb`
  itself; `node --test` and `tsc` are devDependencies for working on pb's own source).
- **Docker**, running and reachable from your shell. pb shells out to `docker build`,
  `docker run` / `docker compose`, and `docker exec` to conjure the SUT, tap its store
  out-of-band, and (for a browser-driven front door) run a pinned Chromium sidecar
  container. No Kubernetes, no cloud account — everything runs in local containers.
- **git** — a `from_tree` recipe (the only code-identity mode either shipped recipe uses)
  clones the target repo at an exact SHA; `git` must be on `PATH`.
- **An agent to propose the walk** — either:
  - the `claude` CLI, authenticated via `claude setup-token` (subscription OAuth, no API
    key needed), **or**
  - `ANTHROPIC_API_KEY` set in your environment (the direct Anthropic Messages API path).

  pb picks automatically (`src/cli.mjs`'s `selectLlmFn`): `PB_PROPOSER=claude-cli` (the
  default when `ANTHROPIC_API_KEY` is unset) shells out to the local `claude` CLI;
  otherwise (or with `PB_PROPOSER=api` / `ANTHROPIC_API_KEY` set) it calls the API
  directly. Either way this is the only place an agent's judgment enters a run — it
  proposes the walk and the claim; it never writes the verdict (`src/proposer.mjs`).

## Install

```
npx proofbench gate
```

`pb gate` runs the E1 malicious-driver honesty gate — a deterministic, docker-free,
network-free suite that proves the verdict logic can't be talked into a false WORKS. It
takes seconds and needs none of the prerequisites above except Node. Treat a `PASS` here
as your install smoke test before you touch Docker or an agent at all.

`package.json`'s name is already `proofbench` with a `pb` bin and no `private` flag, but
the npm publish itself is a still-open ROADMAP item (`docs/ROADMAP.md`'s R1
"Distribution"). Until that lands, run the same smoke test from a clone:

```
git clone -b product-v1 https://github.com/0prodigy/proofbench.git && cd proofbench
node src/cli.mjs gate
```

(The repo's default branch is still `main`, which predates this rewrite and is
historical only — clone `product-v1` explicitly, as above, until publish lands.)

Everything past `gate` (`conjure`, `prove`) needs Docker and an agent, per the
Prerequisites above. Every `pb <command>` below is `node src/cli.mjs <command>` run from
the repo root (or the installed `pb` bin, once published) — interchangeable.

## The pb-recipe-v1 surface

A recipe is `<recipeDir>/recipe.json`, loaded and validated by `src/recipe.mjs`
(`loadRecipe`) — it throws immediately, naming the first bad field, rather than
half-loading. Nothing below is invented; every field is taught by walking the two
shipped recipes against the loader's own JSDoc types.

- `recipes/n8n-respondwebhook-formtrigger-pr9157/` — single-container (`conjure.mode:
  'run'`), sqlite store tap, a plain (non-auth) form front door.
- `recipes/linkding-default-mark-shared-pr1170/` — single-container Django app, sqlite
  store tap, session-auth + CSRF form login before the front door, and a recipe-declared
  `confirm` leg.

Both are **differential** recipes: `code_identity` carries a `parent_sha` so `pb prove`
can run the same walk at the merge SHA and its parent and check that the PR itself is why
it works.

### `code_identity` — what SHA/image the verdict is bound to (invariant 5)

```json
"code_identity": {
  "mode": "from_tree",
  "repo": "https://github.com/sissbruecker/linkding.git",
  "sha": "6c874afff230ee16b1939b3d4e1fa370a4203f44",
  "parent_sha": "723b843c1360f29bb5908a4a501af756e736f843",
  "dockerfile": "docker/default.Dockerfile",
  "context": ".",
  "target": "linkding",
  "version_label": "1.42.0"
}
```

- `mode: "from_tree"` — clone `repo` at `sha`, build `dockerfile` in `context`. This is
  the mode all four shipped recipes use, and the only mode `pb prove`'s differential
  accepts (it needs a disclosed `parent_sha` to build the baseline).
- `parent_sha` — the differential baseline. `pb prove` builds and drives **both** SHAs
  with the identical proposed walk; the PR is only proven the cause if merge=WORKS and
  parent≠WORKS.
- `target` — a docker `--target` build stage, when the tree's default/last stage isn't
  the runnable one (linkding's own last stage 404s on an upstream bug; the R1 proof case
  hit this for real — see `docs/ROADMAP.md`'s R1 section).
- `build_overlay` (n8n's recipe) — disclosed, committed build-time fixups (n8n's Docker
  base image ships a corepack whose pnpm resolution breaks under Node 18); never a silent
  patch — every overlay line is in the recipe file you can read.
- The other identity mode, `pinned_image` (`image_ref` + `image_digest`), pins an
  already-built image by digest instead of building from source — neither shipped recipe
  uses it; see the JSDoc in `src/recipe.mjs` if you need it.

### `conjure` — bringing the SUT up

```json
"conjure": {
  "env": { "LD_SUPERUSER_NAME": "pb-admin", "...": "..." },
  "container_port": 9090,
  "published_port": 9096,
  "ready_signal": { "path": "/health", "expect_status": 200 },
  "setup_overlay": ["apt-get update && apt-get install -y sqlite3"]
}
```

- `env` — inline container environment (linkding's bootstrap superuser credentials, n8n's
  sqlite/insecure-cookie flags for a fresh container).
- `container_port` / `published_port` — where the SUT listens vs. where pb publishes it
  on the host.
- `ready_signal` — the path/status pb polls before touching the SUT at all.
- `setup_overlay` — disclosed fixups needed for the out-of-band tap to work (e.g.
  installing a `sqlite3` client inside the container so the store tap can query it).
- `mode: "compose"` (not used by either worked example; documenso's recipe is the shipped
  one that uses it) brings up a multi-service graph via `compose_file` +
  `compose_overlays` + `service` instead of a single `docker run`.

### `fresh_world`

```json
"fresh_world": { "strategy": "recreate" }
```

The only value v1 supports. Every Catch iteration (k≥2 for a WORKS/DOES_NOT_WORK
conviction) tears down and recreates the SUT — no state bleeds between iterations.

### `auth_preflight` / `setup` — disclosed REST steps before the drive

n8n's recipe mints an owner and a workflow via three plain JSON `setup` steps
(`owner` → `workflow`, capturing `workflow_id` — → `activate`). linkding's recipe needs a
real Django session: `auth_preflight` isn't used here, but `setup` walks
`login_page` (GET, HTML-regex-capture the CSRF token) → `login` (POST, `content_type:
"form"`, the captured token) → `profile_page` (re-GET for a post-login token, since
Django rotates it) → `profile` (POST, sets `default_mark_shared`). Two step fields do the
work a plain JSON setup can't:

- `content_type: "form"` — sends the body `application/x-www-form-urlencoded` instead of
  JSON, the shape an HTML form POST (Django, and most server-rendered login forms) needs.
- `capture` — either a JSONPath string (`"$.data.id"`, the n8n default) read from a JSON
  response, or `{ "from": "html", "pattern": "<regex>" }` read from the response HTML
  (linkding's `csrfmiddlewaretoken` hidden input) — captured values are then referenced
  as `{name}` in later steps' `path`/`body`.

Setup cookies (e.g. the Django session cookie minted by `login`) are exposed on the SUT
handle and injected into the browser sidecar before the front door is driven — this is
what makes a login-gated front door reachable at all.

### `front_door`

```json
"front_door": {
  "url_template": "/bookmarks/new",
  "serves": "the authenticated 'Add bookmark' form..."
}
```

The user-facing URL the drive navigates to. A `{placeholder}` for a setup-minted id is
**optional** — n8n's `/webhook/{webhook_id}/n8n-form` needs one (the webhook UUID minted
during `setup`); linkding's `/bookmarks/new` is a static creation form and needs none.

### `store_tap` — the out-of-band, harness-provenance read (invariant 3, 6)

```json
"store_tap": {
  "engine": "sqlite",
  "db_path": "/etc/linkding/data/db.sqlite3",
  "busy_timeout_ms": 3000,
  "queries": { "bookmarks": "SELECT id, shared FROM bookmarks_bookmark ORDER BY id DESC;" },
  "observables": {
    "bookmarks": { "entity": "bookmarks_bookmark.newest_shared", "relation": "named-scalar", "field": "shared" }
  }
}
```

This is never an app endpoint — it's a direct read of the SUT's own datastore, run by the
harness, never the agent. Two engines ship: `sqlite` (a store **file** inside the
container — `busy_timeout_ms` is required because rollback-journal mode means a reader
can collide with a writer) and `postgres` (a **separate** DB container, `docker exec …
psql` — no busy-timeout needed, MVCC readers never block on writers). `src/recipe.mjs`
rejects any other `store_tap.engine` value naming the field — a store tap must stay
store-direct, never an app call. A cluster-attach class (`k8s-exec`) was designed and
partly built, then excised (commit `b807169`) as an unwired substrate ahead of its live
verdict (CLAUDE.md pattern 1); it resurrects at R3 on the same terms invariant 7 requires
— see [docs/integration.md](integration.md)'s adapter-contract section.

`observables` is how a named query's rows reduce to the one comparable value a claim's
`entity` binds — engine-shaped, not hardcoded to n8n's autoincrement assumption:
`row-count` (how many rows), `max-id` (the max of an id-like field — n8n's shape,
sqlite's default), `named-scalar` (the sole value of one field — a query that already
aggregates in SQL, or, as here, linkding's newest row's `shared` column). Omit
`observables` entirely and a query still resolves to an engine-honest default
(`resolveObservable` in `src/recipe.mjs`): sqlite → max-id over `id`; postgres →
named-scalar over column 0.

### `confirm` — a recipe-declared, fresh-session re-observation

```json
"confirm": [
  { "id": "login_page", "method": "GET", "path": "/login/", "capture": { "csrf_token": {"from":"html","pattern":"..."} } },
  { "id": "login", "method": "POST", "path": "/login/", "content_type": "form", "body_file": "login.json" },
  { "id": "read", "method": "GET", "path": "/api/bookmarks/", "capture": { "observed": "$.results.0.shared" } }
]
```

Optional, same step schema as `setup`. After the drive, the harness re-authenticates
fresh and re-observes the effect through the SUT's own read surface (here, linkding's
DRF API) — a second, independent confirmation that the store-tap delta wasn't a fluke,
using the recipe's own auth/setup surface. Absent defaults to empty (n8n's recipe uses
`confirm` for the same purpose: re-login, then `GET /rest/executions/{value}`).

### `drive`

```json
"drive": { "mode": "browser", "reason": "..." }
```

How the front door gets driven: `http` (raw HTTP), `browser` (a real click/type/click
walk through the pinned Chromium sidecar — what three of the four shipped recipes use),
or `deferred`
(no driver built for this front door — an honest CND, never a forced fit; a recipe with
no `drive` field defaults here). These are the only three values `src/recipe.mjs`
accepts; a Lyric/k8s drive class (R3, not reachable today) was excised at `b807169` and
resurrects only on invariant 7's terms — see [docs/integration.md](integration.md).

### `intent` — only when the discriminating behavior isn't "persists a row"

`runCatch`'s generic default claim is "the walk persists an execution" (n8n's shape — no
`intent` needed). linkding's PR is subtler: the discriminator is a checkbox the walk must
**not** touch, so its recipe carries an explicit `intent` sentence telling the proposing
agent exactly what to avoid inverting. Prose, not a DSL — the walk itself is still
agent-proposed, never recipe data (invariant 4).

## Running it

```
pb prove recipes/linkding-default-mark-shared-pr1170
```

This is the differential Catch (`src/catch.mjs`'s `runCatch`, driven twice by
`src/cli.mjs`'s `prove` command): the agent proposes ONE walk+claim at the merge SHA
(`propose-once-freeze`), the harness builds and drives the merge SHA, then replays the
**identical** frozen walk at `parent_sha` — so only the built SHA differs between legs.
Each leg prints its own verdict and, when produced, the path to its sealed receipt file
(`result.receiptPath` — a JSON `EvidenceBundle`, ed25519-sealed by `src/evidence.mjs`;
any post-seal mutation makes it UNVERIFIED, never silently trusted).

```
pb conjure recipes/n8n-respondwebhook-formtrigger-pr9157 --keep
```

Brings up just the SUT (clone → build → run/compose → wait for `ready_signal`) and mints
its code-identity fingerprint, without running a Catch — useful for checking a new
recipe's `conjure`/`front_door` fields before you invest in `store_tap`/`drive`. `--keep`
leaves the container up for you to poke at (tear down with the `docker rm -f` command it
prints).

`--random` (on both `prove` and `conjure`) picks a recipe from the whole `recipes/` pool
instead of one you name — the anti-overfit check that pb doesn't only ever exercise one
stack.

## What a verdict means

Three states only (`src/verdict.mjs`, frozen — see `CLAUDE.md`'s eight invariants):

- **WORKS** — ≥1 confirmed effect claim, every declared claim confirmed (or justified
  N/A), reproduced from a fresh world k≥2 times. A single walk is never WORKS.
- **DOES_NOT_WORK** — a claim was falsified **and the failure reproduced** (kFail≥2 from
  fresh, identical worlds) — a one-off failure is "observed once, could not reproduce,"
  never a conviction.
- **COULD_NOT_DETERMINE** — the honest default. Nothing falsified but something wasn't
  executed/confirmed, or a failure didn't reproduce enough to convict. `false-WORKS = 0`
  is the release-blocking invariant: the agent's own unreliability can only ever cost you
  a WORKS (degrade it to CND) — it can never manufacture a false WORKS.

`pb prove` combines two such per-leg verdicts into one **differential** result, printed
after both legs: `DIFFERENTIAL: PASS` iff `merge = WORKS` **and** `parent ≠ WORKS` — the
anti-tautology that proves the PR itself, not just the repo in general, is why it works.
`pb prove` exits `0` only on that PASS; it exits `1` on FAIL (merge didn't reach WORKS, or
the parent worked too and the target didn't actually discriminate — reported as a real
finding, not silently retried) and `2` on a usage problem (missing `<recipeDir>`, or a
recipe with no `parent_sha` to build a baseline from — the differential literally cannot
be attempted). `pb gate` exits `0` pass / `1` fail (a deterministic gate, not a verdict).
`pb phase1`/`pb phase2`/`pb phase3` exit CLAUDE.md's frozen four-way contract on their own
verdict state: `0` WORKS / `1` DOES_NOT_WORK / `2` COULD_NOT_DETERMINE / `3` anything else
(internal). `pb conjure` exits `0` on a successful bring-up and `2` on an honest CND
(could not conjure — a bring-up/setup failure, never evidence against the change).

The four committed, sealed differential Catches — n8n #9157 (merge WORKS ∧ parent DOES
NOT WORK — the first live regression catch), linkding #1170 (merge WORKS ∧ parent DOES
NOT WORK, a second stack), n8n #7130 (merge WORKS ∧ parent CND, the earned green), and
documenso #3031 (merge WORKS ∧ parent DOES NOT WORK, the second engine — a real Konva
canvas browser drive over Postgres) — are the receipts under `site/cases/*.json`; the
interactive rendering of the #7130 case is `site/case.html`. See the
[README](../README.md) and [docs/ROADMAP.md](ROADMAP.md) for what those verdicts
actually assert.

## Honest CND — what declines today, and how it names its unblock

pb's stated bar (`docs/ROADMAP.md`'s adoption metrics) is that every CND names the ONE
action that unblocks it — a CND with no named unblock is a bug with false-WORKS
severity. What's built today is one flow shape: a single- or multi-container,
Dockerfile-buildable, docker-compose-runnable web repo with a datastore pb can tap
out-of-band (sqlite file, or a separate postgres container) and a front door pb can
drive over HTTP or a real browser. Outside that shape, today's honest answers are:

- **No Dockerfile / not container-buildable** — `code_identity.mode: "from_tree"`
  requires a `dockerfile` + `context` pb can `docker build`; a repo needing a pre-build
  compile step has no recipe path yet (`docs/ROADMAP.md`'s issue register: "no-Dockerfile
  repos need a pre-build compile hook, undesigned"). Unblock: add a Dockerfile, or wait
  for that hook.
- **Kubernetes / a live cluster** — Docker (`run`/`compose`) is the one shipped
  substrate; the Lyric/k8s attach path (a k8s-exec tap, an argo-workflows drive,
  k8s-attach conjure) was designed, partly built, then excised at `b807169` as unwired
  surface ahead of its live verdict. It resurrects at R3 on invariant 7's terms — see
  `DEFERRED.md`'s resurrect-refs and [docs/integration.md](integration.md). Unblock: none
  yet — this is scheduled work, not a workaround.
- **Serverless / fully-managed backends** — no recipe conjures a managed service pb
  doesn't control the container for. Declared honest CND with no code planned until a
  real paying case demands it.
- **Mobile / native front doors** — the drive vocabulary is browser (DOM find/type/click)
  or HTTP; there is no native-app driver. Declared honest CND, same as serverless.

None of these silently degrade to a guessed WORKS — a recipe your repo can't satisfy
either fails `loadRecipe`'s validation naming the missing field, or fails conjure/drive
with a CND-shaped message naming what blocked it (never evidence against your change).
