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
 *   give the SUT a beat         → poll the store tap until the recipe-declared OBSERVABLE moves
 *                                 (§6, engine-shaped: row-count/max-id/named-scalar; not a bare sleep)
 *   storetap AFTER              → the write-set-bound delta (harness ground truth)
 *   fresh confirm leg           → a genuinely FRESH session walks the recipe's OWN `confirm[]`
 *                                 REST steps (same schema as `setup`, §6) to re-observe the same
 *                                 observable via the app's OWN surface (TOOL confirm leg, §1.1 dual-leg)
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

import { conjure, resolvePlaceholders, resolveBodyPlaceholders, extractJsonPath, extractHtml, absorbSetCookies, encodeSetupBody } from './conjure.mjs';
import { registerReap, deregisterReap } from './reaper.mjs';
import { mintStoreDelta } from './storetap.mjs';
import { openBrowser, mintDriveAttempt } from './browserdrive.mjs';
import { mintWorkflowAttempt, stampManifest, digestBinds, nonceFromRows } from './argoworkflows.mjs';
import { resolveCatchSeams, resolveArgoSeams } from './registry.mjs';
import { proposeWalkAndClaim, ALLOWED_ARGO_OPS } from './proposer.mjs';
import { loadRecipe, resolveObservable } from './recipe.mjs';
import { mint } from './harness.mjs';
import { newBundle, sealBundle, verifySeal } from './evidence.mjs';
import { verdict } from './verdict.mjs';
import { Verdict } from './types.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

const REPRODUCTIONS = 2;
const EXECUTION_SETTLE_MS = 12000; // how long to watch the store for the submitted execution (a beat, not a bare sleep)
const EXECUTION_POLL_MS = 500; // spacing between store-tap re-reads while settling
const HTTP_TIMEOUT_MS = 10000;
const CONFIRM_TEXT_SETTLE_MS = 1500; // best-effort wait for the form's confirmation to render (informational only)

/** The fallback store-effect label when neither the binding iteration nor the claim names one (mirrors assembleArgoBundle's 'argo.effect'). */
const DEFAULT_EFFECT_ENTITY = 'store.effect';

/** Actor/session identities: the configuring operator vs the anonymous form visitor (distinct). */
const ACTOR_IDENTITY = 'pb-operator';
const VISITOR_IDENTITY = 'form-visitor';

/**
 * One reproduction's observed outcome — the raw facts assembleCatchBundle turns into receipts.
 * `executed:false` means the walk could not even run (conjure/drive threw = feature-absent) → it
 * contributes to NEITHER k nor kFail (an honest could-not-execute, not a conviction). `executed:true`
 * with `effectHeld:false` is a real negative (the walk ran, nothing persisted/confirmed) → kFail.
 *
 * `before`/`after` are the recipe-declared OBSERVABLE's value (§6, engine-shaped: row-count | max-id |
 * named-scalar — see recipe.mjs resolveObservable), not an n8n-specific autoincrement id; `entity` is
 * the observable's name (from the SAME recipe declaration) the store-delta receipt binds.
 * @typedef {Object} CatchIteration
 * @property {boolean} executed the browser walk ran end-to-end against a live SUT
 * @property {boolean} effectHeld the observable moved AND a fresh-session re-observation agreed
 * @property {any} before the observable's value BEFORE the walk
 * @property {any} [after] the observable's value AFTER the walk (when it changed)
 * @property {string} [entity] the recipe-declared observable name this reproduction bound (recipe.mjs resolveObservable)
 * @property {any} [freshObserved] the value re-read via a FRESH, recipe-declared confirm-leg session (== after to confirm)
 * @property {number} countBefore rows the store-tap query returned before
 * @property {number} countAfter rows the store-tap query returned after
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
 * Reduce store-tap rows to the ONE comparable value a claim's entity binds, per the recipe-declared,
 * engine-shaped relation (recipe.mjs resolveObservable) — replacing n8n's hardcoded autoincrement
 * assumption: `row-count` (rows.length — a listing query), `max-id` (the max of an id-like
 * field/column, coerced to Number — n8n's autoincrement shape), `named-scalar` (the first row's
 * first field/column, verbatim). Rows are the raw store-tap shape for the engine: sqlite/k8s-exec
 * rows are objects (named columns, e.g. sqlite3 -json); postgres rows are string[] tuples (no
 * column names, tapPostgres). An empty read is a real "nothing yet" (0 for row-count/max-id,
 * undefined for named-scalar), never a throw.
 * @param {any[]} rows
 * @param {{relation:'row-count'|'max-id'|'named-scalar', field?:string, column?:number}} spec
 * @returns {any}
 */
