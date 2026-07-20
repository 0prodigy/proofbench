// @ts-check
/**
 * Catch bundle-assembly tests — DOCKER-FREE and NETWORK-FREE. The live conjure→browser-drive→tap
 * plumbing is proven by `pb prove`; here the PURE assembler is exercised with hand-built
 * reproductions AND a hand-built AGENT PROPOSAL (no LLM) so every verdict branch is nailed without a
 * container:
 *   - two confirmed persists (merge-shaped) → WORKS, with the exact receipt/claim shapes AND the
 *     claim entity/relation/scope threaded FROM the proposal (Unknown #2: not hardcoded)
 *   - no reproduction executed (parent-shaped, feature-absent) → no delta → CND (NOT_EXECUTED)
 *   - the walk ran but nothing persisted, reproduced → the delta FALSIFIES → DOES_NOT_WORK
 *   - a single confirmed walk (k=1) → CND (a single walk is never WORKS, FW-6)
 *   - a fresh re-read that DISAGREES with the store cannot confirm → CND (the dual-leg guard)
 * plus the pure `observedValue` helper (the generic, engine-shaped relation reducer — §6) the live
 * path relies on, and a seam-driven runCatch (mock llmFn + docker-free seams) that seals + persists
 * + judges the on-disk artifact.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { assembleCatchBundle, observedValue, confirmAgrees, normalizeEqualsClaimValue, sealedVerdict, persistCatchReceipt, runCatch } from '../src/catch.mjs';
import { verdict } from '../src/verdict.mjs';
import { sealBundle, verifySeal } from '../src/evidence.mjs';
import { Verdict } from '../src/types.mjs';
import { mint, isMinted } from '../src/harness.mjs';

/** @param {any} x @returns {any} */
const asAny = (x) => x;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const N8N_RECIPE = join(ROOT, 'recipes', 'n8n-form-trigger-pr7130');

/**
 * A hand-built AGENT proposal claim (what proposer.validateProposal yields for the n8n recipe) —
 * entity in the disclosed observable menu, the frozen relation set, and a scope. assembleCatchBundle
 * threads THIS into the effect claim (not a hardcoded one).
 * @type {import('../src/proposer.mjs').ProposedClaim}
 */
const PROPOSED_CLAIM = {
  entity: 'execution_entity.max_id',
  expectedAfterRelation: { op: 'increased' },
  scope: 'a visitor submitting the Form Trigger front door persists an execution',
};

/**
 * A minted harness code-identity fingerprint (as conjure would produce), for a given sha.
 * @param {string} sha
 */
function fingerprint(sha) {
  return mint({ id: 'fingerprint', kind: 'fingerprint', provenance: 'harness', data: { mode: 'from_tree', sha, container: `pb-sut-${sha}` } });
}

/**
 * A reproduction where the form submit persisted an execution and the fresh re-read agreed.
 * @param {number} i
 * @param {{after?:number, freshObserved?:number, sha?:string}} [o]
 * @returns {import('../src/catch.mjs').CatchIteration}
 */
function heldIteration(i, { after = 1, freshObserved = after, sha = 'MERGE' } = {}) {
  return {
    executed: true,
    effectHeld: freshObserved === after,
    before: 0,
    after,
    freshObserved,
    countBefore: 0,
    countAfter: 1,
    driveSteps: [
      { op: 'navigate', url: 'http://host.docker.internal:5678/webhook/abc/n8n-form' },
      { op: 'type', elementId: 'el-1', text: `nonce-${i}` },
      { op: 'click', elementId: 'el-2' },
    ],
    observedText: 'Your response has been recorded',
    frontDoorUrl: 'http://localhost:5678/webhook/abc/n8n-form',
    fingerprint: fingerprint(sha),
    reason: undefined,
  };
}

/**
 * A reproduction the walk could not even run (conjure/drive threw = feature-absent).
 * @param {string} [reason]
 * @returns {import('../src/catch.mjs').CatchIteration}
 */
function absentIteration(reason = 'the front door served no fillable form field — the Form Trigger is absent at this SHA') {
  return { executed: false, effectHeld: false, before: 0, countBefore: 0, countAfter: 0, reason };
}

/**
 * A reproduction where the walk RAN but nothing persisted (a present-but-broken feature).
 * @param {number} i
 * @param {{sha?:string}} [o]
 * @returns {import('../src/catch.mjs').CatchIteration}
 */
