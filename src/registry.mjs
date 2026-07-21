// @ts-check
/**
 * The PROVIDER REGISTRY — the config-keyed DEFAULT wiring for pb's phase seams (M2 seam extraction).
 *
 * docs/pb-extensibility-foundation.md §2.2 settles this: the per-phase "providers" are not a new
 * interface invented here — they are a PROMOTION of the injectable seams runCatch already proves out
 * (catch.mjs:518-529 conjureFn/tapStoreFn/openBrowserFn). Today those seams are passed by hand in unit
 * tests; this module promotes them to a DECLARED registry keyed by the recipe's config, so the live
 * `pb prove` path resolves each phase's provider FROM config instead of a hardcoded import.
 *
 * Each phase resolves to the EXISTING provider ENTRY POINT — the registry adds indirection only, it
 * never re-implements or alters what a provider DOES (§2.3):
 *   - Environment (+ Readiness + Code-Identity): conjure() — it brings the SUT up (conjure.mode
 *     run|compose), resolves code-identity (code_identity.mode from_tree|pinned_image), polls the
 *     disclosed ready_signal, and mints the fingerprint/bringup. conjure's internal mode/engine
 *     dispatch stays in conjure.mjs UNTOUCHED (405 resolveImage, 471 bringUpCompose, 543-557 ready poll).
 *   - Tap: tapStore() — the out-of-band store read, engine-dispatched sqlite|postgres|mongo
 *     inside storetap.mjs, UNTOUCHED.
 *   - Drive: openBrowser() — the browser drive. This slice KEEPS CURRENT BEHAVIOR: runCatch always
 *     browser-drives, so the drive provider is openBrowser REGARDLESS of recipe.drive.mode (the n8n
 *     #7130 golden recipe declares drive.mode:"http" yet is browser-driven today — it must stay so).
 *     Reading drive.mode to dispatch browser|http|note-lifecycle (absent⇒deferred CND) is a deliberate
 *     DEFERRED follow-up (§2.3) so #7130's behavior cannot change here.
 *
 * A recognized config key maps to its native provider; an UNKNOWN key is an honest fail-fast error
 * (mirroring recipe.mjs/orgconfig.mjs `bad`), never a silent fallthrough. The registry validates only
 * that a key is a KNOWN provider — the semantic cross-constraints (e.g. compose requires from_tree,
 * conjure.mjs:474) stay owned by the provider, so this indirection cannot drift from their behavior.
 * New provider types (k8s-attach, ci_attested, argocd, k8s-exec, http) register here in later
 * milestones — additive, never a frozen-core edit (§2.4).
 *
 * resolveCatchSeams is the DEFAULT wiring runCatch consumes, applying the invariant "an explicitly
 * INJECTED seam WINS over the registry default" — catch.mjs's unit tests inject mock seams, and
 * injection must beat (and short-circuit) the config-keyed default.
 *
 * Zero runtime deps: pure config→function resolution over the existing provider modules.
 */

import { conjure } from './conjure.mjs';
import { tapStore } from './storetap.mjs';
import { openBrowser } from './browserdrive.mjs';
import { openWorkflowRun, k8sExecTap } from './argoworkflows.mjs';

/**
 * Native provider keys per phase — EXACTLY the modes/engines conjure/storetap already implement (and
 * recipe.mjs already validates at load). An unknown key has no registered provider ⇒ honest error.
 */
const ENVIRONMENT_MODES = ['run', 'compose'];
const IDENTITY_MODES = ['from_tree', 'pinned_image'];
const TAP_ENGINES = ['sqlite', 'postgres', 'mongo'];

/**
 * Drive-mode dispatch (M3): every mode valid TODAY resolves to the browser drive — exactly current
 * behavior, GRANDFATHERED so the n8n #7130 golden (drive.mode:"http") and documenso ("deferred")
 * stay byte-identical browser-driven (making 'deferred' honestly CND is a named follow-up). Only the
 * new key 'argo-workflows' resolves to the Argo Workflows drive/observe provider.
 */
const BROWSER_DRIVE_MODES = ['browser', 'http', 'note-lifecycle', 'deferred'];

/**
 * Fail loudly, naming the offending config field (mirrors recipe.mjs / orgconfig.mjs `bad`).
 * @param {string} field
 * @param {string} why
 * @returns {never}
 */
function bad(field, why) {
  throw new Error(`registry: ${field} ${why}`);
}

/**
 * Resolve the ENVIRONMENT provider (which also performs Readiness + Code-Identity): conjure(). Keyed
 * by conjure.mode (run|compose) AND code_identity.mode (from_tree|pinned_image) — the branches conjure
 * already dispatches internally. Returns the EXISTING conjure; an unrecognized mode is an honest error
 * (never a silent default). Pure indirection — conjure's behavior is unchanged.
 * @param {import('./recipe.mjs').Recipe} recipe
 * @returns {typeof conjure}
 */
export function environmentProvider(recipe) {
  const mode = recipe.conjure.mode || 'run';
  if (!ENVIRONMENT_MODES.includes(mode)) {
    bad('conjure.mode', `has no registered environment provider (got ${JSON.stringify(mode)}; native: ${ENVIRONMENT_MODES.join('|')})`);
  }
  const idMode = recipe.code_identity.mode;
  if (!IDENTITY_MODES.includes(idMode)) {
    bad('code_identity.mode', `has no registered code-identity provider (got ${JSON.stringify(idMode)}; native: ${IDENTITY_MODES.join('|')})`);
  }
  return conjure;
}