export function observedValue(rows, spec) {
  const list = rows || [];
  if (spec.relation === 'row-count') return list.length;
  if (spec.relation === 'named-scalar') {
    const row = list[0];
    if (row === undefined) return undefined;
    if (Array.isArray(row)) return row[spec.column ?? 0];
    return row[spec.field || Object.keys(row)[0]];
  }
  // max-id (default)
  let m = 0;
  for (const row of list) {
    const raw = Array.isArray(row) ? row[spec.column ?? 0] : row[spec.field || 'id'];
    const n = Number(raw);
    if (Number.isFinite(n) && n > m) m = n;
  }
  return m;
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
    const before = binding.before;
    // A persisted change → after = the observed post-walk value (a real increase/change).
    // Executed but nothing persisted → after = before (no movement), so op:'increased' FALSIFIES
    // rather than sits NOT_EXECUTED.
    const after = binding.after != null ? binding.after : before;
    // The entity is the recipe-declared observable this reproduction bound (§6), falling back to
    // the agent's own claim.entity, then a generic label — never a hardcoded n8n-shaped constant.
    const entity = binding.entity || (claim ? claim.entity : DEFAULT_EFFECT_ENTITY);
    const delta = mintStoreDelta({
      id: 'store-delta',
      entity,
      before,
      after,
      identity,
      sourcePR: false,
      extra: {
        countBefore: binding.countBefore,
        countAfter: binding.countAfter,
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
          ...(binding.after !== undefined ? { after: binding.after } : {}),
        },
      })
    );
    effectReceiptIds.push('browser-drive');

    // Confirm leg (TOOL, fresh-session): a genuinely fresh, recipe-declared re-observation of the
    // SAME observable. `observed` content-binds it to the delta's `after` — a stale read that
    // disagrees cannot confirm (freshBinds). Emitted only when a persisted change existed to re-read.
    if (binding.after != null && binding.freshObserved !== undefined) {
      receipts.push(
        mint({
          id: 'fresh-execution',
          kind: 'fresh-session',
          provenance: 'tool',
          identity,
          data: { entity, after: binding.after, observed: binding.freshObserved },
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
 * Give the SUT a beat: re-read the store tap until the recipe-declared observable's value MOVES
 * off `before` (its engine-shaped relation, recipe.mjs resolveObservable) or the settle window
 * elapses. A polled settle (not a bare sleep) tolerates an async persist without racing it; if
 * nothing changes the last read is returned and the caller records a real negative (executed but
 * not persisted).
 * @param {(handle:any, queryName:string) => Promise<any[]>} tapStoreFn
 * @param {any} handle
 * @param {string} queryName
 * @param {{relation:'row-count'|'max-id'|'named-scalar', field?:string, column?:number}} spec
 * @param {any} before
 * @returns {Promise<{rows:any[], value:any}>}
 */
async function settleObservable(tapStoreFn, handle, queryName, spec, before) {
  const deadline = Date.now() + EXECUTION_SETTLE_MS;
  let rows = await tapStoreFn(handle, queryName);
  let value = observedValue(rows, spec);
  while (value === before && Date.now() < deadline) {
    await sleep(EXECUTION_POLL_MS);
    rows = await tapStoreFn(handle, queryName);
    value = observedValue(rows, spec);
  }
  return { rows, value };
}

/**
 * A single confirm-leg HTTP request through a minimal cookie jar — mirrors conjure.mjs's setup-step
 * runner (reusing its exported encodeSetupBody/absorbSetCookies so the wire format stays identical:
 * 'json' default, 'form' for a Django-style login), but over the INJECTED fetchFn (catch.mjs's seam)
 * rather than the global fetch, so the confirm leg is exercised network-free in tests.
 * @param {typeof fetch} fetchFn
 * @param {string} method
 * @param {string} url
 * @param {any} body
 * @param {Map<string,string>} jar
 * @param {string} [contentType]
 * @returns {Promise<{status:number, text:string, json:any}>}
 */
async function confirmHttpReq(fetchFn, method, url, body, jar, contentType) {
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
      const { contentTypeHeader, encoded } = encodeSetupBody(contentType, body);
      headers['Content-Type'] = contentTypeHeader;
      init.body = encoded;
    }
    const res = await fetchFn(url, init);
    absorbSetCookies(res, jar);
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(t);
  }
}

/**
 * The GENERIC confirm leg (§6): re-observe the persisted effect from a genuinely FRESH session (a
 * brand-new cookie jar, never conjure's setup jar) by walking the recipe's OWN `confirm[]` steps —
 * the EXACT setup-step schema (id/method/path/body/content_type/capture, slice A) — never an n8n-
 * specific REST dance. Auth for the fresh session reuses the recipe's existing auth_preflight
 * surface (a bootstrap cookie, same as conjure's setup dance); the confirm steps themselves carry
 * whatever login the recipe declares (its OWN content_type/capture, e.g. a Django form login + CSRF
 * capture). A `{value}` placeholder in a confirm step's path resolves to the harness-observed AFTER
 * value (e.g. `GET /rest/executions/{value}`), so a recipe can re-read exactly the entity the
 * harness saw move. The designated capture named `observed` (JSONPath or HTML regex, same as setup)
 * supplies the value freshBinds compares to the delta's `after`. No `confirm` steps declared, a
 * step failing, or no `observed` capture => an honest non-confirm (CND), never a fabricated one.
 * @param {Object} args
 * @param {typeof fetch} args.fetchFn
 * @param {import('./recipe.mjs').Recipe} args.recipe
 * @param {string} args.recipeDir
 * @param {string} args.baseUrl
 * @param {any} args.afterValue the harness-observed post-walk observable value (the `{value}` placeholder)
 * @returns {Promise<{observed?:any, reason?:string}>}
 */
async function runConfirmLeg({ fetchFn, recipe, recipeDir, baseUrl, afterValue }) {
  const steps = recipe.confirm || [];
  if (steps.length === 0) {
    return { reason: 'no confirm[] steps declared in the recipe — the fresh-session confirm leg is skipped (effect will CND)' };
  }
  /** @type {Map<string,string>} */
  const jar = new Map();
  if (recipe.auth_preflight) {
    await confirmHttpReq(fetchFn, recipe.auth_preflight.method, `${baseUrl}${recipe.auth_preflight.path}`, undefined, jar);
  }
  /** @type {Record<string,any>} */
  const captures = {};
  for (const step of steps) {
    let path;
    try {
      path = resolvePlaceholders(step.path, (n) => (n === 'value' ? afterValue : captures[n]));
    } catch (e) {
      return { reason: `confirm step "${step.id}" could not resolve its path: ${e instanceof Error ? e.message : String(e)}` };
    }
    let body;
    if (step.body_file !== undefined) body = JSON.parse(readFileSync(join(recipeDir, step.body_file), 'utf8'));
    else if (step.body !== undefined) body = step.body;
    if (body !== undefined) {
      try {
        body = resolveBodyPlaceholders(body, (n) => (n === 'value' ? afterValue : captures[n]));
      } catch (e) {
        return { reason: `confirm step "${step.id}" could not resolve its body: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const res = await confirmHttpReq(fetchFn, step.method, `${baseUrl}${path}`, body, jar, step.content_type);
    if (res.status < 200 || res.status >= 300) {
      return { reason: `confirm step "${step.id}" failed: HTTP ${res.status}` };
    }
    if (step.capture) {
      for (const [name, cap] of Object.entries(step.capture)) {
        captures[name] = typeof cap === 'string' ? extractJsonPath(res.json, cap) : extractHtml(res.text, cap.pattern);
      }
    }
  }
  if (!('observed' in captures) || captures.observed === undefined) {
    return { reason: "confirm[] steps ran but none captured a value named 'observed' — nothing to bind the confirm leg to" };
  }
  return { observed: captures.observed };
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
  const fetchFn = opts.fetchFn || /** @type {typeof fetch} */ (fetch);
  const runDir = opts.runDir || mkdtempSync(join(tmpdir(), 'pb-catch-'));

  const recipe = loadRecipe(recipeDir);
  // drive.mode DISPATCH (M3): the argo-workflows drive is a structurally different leg (submit a
  // Workflow DAG, observe THAT run out-of-band) so it runs its own iteration path. The browser loop
  // below is untouched (#7130 stays byte-identical). Grandfathered modes all browser-drive here.
  if (recipe.drive && recipe.drive.mode === 'argo-workflows') {
    return runArgoCatch(opts, recipe, runDir);
  }
  // Config-keyed registry = the DEFAULT phase-seam wiring; an injected seam still WINS over it
  // (unit tests inject mocks). See src/registry.mjs.
  const { conjureFn, tapStoreFn, openBrowserFn } = resolveCatchSeams(opts, recipe);
  const sha = buildSha || /** @type {import('./recipe.mjs').FromTreeIdentity} */ (recipe.code_identity).sha || '';
  const queryName = Object.keys(recipe.store_tap.queries)[0];
  // The observable spec (§6) — the recipe-declared, engine-shaped relation (recipe.mjs
  // resolveObservable) this Catch taps and binds its effect claim to, replacing the hardcoded
  // n8n execution_entity.max_id assumption.
  const spec = resolveObservable(recipe.store_tap, queryName);
  const intent = opts.intent || `A visitor submitting the ${recipe.name} front door persists an execution, reproduced across fresh worlds (SHA ${sha.slice(0, 7)}).`;
  // The harness-enumerated observable menu — EXACTLY the reading the fresh-session confirm leg
  // binds to. The agent's claim entity must come from here (FW-P1-C).
  const observables = [spec.entity];

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
    /** @type {(() => (void|Promise<void>))|null} */ let browserReap = null;
    try {
      handle = await conjureFn(recipeDir, buildSha ? { buildSha } : {});
      const beforeRows = await tapStoreFn(handle, queryName);
      const countBefore = beforeRows.length;
      const before = observedValue(beforeRows, spec);

      client = await openBrowserFn({ hostPort: 4444 + i });
      // Reap the browser sidecar on interrupt too: a SIGINT/SIGTERM bypasses the finally below and
      // leaks pb-chromium-*. Register a best-effort teardown (de-registered on normal teardown) — the
      // same register-on-bring-up / drop-on-teardown pattern conjure uses for the SUT. See reaper.mjs.
      browserReap = registerReap(async () => { try { await client?.teardown(); } catch { /* sidecar already gone */ } });
      // Cookie-inject (§6): a login-gated front door needs the setup dance's session cookies in the
      // BROWSER before it navigates there — W3C Add Cookie is origin-scoped, so land on the SUT's
      // origin first. A no-op when the recipe's setup minted no cookies (n8n) or the seam predates
      // addCookie (older BrowserClient mocks).
      if (handle.cookies && handle.cookies.length && typeof client.addCookie === 'function') {
        await client.navigate(handle.baseUrl);
        for (const cookie of handle.cookies) await client.addCookie(cookie);
      }
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

      const { rows: afterRows, value: after } = await settleObservable(tapStoreFn, handle, queryName, spec, before);
      const countAfter = afterRows.length;
      const changed = after !== before;

      let freshObserved;
      let confirmReason;
      if (changed) {
        const confirm = await runConfirmLeg({ fetchFn, recipe, recipeDir, baseUrl: handle.baseUrl, afterValue: after });
        freshObserved = confirm.observed;
        confirmReason = confirm.reason;
        if (confirmReason) diagnosis.push(`catch: ${confirmReason}`);
      }
      const effectHeld = changed && freshObserved !== undefined && freshObserved === after;
      const reason = effectHeld
        ? undefined
        : !changed
          ? 'the walk ran but the bound observable did not change'
          : freshObserved === undefined
            ? confirmReason || 'a fresh re-observation could not confirm the effect (confirm leg absent)'
            : `the fresh re-observation (${freshObserved}) disagreed with the store delta (${after})`;

      iterations.push({
        executed: true,
        effectHeld,
        before,
        after,
        entity: spec.entity,
        freshObserved,
        countBefore,
        countAfter,
        driveSteps: client.steps,
        observedText,
        frontDoorUrl: handle.frontDoorUrl,
        fingerprint: handle.receipts.find((r) => r.kind === 'fingerprint'),
        reason,
      });
      if (effectHeld) {
        diagnosis.push(`catch: reproduction ${i} — ${spec.entity} ${before} → ${after}; a fresh re-observation agreed (confirm leg holds).`);
      } else {
        diagnosis.push(`catch: reproduction ${i} executed the walk but did not confirm the effect: ${reason}.`);
      }
    } catch (e) {
      const reason = String((e && /** @type {any} */ (e).message) || e);
      diagnosis.push(`catch: reproduction ${i} could not execute the walk (feature-absent / conjure-drive error, not evidence against the change): ${reason}`);
      iterations.push({ executed: false, effectHeld: false, before: 0, countBefore: 0, countAfter: 0, reason });
    } finally {
      if (client) {
        try {
          await client.teardown();
        } catch {
          /* sidecar already gone */
        }
      }
      if (browserReap) deregisterReap(browserReap); // normal teardown ran → drop the interrupt-reap (no double-reap)
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

// ---------------------------------------------------------------------------
// The ARGO WORKFLOWS Catch — drive.mode:'argo-workflows' (M3)
// ---------------------------------------------------------------------------

/**
 * One argo reproduction's observed outcome — the raw facts assembleArgoBundle turns into receipts.
 * Mirrors CatchIteration's executed/effectHeld partition exactly: `executed:false` = a mint
 * precondition could not even be VERIFIED (submit failed / pin ambiguous / watch timed out / digest
 * unbound / tap threw) → NO delta minted → NOT_EXECUTED → CND. `executed:true` with `effectHeld:false`
 * = every precondition held and the nonce-scoped tap RAN, but the nonce did not round-trip (a real
 * negative) → a non-satisfying delta (before==after) → FALSIFIED.
 * @typedef {Object} ArgoIteration
 * @property {boolean} executed the pinned run reached terminal, the digest bound, and the tap ran
 * @property {boolean} effectHeld the nonce round-tripped into the store AND a second independent read agreed
 * @property {number} before nonce-scoped rows before (always 0 — a fresh globally-unique nonce has no prior rows)
 * @property {number} after nonce-scoped rows after the run
 * @property {string} [nonce] the run-scoped nonce pb generated (public pin correlation)
 * @property {string} [readbackNonce] the nonce READ BACK from the store in the delta tap (never stamped)
 * @property {string} [confirmNonce] the nonce read from a SECOND independent out-of-band observation
 * @property {string} [name] the observed workflow run name
 * @property {string} [phase] the observed terminal phase (attempt-receipt only, never a delta)
 * @property {string[]} [digests] the observed step-pod imageIDs
 * @property {string} [boundDigest] the SHA-under-test digest pb bound (code_identity.image_digest)
 * @property {string} [entity] the nonce-scoped store observable
 * @property {import('./argoworkflows.mjs').DriveStep[]} [driveSteps] the recorded run
 * @property {import('./types.mjs').Receipt} [fingerprint] the harness code-identity receipt
 * @property {string} [reason] why this reproduction did not confirm the effect
 */

/**
 * Assemble the argo evidence bundle from the reproduction outcomes — PURE, mirroring
 * assembleCatchBundle. The binding iteration is the FIRST that executed. HONESTY (requiredFix 2/8 —
 * the vacuous-confirm guard): the store-delta's `nonce` is the value READ BACK from the store
 * (binding.readbackNonce), and the confirm leg's `nonce` is read from a SECOND, genuinely
 * independent out-of-band observation (binding.confirmNonce) — NEITHER is the harness-generated UUID
 * stamped blindly, so freshBinds is satisfied only when two independent reads agree. When either
 * read did not re-observe the nonce, that field is absent → no valid confirm leg → CND. The workflow
 * attempt is TOOL (mintWorkflowAttempt); the HARNESS delta is the sole minter (mintStoreDelta).
 * @param {Object} args
 * @param {any} args.intent
 * @param {ArgoIteration[]} args.iterations
 * @param {import('./proposer.mjs').ProposedClaim} [args.claim] the FROZEN agent-proposed effect claim
 * @param {string} [args.actorIdentity]
 * @param {string} [args.identity]
 * @returns {import('./types.mjs').EvidenceBundle}
 */
export function assembleArgoBundle({ intent, iterations, claim, actorIdentity = ACTOR_IDENTITY, identity = VISITOR_IDENTITY }) {
  const its = iterations || [];
  const binding = its.find((it) => it.executed);
  const fingerprint = (its.find((it) => it.fingerprint) || {}).fingerprint;

  /** @type {import('./types.mjs').Receipt[]} */
  const receipts = [];
  if (fingerprint) receipts.push(fingerprint);
  /** @type {string[]} */
  const effectReceiptIds = [];

  if (binding) {
    const before = binding.before || 0;
    // Nonce round-tripped → after > before (a real increase). Ran but no nonce row → after = before
    // (no increase), so op:'increased' FALSIFIES rather than sits NOT_EXECUTED.
    const after = binding.after != null ? binding.after : before;
    const delta = mintStoreDelta({
      id: 'store-delta',
      entity: binding.entity || (claim ? claim.entity : 'argo.effect'),
      before,
      after,
      identity,
      sourcePR: false,
      extra: {
        ...(binding.name !== undefined ? { workflowName: binding.name } : {}),
        ...(binding.boundDigest !== undefined ? { boundDigest: binding.boundDigest } : {}),
        // The nonce READ BACK from the store out-of-band (only present when it round-tripped). The
        // terminal PHASE is deliberately NOT carried on the delta — phase is not the oracle; it lives
        // strictly in the TOOL attempt receipt.
        ...(binding.readbackNonce !== undefined ? { nonce: binding.readbackNonce } : {}),
      },
    });
    receipts.push(delta);
    effectReceiptIds.push('store-delta');

    // Workflow attempt (TOOL): the trigger + observed phase transitions + observed digests. The
    // terminal PHASE lives ONLY here (never a delta) — phase is not the oracle.
    receipts.push(
      mintWorkflowAttempt({
        id: 'argo-drive',
        name: binding.name || '',
        nonce: binding.nonce || '',
        phase: binding.phase || '',
        steps: binding.driveSteps || [],
        digests: binding.digests,
        identity,
      })
    );
    effectReceiptIds.push('argo-drive');

    // Confirm leg (TOOL, fresh-session): the nonce read from a SECOND independent out-of-band
    // observation. It content-binds to the delta via the shared store-read nonce (freshBinds). Emitted
    // ONLY when the run persisted AND the independent read re-observed the nonce.
    if (binding.after != null && binding.confirmNonce !== undefined) {
      receipts.push(
        mint({
          id: 'argo-confirm',
          kind: 'fresh-session',
          provenance: 'tool',
          identity,
          data: { entity: binding.entity || (claim ? claim.entity : 'argo.effect'), nonce: binding.confirmNonce, workflowName: binding.name },
        })
      );
      effectReceiptIds.push('argo-confirm');
    }
  }

  const quantified = quantifierFromIntent(intent) || !!(claim && claim.quantified);
  /** @type {import('./types.mjs').Claim[]} */
  const claims = claim
    ? [
        {
          id: 'workflow-run-persists-effect',
          kind: 'effect',
          scope: claim.scope,
          ...(quantified ? { quantified: true } : {}),
          effectCheck: {
            entity: claim.entity,
            expectedAfterRelation: claim.expectedAfterRelation,
            deltaReceiptId: 'store-delta',
            confirmLegReceiptId: 'argo-confirm',
          },
          receiptIds: effectReceiptIds,
        },
      ]
    : [];

  const k = its.filter((it) => it.effectHeld).length;
  const kFail = its.filter((it) => it.executed && !it.effectHeld).length;
  return newBundle({ intent, actorIdentity, claims, receipts, reproduce: { k, n: its.length, kFail } });
}

/**
 * Read + JSON-parse the recipe's Argo Workflow manifest (recipe.mjs already validated it at load).
 * @param {string} recipeDir
 * @param {string} manifestFile
 * @returns {any}
 */
function loadArgoManifest(recipeDir, manifestFile) {
  return JSON.parse(readFileSync(join(recipeDir, manifestFile), 'utf8'));
}

/**
 * Run the ARGO WORKFLOWS Catch across REPRODUCTIONS nonce-scoped runs. Per reproduction the harness
 * mints a FRESH globally-unique nonce, stamps + submits the Workflow CR, and enforces the THREE
 * guardrails as MINT PRECONDITIONS (doc v2 §3 — the runner DECLINES to tap/mint a satisfying delta
 * unless each holds):
 *   1. SINGLE-RUN PINNING (P3): pinCheck — the pb.run/nonce label resolves to EXACTLY the submitted
 *      run; 0 or >1 (a concurrent same-label run) throws → could-not-execute → CND.
 *   2. DIGEST<->SHA BINDING (P1/P4): the selected step-pod imageID must bind the DISCLOSED
 *      code_identity digest; unbound / pods GC'd / cache-hit → throw → CND.
 *   3. NONCE ROUND-TRIP (P2): the store is tapped OUT-OF-BAND with the nonce-scoped query TWICE
 *      independently; the delta's nonce is the value READ BACK (never stamped) and the confirm leg is
 *      a genuinely independent second observation. Absent readback → no satisfying delta.
 * Any UNVERIFIED precondition throws → executed:false → NO delta → CND by construction. A verified
 * run whose nonce did not round-trip is a real negative (executed:true, effectHeld:false → FALSIFIED).
 * The frozen core is untouched; the effect claim is agent-proposed (a one-op 'trigger' + claim).
 * @param {any} opts the runCatch opts (recipeDir, buildSha, intent, proposal, llmFn, argoRunFn, argoTapFn, kubectl)
 * @param {import('./recipe.mjs').Recipe} recipe the loaded recipe (drive.mode === 'argo-workflows')
 * @param {string} runDir directory to persist the sealed receipt into
 * @returns {Promise<CatchResult>}
 */
async function runArgoCatch(opts, recipe, runDir) {
  const { recipeDir } = opts;
  const { argoRunFn, argoTapFn } = resolveArgoSeams(opts, recipe);
  const argo = /** @type {import('./recipe.mjs').ArgoDrive} */ (recipe.drive.argo);
  const st = /** @type {import('./recipe.mjs').K8sExecStoreTap} */ (recipe.store_tap);
  const ci = /** @type {import('./recipe.mjs').PinnedImageIdentity} */ (recipe.code_identity);
  const queryName = Object.keys(st.queries)[0];
  const boundDigest = ci.image_digest; // the DISCLOSED SHA<->digest binding, read independently by pb (F2: never the CI ref)
  const observables = [st.entity]; // the harness-enumerated observable menu (the agent's claim must bind this)
  const sha = boundDigest || '';
  const intent =
    opts.intent ||
    `A ${recipe.name} note run driven as an Argo Workflow persists ${st.entity}, reproduced across nonce-scoped runs (image ${String(boundDigest).slice(0, 19)}).`;
  const manifest = loadArgoManifest(recipeDir, argo.manifest_file);

  /** @type {string[]} */
  const diagnosis = [];
  /** @type {ArgoIteration[]} */
  const iterations = [];
  /** @type {import('./proposer.mjs').Proposal|null} */
  let proposal = opts.proposal || null;
  let proposalFrozen = !!proposal;

  for (let i = 0; i < REPRODUCTIONS; i++) {
    const nonce = randomUUID(); // fresh, globally-unique, harness-minted per iteration (P2/P7 uniqueness)
    /** @type {import('./argoworkflows.mjs').WorkflowRunClient|null} */ let client = null;
    /** @type {(() => (void|Promise<void>))|null} */ let workflowReap = null;
    try {
      // Freeze the agent proposal ONCE (mirrors runCatch): a one-op 'trigger' + the effect claim,
      // proposed against DISCLOSED data (the manifest's templates/container), replayed verbatim.
      if (!proposal && !proposalFrozen) {
        proposalFrozen = true;
        const introspection = { workflow: argo.manifest_file, container: argo.container, templates: (manifest && manifest.spec && manifest.spec.templates ? manifest.spec.templates : []).map((/** @type {any} */ t) => t && t.name).filter(Boolean) };
        proposal = await proposeWalkAndClaim({ intent, introspection, observables }, { llmFn: opts.llmFn, allowedOps: ALLOWED_ARGO_OPS });
        diagnosis.push(`argo: agent proposed a ${proposal.walk.length}-step trigger claiming ${proposal.claim.entity} ${proposal.claim.expectedAfterRelation.op} — frozen and replayed verbatim across reproductions.`);
      }
      if (!proposal) throw new Error('the agent seam produced no valid trigger+claim (frozen as unavailable) — could-not-execute');

      client = await argoRunFn({ namespace: argo.namespace, kubectl: opts.kubectl });
      // Reap the workflow run (by its nonce label) on interrupt too; de-registered on normal teardown.
      workflowReap = registerReap(async () => { try { await client?.teardown(nonce); } catch { /* already reaped */ } });
      const name = await client.submit(stampManifest(manifest, { nonceParameter: argo.nonce_parameter, nonce }));

      // GUARDRAIL 1 — SINGLE-RUN PINNING (P3): observe EXACTLY the submitted run.
      if (!(await client.pinCheck(nonce, name))) {
        throw new Error(`single-run pinning failed — the pb.run/nonce label did not resolve to exactly the submitted workflow ${name} (0 or >1 matches: a concurrent same-label run) → CND`);
      }
      // Observe THAT run to a terminal phase (bounded → throw → CND). Phase is NOT the oracle.
      const { phase } = await client.awaitTerminal(name);
      // GUARDRAIL 2 — DIGEST<->SHA BINDING (P1/P4): the step-pod imageID must bind the SHA under test.
      const digests = await client.podDigests(name, argo.container);
      if (!digests.some((d) => digestBinds(d, boundDigest))) {
        throw new Error(`digest<->SHA binding failed — no '${argo.container}' pod imageID bound to the code under test (${boundDigest}); observed=[${digests.join(', ') || "(none — pods GC'd / cache-hit / wrong selector)"}] → CND`);
      }
      // GUARDRAIL 3 — NONCE ROUND-TRIP (P2): tap OUT-OF-BAND with the nonce-scoped query, TWICE
      // independently. before is 0 by construction (a fresh globally-unique nonce has no prior rows).
      const tapHandle = { recipe, namespace: argo.namespace, name, nonce };
      const deltaRows = await argoTapFn(tapHandle, queryName, nonce);
      const readbackNonce = nonceFromRows(deltaRows, nonce);
      const after = (deltaRows || []).length;
      const confirmRows = await argoTapFn(tapHandle, queryName, nonce);
      const confirmNonce = nonceFromRows(confirmRows, nonce);
      const before = 0;
      const effectHeld = after > before && readbackNonce === nonce && confirmNonce === nonce;
      const reason = effectHeld
        ? undefined
        : readbackNonce !== nonce
          ? 'the nonce did not round-trip into the store (no nonce-scoped row) — a real negative'
          : confirmNonce !== nonce
            ? 'the independent confirm read did not re-observe the nonce (confirm leg absent)'
            : 'no store delta';

      iterations.push({
        executed: true,
        effectHeld,
        before,
        after,
        nonce,
        readbackNonce,
        confirmNonce,
        name,
        phase,
        digests,
        boundDigest,
        entity: st.entity,
        driveSteps: client.steps,
        fingerprint: mint({ id: 'fingerprint', kind: 'fingerprint', provenance: 'harness', data: { mode: 'pinned_image', image_ref: ci.image_ref, image_digest: boundDigest, workflow: name } }),
        reason,
      });
      diagnosis.push(
        effectHeld
          ? `argo: reproduction ${i} — workflow ${name} (${phase}) wrote the nonce-scoped effect; a second independent out-of-band read re-observed the nonce (confirm leg agrees).`
          : `argo: reproduction ${i} executed but did not confirm the effect: ${reason}.`
      );
    } catch (e) {
      const reason = String((e && /** @type {any} */ (e).message) || e);
      diagnosis.push(`argo: reproduction ${i} could not execute (an UNVERIFIED mint precondition — feature-absent / could-not-execute, not evidence against the change): ${reason}`);
      iterations.push({ executed: false, effectHeld: false, before: 0, after: 0, reason });
    } finally {
      if (client) {
        try {
          await client.teardown(nonce);
        } catch {
          /* already reaped */
        }
      }
      if (workflowReap) deregisterReap(workflowReap); // normal teardown ran → drop the interrupt-reap (no double-reap)
    }
  }

  const bundle = assembleArgoBundle({ intent, iterations, claim: proposal ? proposal.claim : undefined, actorIdentity: ACTOR_IDENTITY, identity: VISITOR_IDENTITY });
  const { privateKey } = generateKeyPairSync('ed25519');
  const receiptPath = persistCatchReceipt(runDir, sha, sealBundle(bundle, privateKey));
  const persisted = /** @type {import('./types.mjs').EvidenceBundle} */ (JSON.parse(readFileSync(receiptPath, 'utf8')));
  return { phase: 'catch', sha, verdict: sealedVerdict(persisted), diagnosis, bundle: persisted, receiptPath, proposal };
}
