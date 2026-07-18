// @ts-check
/**
 * pb-org-v1 — the untrusted, org-maintained declaration that lets pb OBTAIN and VERIFY a test
 * sandbox, plus its zero-dependency loader/validator. It is the org half of the extensibility
 * foundation (docs/pb-extensibility-foundation.md v2 §1/§2.3/§8-M1): the recipe pins a SPECIFIC
 * change under test; the org config pins the org's per-phase PROVIDER selections so pb can acquire
 * a sandbox, judge readiness, bind code-identity, and tap the store out-of-band.
 *
 * It declares one provider per phase, from an ENUMERATED set only (no org-shipped provider code —
 * that would sit on the harness side of the mint boundary and structurally break I1):
 *   - acquire   (Environment): 'local-docker' | 'compose' | 'k8s-attach'
 *   - readiness (Readiness):   'ready_signal' | 'argocd'                    (optional; native probe always runs)
 *   - identity  (Code-Identity): 'from_tree' | 'pinned_image' | 'ci_attested'
 *   - tap       (Tap):         'sqlite' | 'postgres' | 'k8s-exec'          (optional → CND ceiling)
 *
 * Honesty stance (§2.1, §3): this loader is a PURE DATA validator — it NEVER executes or evals any
 * org-supplied string. Trust rule made physical here: a provider may LOWER or ROUTE; only the
 * harness may RAISE, so an org config can never carry a fact — only routes/params pb later verifies.
 *
 * loadOrgConfig mirrors recipe.mjs loadRecipe: LOUD fail-fast (throws naming the first bad field,
 * never a half-validated config), Node built-ins only (pb runtime deps stay at ZERO). It differs in
 * one honest way: a MISSING tap is VALID but records a warning, because effect claims can then never
 * exceed CND (a persisted-leg WORKS requires an out-of-band store tap — verdict.mjs:115-116). It
 * therefore returns { config, warnings } rather than the bare config.
 *
 * Adversarial fix #6 (P6, §3): `exec` is ARRAY-ARGV and every argv element — plus every scalar
 * identifier param — is rejected if it carries a shell metacharacter, so no org string can ever be
 * re-interpreted by a shell downstream.
 *
 * Ponytail — deliberate v1 simplifications (only the fields the v2 doc defines, nothing speculative):
 *   - readiness is OPTIONAL and gate-only (§2.3): pb's own front-door probe always runs, so an
 *     absent readiness block is valid (no warning) — argocd only ROUTES/vetoes.
 *   - the tap's named QUERIES stay recipe data (recipe.mjs store_tap.queries), not org config: the
 *     org declares HOW to reach the store (engine/exec/creds), the recipe declares WHAT to read.
 *   - the §4.3 binding ladder, §6 `lineage` veto, and multi-repo rollup (§5) are later milestones
 *     (M4/M5/M7) — not modeled here to avoid over-abstracting the single-repo spine.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Enumerated provider types per phase — org-shipped/unknown types are HARD-REJECTED (no plugin protocol in v1). */
const ACQUIRE_TYPES = ['local-docker', 'compose', 'k8s-attach'];
const READINESS_TYPES = ['ready_signal', 'argocd'];
const IDENTITY_TYPES = ['from_tree', 'pinned_image', 'ci_attested'];
const TAP_ENGINES = ['sqlite', 'postgres', 'k8s-exec'];
/** BuildRecord resolvers the org's CI implements to expose the pb-buildrecord-v1 locator (§4.2#2). */
const BUILDRECORD_RESOLVERS = ['registry-referrer', 'well-known', 'github-actions', 'gitlab-ci', 'jenkins'];

/**
 * Shell metacharacters a downstream shell could re-interpret. Rejected in argv elements and scalar
 * identifier params so array-argv discipline (P6) cannot be defeated by a smuggled command string.
 */
