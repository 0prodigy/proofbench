// @ts-check
/**
 * The ARGO WORKFLOWS drive/observe provider — submit a NONCE-STAMPED Workflow CR, OBSERVE that
 * EXACT run to a terminal phase, and surface the facts an honest mint-precondition path needs.
 * A Lyric note run IS an Argo Workflow DAG (a step pod exits 0 ⇒ the DAG advances), so this is
 * pb's path toward the note-DAG dogfood (docs/pb-extensibility-foundation.md §2.3 — Drive is the
 * seam that must finally be dispatched on).
 *
 * It mirrors src/browserdrive.mjs byte-for-pattern: a KubectlRunner seam (default shells to the
 * real `kubectl`, a MOCK is injected in tests so the provider runs WITHOUT a cluster) and a
 * TOOL-only mint helper. The client is submit/awaitTerminal/podDigests/pinCheck/teardown.
 *
 * HONESTY (doc v2 §3 — the runner DECLINES to mint unless verified):
 *   - This module DRIVES and mints only a TOOL attempt (mintWorkflowAttempt) — NEVER the HARNESS
 *     effect delta (that stays storetap.mintStoreDelta, tapped OUT-OF-BAND by runArgoCatch). The
 *     terminal PHASE is kept strictly in the attempt receipt, never as a delta — phase is not the
 *     oracle (a Succeeded run whose write never landed FALSIFIES on the nonce-scoped tap).
 *   - The three guardrails are enforced as MINT PRECONDITIONS in runArgoCatch (catch.mjs), built
 *     from this module's primitives: (1) NONCE ROUND-TRIP — the nonce must be READ BACK from the
 *     store out-of-band (never stamped); (2) DIGEST<->SHA BINDING — the step-pod imageID must bind
 *     the SHA under test; (3) SINGLE-RUN PINNING — observe exactly the run submit returned.
 *   - The pin label pb.run/nonce is a PUBLIC correlation label only. On a truly adversarial shared
 *     cluster a public value cannot prove authorship (a cluster reader could echo it into the
 *     store); the authorship-proving SECRET nonce (a k8s Secret mounted into the step pod, never
 *     written to the CR spec/status/parameters) and the store-DIRECT k8s-exec tap are LIVE-LEG
 *     gates — see recipes/lyric-note-run-argo and docs. This provider is honest on a trusted-tenant
 *     cluster; the shared-cluster forgery vectors are provable only on the deferred live leg.
 *
 * Zero runtime deps: kubectl via child_process (mirroring conjure/storetap/browserdrive), the
 * Node built-in mint for the TOOL receipt.
 */

import { spawnSync } from 'node:child_process';
import { mint } from './harness.mjs';

const KUBECTL_TIMEOUT_MS = 120000; // one kubectl call (create/get)
const TERMINAL_TIMEOUT_MS = 300000; // a workflow may take minutes; bounded ⇒ throw ⇒ could-not-execute ⇒ CND
const TERMINAL_POLL_MS = 2000; // spacing between phase re-reads while observing
const MAX_BUFFER = 64 * 1024 * 1024;

/** The Argo terminal workflow phases (`status.phase`). */
export const TERMINAL_PHASES = Object.freeze(['Succeeded', 'Failed', 'Error']);

/**
 * The PUBLIC run-scoped pin label pb stamps on the Workflow it triggers (P3/P7). It pins the run
 * for single-run observation; it is NOT the authorship proof (that is the deferred SECRET nonce).
 */
export const NONCE_LABEL = 'pb.run/nonce';

/** The placeholder the nonce-scoped tap query MUST carry; runArgoCatch substitutes the harness nonce (P2). */
export const NONCE_PLACEHOLDER = '{nonce}';

/**
 * A kubectl runner — mirrors browserdrive.mjs's DockerRunner. Injected in tests so the provider is
 * exercised cluster-free; the default shells out to the real `kubectl` CLI. `stdin` feeds a manifest
 * to `kubectl create -f -`.
 * @typedef {Object} KubectlRunner
 * @property {(args:string[], timeoutMs:number, stdin?:string) => import('node:child_process').SpawnSyncReturns<string>} run
 */

/**
 * A recorded op in the driven workflow run (the HARNESS-captured outcome of the trigger/observe),
 * handed to mintWorkflowAttempt.
 * @typedef {{ op: string } & Record<string, any>} DriveStep
 */

