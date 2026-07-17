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
 * @property {string} dockerfile path to the Dockerfile (relative to the checkout)
 * @property {string} context docker build context
 * @property {string[]} [build_overlay] disclosed build-time fixups (e.g. the corepack signature fix)
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
 * @typedef {Object} Conjure
 * @property {Record<string,string>} env container environment
 * @property {number} container_port port the SUT listens on inside the container
 * @property {number} published_port host port it is published on
 * @property {ReadySignal} ready_signal
 * @property {string[]} [setup_overlay] disclosed setup-time fixups (e.g. `apk add sqlite` for the tap)
 */

/**
 * @typedef {Object} FreshWorld
 * @property {'recreate'} strategy only 'recreate' is valid for v1
 */

/**
 * @typedef {Object} AuthPreflight
 * @property {string} method
 * @property {string} path a request made before setup to mint a bootstrap cookie (e.g. GET /rest/login)
 */

/**
 * @typedef {Object} SetupStep
 * @property {string} id
 * @property {string} method HTTP method
 * @property {string} path request path (may reference a prior capture, e.g. `/x/{workflow_id}`)
 * @property {any} [body] inline JSON body (mutually exclusive with body_file)
 * @property {string} [body_file] path (relative to recipeDir) to a JSON body file
 * @property {Record<string,string>} [capture] name -> JSONPath extracted from the response
 */

/**
 * @typedef {Object} FrontDoor
 * @property {string} url_template user-facing URL with a `{placeholder}` for a minted id
 * @property {string} [serves] what the front door serves (documentation)
 */

/**
 * @typedef {Object} StoreTap
 * @property {string} engine store engine (e.g. sqlite)
 * @property {string} db_path path to the store file inside the container
 * @property {number} busy_timeout_ms busy-timeout for the out-of-band read (n8n sqlite = rollback journal)
 * @property {Record<string,string>} queries name -> static read-only query (non-empty)
 * @property {boolean} [transient_lock_is_expected] a transient "database is locked" is expected, cleared by the timeout — never a SUT failure
 */

/**
 * A validated pb-recipe-v1 (see {@link loadRecipe}).
 * @typedef {Object} Recipe
 * @property {'pb-recipe-v1'} kind
 * @property {string} name
 * @property {string} [notes] human notes (e.g. how a front-door placeholder is minted)
 * @property {CodeIdentity} code_identity
 * @property {Conjure} conjure
 * @property {FreshWorld} fresh_world
 * @property {AuthPreflight} [auth_preflight]
 * @property {SetupStep[]} setup
 * @property {FrontDoor} front_door
 * @property {StoreTap} store_tap
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

  // code_identity — discriminated union on `mode`
  const ci = r.code_identity;
  if (!isObject(ci)) bad('code_identity', 'must be an object');
  if (ci.mode === 'from_tree') {
    for (const f of ['repo', 'sha', 'dockerfile', 'context']) {
      if (typeof ci[f] !== 'string' || !ci[f]) bad(`code_identity.${f}`, "is required for mode 'from_tree'");
    }
    if (ci.build_overlay !== undefined && !isStringArray(ci.build_overlay)) bad('code_identity.build_overlay', 'must be a string[]');
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
  if (!isObject(c.env)) bad('conjure.env', 'must be an object');
  if (typeof c.container_port !== 'number') bad('conjure.container_port', 'must be a number');
  if (typeof c.published_port !== 'number') bad('conjure.published_port', 'must be a number');
  if (!isObject(c.ready_signal)) bad('conjure.ready_signal', 'must be an object');
  if (typeof c.ready_signal.path !== 'string' || !c.ready_signal.path) bad('conjure.ready_signal.path', 'must be a non-empty string');
  if (typeof c.ready_signal.expect_status !== 'number') bad('conjure.ready_signal.expect_status', 'must be a number');
  if (c.setup_overlay !== undefined && !isStringArray(c.setup_overlay)) bad('conjure.setup_overlay', 'must be a string[]');

  // fresh_world — v1 only supports recreate
  const fw = r.fresh_world;
  if (!isObject(fw)) bad('fresh_world', 'must be an object');
  if (fw.strategy !== 'recreate') bad('fresh_world.strategy', `must be 'recreate' (v1 supports 'recreate' only; got ${JSON.stringify(fw.strategy)})`);

  // auth_preflight (optional)
  if (r.auth_preflight !== undefined) {
    const ap = r.auth_preflight;
    if (!isObject(ap)) bad('auth_preflight', 'must be an object when present');
    if (typeof ap.method !== 'string' || !ap.method) bad('auth_preflight.method', 'must be a non-empty string');
    if (typeof ap.path !== 'string' || !ap.path) bad('auth_preflight.path', 'must be a non-empty string');
  }

  // setup — non-empty array of steps
  if (!Array.isArray(r.setup) || r.setup.length === 0) bad('setup', 'must be a non-empty array of steps');
  r.setup.forEach((/** @type {any} */ step, /** @type {number} */ i) => {
    if (!isObject(step)) bad(`setup[${i}]`, 'must be an object');
    if (typeof step.id !== 'string' || !step.id) bad(`setup[${i}].id`, 'must be a non-empty string');
    if (typeof step.method !== 'string' || !step.method) bad(`setup[${i}].method`, 'must be a non-empty string');
    if (typeof step.path !== 'string' || !step.path) bad(`setup[${i}].path`, 'must be a non-empty string');
    if (step.body !== undefined && step.body_file !== undefined) bad(`setup[${i}]`, 'must not set both body and body_file');
    if (step.body_file !== undefined) {
      if (typeof step.body_file !== 'string' || !step.body_file) bad(`setup[${i}].body_file`, 'must be a non-empty string');
      if (!existsSync(join(recipeDir, step.body_file))) bad(`setup[${i}].body_file`, `references a missing file: ${step.body_file}`);
    }
  });

  // front_door — URL template carrying a minted id
  const fd = r.front_door;
  if (!isObject(fd)) bad('front_door', 'must be an object');
  if (typeof fd.url_template !== 'string' || !fd.url_template) bad('front_door.url_template', 'must be a non-empty string');
  if (!/\{[^}]+\}/.test(fd.url_template)) bad('front_door.url_template', 'must contain a {...} placeholder for the minted id');

  // store_tap — the out-of-band persisted-leg read
  const st = r.store_tap;
  if (!isObject(st)) bad('store_tap', 'must be an object');
  if (typeof st.engine !== 'string' || !st.engine) bad('store_tap.engine', 'must be a non-empty string');
  if (typeof st.db_path !== 'string' || !st.db_path) bad('store_tap.db_path', 'must be a non-empty string');
  if (typeof st.busy_timeout_ms !== 'number') bad('store_tap.busy_timeout_ms', 'must be a number');
  if (!isObject(st.queries) || Object.keys(st.queries).length === 0) bad('store_tap.queries', 'must be a non-empty object of named queries');
  if (st.transient_lock_is_expected !== undefined && typeof st.transient_lock_is_expected !== 'boolean') bad('store_tap.transient_lock_is_expected', 'must be a boolean');

  return /** @type {Recipe} */ (r);
}