const SHELL_META = /[;&|`$(){}<>\\!*?~\n\r]/;

/**
 * @typedef {Object} LocalDockerAcquire
 * @property {'local-docker'} type native, zero-integration default — pb builds/runs from the recipe's from_tree path
 */

/**
 * @typedef {Object} ComposeAcquire
 * @property {'compose'} type multi-service graph brought up via docker compose
 * @property {string} compose_file compose file path (relative to the checkout)
 */

/**
 * @typedef {Object} K8sAttachAcquire
 * @property {'k8s-attach'} type ATTACH to a running workload the org's platform deployed (pb did not build it → release+record, never destroy)
 * @property {string} namespace the sandbox namespace pb attaches to
 * @property {string} release_label the co-location label binding pod+front-door+store to ONE workload (P6)
 * @property {string} [front_door] the acquired sandbox ingress the drive is confined to (P6); a URL — not argv-scanned
 * @property {string[]} [wake] optional array-argv to wake a suspended sandbox (e.g. mic byoc power start) — argv-scanned, never shelled
 */

/** @typedef {LocalDockerAcquire | ComposeAcquire | K8sAttachAcquire} Acquire */

/**
 * @typedef {Object} ReadySignalReadiness
 * @property {'ready_signal'} type the native front-door poll (conjure ready_signal); always runs regardless
 * @property {string} path HTTP path polled for readiness
 * @property {number} expect_status status that means "ready"
 */

/**
 * @typedef {Object} ArgocdReadiness
 * @property {'argocd'} type routing/fail-fast gate only (§4.1): not-Healthy ⇒ skip drive + CND; never a substitute for pb's own probe
 * @property {string} app the <svc>-<env> Argo Application name
 */

/** @typedef {ReadySignalReadiness | ArgocdReadiness} Readiness */

/**
 * @typedef {Object} BuildRecordRef
 * @property {'registry-referrer'|'well-known'|'github-actions'|'gitlab-ci'|'jenkins'} resolver how pb LOCATES the pb-buildrecord-v1 record (CI exposes a locator; pb does 100% of the verifying)
 * @property {string} [ref] resolver-specific hint (referrer subject, well-known path template, or CI build handle) — the org may not assert containment, only where to look
 */

/**
 * @typedef {Object} FromTreeIdentity
 * @property {'from_tree'} type native tier-1 — pb builds from source, digest↔SHA airtight (params come from the recipe)
 */

/**
 * @typedef {Object} PinnedImageIdentity
 * @property {'pinned_image'} type native — pb pulls + digest-verifies a pinned image (params come from the recipe)
 */

/**
 * @typedef {Object} CiAttestedIdentity
 * @property {'ci_attested'} type consume the CI-integration contract for an artifact pb did NOT build (§4.2)
 * @property {BuildRecordRef} buildrecord the pb-buildrecord-v1 reference/resolver pb re-derives code-identity from
 */

/** @typedef {FromTreeIdentity | PinnedImageIdentity | CiAttestedIdentity} Identity */

/**
 * @typedef {Object} SqliteTap
 * @property {'sqlite'} engine a store file inside the SUT container
 * @property {string} db_path path to the store file inside the container
 */

/**
 * @typedef {Object} PostgresTap
 * @property {'postgres'} engine a separate DB container tapped via docker exec psql
 * @property {string} container the DB container the tap execs into
 * @property {string} user postgres role (trust auth over the local socket)
 * @property {string} db database name
 */

/**
 * @typedef {Object} K8sExecTap
 * @property {'k8s-exec'} engine out-of-band read via kubectl exec (e.g. mongosh) — the SOLE minter of delta stays the harness
 * @property {string[]} exec array-argv reaching the store shell (P6), never the app's own REST read path — argv-scanned
 */

/** @typedef {SqliteTap | PostgresTap | K8sExecTap} Tap */

/**
 * A validated pb-org-v1 (see {@link loadOrgConfig}).
 * @typedef {Object} OrgConfig
 * @property {'pb-org-v1'} kind
 * @property {string} name
 * @property {Acquire} acquire how a SUT comes to exist (Environment phase)
 * @property {Readiness} [readiness] how "up" is judged (Readiness phase); native probe always runs, so optional
 * @property {Identity} identity how THIS SHA's artifact is bound (Code-Identity phase)
 * @property {Tap} [tap] out-of-band ground-truth read (Tap phase); ABSENT is valid but caps effect claims at CND
 */

/**
 * Fail loudly, naming the offending field (mirrors recipe.mjs `bad`).
 * @param {string} field
 * @param {string} why
 * @returns {never}
 */
function bad(field, why) {
  throw new Error(`orgconfig: ${field} ${why}`);
}

/** @param {any} v @returns {boolean} */
function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} v @returns {boolean} */
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Reject a scalar identifier param carrying a shell metacharacter (P6 defense-in-depth — an org
 * identifier that a shell could re-interpret never reaches a downstream command).
 * @param {string} field @param {any} v
 */
function assertCleanIdentifier(field, v) {
  if (typeof v !== 'string' || !v) bad(field, 'must be a non-empty string');
  if (SHELL_META.test(v)) bad(field, 'must not contain shell metacharacters (array-argv discipline, P6)');
}

/**
 * Require an array-argv and reject any element carrying a shell metacharacter (P6). `exec` is NEVER
 * a single string command a shell could re-interpret.
 * @param {string} field @param {any} v
 */
function assertArgv(field, v) {
  if (!isStringArray(v) || v.length === 0) bad(field, 'must be a non-empty string[] (array-argv, never a shell string — P6)');
  v.forEach((/** @type {string} */ el, /** @type {number} */ i) => {
    if (!el) bad(`${field}[${i}]`, 'must be a non-empty string');
    if (SHELL_META.test(el)) bad(`${field}[${i}]`, 'must not contain shell metacharacters (array-argv discipline, P6)');
  });
}

/**
 * Load and validate `<orgDir>/pb-org.json` as a pb-org-v1. Throws an Error naming the first
 * missing/invalid field; never returns a half-validated config. A missing `tap` is VALID but is
 * surfaced in `warnings` (effect claims then cap at CND). Never executes or evals any org string.
 * @param {string} orgDir directory containing pb-org.json
 * @returns {{ config: OrgConfig, warnings: string[] }}
 */
export function loadOrgConfig(orgDir) {
  const file = join(orgDir, 'pb-org.json');
  if (!existsSync(file)) bad('pb-org.json', `not found in ${orgDir}`);
  let o;
  try {
    o = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    bad('pb-org.json', `is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(o)) bad('orgconfig', 'must be a JSON object');

  /** @type {string[]} */
  const warnings = [];

  // Identity
  if (o.kind !== 'pb-org-v1') bad('kind', `must be 'pb-org-v1' (got ${JSON.stringify(o.kind)})`);
  if (typeof o.name !== 'string' || !o.name.trim()) bad('name', 'must be a non-empty string');

  // acquire (Environment) — required; enumerated provider type only
  const a = o.acquire;
  if (!isObject(a)) bad('acquire', 'must be an object');
  if (!ACQUIRE_TYPES.includes(a.type)) bad('acquire.type', `must be one of ${ACQUIRE_TYPES.map((t) => `'${t}'`).join('|')} (got ${JSON.stringify(a.type)})`);
  if (a.type === 'compose') {
    if (typeof a.compose_file !== 'string' || !a.compose_file) bad('acquire.compose_file', "is required for type 'compose'");
  } else if (a.type === 'k8s-attach') {
    assertCleanIdentifier('acquire.namespace', a.namespace);
    assertCleanIdentifier('acquire.release_label', a.release_label);
    if (a.front_door !== undefined && (typeof a.front_door !== 'string' || !a.front_door)) bad('acquire.front_door', 'must be a non-empty string when present');
    if (a.wake !== undefined) assertArgv('acquire.wake', a.wake);
  }

  // readiness (Readiness) — optional; pb's own probe always runs, so an absent block is valid
  if (o.readiness !== undefined) {
    const rd = o.readiness;
    if (!isObject(rd)) bad('readiness', 'must be an object when present');
    if (!READINESS_TYPES.includes(rd.type)) bad('readiness.type', `must be one of ${READINESS_TYPES.map((t) => `'${t}'`).join('|')} (got ${JSON.stringify(rd.type)})`);
    if (rd.type === 'ready_signal') {
      if (typeof rd.path !== 'string' || !rd.path) bad('readiness.path', "is required (a non-empty string) for type 'ready_signal'");
      if (typeof rd.expect_status !== 'number') bad('readiness.expect_status', "is required (a number) for type 'ready_signal'");
    } else if (rd.type === 'argocd') {
      assertCleanIdentifier('readiness.app', rd.app);
    }
  }

  // identity (Code-Identity) — required; enumerated mode only, ci_attested carries the CI-contract ref
  const id = o.identity;
  if (!isObject(id)) bad('identity', 'must be an object');
  if (!IDENTITY_TYPES.includes(id.type)) bad('identity.type', `must be one of ${IDENTITY_TYPES.map((t) => `'${t}'`).join('|')} (got ${JSON.stringify(id.type)})`);
  if (id.type === 'ci_attested') {
    const br = id.buildrecord;
    if (!isObject(br)) bad('identity.buildrecord', "is required (an object) for type 'ci_attested'");
    if (!BUILDRECORD_RESOLVERS.includes(br.resolver)) bad('identity.buildrecord.resolver', `must be one of ${BUILDRECORD_RESOLVERS.map((t) => `'${t}'`).join('|')} (got ${JSON.stringify(br.resolver)})`);
    if (br.ref !== undefined && (typeof br.ref !== 'string' || !br.ref)) bad('identity.buildrecord.ref', 'must be a non-empty string when present');
  }

  // tap (Tap) — OPTIONAL. Absent is honest but caps effect claims at CND (no out-of-band ground truth).
  if (o.tap === undefined) {
    warnings.push('orgconfig: no tap declared — effect claims can never exceed CND (a persisted-leg WORKS requires an out-of-band store tap)');
  } else {
    const t = o.tap;
    if (!isObject(t)) bad('tap', 'must be an object when present');
    if (!TAP_ENGINES.includes(t.engine)) bad('tap.engine', `must be one of ${TAP_ENGINES.map((e) => `'${e}'`).join('|')} (got ${JSON.stringify(t.engine)})`);
    if (t.engine === 'sqlite') {
      if (typeof t.db_path !== 'string' || !t.db_path) bad('tap.db_path', "is required (a non-empty string) for engine 'sqlite'");
    } else if (t.engine === 'postgres') {
      assertCleanIdentifier('tap.container', t.container);
      assertCleanIdentifier('tap.user', t.user);
      assertCleanIdentifier('tap.db', t.db);
    } else if (t.engine === 'k8s-exec') {
      assertArgv('tap.exec', t.exec);
    }
  }

  return { config: /** @type {OrgConfig} */ (o), warnings };
}
