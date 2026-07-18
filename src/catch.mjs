// @ts-check
/**
 * The CATCH HARNESS — the first EXECUTED behavioral Catch, end-to-end on a real conjured SUT.
 *
 * runCatch drives ONE recipe through REPRODUCTIONS fresh worlds and, for each, executes the
 * agent-shaped user walk exactly as a visitor would, capturing evidence out of band:
 *   conjure(recipe,{buildSha})  → a FRESH world at the built SHA (differential: merge vs parent)
 *   storetap BEFORE             → the baseline persisted state (harness, §1.1)
 *   browser-drive the front door→ navigate → introspect the form (execute) → type a per-iteration
 *                                 nonce → submit (TOOL attempt; the app's own rendered surface)
 *   give n8n a beat             → poll the store tap until the execution persists (not a bare sleep)
 *   storetap AFTER              → the write-set-bound delta (harness ground truth)
 *   fresh REST re-read          → a genuinely FRESH session (new login) re-observes the same
 *                                 execution via the app's OWN API (TOOL confirm leg, §1.1 dual-leg)
 *   teardown                    → reap the browser sidecar + the SUT (no orphans)
 *
 * It then assembles a bundle MIRRORING phase3 (store-delta harness · fresh-session confirm leg ·
 * browser attempt · one non-quantified effect claim) and calls the FROZEN verdict — it NEVER
 * writes the tri-state. The differential PROPERTY (merge==WORKS ∧ parent!=WORKS) is decided by the
 * runner (cli.mjs), not here.
 *
 * assembleCatchBundle is PURE (unit-tested docker-free with hand-built iterations); the live
 * conjure→drive→tap plumbing in runCatch is proven by `pb prove`. Zero runtime deps: docker via
 * child_process (through conjure/storetap/browserdrive), the Node built-in global fetch for the
 * confirm read. The honesty core (verdict/harness/evidence) stays FROZEN.
 */

import { conjure } from './conjure.mjs';
import { tapStore, mintStoreDelta } from './storetap.mjs';
import { openBrowser, mintDriveAttempt } from './browserdrive.mjs';
import { loadRecipe } from './recipe.mjs';
import { mint } from './harness.mjs';
import { newBundle } from './evidence.mjs';
import { verdict } from './verdict.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPRODUCTIONS = 2;
const EXECUTION_SETTLE_MS = 12000; // how long to watch the store for the submitted execution (a beat, not a bare sleep)
const EXECUTION_POLL_MS = 500; // spacing between store-tap re-reads while settling
const HTTP_TIMEOUT_MS = 10000;
const CONFIRM_TEXT_SETTLE_MS = 1500; // best-effort wait for the form's confirmation to render (informational only)

/** The store entity the effect is bound to — the newest execution_entity id (n8n autoincrement). */
const EFFECT_ENTITY = 'execution_entity.max_id';

/** Actor/session identities: the configuring operator vs the anonymous form visitor (distinct). */
const ACTOR_IDENTITY = 'pb-operator';
const VISITOR_IDENTITY = 'form-visitor';

/**
 * One reproduction's observed outcome — the raw facts assembleCatchBundle turns into receipts.
 * `executed:false` means the walk could not even run (conjure/drive threw = feature-absent) → it
 * contributes to NEITHER k nor kFail (an honest could-not-execute, not a conviction). `executed:true`
 * with `effectHeld:false` is a real negative (the walk ran, nothing persisted/confirmed) → kFail.
 * @typedef {Object} CatchIteration
 * @property {boolean} executed the browser walk ran end-to-end against a live SUT
 * @property {boolean} effectHeld a NEW execution persisted AND the fresh app-surface re-read agreed
 * @property {number} beforeId the newest execution id observed BEFORE the walk (0 when none)
 * @property {number} [afterId] the newest execution id observed AFTER (when one persisted)
 * @property {number} [freshObserved] the execution id re-read via a FRESH REST session (== afterId to confirm)
 * @property {number} countBefore rows in execution_entity before
 * @property {number} countAfter rows in execution_entity after
 * @property {string} [workflowId] the persisted execution's workflowId (should match the conjured workflow)
 * @property {string} [status] the persisted execution status (informational)
 * @property {string} [nonce] the per-iteration value typed into the form
 * @property {import('./browserdrive.mjs').DriveStep[]} [driveSteps] the recorded browser walk
 * @property {string} [observedText] the confirmation text observed in the DOM (informational)
 * @property {string} [frontDoorUrl] the front door the walk drove
 * @property {import('./types.mjs').Receipt} [fingerprint] the harness code-identity receipt (built SHA)
 * @property {string} [reason] why this reproduction did not confirm the effect
 */