function ranButUnpersistedIteration(i, { sha = 'MERGE' } = {}) {
  return {
    executed: true,
    effectHeld: false,
    before: 0,
    after: undefined,
    freshObserved: undefined,
    countBefore: 0,
    countAfter: 0,
    driveSteps: [{ op: 'navigate', url: 'http://host.docker.internal:5678/webhook/abc/n8n-form' }],
    frontDoorUrl: 'http://localhost:5678/webhook/abc/n8n-form',
    fingerprint: fingerprint(sha),
    reason: 'the walk ran but no execution persisted in execution_entity',
  };
}

test('catch helpers: observedValue reduces store-tap rows per the engine-shaped relation (row-count | max-id | named-scalar)', () => {
  // row-count: engine-agnostic — just how many rows the query returned.
  assert.equal(observedValue([], { relation: 'row-count' }), 0);
  assert.equal(observedValue([{ id: 1 }, { id: 2 }], { relation: 'row-count' }), 2);
  assert.equal(observedValue([[1], [2], [3]], { relation: 'row-count' }), 3); // postgres tuples count the same
  // max-id: sqlite/k8s-exec object rows, default field 'id', coerced to Number.
  assert.equal(observedValue([], { relation: 'max-id' }), 0);
  assert.equal(observedValue([{ id: 1 }, { id: 3 }, { id: 2 }], { relation: 'max-id' }), 3);
  assert.equal(observedValue([{ id: '5' }, { id: '2' }], { relation: 'max-id' }), 5); // string ids coerced
  assert.equal(observedValue([{ pk: 7 }], { relation: 'max-id', field: 'pk' }), 7); // recipe-declared field override
  // max-id: postgres tuples, default column 0.
  assert.equal(observedValue([['1'], ['9'], ['4']], { relation: 'max-id' }), 9);
  assert.equal(observedValue([['x', '2']], { relation: 'max-id', column: 1 }), 2);
  // named-scalar: sqlite object row — the sole value of the first row's first field (or a declared one).
  assert.equal(observedValue([], { relation: 'named-scalar' }), undefined);
  assert.equal(observedValue([{ n: '3' }], { relation: 'named-scalar' }), '3'); // documenso's SELECT count(*) AS n shape
  assert.equal(observedValue([{ a: 1, b: 2 }], { relation: 'named-scalar', field: 'b' }), 2);
  // named-scalar: postgres tuple — column 0 (or a declared one), verbatim (no coercion).
  assert.equal(observedValue([['3']], { relation: 'named-scalar' }), '3');
  assert.equal(observedValue([['x', '9']], { relation: 'named-scalar', column: 1 }), '9');
});

test('catch helpers: confirmAgrees coerces the SAME boolean-shaped column\'s two honest representations (sqlite INTEGER 0/1 vs a JSON API boolean), never a real disagreement', () => {
  assert.equal(confirmAgrees(1, 1), true); // exact match, no coercion needed
  assert.equal(confirmAgrees(true, 1), true); // linkding: API returns JSON boolean, store tap reads sqlite INTEGER
  assert.equal(confirmAgrees(false, 0), true);
  assert.equal(confirmAgrees(true, 0), false); // a genuine disagreement still fails
  assert.equal(confirmAgrees(false, 1), false);
  assert.equal(confirmAgrees('1', 1), true); // an HTML-regex capture returning a numeral string
  assert.equal(confirmAgrees('0', 1), false);
  assert.equal(confirmAgrees(undefined, 1), false);
  assert.equal(confirmAgrees('abc', 1), false); // non-numeric string never silently agrees
});

test("catch helpers: normalizeEqualsClaimValue aligns an 'equals' claim's boolean/numeral TYPE to the observed store value's, never its meaning", () => {
  // linkding shape: the agent proposes 'the shared column equals true', the store tap reads sqlite's 0/1.
  assert.deepEqual(normalizeEqualsClaimValue({ op: 'equals', value: true }, 1), { op: 'equals', value: 1 });
  assert.deepEqual(normalizeEqualsClaimValue({ op: 'equals', value: false }, 0), { op: 'equals', value: 0 });
  // the reverse direction (observed already boolean, claim numeric) also coerces.
  assert.deepEqual(normalizeEqualsClaimValue({ op: 'equals', value: 1 }, true), { op: 'equals', value: true });
  // a genuine disagreement is NOT laundered into an agreement by the coercion: it only aligns
  // TYPE (true -> 1, unconditionally), so the mismatch (1 vs the real observed 0) still surfaces
  // at verdict.mjs's deepEqual, unaffected by this helper.
  assert.deepEqual(normalizeEqualsClaimValue({ op: 'equals', value: true }, 0), { op: 'equals', value: 1 });
  // untouched: non-'equals' ops, and 'equals' whose value isn't a bool/number pair.
  assert.deepEqual(normalizeEqualsClaimValue({ op: 'increased' }, 1), { op: 'increased' });
  assert.deepEqual(normalizeEqualsClaimValue({ op: 'equals', value: 'archived' }, 'archived'), { op: 'equals', value: 'archived' });
  assert.equal(normalizeEqualsClaimValue(undefined, 1), undefined);
});