/**
 * The observe/drive client openWorkflowRun returns.
 * @typedef {Object} WorkflowRunClient
 * @property {string|undefined} namespace the namespace all ops run in
 * @property {DriveStep[]} steps the recorded run (raw observations for the attempt receipt)
 * @property {(manifest:any)=>Promise<string>} submit `kubectl create -f -` the stamped Workflow CR → the generated name
 * @property {(name:string)=>Promise<{phase:string, workflow:any}>} awaitTerminal poll `status.phase` until terminal (bounded ⇒ throw)
 * @property {(name:string, container:string)=>Promise<string[]>} podDigests the selected step container's observed imageIDs
 * @property {(nonce:string, name:string)=>Promise<boolean>} pinCheck the pb.run/nonce label resolves to EXACTLY the submitted name
 * @property {(nonce:string)=>Promise<void>} teardown reap only what pb labeled (`delete wf -l pb.run/nonce=<nonce>`)
 */

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; cluster-free)
// ---------------------------------------------------------------------------

/** @param {string} [s] @param {number} [n] */
function tail(s, n = 600) {
  s = s || '';
  return s.length > n ? s.slice(-n) : s;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse a kubectl `-o json` stdout, throwing (naming the op) on non-JSON.
 * @param {string} stdout
 * @param {string} op the kubectl op (for the error)
 * @returns {any}
 */
function parseJson(stdout, op) {
  const s = (stdout || '').trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error(`argoworkflows: could not parse '${op}' -o json output: ${e instanceof Error ? e.message : String(e)} — got: ${tail(s, 300)}`);
  }
}

/**
 * The workflow's `status.phase` ('' when not yet set).
 * @param {any} wf
 * @returns {string}
 */
export function workflowPhaseFrom(wf) {
  return wf && wf.status && typeof wf.status.phase === 'string' ? wf.status.phase : '';
}

/** @param {string} phase @returns {boolean} whether the phase is terminal */
export function isTerminal(phase) {
  return TERMINAL_PHASES.includes(phase);
}

/**
 * The observed imageIDs of the SELECTED step container across a workflow's pods (both regular and
 * init container statuses). An imageID is the RESOLVED `@sha256:` reference, so a mutable tag is
 * neutralized. Empty ⇒ the container was never observed (pods GC'd / cache-hit / wrong selector).
 * @param {any} poList a `kubectl get po -o json` list
 * @param {string} container the recipe-declared container carrying the SHA under test
 * @returns {string[]}
 */
export function imageIDsFrom(poList, container) {
  const items = poList && Array.isArray(poList.items) ? poList.items : [];
  /** @type {string[]} */
  const ids = [];
  for (const pod of items) {
    const st = (pod && pod.status) || {};
    const statuses = [...(st.containerStatuses || []), ...(st.initContainerStatuses || [])];
    for (const cs of statuses) {
      if (cs && cs.name === container && typeof cs.imageID === 'string' && cs.imageID) ids.push(cs.imageID);
    }
  }
  return ids;
}

/**
 * Extract the `sha256:<64hex>` digest from an imageID / image reference ('' when absent).
 * @param {string} imageID
 * @returns {string}
 */
export function normalizeDigest(imageID) {
  if (typeof imageID !== 'string') return '';
  const m = imageID.match(/sha256:[0-9a-f]{64}/i);
  return m ? m[0].toLowerCase() : '';
}

/**
 * Whether an observed imageID binds to the SHA-under-test digest (both resolved to `@sha256:`).
 * @param {string} imageID
 * @param {string} boundDigest
 * @returns {boolean}
 */
export function digestBinds(imageID, boundDigest) {
  const a = normalizeDigest(imageID);
  const b = normalizeDigest(boundDigest);
  return !!a && a === b;
}

/**
 * Single-run pinning (P3): the nonce-label list must be EXACTLY the one submitted name — 0 or >1
 * (a concurrent same-label run) is a pin failure.
 * @param {any} wfList a `kubectl get wf -l pb.run/nonce=<n> -o json` list
 * @param {string} name the name submit returned
 * @returns {boolean}
 */
export function pinnedExactly(wfList, name) {
  const items = wfList && Array.isArray(wfList.items) ? wfList.items : [];
  return items.length === 1 && !!items[0] && !!items[0].metadata && items[0].metadata.name === name;
}

