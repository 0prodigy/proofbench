// @ts-check
/**
 * The CATCH HARNESS — the first EXECUTED behavioral Catch, end-to-end on a real conjured SUT.
 *
 * runCatch drives ONE recipe through REPRODUCTIONS fresh worlds and, for each, executes the
 * AGENT-PROPOSED user walk exactly as a visitor would, capturing evidence out of band:
 *   conjure(recipe,{buildSha})  → a FRESH world at the built SHA (differential: merge vs parent)
 *   storetap BEFORE             → the baseline persisted state (harness, §1.1)
 *   navigate + introspect       → the HARNESS reaches the front door and reads its fillable fields
 *                                 (the read-only snapshot the agent sees; the agent runs neither)
 *   propose (seam, ONCE)        → the agent (proposer.mjs) returns a validated {walk, claim}; it is
 *                                 FROZEN at the first reproduction and replayed VERBATIM thereafter
 *   executeWalk                 → map the validated steps to browser-drive ops (find/type/click/…),
 *                                 recording the real walk (TOOL attempt; the app's own surface)
 *   give n8n a beat             → poll the store tap until the execution persists (not a bare sleep)
 *   storetap AFTER              → the write-set-bound delta (harness ground truth)
 *   fresh REST re-read          → a genuinely FRESH session (new login) re-observes the same
 *                                 execution via the app's OWN API (TOOL confirm leg, §1.1 dual-leg)
 *   teardown                    → reap the browser sidecar + the SUT (no orphans)
 *
 * The walk + effect claim are the AGENT's judgement, entering only through the proposer seam and
 * only as validated pure data (proposer.mjs closes FW-P1-C/-D: an in-menu entity, no execute/navigate
 * escape). The harness owns navigation, the introspection read, the out-of-band taps, and the verdict;
 * a proposer throw is an honest could-not-execute (→ CND), never routed around. A deterministic
 * quantifier lint (quantifierFromIntent) can only ADD `quantified` to the claim (the agent can never
 * clear it to dodge rule 5, FW-P1-E). It then assembles a bundle MIRRORING phase3 (store-delta harness ·
 * fresh-session confirm leg · browser attempt · the PROPOSED effect claim), SEALS it (ed25519 via evidence.mjs) and
 * PERSISTS the sealed evidence to a run dir; the verdict is computed by RE-READING that on-disk
 * artifact through the FROZEN verdict, so the judgement is bound to tamper-evident evidence (a
 * receipt mutated after sealing → UNVERIFIED), never a loose in-memory object — and it NEVER
 * writes the tri-state itself. The differential PROPERTY (merge==WORKS ∧ parent!=WORKS) is decided
 * by the runner (cli.mjs), not here.
 *
 * assembleCatchBundle is PURE (unit-tested docker-free with hand-built iterations); the live
 * conjure→drive→tap plumbing in runCatch is proven by `pb prove`. Zero runtime deps: docker via
 * child_process (through conjure/storetap/browserdrive), the Node built-in global fetch for the
 * confirm read. The honesty core (verdict/harness/evidence) stays FROZEN.
 */