test('catch assembly: two confirmed persists (merge-shaped) => WORKS with the exact receipt + claim shapes (claim FROM the proposal)', () => {
  const bundle = assembleCatchBundle({ intent: 'form submit persists an execution', claim: PROPOSED_CLAIM, iterations: [heldIteration(0), heldIteration(1)] });
  const v = verdict(bundle);
  assert.equal(v.state, Verdict.WORKS, v.reasons.join(' | '));
  assert.deepEqual(bundle.reproduce, { k: 2, n: 2, kFail: 0 });

  const byId = (/** @type {string} */ id) => bundle.receipts.find((r) => r.id === id);
  // store-delta: HARNESS ground truth, a real increase (0 -> 1), minted (not a labeled look-alike)
  const delta = byId('store-delta');
  assert.ok(delta, 'store-delta present');
  assert.equal(delta.provenance, 'harness');
  assert.equal(delta.kind, 'delta');
  assert.equal(delta.sourcePR, false);
  assert.equal(delta.data.before, 0);
  assert.equal(delta.data.after, 1);
  assert.equal(delta.data.entity, 'execution_entity.max_id');
  assert.ok(isMinted(delta));
  // confirm leg: TOOL fresh-session, observed content-bound to the delta's after
  const fresh = byId('fresh-execution');
  assert.ok(fresh, 'fresh-execution present');
  assert.equal(fresh.provenance, 'tool');
  assert.equal(fresh.kind, 'fresh-session');
  assert.equal(fresh.data.observed, 1);
  assert.equal(fresh.data.observed, delta.data.after); // freshBinds: observed === after
  assert.ok(isMinted(fresh));
  // browser attempt: TOOL, the driven walk
  const attempt = byId('browser-drive');
  assert.ok(attempt, 'browser-drive present');
  assert.equal(attempt.provenance, 'tool');
  assert.equal(attempt.kind, 'attempt');
  assert.ok(Array.isArray(attempt.data.steps) && attempt.data.steps.length >= 1);
  assert.ok(isMinted(attempt));
  // code-identity fingerprint carried (binds the built SHA)
  const fp = byId('fingerprint');
  assert.ok(fp && fp.data.sha === 'MERGE', 'fingerprint binds the built sha');
  // ONE effect claim, its entity/relation/scope threaded FROM the proposal (Unknown #2), not hardcoded
  assert.equal(bundle.claims.length, 1);
  const claim = bundle.claims[0];
  assert.equal(claim.kind, 'effect');
  assert.equal(claim.quantified, undefined);
  assert.equal(claim.scope, PROPOSED_CLAIM.scope); // scope FROM the proposal
  const ec = /** @type {import('../src/types.mjs').EffectCheck} */ (claim.effectCheck);
  assert.equal(ec.entity, PROPOSED_CLAIM.entity); // entity FROM the proposal (in the disclosed menu)
  assert.deepEqual(ec.expectedAfterRelation, { op: 'increased' }); // relation FROM the proposal
  assert.equal(ec.deltaReceiptId, 'store-delta');
  assert.equal(ec.confirmLegReceiptId, 'fresh-execution');
});

test('catch assembly: no reproduction executed (parent-shaped, feature-absent) => CND, no delta, effect NOT_EXECUTED', () => {
  const bundle = assembleCatchBundle({ intent: 'x', claim: PROPOSED_CLAIM, iterations: [absentIteration(), absentIteration()] });
  const v = verdict(bundle);
  assert.equal(v.state, Verdict.COULD_NOT_DETERMINE, v.reasons.join(' | '));
  assert.deepEqual(bundle.reproduce, { k: 0, n: 2, kFail: 0 }); // feature-absent counts toward NEITHER
  assert.equal(bundle.receipts.find((r) => r.id === 'store-delta'), undefined); // no delta emitted → nothing to falsify
  const effect = v.scoreboard.find((s) => s.kind === 'effect');
  assert.equal(effect?.state, 'NOT_EXECUTED');
  assert.match(v.reasons.join(' '), /delta receipt missing|NOT_EXECUTED/);
});

