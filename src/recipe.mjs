// @ts-check
/**
 * pb-recipe-v1 — the per-repo recipe contract + its zero-dependency loader/validator.
 *
 * A recipe generalizes `fixtures/*\/pb-fixture.json` into the honest, disclosed setup a
 * real corpus case needs: how to bind CODE-IDENTITY (build-from-tree@SHA or a pinned image
 * digest), how to CONJURE the SUT (env, ports, ready signal, disclosed overlays), how to
 * make a FRESH WORLD, the disclosed REST SETUP steps, the user-facing FRONT DOOR (a URL
 * template with a minted id), and the out-of-band STORE TAP (the harness-provenance
 * persisted-leg read, never an app endpoint — §1.1/§4). The walk itself stays
 * agent-proposed and is NOT recipe data (that avoids the Gherkin grave).
 *
 * loadRecipe mirrors phase3's readFixture load+validate stance, but LOUD: where a bad
 * fixture is a silent honest-CND (return null), a bad recipe is a fail-fast Error naming
 * the first missing/invalid field — a recipe must never silently half-load, because every
 * downstream milestone (conjure, tap, drive) trusts these fields verbatim.
 *
 * Node built-ins only (JSON.parse + hand validation) — pb's runtime deps stay at ZERO.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {Object} FromTreeIdentity
 * @property {'from_tree'} mode build the SUT from source at an exact SHA (highest code-identity)
 * @property {string} repo git remote to clone
 * @property {string} sha exact merge/commit SHA the SUT is built from
 * @property {string} [parent_sha] the disclosed differential baseline — the SHA the merge SHA was built ON (M6 builds this via conjure's buildSha override to prove parent!=WORKS)
 * @property {string} dockerfile path to the Dockerfile (relative to the checkout)
 * @property {string} context docker build context
 * @property {string[]} [build_overlay] disclosed build-time fixups (e.g. the corepack signature fix)
 * @property {string} [target] docker build `--target` stage (e.g. when a tree's default/last stage
 *   isn't the buildable one — a real linkding blocker: its last stage 404s on an upstream bug)
 * @property {string} [version_label] version this SHA self-reports (may differ from the release tag)
 */

/**
 * @typedef {Object} PinnedImageIdentity
 * @property {'pinned_image'} mode pin an already-built image by digest (digest-only identity)
 * @property {string} image_ref pullable image reference
 * @property {string} image_digest sha256 digest pinning the exact image
 * @property {string} [version_label] version the image self-reports
 */

/** @typedef {FromTreeIdentity | PinnedImageIdentity} CodeIdentity */

/**
 * @typedef {Object} ReadySignal
 * @property {string} path HTTP path polled for readiness
 * @property {number} expect_status status that means "ready"
 */

/**
 * How to CONJURE the SUT — two disclosed classes:
 *   - mode 'run' (default): a single container (n8n) — the runner `docker run`s one image.
 *   - mode 'compose': a multi-service graph (documenso = app + postgres + inbucket) — the
 *     runner brings the graph up with `docker compose -f <compose_file> [-f <overlay>…]`.
 * The base fields (env, ports, ready_signal) apply to both; compose adds compose_file
 * (required), compose_overlays, and service. (The compose bring-up runner is a later slice;
 * here the recipe only DECLARES the compose class.)
 * @typedef {Object} Conjure
 * @property {'run'|'compose'} [mode] conjure strategy; defaults to 'run' (single container)
 * @property {Record<string,string>} env inline container environment (a compose SUT usually lets the compose file own env → {})
 * @property {number} container_port port the SUT listens on inside the container
 * @property {number} published_port host port it is published on
 * @property {ReadySignal} ready_signal
 * @property {string[]} [setup_overlay] disclosed setup-time fixups (e.g. `apk add sqlite` for the tap)
 * @property {string} [compose_file] compose file path relative to the checkout — REQUIRED for mode 'compose' (e.g. docker/testing/compose.yml)
 * @property {string[]} [compose_overlays] recipe-local override file names layered over compose_file (e.g. a mem Dockerfile + compose override)
 * @property {string} [service] the app service name within the compose graph (mode 'compose')
 */