/**
 * @typedef {Object} CatchResult
 * @property {string} phase always 'catch'
 * @property {string} sha the SHA actually built (merge or parent)
 * @property {import('./types.mjs').VerdictResult} verdict
 * @property {string[]} diagnosis runner-computed deterministic notes (never the tri-state itself)
 * @property {import('./types.mjs').EvidenceBundle} bundle
 */

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; docker-free, network-free)
// ---------------------------------------------------------------------------

/**
 * The newest execution id across store-tap rows (0 when there are none). Coerces the id to a
 * Number so the sqlite id (a number) and the REST id (a string) denote the same execution.
 * @param {any[]} rows sqlite store-tap rows (objects carrying `id`)
 * @returns {number}
 */
export function maxId(rows) {
  let m = 0;
  for (const r of rows || []) {
    const n = Number(r && r.id);
    if (Number.isFinite(n) && n > m) m = n;
  }
  return m;
}

/**
 * The row for a given id (so the delta can carry its status/workflowId), or undefined.
 * @param {any[]} rows
 * @param {number} id
 * @returns {any}
 */
export function rowById(rows, id) {
  return (rows || []).find((r) => Number(r && r.id) === id);
}

/**
 * Extract the execution id from an n8n `GET /rest/executions/:id` body and coerce it to a Number.
 * n8n wraps most REST responses in `{data:...}`; tolerate both wrapped and bare. Returns undefined
 * when no id is present (a failed/empty read → the confirm leg cannot bind → honest non-confirm).
 * @param {any} body parsed JSON body
 * @returns {number|undefined}
 */
