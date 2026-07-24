// @ts-check
/**
 * One test per verdict rule (1-7), each with a minimal bundle. See
 * docs/internal/phase-3-theory.md §0-§2/§7 and src/verdict.mjs for the rule text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { newBundle } from '../src/evidence.mjs';
import { mint } from '../src/harness.mjs';
import { verdict } from '../src/verdict.mjs';
import { Verdict, ClaimState } from '../src/types.mjs';

/** @param {import('../src/types.mjs').ScoreboardEntry[]} sb @param {string} id */
function stateOf(sb, id) {
  const entry = sb.find((s) => s.claimId === id);
  return entry ? entry.state : undefined;
}

test('rule 1 — agent-provenance receipts cannot satisfy a claim (corroborate only)', () => {
  const b = newBundle({
    intent: 'x',
    actorIdentity: 'owner',
    claims: [
      {
        id: 'e',
        kind: 'effect',
        scope: 'user',
        effectCheck: {
          entity: 'row',
          beforeValue: 0,
          expectedAfterRelation: { op: 'increased' },
          deltaReceiptId: 'd',
          confirmLegReceiptId: 'f',
        },
        receiptIds: ['d', 'f'],
      },
    ],
    receipts: [
      { id: 'd', kind: 'delta', provenance: 'agent', data: { entity: 'row', before: 0, after: 1 } },
      { id: 'f', kind: 'fresh-session', provenance: 'agent', data: { observed: 1 } },
    ],
    reproduce: { k: 2, n: 2 },
  });
  const v = verdict(b);
  assert.equal(stateOf(v.scoreboard, 'e'), ClaimState.NOT_EXECUTED);
  assert.equal(v.state, Verdict.COULD_NOT_DETERMINE);
});

test('rule 2 — a FALSIFIED claim yields DOES_NOT_WORK', () => {
  const b = newBundle({
    intent: 'x',
    actorIdentity: 'owner',
    claims: [
      {
        id: 'e',
        kind: 'effect',
        scope: 'user',
        effectCheck: {
          entity: 'row',
          beforeValue: 1,
          expectedAfterRelation: { op: 'increased' },
          deltaReceiptId: 'd',
          confirmLegReceiptId: 'f',
        },
        receiptIds: ['d', 'f'],
      },
    ],
    receipts: [
      { id: 'd', kind: 'delta', provenance: 'harness', data: { entity: 'row', before: 1, after: 1 } },
      { id: 'f', kind: 'fresh-session', provenance: 'harness', data: { observed: 1 } },
    ].map(mint),
    reproduce: { k: 2, n: 2, kFail: 2 },
  });
  const v = verdict(b);
  assert.equal(stateOf(v.scoreboard, 'e'), ClaimState.FALSIFIED);
  assert.equal(v.state, Verdict.DOES_NOT_WORK);
});

test('rule 2 — a FALSIFIED claim that reproduced only once (kFail=1) is CND, not DNW', () => {
  const b = newBundle({
    intent: 'x',
    actorIdentity: 'owner',
    claims: [
      {
        id: 'e',
        kind: 'effect',
        scope: 'user',
        effectCheck: {
          entity: 'row',
          beforeValue: 1,
          expectedAfterRelation: { op: 'increased' },
          deltaReceiptId: 'd',
          confirmLegReceiptId: 'f',
        },
        receiptIds: ['d', 'f'],
      },
    ],
    receipts: [
      { id: 'd', kind: 'delta', provenance: 'harness', data: { entity: 'row', before: 1, after: 1 } },
      { id: 'f', kind: 'fresh-session', provenance: 'harness', data: { observed: 1 } },
    ].map(mint),
    reproduce: { k: 0, n: 2, kFail: 1 },
  });
  const v = verdict(b);
  // The decisive moment survives on the scoreboard — the claim is still FALSIFIED...
  assert.equal(stateOf(v.scoreboard, 'e'), ClaimState.FALSIFIED);
  // ...but a single unreproduced failure is "observed once, could not reproduce" => CND, not DNW.
  assert.equal(v.state, Verdict.COULD_NOT_DETERMINE);
});

