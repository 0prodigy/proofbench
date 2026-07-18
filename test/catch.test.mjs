// @ts-check
/**
 * Catch bundle-assembly tests — DOCKER-FREE and NETWORK-FREE. The live conjure→browser-drive→tap
 * plumbing is proven by `pb prove`; here the PURE assembler is exercised with hand-built
 * reproductions so every verdict branch is nailed without a container:
 *   - two confirmed persists (merge-shaped) → WORKS, with the exact receipt/claim shapes
 *   - no reproduction executed (parent-shaped, feature-absent) → no delta → CND (NOT_EXECUTED)
 *   - the walk ran but nothing persisted, reproduced → the delta FALSIFIES → DOES_NOT_WORK
 *   - a single confirmed walk (k=1) → CND (a single walk is never WORKS, FW-6)
 *   - a fresh re-read that DISAGREES with the store cannot confirm → CND (the dual-leg guard)
 * plus the pure helpers (maxId / rowById / executionIdFrom) the live path relies on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleCatchBundle, maxId, rowById, executionIdFrom } from '../src/catch.mjs';
import { verdict } from '../src/verdict.mjs';
import { Verdict } from '../src/types.mjs';
import { mint, isMinted } from '../src/harness.mjs';

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
 * @param {{afterId?:number, freshObserved?:number, sha?:string}} [o]
 * @returns {import('../src/catch.mjs').CatchIteration}
 */
function heldIteration(i, { afterId = 1, freshObserved = afterId, sha = 'MERGE' } = {}) {
  return {
    executed: true,
    effectHeld: freshObserved === afterId,
    beforeId: 0,
    afterId,
    freshObserved,
    countBefore: 0,
    countAfter: 1,
    workflowId: 'wf-123',
    status: 'success',
    nonce: `nonce-${i}`,
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
  return { executed: false, effectHeld: false, beforeId: 0, countBefore: 0, countAfter: 0, reason };
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
    beforeId: 0,
    afterId: undefined,
    freshObserved: undefined,
    countBefore: 0,
    countAfter: 0,
    nonce: `nonce-${i}`,
    driveSteps: [{ op: 'navigate', url: 'http://host.docker.internal:5678/webhook/abc/n8n-form' }],
    frontDoorUrl: 'http://localhost:5678/webhook/abc/n8n-form',
    fingerprint: fingerprint(sha),
    reason: 'the walk ran but no execution persisted in execution_entity',
  };
}

test('catch helpers: maxId / rowById / executionIdFrom coerce ids and tolerate empty/wrapped shapes', () => {
  assert.equal(maxId([]), 0); // no executions
  assert.equal(maxId([{ id: 1 }, { id: 3 }, { id: 2 }]), 3);
  assert.equal(maxId([{ id: '5' }, { id: '2' }]), 5); // string ids coerced
  assert.deepEqual(rowById([{ id: 1, status: 'success' }, { id: 2, status: 'error' }], 2), { id: 2, status: 'error' });
  assert.equal(executionIdFrom({ data: { id: '7' } }), 7); // n8n wraps in {data:...}; id is a string
  assert.equal(executionIdFrom({ id: 9 }), 9); // bare
  assert.equal(executionIdFrom({ data: {} }), undefined); // no id → cannot confirm
  assert.equal(executionIdFrom(null), undefined);
});

test('catch assembly: two confirmed persists (merge-shaped) => WORKS with the exact receipt + claim shapes', () => {
  const bundle = assembleCatchBundle({ intent: 'form submit persists an execution', iterations: [heldIteration(0), heldIteration(1)] });
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
  assert.equal(delta.data.workflowId, 'wf-123');
  assert.equal(delta.data.status, 'success');
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
  // ONE non-quantified effect claim (no negative/quantifier for M6)
  assert.equal(bundle.claims.length, 1);
  const claim = bundle.claims[0];
  assert.equal(claim.kind, 'effect');
  assert.equal(claim.quantified, undefined);
  const ec = /** @type {import('../src/types.mjs').EffectCheck} */ (claim.effectCheck);
  assert.deepEqual(ec.expectedAfterRelation, { op: 'increased' });
  assert.equal(ec.deltaReceiptId, 'store-delta');
  assert.equal(ec.confirmLegReceiptId, 'fresh-execution');
});

test('catch assembly: no reproduction executed (parent-shaped, feature-absent) => CND, no delta, effect NOT_EXECUTED', () => {
  const bundle = assembleCatchBundle({ intent: 'x', iterations: [absentIteration(), absentIteration()] });
  const v = verdict(bundle);
  assert.equal(v.state, Verdict.COULD_NOT_DETERMINE, v.reasons.join(' | '));
  assert.deepEqual(bundle.reproduce, { k: 0, n: 2, kFail: 0 }); // feature-absent counts toward NEITHER
  assert.equal(bundle.receipts.find((r) => r.id === 'store-delta'), undefined); // no delta emitted → nothing to falsify
  const effect = v.scoreboard.find((s) => s.kind === 'effect');
  assert.equal(effect?.state, 'NOT_EXECUTED');
  assert.match(v.reasons.join(' '), /delta receipt missing|NOT_EXECUTED/);
});

test('catch assembly: the walk ran but nothing persisted, reproduced => the delta FALSIFIES => DOES_NOT_WORK', () => {
  const bundle = assembleCatchBundle({ intent: 'x', iterations: [ranButUnpersistedIteration(0), ranButUnpersistedIteration(1)] });
  const v = verdict(bundle);
  assert.equal(v.state, Verdict.DOES_NOT_WORK, v.reasons.join(' | '));
  assert.deepEqual(bundle.reproduce, { k: 0, n: 2, kFail: 2 }); // executed-but-unheld => kFail
  const delta = bundle.receipts.find((r) => r.id === 'store-delta');
  assert.ok(delta && delta.data.before === delta.data.after, 'no-increase delta (before == after)'); // op:increased FALSIFIES
});

test('catch assembly: a single confirmed walk (k=1) => CND (a single walk is never WORKS)', () => {
  const bundle = assembleCatchBundle({ intent: 'x', iterations: [heldIteration(0), absentIteration()] });
  const v = verdict(bundle);
  assert.equal(v.state, Verdict.COULD_NOT_DETERMINE, v.reasons.join(' | '));
  assert.equal(bundle.reproduce.k, 1);
  assert.match(v.reasons.join(' '), /k=1|k >= 2|single walk/i);
});

test('catch assembly: a fresh re-read that DISAGREES with the store cannot confirm => CND (dual-leg guard)', () => {
  // afterId=1 persisted, but the fresh REST re-read observed a different id (2) — stale/inconsistent.
  const stale = [heldIteration(0, { afterId: 1, freshObserved: 2 }), heldIteration(1, { afterId: 1, freshObserved: 2 })];
  const bundle = assembleCatchBundle({ intent: 'x', iterations: stale });
  const v = verdict(bundle);
  assert.equal(v.state, Verdict.COULD_NOT_DETERMINE, v.reasons.join(' | ')); // NOT_EXECUTED (no valid confirm leg), never WORKS
  const fresh = bundle.receipts.find((r) => r.id === 'fresh-execution');
  assert.ok(fresh && fresh.data.observed !== bundle.receipts.find((r) => r.id === 'store-delta')?.data.after, 'confirm leg disagrees with the delta');
  assert.match(v.reasons.join(' '), /confirm leg|fresh-session/i);
});