test('catch assembly: the walk ran but nothing persisted, reproduced => the delta FALSIFIES => DOES_NOT_WORK', () => {
  const bundle = assembleCatchBundle({ intent: 'x', claim: PROPOSED_CLAIM, iterations: [ranButUnpersistedIteration(0), ranButUnpersistedIteration(1)] });
  const v = verdict(bundle);
  assert.equal(v.state, Verdict.DOES_NOT_WORK, v.reasons.join(' | '));
  assert.deepEqual(bundle.reproduce, { k: 0, n: 2, kFail: 2 }); // executed-but-unheld => kFail
  const delta = bundle.receipts.find((r) => r.id === 'store-delta');
  assert.ok(delta && delta.data.before === delta.data.after, 'no-increase delta (before == after)'); // op:increased FALSIFIES
});

test('catch assembly: a single confirmed walk (k=1) => CND (a single walk is never WORKS)', () => {
  const bundle = assembleCatchBundle({ intent: 'x', claim: PROPOSED_CLAIM, iterations: [heldIteration(0), absentIteration()] });
  const v = verdict(bundle);
  assert.equal(v.state, Verdict.COULD_NOT_DETERMINE, v.reasons.join(' | '));
  assert.equal(bundle.reproduce.k, 1);
  assert.match(v.reasons.join(' '), /k=1|k >= 2|single walk/i);
});

test('catch assembly: a fresh re-read that DISAGREES with the store cannot confirm => CND (dual-leg guard)', () => {
  // after=1 persisted, but the fresh re-observation observed a different value (2) — stale/inconsistent.
  const stale = [heldIteration(0, { after: 1, freshObserved: 2 }), heldIteration(1, { after: 1, freshObserved: 2 })];
  const bundle = assembleCatchBundle({ intent: 'x', claim: PROPOSED_CLAIM, iterations: stale });
  const v = verdict(bundle);
  assert.equal(v.state, Verdict.COULD_NOT_DETERMINE, v.reasons.join(' | ')); // NOT_EXECUTED (no valid confirm leg), never WORKS
  const fresh = bundle.receipts.find((r) => r.id === 'fresh-execution');
  assert.ok(fresh && fresh.data.observed !== bundle.receipts.find((r) => r.id === 'store-delta')?.data.after, 'confirm leg disagrees with the delta');
  assert.match(v.reasons.join(' '), /confirm leg|fresh-session/i);
});

// ── M7 slice 1: seal + persist — the verdict is bound to tamper-evident evidence ──────
//
// After assembly the Catch bundle is SEALED (ed25519) and PERSISTED to a run dir; the verdict is
// computed by RE-READING that on-disk artifact through sealedVerdict. A receipt mutated after
// sealing fails verifySeal → UNVERIFIED (contents not trusted), so a tamper can never green.

test('sealedVerdict: an unsealed bundle is disposed by the pure verdict (transparent passthrough)', () => {
  const bundle = assembleCatchBundle({ intent: 'x', claim: PROPOSED_CLAIM, iterations: [heldIteration(0), heldIteration(1)] });
  assert.equal(bundle.seal, undefined);
  assert.equal(sealedVerdict(bundle).state, verdict(bundle).state); // WORKS, unchanged
});