test('rule 3 — effect confirmed only with a harness, non-sourcePR delta + a valid confirm leg', () => {
  /**
   * @param {Partial<import('../src/types.mjs').Receipt>} [deltaOverrides]
   * @param {string} [legKind]
   * @param {{observed?:number, nonce?:string, dest?:string}} [legData]
   */
  const base = (deltaOverrides = {}, legKind = 'fresh-session', legData = { observed: 1 }) =>
    newBundle({
      intent: 'x',
      actorIdentity: 'owner',
      claims: [
        {
          id: 'e',
          kind: 'effect',
          scope: 'user',
          effectCheck: {
            entity: 'row',
            beforeValue: 0,
            expectedAfterRelation: { op: 'increased' },
            deltaReceiptId: 'd',
            confirmLegReceiptId: 'f',
          },
          receiptIds: ['d', 'f'],
        },
      ],
      receipts: [
        { id: 'd', kind: 'delta', provenance: 'harness', data: { entity: 'row', before: 0, after: 1, nonce: 'n1' }, ...deltaOverrides },
        { id: 'f', kind: legKind, provenance: 'harness', data: legData },
      ].map(mint),
      reproduce: { k: 2, n: 2 },
    });
  // valid fresh-session leg -> CONFIRMED
  assert.equal(stateOf(verdict(base()).scoreboard, 'e'), ClaimState.CONFIRMED);
  // PR-authored oracle (sourcePR) -> NOT_EXECUTED
  assert.equal(stateOf(verdict(base({ sourcePR: true })).scoreboard, 'e'), ClaimState.NOT_EXECUTED);
  // egress confirm leg content-bound to the delta by nonce -> CONFIRMED (§1.5)
  assert.equal(
    stateOf(verdict(base({}, 'egress', { nonce: 'n1', dest: 'https://hook.example' })).scoreboard, 'e'),
    ClaimState.CONFIRMED
  );
  // egress leg NOT content-bound -> NOT_EXECUTED
  assert.equal(
    stateOf(verdict(base({}, 'egress', { nonce: 'other' })).scoreboard, 'e'),
    ClaimState.NOT_EXECUTED
  );
});

test('rule 4 — a negative claim needs BOTH a null delta AND an attempt receipt (M1)', () => {
  /** @param {boolean} withAttempt */
  const mk = (withAttempt) =>
    newBundle({
      intent: 'x',
      actorIdentity: 'owner',
      claims: [
        {
          id: 'n',
          kind: 'negative',
          scope: 'attacker',
          receiptIds: withAttempt ? ['a', 'd'] : ['d'],
        },
      ],
      receipts: [
        { id: 'a', kind: 'attempt', provenance: 'harness', data: { request: 'POST', rejected: true, status: 403 } },
        { id: 'd', kind: 'delta', provenance: 'harness', data: { entity: 'row', before: 0, after: 0, nullDelta: true } },
      ].map(mint),
      reproduce: { k: 2, n: 2 },
    });
  assert.equal(stateOf(verdict(mk(true)).scoreboard, 'n'), ClaimState.CONFIRMED);
  assert.equal(stateOf(verdict(mk(false)).scoreboard, 'n'), ClaimState.NOT_EXECUTED);
});