/**
 * Resolve the TAP provider: tapStore(). Keyed by store_tap.engine (sqlite|postgres|mongo) — the
 * branches tapStore already dispatches internally. Returns the EXISTING tapStore; an unrecognized
 * engine is an honest error. Pure indirection — tapStore's behavior is unchanged.
 * @param {import('./recipe.mjs').Recipe} recipe
 * @returns {(handle:any, queryName:string) => Promise<any[]>}
 */
export function tapProvider(recipe) {
  const engine = recipe.store_tap.engine;
  if (!TAP_ENGINES.includes(engine)) {
    bad('store_tap.engine', `has no registered tap provider (got ${JSON.stringify(engine)}; native: ${TAP_ENGINES.join('|')})`);
  }
  return tapStore;
}

/**
 * Resolve the DRIVE provider, DISPATCHING on recipe.drive.mode (M3): a grandfathered browser mode
 * (browser|http|note-lifecycle|deferred, absent⇒deferred) resolves to openBrowser — EXACTLY current
 * behavior, so #7130's http drive stays browser-driven and byte-identical — and 'argo-workflows'
 * resolves to the Argo Workflows drive/observe provider. An unknown mode has no registered provider
 * ⇒ honest error (never a silent browser fallthrough).
 * @param {import('./recipe.mjs').Recipe} recipe
 * @returns {typeof openBrowser | typeof openWorkflowRun}
 */
export function driveProvider(recipe) {
  const mode = (recipe.drive && recipe.drive.mode) || 'deferred';
  if (BROWSER_DRIVE_MODES.includes(mode)) return openBrowser;
  if (mode === 'argo-workflows') return openWorkflowRun;
  return bad('drive.mode', `has no registered drive provider (got ${JSON.stringify(mode)}; native: ${[...BROWSER_DRIVE_MODES, 'argo-workflows'].join('|')})`);
}

/**
 * Resolve the ARGO TAP provider: the store-DIRECT, nonce-keyed k8s-exec tap (LIVE-GATED — the
 * default throws until the live leg ships). Keyed by store_tap.engine 'k8s-exec'; any other engine
 * for argo mode is an honest error (the argo persisted leg must be a store read, never an app read).
 * @param {import('./recipe.mjs').Recipe} recipe
 * @returns {typeof k8sExecTap}
 */
export function argoTapProvider(recipe) {
  const engine = recipe.store_tap && recipe.store_tap.engine;
  if (engine !== 'k8s-exec') {
    bad('store_tap.engine', `drive.mode 'argo-workflows' requires a 'k8s-exec' out-of-band store tap (got ${JSON.stringify(engine)})`);
  }
  return k8sExecTap;
}

/**
 * The DEFAULT phase-seam wiring runCatch drives, applying the invariant "an explicitly INJECTED seam
 * WINS over the registry default." catch.mjs's unit tests inject mock conjureFn/tapStoreFn/openBrowserFn;
 * injection must beat the config-keyed default (and short-circuits registry resolution entirely, so a
 * fully-mocked test never triggers registry validation). Given the caller's opts and the loaded recipe,
 * returns the environment/tap/drive functions runCatch calls. (runCatch dispatches an argo-workflows
 * recipe to runArgoCatch BEFORE this, so openBrowserFn here is always the browser opener.)
 * @param {{conjureFn?:typeof conjure, tapStoreFn?:(handle:any, queryName:string)=>Promise<any[]>, openBrowserFn?:typeof openBrowser}} opts
 * @param {import('./recipe.mjs').Recipe} recipe
 * @returns {{conjureFn:typeof conjure, tapStoreFn:(handle:any, queryName:string)=>Promise<any[]>, openBrowserFn:typeof openBrowser}}
 */
export function resolveCatchSeams(opts, recipe) {
  return {
    conjureFn: opts.conjureFn || environmentProvider(recipe),
    tapStoreFn: opts.tapStoreFn || tapProvider(recipe),
    openBrowserFn: opts.openBrowserFn || /** @type {typeof openBrowser} */ (driveProvider(recipe)),
  };
}

/**
 * The DEFAULT argo-phase-seam wiring runArgoCatch drives (same injection-wins invariant): the Argo
 * drive/observe provider + the store-direct nonce-keyed tap. A fully-injected pair short-circuits
 * registry resolution so a cluster-free unit test never triggers the (deferred) live defaults.
 * @param {{argoRunFn?:typeof openWorkflowRun, argoTapFn?:(handle:any, queryName:string, nonce:string)=>Promise<any[]>}} opts
 * @param {import('./recipe.mjs').Recipe} recipe
 * @returns {{argoRunFn:typeof openWorkflowRun, argoTapFn:(handle:any, queryName:string, nonce:string)=>Promise<any[]>}}
 */
export function resolveArgoSeams(opts, recipe) {
  return {
    argoRunFn: opts.argoRunFn || /** @type {typeof openWorkflowRun} */ (driveProvider(recipe)),
    argoTapFn: opts.argoTapFn || argoTapProvider(recipe),
  };
}