test('persistCatchReceipt: writes the sealed bundle to disk; re-read verifies and judges identically', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'pb-catch-test-'));
  try {
    const bundle = assembleCatchBundle({ intent: 'form submit persists an execution', claim: PROPOSED_CLAIM, iterations: [heldIteration(0), heldIteration(1)] });
    const { privateKey } = generateKeyPairSync('ed25519');
    const receiptPath = persistCatchReceipt(runDir, 'deadbeefcafef00d', sealBundle(bundle, privateKey));
    assert.ok(existsSync(receiptPath), 'sealed receipt written to disk');
    assert.match(receiptPath, /catch-deadbeefcafe\.receipt\.json$/); // sha-tagged filename (no merge/parent clobber)
    const persisted = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(persisted.seal.algorithm, 'ed25519');
    assert.equal(verifySeal(persisted, persisted.seal.publicKey), true, 'persisted seal verifies after a JSON round-trip');
    assert.equal(sealedVerdict(persisted).state, Verdict.WORKS, 'the on-disk artifact judges to WORKS');
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('sealedVerdict: a receipt tampered AFTER sealing => UNVERIFIED (not judged on merit)', () => {
  const bundle = assembleCatchBundle({ intent: 'x', claim: PROPOSED_CLAIM, iterations: [heldIteration(0), heldIteration(1)] });
  const { privateKey } = generateKeyPairSync('ed25519');
  const sealed = sealBundle(bundle, privateKey);
  assert.equal(sealedVerdict(sealed).state, Verdict.WORKS, 'intact seal → the honest WORKS');
  // Mutate the persisted delta's `after` the seal already committed to (a doctored receipt).
  const idx = sealed.receipts.findIndex((r) => r.id === 'store-delta');
  const tampered = { ...sealed, receipts: sealed.receipts.map((r, i) => (i === idx ? { ...r, data: { ...r.data, after: 999 } } : r)) };
  assert.ok(tampered.seal);
  assert.equal(verifySeal(tampered, tampered.seal.publicKey), false, 'the seal no longer verifies');
  assert.equal(sealedVerdict(tampered).state, Verdict.UNVERIFIED, 'a tampered receipt is UNVERIFIED, never WORKS');
});

/**
 * A realistic GOOD raw proposal (as an llmFn's tool_use input would arrive) for the n8n Form Trigger:
 * a type-then-submit walk with world-stable selectors + one in-menu effect claim (increased).
 * @returns {any}
 */
function goodRawProposal() {
  return {
    walk: [
      { op: 'type', args: { selector: 'input[name="field-0"]', text: 'pb-mock-response' } },
      { op: 'click', args: { selector: 'button[type="submit"]' } },
    ],
    claim: { entity: 'execution_entity.max_id', expectedAfterRelation: { op: 'increased' }, scope: PROPOSED_CLAIM.scope },
  };
}

/**
 * Docker-free seams that simulate a live n8n Catch: the store grows by one execution per browser
 * submit (one click), the fresh REST re-read echoes the requested id (so the confirm leg
 * content-binds), and a MOCK llmFn returns the good proposal (no API key, no network).
 */
function catchSeams() {
  let count = 0;
  const conjureFn = asAny(async () => ({
    recipe: {},
    containerName: 'pb-sut-test',
    baseUrl: 'http://localhost:5678',
    frontDoorUrl: 'http://localhost:5678/webhook/abc/n8n-form',
    captures: {},
    _cloneDir: null,
    _compose: null,
    receipts: [mint({ id: 'fingerprint', kind: 'fingerprint', provenance: 'harness', data: { mode: 'from_tree', sha: 'MERGE', container: 'pb-sut-test' } })],
    teardown: async () => {},
  }));
  const openBrowserFn = asAny(async () => ({
    steps: [{ op: 'navigate', url: 'http://host.docker.internal:5678/webhook/abc/n8n-form' }],
    navigate: async () => {},
    execute: async (/** @type {string} */ js) =>
      js.includes('querySelectorAll') ? [{ name: 'field-0', type: 'text', tag: 'input' }] : 'Your response has been recorded',
    find: async () => 'el-1',
    type: async () => {},
    click: async () => {
      count += 1; // the submit persists one execution
    },
    teardown: async () => {},
  }));
  const tapStoreFn = asAny(async () => Array.from({ length: count }, (_, i) => ({ id: i + 1, workflowId: 'wf-7130', status: 'success', finished: 1 })));
  const fetchFn = asAny(async (/** @type {string} */ url) => {
    if (url.endsWith('/rest/login')) {
      return { status: 200, headers: { getSetCookie: () => ['n8n-auth=tok'], get: () => null }, text: async () => '{}' };
    }
    const m = url.match(/\/rest\/executions\/(\d+)/); // echo the requested id (a fresh honest re-read)
    return { status: 200, headers: { getSetCookie: () => [], get: () => null }, text: async () => JSON.stringify({ data: { id: m ? Number(m[1]) : 0 } }) };
  });
  const llmFn = asAny(async () => goodRawProposal());
  return { conjureFn, openBrowserFn, tapStoreFn, fetchFn, llmFn };
}

test('runCatch: seals + persists the Catch bundle and computes the verdict from the on-disk sealed evidence (mock llmFn)', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'pb-catch-test-'));
  try {
    const result = await runCatch({ recipeDir: N8N_RECIPE, runDir, ...catchSeams() });
    assert.ok(result.receiptPath && existsSync(result.receiptPath), 'the sealed receipt was persisted to the run dir');
    const persisted = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
    assert.equal(persisted.seal.algorithm, 'ed25519', 'the persisted evidence carries an ed25519 seal');
    assert.equal(verifySeal(persisted, persisted.seal.publicKey), true, 'the persisted seal verifies');
    assert.ok(result.bundle.seal);
    assert.equal(result.bundle.seal.digest, persisted.seal.digest, 'the returned bundle IS the re-read on-disk artifact');
    assert.equal(result.verdict.state, Verdict.WORKS, result.verdict.reasons.join(' | ')); // k=2 fresh worlds, each confirmed
    // The claim in the sealed bundle came from the (mock) PROPOSAL, not a hardcoded string.
    assert.ok(result.proposal, 'runCatch returns the frozen proposal');
    assert.equal(result.bundle.claims[0].effectCheck?.entity, 'execution_entity.max_id');
    assert.equal(result.bundle.claims[0].scope, PROPOSED_CLAIM.scope);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

/**
 * PARENT-leg seams: a feature-absent world — the front door serves no fillable field and the frozen
 * merge selector matches nothing (find throws), so the replayed walk cannot execute. Nothing persists.
 */
function parentSeams() {
  const conjureFn = asAny(async () => ({
    recipe: {},
    containerName: 'pb-sut-parent',
    baseUrl: 'http://localhost:5678',
    frontDoorUrl: 'http://localhost:5678/webhook/abc/n8n-form',
    captures: {},
    _cloneDir: null,
    _compose: null,
    receipts: [mint({ id: 'fingerprint', kind: 'fingerprint', provenance: 'harness', data: { mode: 'from_tree', sha: 'PARENT', container: 'pb-sut-parent' } })],
    teardown: async () => {},
  }));
  const openBrowserFn = asAny(async () => ({
    steps: [{ op: 'navigate', url: 'http://host.docker.internal:5678/webhook/abc/n8n-form' }],
    navigate: async () => {},
    execute: async (/** @type {string} */ js) => (js.includes('querySelectorAll') ? [] : ''), // no fillable fields at parent
    find: async () => {
      throw new Error('browserdrive: find matched no element'); // the frozen merge selector 404s at parent
    },
    type: async () => {},
    click: async () => {},
    teardown: async () => {},
  }));
  const tapStoreFn = asAny(async () => []); // nothing ever persists at parent
  const fetchFn = asAny(async () => ({ status: 200, headers: { getSetCookie: () => [], get: () => null }, text: async () => '{}' }));
  return { conjureFn, openBrowserFn, tapStoreFn, fetchFn };
}

test('runCatch DIFFERENTIAL (mock llmFn): merge=WORKS ∧ parent=CND — the SAME frozen agent proposal replays across legs', async () => {
  const mergeDir = mkdtempSync(join(tmpdir(), 'pb-catch-merge-'));
  const parentDir = mkdtempSync(join(tmpdir(), 'pb-catch-parent-'));
  try {
    // MERGE leg: the agent proposes + the harness FREEZES the walk; the real effect confirms → WORKS.
    const merge = await runCatch({ recipeDir: N8N_RECIPE, buildSha: 'MERGE', runDir: mergeDir, ...catchSeams() });
    assert.equal(merge.verdict.state, Verdict.WORKS, merge.verdict.reasons.join(' | '));
    assert.ok(merge.proposal, 'the merge leg froze a proposal');
    // PARENT leg: replay the SAME frozen {walk, claim} against a feature-absent world → could-not-execute → CND.
    const parent = await runCatch({ recipeDir: N8N_RECIPE, buildSha: 'PARENT', runDir: parentDir, proposal: merge.proposal || undefined, ...parentSeams() });
    assert.equal(parent.verdict.state, Verdict.COULD_NOT_DETERMINE, parent.verdict.reasons.join(' | '));
    // Apples-to-apples: the parent leg judged the EXACT frozen proposal from merge (claim from the proposal).
    assert.deepEqual(parent.proposal, merge.proposal, 'the identical {walk, claim} was replayed at the parent leg');
    assert.equal(merge.bundle.claims[0].effectCheck?.entity, 'execution_entity.max_id'); // claim entity FROM the proposal
    // The two asserts above ARE the differential the runner (cli.mjs) decides: merge=WORKS ∧ parent≠WORKS,
    // proven here from an AGENT-SHAPED proposal (claim from the proposal, not hardcoded).
  } finally {
    rmSync(mergeDir, { recursive: true, force: true });
    rmSync(parentDir, { recursive: true, force: true });
  }
});