test('rule 5 — a quantified claim needs >=2 distinct non-actor instantiations + a confirmed negative', () => {
  /**
   * @param {import('../src/types.mjs').Receipt[]} receipts
   * @param {string[]} claimReceiptIds
   * @param {import('../src/types.mjs').Claim[]} [extraClaims]
   */
  const quantified = (receipts, claimReceiptIds, extraClaims = []) =>
    newBundle({
      intent: 'any user can book',
      actorIdentity: 'owner',
      claims: [
        {
          id: 'q',
          kind: 'effect',
          quantified: true,
          scope: 'any user',
          effectCheck: {
            entity: 'booking',
            beforeValue: 0,
            expectedAfterRelation: { op: 'increased' },
            deltaReceiptId: 'd1',
            confirmLegReceiptId: 'f1',
          },
          receiptIds: claimReceiptIds,
        },
        ...extraClaims,
      ],
      receipts: receipts.map(mint),
      reproduce: { k: 2, n: 2 },
    });

  // Two distinct non-actor identities + a confirmed negative -> CONFIRMED.
  const ok = quantified(
    [
      { id: 'd1', kind: 'delta', provenance: 'harness', identity: 'alice', data: { entity: 'b:a', before: 0, after: 1 } },
      { id: 'f1', kind: 'fresh-session', provenance: 'harness', identity: 'alice', data: { observed: 1 } },
      { id: 'd2', kind: 'delta', provenance: 'harness', identity: 'bob', data: { entity: 'b:b', before: 0, after: 1 } },
      { id: 'f2', kind: 'fresh-session', provenance: 'harness', identity: 'bob', data: { observed: 1 } },
      { id: 'an', kind: 'attempt', provenance: 'harness', identity: 'mallory', data: { rejected: true } },
      { id: 'dn', kind: 'delta', provenance: 'harness', identity: 'mallory', data: { before: 0, after: 0, nullDelta: true } },
    ],
    ['d1', 'f1', 'd2', 'f2'],
    [{ id: 'neg', kind: 'negative', scope: 'out-of-scope', receiptIds: ['an', 'dn'] }]
  );
  assert.equal(stateOf(verdict(ok).scoreboard, 'q'), ClaimState.CONFIRMED);

  // Single instantiation under the configuring actor's own identity -> NOT_EXECUTED (owner-shadow).
  const collapsed = quantified(
    [
      { id: 'd1', kind: 'delta', provenance: 'harness', identity: 'owner', data: { entity: 'b:o', before: 0, after: 1 } },
      { id: 'f1', kind: 'fresh-session', provenance: 'harness', identity: 'owner', data: { observed: 1 } },
    ],
    ['d1', 'f1']
  );
  assert.equal(stateOf(verdict(collapsed).scoreboard, 'q'), ClaimState.NOT_EXECUTED);
});

test('rule 6 — WORKS needs a confirmed effect, all claims satisfied, and reproduce k>=2', () => {
  /** @param {number} k */
  const mk = (k) =>
    newBundle({
      intent: 'x',
      actorIdentity: 'owner',
      claims: [
        {
          id: 'e',
          kind: 'effect',
          scope: 'user',
          effectCheck: {
            entity: 'row',
            beforeValue: 0,
            expectedAfterRelation: { op: 'increased' },
            deltaReceiptId: 'd',
            confirmLegReceiptId: 'f',
          },
          receiptIds: ['d', 'f'],
        },
      ],
      receipts: [
        { id: 'd', kind: 'delta', provenance: 'harness', identity: 'u1', data: { entity: 'row', before: 0, after: 1 } },
        { id: 'f', kind: 'fresh-session', provenance: 'harness', identity: 'u1', data: { observed: 1 } },
      ].map(mint),
      reproduce: { k, n: 2 },
    });
  assert.equal(verdict(mk(2)).state, Verdict.WORKS);
  assert.equal(verdict(mk(1)).state, Verdict.COULD_NOT_DETERMINE); // single walk is never WORKS
});

test('rule 7 — nothing falsified but a required check NOT_EXECUTED => CND naming what + why', () => {
  const b = newBundle({
    intent: 'x',
    actorIdentity: 'owner',
    claims: [
      {
        id: 'e',
        kind: 'effect',
        scope: 'user',
        effectCheck: {
          entity: 'row',
          beforeValue: 0,
          expectedAfterRelation: { op: 'increased' },
          deltaReceiptId: 'missing',
          confirmLegReceiptId: 'f',
        },
        receiptIds: ['f'],
      },
    ],
    receipts: [{ id: 'f', kind: 'fresh-session', provenance: 'harness', data: { observed: 1 } }].map(mint),
    reproduce: { k: 2, n: 2 },
  });
  const v = verdict(b);
  assert.equal(stateOf(v.scoreboard, 'e'), ClaimState.NOT_EXECUTED);
  assert.equal(v.state, Verdict.COULD_NOT_DETERMINE);
  assert.ok(v.reasons.length > 0);
  assert.ok(v.reasons.some((r) => r.includes('e') && /NOT_EXECUTED|effect|delta/i.test(r)));
});