/**
 * @typedef {Object} FreshWorld
 * @property {'recreate'} strategy tears down/rebuilds the whole SUT per iteration (v1 default,
 *   docker-conjured recipes)
 */

/**
 * @typedef {Object} AuthPreflight
 * @property {string} method
 * @property {string} path a request made before setup to mint a bootstrap cookie (e.g. GET /rest/login)
 */

/**
 * @typedef {Object} SetupStep
 * @property {string} id
 * @property {string} [method] HTTP method — required unless `exec` is set
 * @property {string} [path] request path (may reference a prior capture, e.g. `/x/{workflow_id}`) — required unless `exec` is set
 * @property {any} [body] inline JSON body (mutually exclusive with body_file)
 * @property {string} [body_file] path (relative to recipeDir) to a JSON body file
 * @property {'json'|'form'|'multipart'} [content_type] how `body` is encoded on the wire; defaults
 *   to 'json'. 'form' sends `application/x-www-form-urlencoded` (URLSearchParams over the body
 *   object) — the shape a Django-style HTML form login expects. 'multipart' sends
 *   `multipart/form-data` (body's top-level fields as form fields + `files`, see below) — the
 *   shape a file-upload create endpoint expects (e.g. documenso's `POST /envelope/create`).
 * @property {Record<string,string>} [headers] extra request headers, placeholder-resolved
 *   the same way `path`/`body` are (e.g. `{"x-team-id":"{team_id}"}`)
 * @property {string} [origin] an absolute `http(s)://host:port` override for this ONE step,
 *   placeholder-resolved; absent defaults to the SUT's own `baseUrl` (a cross-service capture,
 *   e.g. an inbucket mailbox at a different published port on the same host)
 * @property {{field:string, path:string, content_type?:string}[]} [files] file parts to attach
 *   when `content_type` is 'multipart' — `path` is relative to recipeDir (a recipe-local asset,
 *   e.g. a blank PDF); `content_type` defaults to `application/octet-stream`
 * @property {Record<string,string|HtmlCapture>} [capture] name -> a JSONPath string read from the
 *   JSON response (default, unchanged), or an {@link HtmlCapture} regex read from the response HTML
 *   (e.g. Django's csrfmiddlewaretoken hidden input, or a token embedded in an inbucket-captured
 *   email body)
 * @property {ExecCapture} [exec] an out-of-band SETUP-TIME store read (mutually exclusive with
 *   method/path/body/content_type/headers/origin/files) — the disclosed fallback for a bootstrap
 *   value with NO REST route (e.g. a just-created team's id/url); NEVER the store_tap
 *   ground-truth read the verdict binds to. When present, `capture` (if any) maps a name to a
 *   zero-based COLUMN INDEX into the first returned row (not a JSONPath).
 */

/**
 * A setup-time, out-of-band store read used ONLY to resolve a bootstrap value with no REST route
 * (§6 fallback) — e.g. looking up a just-created team's numeric id/url slug. This is a disclosed
 * convenience for SETUP, never the store_tap ground-truth read the verdict binds to (that stays
 * `store_tap`, unconditionally). `query` is placeholder-resolved like a REST step's `path`.
 * @typedef {Object} ExecCapture
 * @property {'postgres'} engine
 * @property {string} container the DB container to `docker exec` into
 * @property {string} user postgres role
 * @property {string} db database name
 * @property {string} query a single read-only SQL statement (placeholder-resolved)
 */

/**
 * An alternative, HTML-regex capture source (the JSONPath string form stays the default).
 * @typedef {Object} HtmlCapture
 * @property {'html'} from
 * @property {string} pattern a regex (<=200 chars) with one capture group; group 1 is captured
 */

/**
 * @typedef {Object} FrontDoor
 * @property {'url'} [mode] front-door class; defaults to 'url' (a single minted-id URL) so
 *   every existing recipe keeps validating unchanged.
 * @property {string} url_template user-facing URL. A `{placeholder}` for a minted id is OPTIONAL —
 *   a template with none (e.g. a static creation form) is used verbatim.
 * @property {string} [serves] what the front door serves (documentation)
 */