export function executionIdFrom(body) {
  const node = body && typeof body === 'object' && 'data' in body ? body.data : body;
  const id = node && typeof node === 'object' ? node.id : undefined;
  if (id == null) return undefined;
  const n = Number(id);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Assemble the evidence bundle from the reproduction outcomes — PURE, mirroring phase3's
 * receipt/claim block. The binding iteration is the FIRST that executed the walk: if it persisted
 * an execution the store-delta is a real increase (before < after) confirmed by the fresh leg
 * (→ CONFIRMED); if the walk ran but nothing persisted the delta shows no increase (→ FALSIFIED);
 * if NO iteration executed at all (feature-absent: conjure/drive threw everywhere) NO delta is
 * emitted and the effect is NOT_EXECUTED (→ CND). k counts confirmed persists, kFail counts
 * executed-but-unheld walks; feature-absent reproductions count toward neither. verdict() disposes.
 * @param {Object} args
 * @param {any} args.intent
 * @param {CatchIteration[]} args.iterations
 * @param {string} [args.actorIdentity] the configuring actor (owner-shadow guard, §1.4)
 * @param {string} [args.identity] the walk's session identity
 * @returns {import('./types.mjs').EvidenceBundle}
 */
export function assembleCatchBundle({ intent, iterations, actorIdentity = ACTOR_IDENTITY, identity = VISITOR_IDENTITY }) {
  const its = iterations || [];
  const binding = its.find((it) => it.executed);
  const fingerprint = (its.find((it) => it.fingerprint) || {}).fingerprint;

  /** @type {import('./types.mjs').Receipt[]} */
  const receipts = [];
  if (fingerprint) receipts.push(fingerprint); // harness code-identity (built SHA) — minted by conjure
  /** @type {string[]} */
  const effectReceiptIds = [];

  if (binding) {
    const before = binding.beforeId;
    // A persisted new execution → after = its id (a real increase). Executed but nothing persisted
    // → after = before (no increase), so op:'increased' FALSIFIES rather than sits NOT_EXECUTED.
    const after = binding.afterId != null ? binding.afterId : before;
    const delta = mintStoreDelta({
      id: 'store-delta',
      entity: EFFECT_ENTITY,
      before,
      after,
      identity,
      sourcePR: false,
      extra: {
        countBefore: binding.countBefore,
        countAfter: binding.countAfter,
        ...(binding.workflowId !== undefined ? { workflowId: binding.workflowId } : {}),
        ...(binding.status !== undefined ? { status: binding.status } : {}),
        ...(binding.nonce !== undefined ? { nonce: binding.nonce } : {}),
      },
    });
    receipts.push(delta);
    effectReceiptIds.push('store-delta');

    // Browser attempt (TOOL): the AGENT-PROPOSED walk observed through the app's own rendered surface.
    receipts.push(
      mintDriveAttempt({
        id: 'browser-drive',
        frontDoorUrl: binding.frontDoorUrl || '',
        steps: binding.driveSteps || [],
        observed: binding.observedText,
        identity,
        extra: {
          ...(binding.nonce !== undefined ? { nonce: binding.nonce } : {}),
          ...(binding.afterId !== undefined ? { executionId: binding.afterId } : {}),
        },
      })
    );
    effectReceiptIds.push('browser-drive');

    // Confirm leg (TOOL, fresh-session): a genuinely fresh app-surface re-read of the SAME
    // execution. `observed` content-binds it to the delta's `after` — a stale read that disagrees
    // cannot confirm (freshBinds). Emitted only when a persisted execution existed to re-read.
    if (binding.afterId != null && binding.freshObserved !== undefined) {
      receipts.push(
        mint({
          id: 'fresh-execution',
          kind: 'fresh-session',
          provenance: 'tool',
          identity,
          data: { entity: EFFECT_ENTITY, executionId: binding.afterId, observed: binding.freshObserved },
        })
      );
      effectReceiptIds.push('fresh-execution');
    }
  }

  /** @type {import('./types.mjs').Claim[]} */
  const claims = [
    {
      id: 'form-submit-persists-execution',
      kind: 'effect',
      scope: 'a visitor submitting the Form Trigger front door persists an execution (execution_entity)',
      effectCheck: {
        entity: EFFECT_ENTITY,
        expectedAfterRelation: { op: 'increased' },
        deltaReceiptId: 'store-delta',
        confirmLegReceiptId: 'fresh-execution',
      },
      receiptIds: effectReceiptIds,
    },
  ];

  const k = its.filter((it) => it.effectHeld).length;
  const kFail = its.filter((it) => it.executed && !it.effectHeld).length;
  return newBundle({ intent, actorIdentity, claims, receipts, reproduce: { k, n: its.length, kFail } });
}

// ---------------------------------------------------------------------------
// Live drive / tap / confirm (seam-driven; proven by `pb prove`)
// ---------------------------------------------------------------------------

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {string} value @returns {string} a CSS attribute-selector value, quotes/backslashes escaped */
function cssAttrValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The AGENT-PROPOSED walk of the n8n Form Trigger front door: introspect the rendered form to find
 * its fillable field (never a recipe-baked selector — avoids the Gherkin grave), type the nonce,
 * and submit. Returns the confirmation text observed (informational). Throws if the form has no
 * fillable field (parent: the trigger node does not exist → the form 404s / renders nothing) — the
 * caller catches it as a could-not-execute (feature-absent → CND).
 * @param {import('./browserdrive.mjs').BrowserClient} client
 * @param {string} frontDoorUrl
 * @param {string} nonce
 * @returns {Promise<string>}
 */
async function driveForm(client, frontDoorUrl, nonce) {
  await client.navigate(frontDoorUrl);
  // Introspect: the agent looks at the rendered form and enumerates its inputs.
  const fields = await client.execute(
    "return Array.from(document.querySelectorAll('form input, form textarea')).map((el) => ({ name: el.getAttribute('name'), type: (el.getAttribute('type') || 'text').toLowerCase(), tag: el.tagName.toLowerCase() }))"
  );
  const skip = new Set(['submit', 'button', 'checkbox', 'radio', 'file', 'hidden', 'reset', 'image']);
  const field = (Array.isArray(fields) ? fields : []).find((f) => f && f.name && (f.tag === 'textarea' || !skip.has(f.type)));
  if (!field) {
    throw new Error(`catch: the front door served no fillable form field (introspected: ${JSON.stringify(fields)}) — the Form Trigger is absent at this SHA`);
  }
  const selector = `${field.tag}[name="${cssAttrValue(field.name)}"]`;
  const input = await client.find(selector);
  await client.type(input, nonce);
  const submit = await client.find('button[type="submit"], form button, [type="submit"]');
  await client.click(submit);
  // Best-effort: let the confirmation render, then read the page text (informational only — the
  // load-bearing signal is the out-of-band store delta, not this DOM read).
  await sleep(CONFIRM_TEXT_SETTLE_MS);
  try {
    return String(await client.execute('return document.body ? document.body.innerText : ""'));
  } catch {
    return '';
  }
}

/**
 * Give n8n a beat: re-read the store tap until a NEW execution persists (count > countBefore) or
 * the settle window elapses. A polled settle (not a bare sleep) tolerates n8n's async persist
 * without racing it; if nothing new appears the last read is returned and the caller records a
 * real negative (executed but not persisted).
 * @param {(handle:any, queryName:string) => Promise<any[]>} tapStoreFn
 * @param {any} handle
 * @param {string} queryName
 * @param {number} countBefore
 * @returns {Promise<any[]>}
 */
async function settleExecutions(tapStoreFn, handle, queryName, countBefore) {
  const deadline = Date.now() + EXECUTION_SETTLE_MS;
  let rows = await tapStoreFn(handle, queryName);
  while (rows.length <= countBefore && Date.now() < deadline) {
    await sleep(EXECUTION_POLL_MS);
    rows = await tapStoreFn(handle, queryName);
  }
  return rows;
}

/**
 * A single cookie-jar HTTP request (mirrors conjure's minimal jar) — sends accumulated cookies,
 * absorbs Set-Cookie, returns status + parsed JSON. Used only for the fresh confirm read.
 * @param {typeof fetch} fetchFn
 * @param {'GET'|'POST'} method
 * @param {string} url
 * @param {any} body
 * @param {Map<string,string>} jar
 * @returns {Promise<{status:number, json:any}>}
 */
async function jarFetch(fetchFn, method, url, body, jar) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    /** @type {Record<string,string>} */
    const headers = {};
    const cookie = Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers['Cookie'] = cookie;
    /** @type {RequestInit} */
    const init = { method, headers, redirect: 'manual', signal: controller.signal };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetchFn(url, init);
    const h = /** @type {any} */ (res.headers);
    const setCookies = typeof h.getSetCookie === 'function' ? h.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const c of setCookies) {
      const first = String(c).split(';')[0];
      const eq = first.indexOf('=');
      if (eq > 0) {
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (name && value) jar.set(name, value);
      }
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Re-read an execution from a genuinely FRESH session: a brand-new login (new cookie, distinct from
 * conjure's setup session) then `GET /rest/executions/{id}` via the app's OWN REST API. This is the
 * TOOL confirm leg (§1.1 dual-leg) — an app-surface read that must agree with the out-of-band store
 * delta. n8n's login field changed across versions, so both `emailOrLdapLoginId` and `email` are
 * tried. Returns the re-observed execution id, or undefined when it cannot be confirmed.
 * @param {typeof fetch} fetchFn
 * @param {string} baseUrl
 * @param {{email:string, password:string}} creds
 * @param {number} id
 * @returns {Promise<number|undefined>}
 */
async function freshReadExecution(fetchFn, baseUrl, creds, id) {
  for (const loginBody of [{ emailOrLdapLoginId: creds.email, password: creds.password }, { email: creds.email, password: creds.password }]) {
    /** @type {Map<string,string>} */
    const jar = new Map();
    const login = await jarFetch(fetchFn, 'POST', `${baseUrl}/rest/login`, loginBody, jar);
    if (login.status < 200 || login.status >= 300 || jar.size === 0) continue; // wrong field / not authed → try the other shape
    const ex = await jarFetch(fetchFn, 'GET', `${baseUrl}/rest/executions/${encodeURIComponent(String(id))}`, undefined, jar);
    if (ex.status < 200 || ex.status >= 300) return undefined; // authed but could not read → cannot confirm
    return executionIdFrom(ex.json);
  }
  return undefined;
}

/**
 * Read the owner credentials from the recipe's disclosed setup — the first setup step whose
 * body_file carries an email + password (n8n's owner setup). Returns null when none is present
 * (then the confirm leg is skipped and the effect honestly CNDs rather than over-claim).
 * @param {string} recipeDir
 * @param {import('./recipe.mjs').Recipe} recipe
 * @returns {{email:string, password:string}|null}
 */
function readOwnerCreds(recipeDir, recipe) {
  for (const step of recipe.setup || []) {
    if (!step.body_file) continue;
    const p = join(recipeDir, step.body_file);
    if (!existsSync(p)) continue;
    try {
      const body = JSON.parse(readFileSync(p, 'utf8'));
      if (body && typeof body.email === 'string' && typeof body.password === 'string') {
        return { email: body.email, password: body.password };
      }
    } catch {
      /* not JSON / unreadable — keep looking */
    }
  }
  return null;
}

/**
 * Run the Catch against a recipe across REPRODUCTIONS fresh worlds and return the verdict result.
 * buildSha selects the code-identity built (merge vs the differential parent). External effects are
 * seam-injectable so the plumbing can be exercised without docker; the default seams are the real
 * conjure/browser/tap. This computes evidence and calls the FROZEN verdict — it NEVER writes the
 * tri-state, and it NEVER decides the differential (the runner does).
 * @param {Object} opts
 * @param {string} opts.recipeDir
 * @param {string} [opts.buildSha] alternate from_tree SHA (the parent) to build; default = code_identity.sha
 * @param {any} [opts.intent]
 * @param {typeof conjure} [opts.conjureFn]
 * @param {typeof openBrowser} [opts.openBrowserFn]
 * @param {(handle:any, queryName:string) => Promise<any[]>} [opts.tapStoreFn]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<CatchResult>}
 */
export async function runCatch(opts) {
  const { recipeDir, buildSha } = opts;
  const conjureFn = opts.conjureFn || conjure;
  const openBrowserFn = opts.openBrowserFn || openBrowser;
  const tapStoreFn = opts.tapStoreFn || tapStore;
  const fetchFn = opts.fetchFn || /** @type {typeof fetch} */ (fetch);

  const recipe = loadRecipe(recipeDir);
  const sha = buildSha || /** @type {import('./recipe.mjs').FromTreeIdentity} */ (recipe.code_identity).sha || '';
  const queryName = Object.keys(recipe.store_tap.queries)[0];
  const creds = readOwnerCreds(recipeDir, recipe);
  const intent = opts.intent || `A visitor submitting the ${recipe.name} front door persists an execution, reproduced across fresh worlds (SHA ${sha.slice(0, 7)}).`;

  /** @type {string[]} */
  const diagnosis = [];
  /** @type {CatchIteration[]} */
  const iterations = [];

  for (let i = 0; i < REPRODUCTIONS; i++) {
    const nonce = `pb-${sha.slice(0, 7)}-r${i}-${Date.now().toString(36)}`;
    /** @type {import('./conjure.mjs').SutHandle|null} */ let handle = null;
    /** @type {import('./browserdrive.mjs').BrowserClient|null} */ let client = null;
    try {
      handle = await conjureFn(recipeDir, buildSha ? { buildSha } : {});
      const beforeRows = await tapStoreFn(handle, queryName);
      const countBefore = beforeRows.length;
      const beforeId = maxId(beforeRows);

      client = await openBrowserFn({ hostPort: 4444 + i });
      const observedText = await driveForm(client, handle.frontDoorUrl, nonce);

      const afterRows = await settleExecutions(tapStoreFn, handle, queryName, countBefore);
      const countAfter = afterRows.length;
      const persisted = countAfter > countBefore;
      const afterId = persisted ? maxId(afterRows) : undefined;
      const row = afterId != null ? rowById(afterRows, afterId) : undefined;

      let freshObserved;
      if (afterId != null) {
        if (creds) freshObserved = await freshReadExecution(fetchFn, handle.baseUrl, creds, afterId);
        else diagnosis.push('catch: no owner credentials in the recipe setup — the fresh-session confirm leg is skipped (effect will CND).');
      }
      const effectHeld = afterId != null && freshObserved === afterId;
      const reason = effectHeld
        ? undefined
        : afterId == null
          ? 'the walk ran but no execution persisted in execution_entity'
          : freshObserved === undefined
            ? 'a fresh REST re-read could not re-observe the execution (confirm leg absent)'
            : `the fresh REST re-read (${freshObserved}) disagreed with the store delta (${afterId})`;

      iterations.push({
        executed: true,
        effectHeld,
        beforeId,
        afterId,
        freshObserved,
        countBefore,
        countAfter,
        workflowId: row ? row.workflowId : undefined,
        status: row ? row.status : undefined,
        nonce,
        driveSteps: client.steps,
        observedText,
        frontDoorUrl: handle.frontDoorUrl,
        fingerprint: handle.receipts.find((r) => r.kind === 'fingerprint'),
        reason,
      });
      if (effectHeld) {
        diagnosis.push(`catch: reproduction ${i} — execution ${afterId} persisted (status=${row ? row.status : '?'}, workflowId=${row ? row.workflowId : '?'}); a fresh REST session re-observed the same id (confirm leg agrees).`);
      } else {
        diagnosis.push(`catch: reproduction ${i} executed the walk but did not confirm the effect: ${reason}.`);
      }
    } catch (e) {
      const reason = String((e && /** @type {any} */ (e).message) || e);
      diagnosis.push(`catch: reproduction ${i} could not execute the walk (feature-absent / conjure-drive error, not evidence against the change): ${reason}`);
      iterations.push({ executed: false, effectHeld: false, beforeId: 0, countBefore: 0, countAfter: 0, reason });
    } finally {
      if (client) {
        try {
          await client.teardown();
        } catch {
          /* sidecar already gone */
        }
      }
      if (handle) {
        try {
          await handle.teardown();
        } catch {
          /* SUT already reaped */
        }
      }
    }
  }

  const bundle = assembleCatchBundle({ intent, iterations, actorIdentity: ACTOR_IDENTITY, identity: VISITOR_IDENTITY });
  return { phase: 'catch', sha, verdict: verdict(bundle), diagnosis, bundle };
}