import { conjure } from './conjure.mjs';
import { tapStore, mintStoreDelta } from './storetap.mjs';
import { openBrowser, mintDriveAttempt } from './browserdrive.mjs';
import { proposeWalkAndClaim } from './proposer.mjs';
import { loadRecipe } from './recipe.mjs';
import { mint } from './harness.mjs';
import { newBundle, sealBundle, verifySeal } from './evidence.mjs';
import { verdict } from './verdict.mjs';
import { Verdict } from './types.mjs';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';

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
 * @property {string} [nonce] optional informational marker recorded on the delta/attempt (the typed value itself now lives in the frozen walk)
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
 * @property {import('./types.mjs').VerdictResult} verdict computed from the SEALED, persisted evidence (UNVERIFIED if the seal was broken)
 * @property {string[]} diagnosis runner-computed deterministic notes (never the tri-state itself)
 * @property {import('./types.mjs').EvidenceBundle} bundle the sealed evidence, re-read from disk (the artifact the verdict was computed from)
 * @property {string} receiptPath the on-disk sealed receipt (durable, replayable)
 * @property {import('./proposer.mjs').Proposal|null} proposal the FROZEN agent proposal (prove passes the merge leg's proposal into the parent leg so the differential stays apples-to-apples); null when the seam produced none
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
 *
 * The effect claim is the AGENT-PROPOSED one: its entity (in-menu, FW-P1-C), expectedAfterRelation,
 * and scope come from `claim` — never hardcoded here. The M4 quantifier lint (quantifierFromIntent)
 * can only ADD `quantified` (from a universal-quantifier intent OR the agent's own proposal), never
 * clear it, so a quantified intent routes to rule 5 → CND (FW-P1-E). When no proposal was frozen
 * (the seam produced none) there is no claim to assemble → an empty claim set → CND.
 * @param {Object} args
 * @param {any} args.intent
 * @param {CatchIteration[]} args.iterations
 * @param {import('./proposer.mjs').ProposedClaim} [args.claim] the FROZEN agent-proposed effect claim
 * @param {string} [args.actorIdentity] the configuring actor (owner-shadow guard, §1.4)
 * @param {string} [args.identity] the walk's session identity
 * @returns {import('./types.mjs').EvidenceBundle}
 */
export function assembleCatchBundle({ intent, iterations, claim, actorIdentity = ACTOR_IDENTITY, identity = VISITOR_IDENTITY }) {
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

  // M4 quantifier lint (ADD-only, FW-P1-E): quantified iff the intent carries a universal
  // quantifier OR the agent proposed it — the agent can never clear a quantified intent to dodge
  // rule 5. A quantified claim on a single-identity Catch routes to rule 5 → NOT_EXECUTED → CND.
  const quantified = quantifierFromIntent(intent) || !!(claim && claim.quantified);
  // The effect claim is the PROPOSED one (entity/relation/scope threaded from the agent, not
  // hardcoded). No proposal frozen → no claim to assemble → CND.
  /** @type {import('./types.mjs').Claim[]} */
  const claims = claim
    ? [
        {
          id: 'form-submit-persists-execution',
          kind: 'effect',
          scope: claim.scope,
          ...(quantified ? { quantified: true } : {}),
          effectCheck: {
            entity: claim.entity,
            expectedAfterRelation: claim.expectedAfterRelation,
            deltaReceiptId: 'store-delta',
            confirmLegReceiptId: 'fresh-execution',
          },
          receiptIds: effectReceiptIds,
        },
      ]
    : [];

  const k = its.filter((it) => it.effectHeld).length;
  const kFail = its.filter((it) => it.executed && !it.effectHeld).length;
  return newBundle({ intent, actorIdentity, claims, receipts, reproduce: { k, n: its.length, kFail } });
}

// ---------------------------------------------------------------------------
// Seal · persist · judge — the verdict is bound to tamper-evident evidence
// ---------------------------------------------------------------------------

/**
 * The verdict BOUND to the seal: a sealed bundle whose seal does NOT verify (any receipt/claim/
 * intent mutated after sealing) is UNVERIFIED — its contents are not judged on their merits at
 * all (mirrors the E1 gate's effective verdict). A sealed bundle whose seal holds, or an unsealed
 * bundle, is disposed by the FROZEN pure verdict. This is how a tampered receipt can never green.
 * @param {import('./types.mjs').EvidenceBundle} bundle
 * @returns {import('./types.mjs').VerdictResult}
 */
export function sealedVerdict(bundle) {
  if (bundle && bundle.seal && !verifySeal(bundle, bundle.seal.publicKey)) {
    return {
      state: Verdict.UNVERIFIED,
      reasons: [
        'UNVERIFIED: the ed25519 evidence seal did not verify — a receipt/claim was mutated after sealing, so the contents are not trusted (tamper-evident, not judged on merit).',
      ],
      scoreboard: [],
    };
  }
  return verdict(bundle);
}

/**
 * Persist the SEALED Catch bundle to a run directory as the durable, replayable receipt of
 * record. runCatch re-reads THIS artifact to compute the verdict, so the judgement is bound to
 * tamper-evident evidence on disk — not a loose in-memory object. The filename carries the built
 * SHA so the differential's merge and parent legs never clobber each other.
 * @param {string} runDir
 * @param {string} sha the built SHA (merge or parent)
 * @param {import('./types.mjs').EvidenceBundle} sealed a bundle carrying an ed25519 seal
 * @returns {string} the receipt path
 */
export function persistCatchReceipt(runDir, sha, sealed) {
  mkdirSync(runDir, { recursive: true });
  const receiptPath = join(runDir, `catch-${(sha || 'unknown').slice(0, 12)}.receipt.json`);
  writeFileSync(receiptPath, JSON.stringify(sealed, null, 2));
  return receiptPath;
}

// ---------------------------------------------------------------------------
// Live drive / tap / confirm (seam-driven; proven by `pb prove`)
// ---------------------------------------------------------------------------

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** The read-only page snapshot the agent proposes against — the HARNESS runs it, never the agent. */
const INTROSPECT_JS =
  "return Array.from(document.querySelectorAll('input, textarea')).map((el) => ({ name: el.getAttribute('name'), type: (el.getAttribute('type') || 'text').toLowerCase(), tag: el.tagName.toLowerCase() }))";

/**
 * Universal-quantifier words that make a claim quantified (§1.4/FW-11). Word-bounded so
 * "across"/"reproduced"/"allocate" never spuriously match "all"/etc.
 */
const UNIVERSAL_QUANTIFIER = /\b(any|all|every|each|whole)\b/i;

/**
 * The M4 intent lint: does the intent carry a universal quantifier? Deterministic + harness-owned.
 * assembleCatchBundle uses it ADD-only — it can turn a claim quantified but never clear it, so a
 * quantified intent always routes to rule 5 (FW-P1-E). PURE.
 * @param {any} intent
 * @returns {boolean}
 */
export function quantifierFromIntent(intent) {
  return typeof intent === 'string' && UNIVERSAL_QUANTIFIER.test(intent);
}

/**
 * Introspect the ALREADY-NAVIGATED front door — the read-only snapshot of fillable fields the agent
 * proposes against. This is HARNESS-owned (it runs the page read via client.execute); the agent
 * never runs the read and never navigates, so `execute`/`navigate` stay out of the walk vocabulary
 * (FW-P1-D). Returns the field descriptors (name/type/tag) the proposer sees.
 * @param {import('./browserdrive.mjs').BrowserClient} client
 * @returns {Promise<{fields: Array<{name:string|null, type:string, tag:string}>}>}
 */
export async function introspect(client) {
  const fields = await client.execute(INTROSPECT_JS);
  return { fields: Array.isArray(fields) ? fields : [] };
}

/**
 * Execute a VALIDATED walk against the live browser client, mapping each step to a browser-drive op
 * and recording the real outcome in client.steps (the harness owns the observed walk; mintDriveAttempt
 * mints TOOL from it). type/click resolve their world-stable selector via find at execution time;
 * a find that matches nothing throws → the caller records a could-not-execute (feature-absent → CND).
 * navigate/execute are absent by construction (proposer.mjs excludes them, FW-P1-D).
 * @param {import('./browserdrive.mjs').BrowserClient} client
 * @param {import('./proposer.mjs').WalkStep[]} walk a validated walk (proposer.validateProposal)
 * @returns {Promise<void>}
 */
export async function executeWalk(client, walk) {
  for (const step of walk || []) {
    switch (step.op) {
      case 'find':
        await client.find(step.args.selector);
        break;
      case 'type': {
        const el = await client.find(step.args.selector);
        await client.type(el, step.args.text);
        break;
      }
      case 'click': {
        const el = await client.find(step.args.selector);
        await client.click(el);
        break;
      }
      case 'clickAt':
        await client.clickAt(step.args.x, step.args.y);
        break;
      case 'pointer':
        await client.pointer(step.args.actions, step.args.pointerType);
        break;
      default:
        throw new Error(`catch: executeWalk got an unsupported op '${step.op}' (a validated walk never contains this)`);
    }
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
 * conjure/browser/tap and the real Anthropic proposer. This computes evidence and calls the FROZEN
 * verdict — it NEVER writes the tri-state, and it NEVER decides the differential (the runner does).
 *
 * The agent proposal is FROZEN once (M3): opts.proposal reuses a pre-frozen one (prove passes the
 * SAME merge-leg proposal into the parent leg so the differential stays apples-to-apples and LLM
 * non-determinism is irrelevant); otherwise the proposer seam (opts.llmFn) is called EXACTLY ONCE,
 * at the first reproduction, and the result is replayed verbatim across the rest.
 * @param {Object} opts
 * @param {string} opts.recipeDir
 * @param {string} [opts.buildSha] alternate from_tree SHA (the parent) to build; default = code_identity.sha
 * @param {any} [opts.intent]
 * @param {typeof conjure} [opts.conjureFn]
 * @param {typeof openBrowser} [opts.openBrowserFn]
 * @param {(handle:any, queryName:string) => Promise<any[]>} [opts.tapStoreFn]
 * @param {typeof fetch} [opts.fetchFn]
 * @param {import('./proposer.mjs').LlmFn} [opts.llmFn] the proposer seam (default: the real Anthropic call)
 * @param {import('./proposer.mjs').Proposal} [opts.proposal] a pre-frozen proposal to replay (prove reuses the merge leg's across both legs)
 * @param {string} [opts.runDir] directory to persist the sealed receipt into (default: a fresh pb-catch- tmpdir)
 * @returns {Promise<CatchResult>}
 */
export async function runCatch(opts) {
  const { recipeDir, buildSha } = opts;
  const conjureFn = opts.conjureFn || conjure;
  const openBrowserFn = opts.openBrowserFn || openBrowser;
  const tapStoreFn = opts.tapStoreFn || tapStore;
  const fetchFn = opts.fetchFn || /** @type {typeof fetch} */ (fetch);
  const runDir = opts.runDir || mkdtempSync(join(tmpdir(), 'pb-catch-'));

  const recipe = loadRecipe(recipeDir);
  const sha = buildSha || /** @type {import('./recipe.mjs').FromTreeIdentity} */ (recipe.code_identity).sha || '';
  const queryName = Object.keys(recipe.store_tap.queries)[0];
  const creds = readOwnerCreds(recipeDir, recipe);
  const intent = opts.intent || `A visitor submitting the ${recipe.name} front door persists an execution, reproduced across fresh worlds (SHA ${sha.slice(0, 7)}).`;
  // The harness-enumerated observable menu — EXACTLY the execution/max_id reading the fresh-session
  // confirm leg binds to. The agent's claim entity must come from here (FW-P1-C).
  const observables = [EFFECT_ENTITY];

  /** @type {string[]} */
  const diagnosis = [];
  /** @type {CatchIteration[]} */
  const iterations = [];
  // M3 propose-once-freeze: a pre-frozen proposal is replayed as-is; otherwise the seam fires ONCE.
  /** @type {import('./proposer.mjs').Proposal|null} */
  let proposal = opts.proposal || null;
  let proposalFrozen = !!proposal; // true once the seam has been consulted (success OR failure)

  for (let i = 0; i < REPRODUCTIONS; i++) {
    /** @type {import('./conjure.mjs').SutHandle|null} */ let handle = null;
    /** @type {import('./browserdrive.mjs').BrowserClient|null} */ let client = null;
    try {
      handle = await conjureFn(recipeDir, buildSha ? { buildSha } : {});
      const beforeRows = await tapStoreFn(handle, queryName);
      const countBefore = beforeRows.length;
      const beforeId = maxId(beforeRows);

      client = await openBrowserFn({ hostPort: 4444 + i });
      // The HARNESS reaches the front door and reads it; the agent neither navigates nor runs the read.
      await client.navigate(handle.frontDoorUrl);
      const introspection = await introspect(client);
      // Freeze the proposal ONCE: consult the seam only at the first reproduction; a success OR a
      // deterministic rejection is frozen, so the seam is never re-consulted this run.
      if (!proposal && !proposalFrozen) {
        proposalFrozen = true;
        proposal = await proposeWalkAndClaim({ intent, introspection, observables }, { llmFn: opts.llmFn });
        diagnosis.push(`catch: agent proposed a ${proposal.walk.length}-step walk claiming ${proposal.claim.entity} ${proposal.claim.expectedAfterRelation.op} — frozen and replayed verbatim across reproductions.`);
      }
      if (!proposal) throw new Error('the agent seam produced no valid walk+claim (frozen as unavailable) — could-not-execute');
      await executeWalk(client, proposal.walk);
      // Best-effort confirmation-text read (HARNESS-owned, informational — the load-bearing signal
      // is the out-of-band store delta, not this DOM read).
      await sleep(CONFIRM_TEXT_SETTLE_MS);
      let observedText = '';
      try {
        observedText = String(await client.execute('return document.body ? document.body.innerText : ""'));
      } catch {
        /* the confirmation text is informational only */
      }

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

  const bundle = assembleCatchBundle({ intent, iterations, claim: proposal ? proposal.claim : undefined, actorIdentity: ACTOR_IDENTITY, identity: VISITOR_IDENTITY });
  // Seal (ed25519) → persist to the run dir → RE-READ the persisted artifact → judge THAT. The
  // verdict is bound to tamper-evident evidence ON DISK, never a loose in-memory object: a receipt
  // mutated after sealing fails verifySeal → UNVERIFIED (the contents are not trusted at all).
  const { privateKey } = generateKeyPairSync('ed25519');
  const receiptPath = persistCatchReceipt(runDir, sha, sealBundle(bundle, privateKey));
  const persisted = /** @type {import('./types.mjs').EvidenceBundle} */ (JSON.parse(readFileSync(receiptPath, 'utf8')));
  return { phase: 'catch', sha, verdict: sealedVerdict(persisted), diagnosis, bundle: persisted, receiptPath, proposal };
}