/**
 * How catch.mjs reduces a named store-tap query's rows to the ONE comparable value a claim's
 * `entity` binds (§6 generic effect binding) — engine-shaped, replacing the n8n-only autoincrement
 * assumption: `row-count` (the number of rows returned — a listing query), `max-id` (the max of an
 * id-like field/column across rows — n8n's autoincrement shape), `named-scalar` (the sole value of
 * the first row's first field/column — a query that already aggregates in SQL, e.g. documenso's
 * `SELECT count(*) AS n …`). Keyed by the SAME name as `store_tap.queries`; absent for a given
 * query name falls back to an engine-honest default (sqlite: max-id over 'id'; postgres:
 * named-scalar over column 0) so an already-shipped recipe with no `observables` block loads and
 * binds exactly as it did before this field existed. See {@link resolveObservable}.
 * @typedef {Object} ObservableSpec
 * @property {string} [entity] the observable name an agent's claim binds (defaults to `<queryName>.<relation>`)
 * @property {'row-count'|'max-id'|'named-scalar'} [relation] engine-shaped reduction (default per-engine, see above)
 * @property {string} [field] sqlite row-object field read for 'max-id' (default 'id') or 'named-scalar' (default: the row's first key)
 * @property {number} [column] postgres tuple column index read for 'max-id' or 'named-scalar' (default 0)
 */

/**
 * The out-of-band STORE TAP, engine-discriminated — two disclosed classes:
 *   - sqlite (n8n): a store FILE inside the SUT container. Rollback-journal mode means a
 *     reader can collide with a writer, so busy_timeout_ms is REQUIRED and a transient
 *     "database is locked" is EXPECTED (retried, never a SUT failure).
 *   - postgres (documenso): a SEPARATE DB container tapped via `docker exec <container> psql`.
 *     Postgres MVCC/read-committed means readers never block on writers, so NO busy-timeout is
 *     needed (busy_timeout_ms is optional and unused for postgres).
 * @typedef {Object} SqliteStoreTap
 * @property {'sqlite'} engine
 * @property {string} db_path path to the store file inside the SUT container
 * @property {number} busy_timeout_ms busy-timeout for the out-of-band read (rollback-journal contention)
 * @property {Record<string,string>} queries name -> static read-only query (non-empty)
 * @property {Record<string,ObservableSpec>} [observables] per-query engine-shaped relation (§6); absent per-query defaults to max-id over 'id'
 * @property {boolean} [transient_lock_is_expected] a transient "database is locked" is expected, cleared by the timeout — never a SUT failure
 */

/**
 * @typedef {Object} PostgresStoreTap
 * @property {'postgres'} engine
 * @property {string} container the DB container the tap `docker exec`s into (a SEPARATE container from the app)
 * @property {string} user postgres role (docker exec over the local unix socket = trust auth, no password)
 * @property {string} db database name
 * @property {Record<string,string>} queries name -> static read-only query (non-empty); PascalCase identifiers MUST be double-quoted in the query string (Prisma does not remap them to snake_case)
 * @property {Record<string,ObservableSpec>} [observables] per-query engine-shaped relation (§6); absent per-query defaults to named-scalar over column 0
 * @property {number} [busy_timeout_ms] optional and unused for postgres — MVCC readers never block on writers
 * @property {boolean} [transient_lock_is_expected]
 * @property {SettleSpec} [settle] after the observable first moves, keep polling until it is
 *   UNCHANGED for `quiet_ms` (bounded by `max_ms`) before reading `after` — a debounced autosave
 *   (e.g. documenso's ~2s field-persist debounce) can otherwise be read mid-flight. Absent = read
 *   the instant the value first moves (unchanged prior behavior).
 */

/**
 * @typedef {Object} SettleSpec
 * @property {number} quiet_ms how long the observable must stop changing before it is read
 * @property {number} max_ms the overall bound on the settle wait (never polls forever)
 */

/** @typedef {SqliteStoreTap | PostgresStoreTap} StoreTap */