/**
 * Substitute the harness nonce into a nonce-scoped tap query TEMPLATE (P2). Throws when the
 * template lacks the {@link NONCE_PLACEHOLDER} — a query that is not nonce-scoped cannot prove
 * authorship (a global counter is bumped by any concurrent run).
 * @param {string} template
 * @param {string} nonce
 * @returns {string}
 */
export function substituteNonce(template, nonce) {
  if (typeof template !== 'string' || !template.includes(NONCE_PLACEHOLDER)) {
    throw new Error(`argoworkflows: tap query template must contain the ${NONCE_PLACEHOLDER} placeholder — the argo tap MUST be nonce-scoped (P2/requiredFix 3)`);
  }
  return template.split(NONCE_PLACEHOLDER).join(String(nonce));
}

/**
 * The container names declared across a Workflow manifest's templates (both `container` and
 * `containerSet.containers`). Used to validate the digest<->SHA selector at recipe load.
 * @param {any} manifest a JSON Argo Workflow CR
 * @returns {string[]}
 */
export function argoContainerNames(manifest) {
  const tpls = manifest && manifest.spec && Array.isArray(manifest.spec.templates) ? manifest.spec.templates : [];
  /** @type {string[]} */
  const names = [];
  for (const t of tpls) {
    if (t && t.container && typeof t.container.name === 'string' && t.container.name) names.push(t.container.name);
    const set = t && t.containerSet && Array.isArray(t.containerSet.containers) ? t.containerSet.containers : [];
    for (const c of set) if (c && typeof c.name === 'string' && c.name) names.push(c.name);
  }
  return names;
}

/**
 * Whether ANY store row carries the harness nonce — the nonce READ BACK from the store (P2). The
 * value is what the store returned, never a value pb stamped: absence ⇒ the nonce did not round-trip.
 * @param {any[]} rows the nonce-scoped tap rows (objects/arrays of field values)
 * @param {string} nonce
 * @returns {string|undefined} the nonce when present, else undefined
 */
export function nonceFromRows(rows, nonce) {
  for (const row of rows || []) {
    if (String(row) === String(nonce)) return nonce;
    if (row && typeof row === 'object') {
      for (const v of Object.values(row)) if (String(v) === String(nonce)) return nonce;
    }
  }
  return undefined;
}

/**
 * Stamp the loaded Workflow manifest for a run: `metadata.generateName` (the cluster assigns a
 * unique name synchronously on create — no race), the PUBLIC pb.run/nonce pin label, and the nonce
 * injected as the disclosed workflow parameter. DEEP-CLONES so the loaded recipe data is never
 * mutated. NOTE: on a live adversarial cluster the value that must round-trip into the STORE must be
 * a high-entropy SECRET delivered via a k8s Secret into the step pod and NEVER written to the CR
 * (Argo params are plaintext in the CR) — that secret-nonce split is a LIVE-LEG gate (requiredFix 1).
 * @param {any} manifest a JSON Argo Workflow CR
 * @param {{nonceParameter:string, nonce:string}} args
 * @returns {any} the stamped manifest (a fresh object)
 */
export function stampManifest(manifest, { nonceParameter, nonce }) {
  if (!manifest || typeof manifest !== 'object') throw new Error('argoworkflows: manifest must be a JSON object');
  const m = JSON.parse(JSON.stringify(manifest));
  m.metadata = m.metadata || {};
  if (!m.metadata.generateName) m.metadata.generateName = m.metadata.name ? `${m.metadata.name}-` : 'pb-run-';
  delete m.metadata.name; // generateName owns identity; submit returns the assigned name (single-run pin)
  m.metadata.labels = { ...(m.metadata.labels || {}), [NONCE_LABEL]: String(nonce) };
  m.spec = m.spec || {};
  m.spec.arguments = m.spec.arguments || {};
  const params = Array.isArray(m.spec.arguments.parameters) ? m.spec.arguments.parameters.slice() : [];
  const entry = { name: nonceParameter, value: String(nonce) };
  const idx = params.findIndex((/** @type {any} */ p) => p && p.name === nonceParameter);
  if (idx >= 0) params[idx] = entry;
  else params.push(entry);
  m.spec.arguments.parameters = params;
  return m;
}

// ---------------------------------------------------------------------------
// kubectl runner + the observe/drive client
// ---------------------------------------------------------------------------

/** @returns {KubectlRunner} the real kubectl child_process runner */
function defaultKubectl() {
  return {
    run: (args, timeoutMs, stdin) =>
      spawnSync('kubectl', args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        ...(stdin !== undefined ? { input: stdin } : {}),
      }),
  };
}

/**
 * @typedef {Object} WorkflowRunOpts
 * @property {string} [namespace] the namespace to submit/observe in
 * @property {KubectlRunner} [kubectl] injected for cluster-free tests
 */

/**
 * Open an Argo Workflows observe/drive client. No cluster call happens until submit — a missing
 * kubeconfig/cluster surfaces as a submit throw (could-not-execute ⇒ CND), mirroring the
 * live-gated seal-adapter precedent.
 * @param {WorkflowRunOpts} [opts]
 * @returns {Promise<WorkflowRunClient>}
 */
export async function openWorkflowRun(opts = {}) {
  const kubectl = opts.kubectl || defaultKubectl();
  const namespace = opts.namespace;
  const ns = namespace ? ['-n', namespace] : [];
  /** @type {DriveStep[]} */
  const steps = [];

  /** @param {import('node:child_process').SpawnSyncReturns<string>} res @param {string} op */
  const okOrThrow = (res, op) => {
    if (res.error) throw new Error(`argoworkflows: kubectl ${op} failed to run: ${res.error.message}`);
    if (res.status !== 0) throw new Error(`argoworkflows: kubectl ${op} failed (exit ${res.status}): ${tail(res.stderr || res.stdout)}`);
    return res;
  };

  /** @type {WorkflowRunClient} */
  const client = {
    namespace,
    steps,
    async submit(manifest) {
      const res = okOrThrow(kubectl.run(['create', ...ns, '-o', 'json', '-f', '-'], KUBECTL_TIMEOUT_MS, JSON.stringify(manifest)), 'create');
      const created = parseJson(res.stdout, 'create');
      const name = created && created.metadata && created.metadata.name;
      if (typeof name !== 'string' || !name) throw new Error('argoworkflows: kubectl create returned no metadata.name');
      steps.push({ op: 'submit', name });
      return name;
    },
    async awaitTerminal(name) {
      const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
      for (;;) {
        const res = okOrThrow(kubectl.run(['get', 'workflow', name, ...ns, '-o', 'json'], KUBECTL_TIMEOUT_MS), `get workflow ${name}`);
        const workflow = parseJson(res.stdout, 'get workflow');
        const phase = workflowPhaseFrom(workflow);
        steps.push({ op: 'phase', phase: phase || '(pending)' });
        if (isTerminal(phase)) return { phase, workflow };
        if (Date.now() >= deadline) {
          throw new Error(`argoworkflows: workflow ${name} did not reach a terminal phase within ${TERMINAL_TIMEOUT_MS / 1000}s (last=${phase || 'pending'}) — could-not-execute`);
        }
        await sleep(TERMINAL_POLL_MS);
      }
    },
    async podDigests(name, container) {
      const res = okOrThrow(kubectl.run(['get', 'po', ...ns, '-l', `workflows.argoproj.io/workflow=${name}`, '-o', 'json'], KUBECTL_TIMEOUT_MS), 'get po');
      const list = parseJson(res.stdout, 'get po');
      const ids = imageIDsFrom(list, container);
      steps.push({ op: 'podDigests', container, count: ids.length });
      return ids;
    },
    async pinCheck(nonce, name) {
      const res = okOrThrow(kubectl.run(['get', 'wf', ...ns, '-l', `${NONCE_LABEL}=${nonce}`, '-o', 'json'], KUBECTL_TIMEOUT_MS), 'get wf -l nonce');
      const list = parseJson(res.stdout, 'get wf');
      const matched = (list && Array.isArray(list.items) ? list.items : []).length;
      const ok = pinnedExactly(list, name);
      steps.push({ op: 'pinCheck', matched, ok });
      return ok;
    },
    async teardown(nonce) {
      // Reap ONLY what pb labeled (P7); never a blanket delete.
      kubectl.run(['delete', 'wf', ...ns, '-l', `${NONCE_LABEL}=${nonce}`, '--ignore-not-found'], KUBECTL_TIMEOUT_MS);
    },
  };
  return client;
}