/**
 * How the driving agent DRIVES the front door to produce the store delta. 'deferred' means the
 * driver for this front door is not built, so the Catch honestly CNDs for this repo (never a
 * forced fit — e.g. a Konva <canvas> front door). Absent in a recipe defaults to 'deferred'.
 * @typedef {Object} Drive
 * @property {'http'|'browser'|'deferred'} mode
 * @property {string} [reason] why — especially for 'deferred'
 */

/**
 * A validated pb-recipe-v1 (see {@link loadRecipe}).
 * @typedef {Object} Recipe
 * @property {'pb-recipe-v1'} kind
 * @property {string} name
 * @property {string} [notes] human notes (e.g. how a front-door placeholder is minted)
 * @property {string} [intent] the behavioral claim the agent proposes a walk against — REQUIRED
 *   for a recipe whose discriminating behavior isn't "persists an execution" (runCatch's generic
 *   default, n8n-shaped); e.g. linkding #1170's default_mark_shared needs "...WITHOUT touching the
 *   shared checkbox" or a cold proposer has no signal against clicking it. Prose, not a DSL — the
 *   walk itself stays agent-proposed.
 * @property {CodeIdentity} code_identity
 * @property {Conjure} conjure
 * @property {FreshWorld} fresh_world
 * @property {AuthPreflight} [auth_preflight]
 * @property {SetupStep[]} setup disclosed REST setup steps — may be empty when the SUT self-bootstraps (e.g. documenso auto-runs its Prisma migrations at boot, so it needs no REST dance)
 * @property {SetupStep[]} [confirm] optional post-drive REST confirm steps — same step schema as
 *   `setup` (validated identically here; a later slice walks it). Absent defaults to empty.
 * @property {FrontDoor} front_door
 * @property {StoreTap} store_tap
 * @property {Drive} drive how the front door is driven (absent defaults to 'deferred', an honest CND)
 */

/**
 * Fail loudly, naming the offending field (the one "required field" error helper).
 * @param {string} field
 * @param {string} why
 * @returns {never}
 */
function bad(field, why) {
  throw new Error(`recipe: ${field} ${why}`);
}

/** @param {any} v @returns {boolean} */
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate an array of setup-shaped steps: id/method/path, body XOR body_file (resolved on
 * disk), optional content_type ('json' default | 'form'), and optional per-name capture — a
 * JSONPath string (default, unchanged) or an {from:'html', pattern} regex read from the response
 * HTML. Shared verbatim by `setup` and `confirm` (§6): the confirm array is the SAME step shape,
 * just walked by a later slice — this loader only validates it.
 * @param {any} steps
 * @param {string} field 'setup' or 'confirm'
 * @param {string} recipeDir
 */