/**
 * Mint a TOOL attempt receipt for the driven workflow run — the trigger + observed phase transitions
 * + observed pod digests, provenance:'tool', kind:'attempt', NEVER 'harness' (the persisted leg
 * stays the out-of-band store delta). The terminal PHASE lives here and NEVER as a delta (phase is
 * not the oracle). Goes through the harness mint() so it is content-addressed and branded; `id` MUST
 * be passed here (the brand is non-enumerable and a re-spread drops it).
 * @param {Object} args
 * @param {string} [args.id] receipt id (defaults to 'argo-drive')
 * @param {string} args.name the observed workflow run name
 * @param {string} args.nonce the run-scoped nonce (public pin correlation)
 * @param {string} args.phase the observed terminal phase
 * @param {DriveStep[]} args.steps the recorded run (client.steps)
 * @param {string[]} [args.digests] the observed step-pod imageIDs
 * @param {string} args.identity actor/session identity the run ran under
 * @param {Record<string,any>} [args.extra] extra data fields merged into the receipt payload
 * @returns {import('./types.mjs').Receipt} a minted TOOL attempt receipt
 */
export function mintWorkflowAttempt({ id, name, nonce, phase, steps, digests, identity, extra }) {
  return mint({
    id: id ?? 'argo-drive',
    kind: 'attempt',
    provenance: 'tool',
    identity,
    data: {
      request: `argo-workflow ${name}`,
      name,
      nonce,
      phase,
      steps,
      ...(digests !== undefined ? { digests } : {}),
      ...(extra || {}),
    },
  });
}

/**
 * The DEFAULT argo store tap — LIVE-GATED (not built). An honest argo tap MUST be a store-DIRECT,
 * out-of-band read (kubectl exec into the datastore pod / a read replica with a read-only store
 * credential, keyed on the nonce) and MUST THROW rather than fall back to an app-API read
 * (requiredFix 4). Because mintStoreDelta stamps HARNESS unconditionally, out-of-band-ness cannot
 * be enforced in the frozen core — it lives here + in recipe-load validation. Unit runs inject an
 * argoTapFn seam; the live k8s-exec engine ships with the deferred live leg.
 *
 * WHY THIS STAYS SEPARATE FROM mongotap.mjs's `tapMongo` (both now read mongo via `kubectl exec …
 * mongosh`, but they are NOT the same engine and must not be conflated):
 *   - recipe.mjs validates `store_tap.engine:'k8s-exec'` and `'mongo'` as DISTINCT discriminated-
 *     union members with different honesty contracts. 'k8s-exec' queries MUST carry the `{nonce}`
 *     placeholder and `entity` MUST NOT be a global max-id/count aggregate (requiredFix 3) — the
 *     nonce round-trip (P2) is what proves THIS run's write, not merely that mongo has A row.
 *     'mongo' has neither requirement; it is a plain credentialed read (pod/container/db/
 *     credential_secrets), correct for the Lyric class's general store_tap but NOT nonce-scoped —
 *     silently routing k8s-exec through it would drop the nonce-round-trip guardrail the argo
 *     drive's honesty depends on.
 *   - The call SHAPES differ: argoTapFn is `(handle, queryName, nonce) => Promise<any[]>` (the
 *     nonce is substituted into the query via `substituteNonce`, see runArgoCatch); tapMongo is
 *     `(st, queryName, query, execFn) => Promise<any[]>` with a plain static query — a nonce
 *     round-trip has nowhere to plug in.
 *   - `store_client` on a k8s-exec tap is a generic string ('mongosh'|'psql'|...), not mongo-
 *     specific — a live k8s-exec implementation is a DISPATCH over `store_client`, of which a
 *     mongosh backend could reuse mongotap.mjs's low-level `kubectl exec … mongosh` transport
 *     (credential-secret fallback, JSON-row normalization) as a building block. That reuse is a
 *     future slice, not this one — this task's scope is the 'mongo' engine only (LOCAL-ONLY, no
 *     live cluster calls); the live k8s-exec leg stays explicitly deferred.
 * @returns {Promise<any[]>}
 */
export async function k8sExecTap() {
  throw new Error(
    'argoworkflows: the k8s-exec store tap is LIVE-GATED (not built) — it must be a store-DIRECT out-of-band read ' +
      '(kubectl exec into the datastore pod / a read replica), nonce-keyed, and must NEVER fall back to an app-API read ' +
      '(requiredFix 4). Inject an argoTapFn seam for cluster-free runs.'
  );
}