function validateSteps(steps, field, recipeDir) {
  if (!Array.isArray(steps)) bad(field, 'must be an array of steps when present');
  steps.forEach((/** @type {any} */ step, /** @type {number} */ i) => {
    if (!isObject(step)) bad(`${field}[${i}]`, 'must be an object');
    if (typeof step.id !== 'string' || !step.id) bad(`${field}[${i}].id`, 'must be a non-empty string');

    if (step.exec !== undefined) {
      // An out-of-band SETUP-TIME store read (§6 fallback) — mutually exclusive with every
      // REST-step field; never the store_tap ground-truth read the verdict binds to.
      for (const f of ['method', 'path', 'body', 'body_file', 'content_type', 'headers', 'origin', 'files']) {
        if (step[f] !== undefined) bad(`${field}[${i}]`, `must not combine exec with ${f}`);
      }
      const ex = step.exec;
      if (!isObject(ex)) bad(`${field}[${i}].exec`, 'must be an object');
      if (ex.engine !== 'postgres') bad(`${field}[${i}].exec.engine`, `must be 'postgres' (got ${JSON.stringify(ex.engine)})`);
      for (const f of ['container', 'user', 'db', 'query']) {
        if (typeof ex[f] !== 'string' || !ex[f]) bad(`${field}[${i}].exec.${f}`, 'must be a non-empty string');
      }
      if (step.capture !== undefined) {
        if (!isObject(step.capture)) bad(`${field}[${i}].capture`, 'must be an object of name -> zero-based column index when exec is present');
        for (const [name, col] of Object.entries(step.capture)) {
          if (typeof col !== 'number' || !Number.isInteger(col) || col < 0) {
            bad(`${field}[${i}].capture.${name}`, 'must be a non-negative integer column index when exec is present');
          }
        }
      }
      return; // exec steps skip the REST-step validation below entirely
    }

    if (typeof step.method !== 'string' || !step.method) bad(`${field}[${i}].method`, 'must be a non-empty string');
    if (typeof step.path !== 'string' || !step.path) bad(`${field}[${i}].path`, 'must be a non-empty string');
    if (step.body !== undefined && step.body_file !== undefined) bad(`${field}[${i}]`, 'must not set both body and body_file');
    if (step.body_file !== undefined) {
      if (typeof step.body_file !== 'string' || !step.body_file) bad(`${field}[${i}].body_file`, 'must be a non-empty string');
      if (!existsSync(join(recipeDir, step.body_file))) bad(`${field}[${i}].body_file`, `references a missing file: ${step.body_file}`);
    }
    if (step.content_type !== undefined && !['json', 'form', 'multipart'].includes(step.content_type)) {
      bad(`${field}[${i}].content_type`, `must be 'json', 'form', or 'multipart' when present (got ${JSON.stringify(step.content_type)})`);
    }
    if (step.headers !== undefined) {
      if (!isObject(step.headers)) bad(`${field}[${i}].headers`, 'must be an object of header name -> string value when present');
      for (const [hk, hv] of Object.entries(step.headers)) {
        if (typeof hv !== 'string') bad(`${field}[${i}].headers.${hk}`, 'must be a string value');
      }
    }
    if (step.origin !== undefined && (typeof step.origin !== 'string' || !/^https?:\/\//i.test(step.origin))) {
      bad(`${field}[${i}].origin`, 'must be an absolute http(s) origin string when present');
    }
    if (step.files !== undefined) {
      if (step.content_type !== 'multipart') bad(`${field}[${i}].content_type`, "must be 'multipart' when files is present");
      if (!Array.isArray(step.files) || step.files.length === 0) bad(`${field}[${i}].files`, 'must be a non-empty array of {field,path[,content_type]} when present');
      step.files.forEach((/** @type {any} */ f, /** @type {number} */ fi) => {
        if (!isObject(f)) bad(`${field}[${i}].files[${fi}]`, 'must be an object');
        if (typeof f.field !== 'string' || !f.field) bad(`${field}[${i}].files[${fi}].field`, 'must be a non-empty string');
        if (typeof f.path !== 'string' || !f.path) bad(`${field}[${i}].files[${fi}].path`, 'must be a non-empty string');
        if (!existsSync(join(recipeDir, f.path))) bad(`${field}[${i}].files[${fi}].path`, `references a missing file: ${f.path}`);
        if (f.content_type !== undefined && (typeof f.content_type !== 'string' || !f.content_type)) {
          bad(`${field}[${i}].files[${fi}].content_type`, 'must be a non-empty string when present');
        }
      });
    }
    if (step.capture !== undefined) {
      if (!isObject(step.capture)) bad(`${field}[${i}].capture`, 'must be an object of name -> JSONPath string (default) or {from:"html",pattern}');
      for (const [name, cap] of Object.entries(step.capture)) {
        if (typeof cap === 'string') continue; // JSONPath — the existing, default form (unchanged)
        if (!isObject(cap)) bad(`${field}[${i}].capture.${name}`, 'must be a JSONPath string or an {from:"html",pattern} object');
        if (cap.from !== 'html') bad(`${field}[${i}].capture.${name}.from`, `must be 'html' when capture is an object (got ${JSON.stringify(cap.from)})`);
        if (typeof cap.pattern !== 'string' || !cap.pattern) bad(`${field}[${i}].capture.${name}.pattern`, "is required for from:'html'");
        if (cap.pattern.length > 200) bad(`${field}[${i}].capture.${name}.pattern`, `must be <= 200 chars (got ${cap.pattern.length})`);
        try {
          new RegExp(cap.pattern);
        } catch (e) {
          bad(`${field}[${i}].capture.${name}.pattern`, `must compile as a RegExp: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  });
}

const OBSERVABLE_RELATIONS = ['row-count', 'max-id', 'named-scalar'];

/**
 * Validate `store_tap.observables` (sqlite | postgres): each key must name a declared query, each
 * spec an object with an optional entity/relation/field/column of the right shape.
 * @param {any} observables
 * @param {string[]} queryNames
 */
function validateObservables(observables, queryNames) {
  if (!isObject(observables)) bad('store_tap.observables', 'must be an object of query name -> observable spec when present');
  for (const [qn, spec] of Object.entries(observables)) {
    if (!queryNames.includes(qn)) bad(`store_tap.observables.${qn}`, `does not match any store_tap.queries name (${queryNames.join(', ')})`);
    if (!isObject(spec)) bad(`store_tap.observables.${qn}`, 'must be an object');
    if (spec.entity !== undefined && (typeof spec.entity !== 'string' || !spec.entity)) bad(`store_tap.observables.${qn}.entity`, 'must be a non-empty string when present');
    if (spec.relation !== undefined && !OBSERVABLE_RELATIONS.includes(spec.relation)) {
      bad(`store_tap.observables.${qn}.relation`, `must be one of ${OBSERVABLE_RELATIONS.join('|')} when present (got ${JSON.stringify(spec.relation)})`);
    }
    if (spec.field !== undefined && (typeof spec.field !== 'string' || !spec.field)) bad(`store_tap.observables.${qn}.field`, 'must be a non-empty string when present');
    if (spec.column !== undefined && typeof spec.column !== 'number') bad(`store_tap.observables.${qn}.column`, 'must be a number when present');
  }
}

/**
 * Resolve the OBSERVABLE spec for a named store-tap query (§6) — the recipe-declared override (if
 * any, `store_tap.observables[queryName]`) merged over an engine-honest default: sqlite defaults to
 * 'max-id' over the row's 'id' field (n8n's autoincrement shape); postgres defaults to
 * 'named-scalar' over the first row's first column (documenso's `SELECT count(*) AS n` shape). An
 * already-shipped recipe with no `observables` block resolves to exactly its prior hardcoded
 * behavior. PURE — no I/O.
 * @param {StoreTap} storeTap
 * @param {string} queryName
 * @returns {{entity:string, relation:'row-count'|'max-id'|'named-scalar', field?:string, column?:number}}
 */
export function resolveObservable(storeTap, queryName) {
  const override = /** @type {any} */ (storeTap).observables && /** @type {any} */ (storeTap).observables[queryName];
  const relation = (override && override.relation) || DEFAULT_RELATION[storeTap.engine] || 'max-id';
  const entity = (override && override.entity) || `${queryName}.${relation}`;
  return { entity, relation, field: override && override.field, column: override && override.column };
}

/**
 * Per-engine default relation when a query has no `observables` override (§6): sqlite defaults to
 * 'max-id' over 'id' (n8n's autoincrement shape); postgres to 'named-scalar' over column 0
 * (documenso's `SELECT count(*) AS n` shape).
 * @type {Record<string,'row-count'|'max-id'|'named-scalar'>}
 */
const DEFAULT_RELATION = { postgres: 'named-scalar' };

/**
 * Load and validate `<recipeDir>/recipe.json` as a pb-recipe-v1. Throws an Error naming
 * the first missing/invalid field; never returns a half-validated recipe.
 * @param {string} recipeDir directory containing recipe.json and any body files
 * @returns {Recipe}
 */
export function loadRecipe(recipeDir) {
  const file = join(recipeDir, 'recipe.json');
  if (!existsSync(file)) bad('recipe.json', `not found in ${recipeDir}`);
  let r;
  try {
    r = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    bad('recipe.json', `is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(r)) bad('recipe', 'must be a JSON object');

  // Identity
  if (r.kind !== 'pb-recipe-v1') bad('kind', `must be 'pb-recipe-v1' (got ${JSON.stringify(r.kind)})`);
  if (typeof r.name !== 'string' || !r.name.trim()) bad('name', 'must be a non-empty string');
  if (r.intent !== undefined && (typeof r.intent !== 'string' || !r.intent.trim())) bad('intent', 'must be a non-empty string when present');

  // code_identity — discriminated union on `mode`
  const ci = r.code_identity;
  if (!isObject(ci)) bad('code_identity', 'must be an object');
  if (ci.mode === 'from_tree') {
    for (const f of ['repo', 'sha', 'dockerfile', 'context']) {
      if (typeof ci[f] !== 'string' || !ci[f]) bad(`code_identity.${f}`, "is required for mode 'from_tree'");
    }
    if (ci.parent_sha !== undefined && (typeof ci.parent_sha !== 'string' || !ci.parent_sha)) bad('code_identity.parent_sha', 'must be a non-empty string when present (the differential baseline SHA)');
    if (ci.build_overlay !== undefined && !isStringArray(ci.build_overlay)) bad('code_identity.build_overlay', 'must be a string[]');
    if (ci.target !== undefined && (typeof ci.target !== 'string' || !ci.target)) bad('code_identity.target', 'must be a non-empty string when present (the docker build --target stage)');
  } else if (ci.mode === 'pinned_image') {
    for (const f of ['image_ref', 'image_digest']) {
      if (typeof ci[f] !== 'string' || !ci[f]) bad(`code_identity.${f}`, "is required for mode 'pinned_image'");
    }
  } else {
    bad('code_identity.mode', `must be 'from_tree' or 'pinned_image' (got ${JSON.stringify(ci.mode)})`);
  }

  // conjure
  const c = r.conjure;
  if (!isObject(c)) bad('conjure', 'must be an object');
  if (c.setup_overlay !== undefined && !isStringArray(c.setup_overlay)) bad('conjure.setup_overlay', 'must be a string[]');

  // conjure.mode — 'run' (default, single container) | 'compose' (multi-service graph). Default a
  // missing mode to 'run' so a single-container recipe (n8n) stays valid without a mode field.
  if (c.mode === undefined) c.mode = 'run';
  else if (!['run', 'compose'].includes(c.mode)) bad('conjure.mode', `must be 'run' or 'compose' (got ${JSON.stringify(c.mode)})`);

  if (!isObject(c.env)) bad('conjure.env', 'must be an object');
  if (typeof c.container_port !== 'number') bad('conjure.container_port', 'must be a number');
  if (typeof c.published_port !== 'number') bad('conjure.published_port', 'must be a number');
  if (!isObject(c.ready_signal)) bad('conjure.ready_signal', 'must be an object');
  if (typeof c.ready_signal.path !== 'string' || !c.ready_signal.path) bad('conjure.ready_signal.path', 'must be a non-empty string');
  if (typeof c.ready_signal.expect_status !== 'number') bad('conjure.ready_signal.expect_status', 'must be a number');
  if (c.mode === 'compose') {
    if (typeof c.compose_file !== 'string' || !c.compose_file) bad('conjure.compose_file', "is required for mode 'compose'");
    if (c.compose_overlays !== undefined && !isStringArray(c.compose_overlays)) bad('conjure.compose_overlays', 'must be a string[]');
    if (c.service !== undefined && (typeof c.service !== 'string' || !c.service)) bad('conjure.service', 'must be a non-empty string when present');
  }

  // fresh_world — 'recreate' (v1 default): tears down/rebuilds the whole SUT per iteration.
  const fw = r.fresh_world;
  if (!isObject(fw)) bad('fresh_world', 'must be an object');
  if (!['recreate'].includes(fw.strategy)) {
    bad('fresh_world.strategy', `must be 'recreate' (got ${JSON.stringify(fw.strategy)})`);
  }

  // auth_preflight (optional)
  if (r.auth_preflight !== undefined) {
    const ap = r.auth_preflight;
    if (!isObject(ap)) bad('auth_preflight', 'must be an object when present');
    if (typeof ap.method !== 'string' || !ap.method) bad('auth_preflight.method', 'must be a non-empty string');
    if (typeof ap.path !== 'string' || !ap.path) bad('auth_preflight.path', 'must be a non-empty string');
  }

  // setup — optional disclosed REST steps (array form). Absent/empty is valid: some SUTs
  // self-bootstrap (documenso auto-runs its Prisma migrations at container boot; there is no REST
  // setup dance to model, and inventing one would be a forced fit).
  if (r.setup === undefined) {
    r.setup = [];
  } else if (Array.isArray(r.setup)) {
    validateSteps(r.setup, 'setup', recipeDir);
  } else {
    bad('setup', 'must be an array of steps when present');
  }

  // confirm — optional post-drive REST steps (§6), validated with EXACTLY the setup step schema
  // (same id/method/path/body/content_type/capture rules). Absent defaults to empty, like setup;
  // no executor here — a later slice walks it.
  if (r.confirm === undefined) r.confirm = [];
  else validateSteps(r.confirm, 'confirm', recipeDir);

  // front_door — mode 'url' (default) is a user-facing URL; a `{placeholder}` for a minted id is
  // OPTIONAL (§5): a template with none (e.g. a static creation form) is used verbatim — no forced
  // schema theater.
  const fd = r.front_door;
  if (!isObject(fd)) bad('front_door', 'must be an object');
  if (fd.mode === undefined) fd.mode = 'url';
  else if (fd.mode !== 'url') bad('front_door.mode', `must be 'url' (got ${JSON.stringify(fd.mode)})`);
  if (typeof fd.url_template !== 'string' || !fd.url_template) bad('front_door.url_template', 'is required');

  // store_tap — the out-of-band persisted-leg read; engine-discriminated (sqlite | postgres).
  const st = r.store_tap;
  if (!isObject(st)) bad('store_tap', 'must be an object');
  if (!isObject(st.queries) || Object.keys(st.queries).length === 0) bad('store_tap.queries', 'must be a non-empty object of named queries');
  if (st.transient_lock_is_expected !== undefined && typeof st.transient_lock_is_expected !== 'boolean') bad('store_tap.transient_lock_is_expected', 'must be a boolean');
  if (st.settle !== undefined) {
    if (!isObject(st.settle)) bad('store_tap.settle', 'must be an object when present');
    if (typeof st.settle.quiet_ms !== 'number') bad('store_tap.settle.quiet_ms', 'must be a number');
    if (typeof st.settle.max_ms !== 'number') bad('store_tap.settle.max_ms', 'must be a number');
  }
  if (st.engine === 'sqlite') {
    if (typeof st.db_path !== 'string' || !st.db_path) bad('store_tap.db_path', "is required for engine 'sqlite'");
    if (typeof st.busy_timeout_ms !== 'number') bad('store_tap.busy_timeout_ms', "is required (a number) for engine 'sqlite' (the rollback-journal busy-timeout)");
    if (st.observables !== undefined) validateObservables(st.observables, Object.keys(st.queries));
  } else if (st.engine === 'postgres') {
    for (const f of ['container', 'user', 'db']) {
      if (typeof st[f] !== 'string' || !st[f]) bad(`store_tap.${f}`, "is required for engine 'postgres'");
    }
    if (st.busy_timeout_ms !== undefined && typeof st.busy_timeout_ms !== 'number') bad('store_tap.busy_timeout_ms', 'must be a number when present (optional for postgres — MVCC needs no busy-timeout)');
    if (st.observables !== undefined) validateObservables(st.observables, Object.keys(st.queries));
  } else {
    bad('store_tap.engine', `must be 'sqlite' or 'postgres' (got ${JSON.stringify(st.engine)})`);
  }

  // drive — how the front door is driven; absent defaults to an honest 'deferred' (drive not built → CND).
  if (r.drive === undefined) {
    r.drive = { mode: 'deferred', reason: 'no drive declared for this recipe (honest CND)' };
  } else {
    const dr = r.drive;
    if (!isObject(dr)) bad('drive', 'must be an object when present');
    if (!['http', 'browser', 'deferred'].includes(dr.mode)) {
      bad('drive.mode', `must be one of 'http'|'browser'|'deferred' (got ${JSON.stringify(dr.mode)})`);
    }
    if (dr.reason !== undefined && (typeof dr.reason !== 'string' || !dr.reason)) bad('drive.reason', 'must be a non-empty string when present');
  }

  return /** @type {Recipe} */ (r);
}
