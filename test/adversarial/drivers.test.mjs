// @ts-check
/**
 * Adversarial DRIVER attacks on the honesty core (docs/phase-3-theory.md §1-§2, §7).
 *
 * Each test is a scripted *lying prosecutor*: a sealed evidence bundle engineered to
 * sneak a false WORKS past the pure verdict. The property is asymmetric — every attack
 * MUST land not-WORKS (a correct COULD_NOT_DETERMINE), and only genuinely honest
 * evidence earns WORKS. These complement src/e1/drivers.mjs with the specific vectors
 * the red-team brief calls out: (b) a forged persisted delta sourced from the app's own
 * endpoint, (c) an owner-shadow on a quantified claim, (d) a vacuous negative.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { newBundle, sealBundle, verifySeal } from '../../src/evidence.mjs';
import { verdict } from '../../src/verdict.mjs';
import { Verdict } from '../../src/types.mjs';

/**
 * Seal a spec with a real ed25519 key (exercises the seal on every attack, like the E1 gate).
 * @param {Parameters<typeof newBundle>[0]} spec
 * @returns {import('../../src/types.mjs').EvidenceBundle}
 */
function sealed(spec) {
  const { privateKey } = generateKeyPairSync('ed25519');
  return sealBundle(newBundle(spec), privateKey);
}

/**
 * Effective verdict: a broken seal is UNVERIFIED; otherwise the pure verdict state.
 * Mirrors src/e1/gate.mjs so the attacks run through the exact release-gate path.
 * @param {import('../../src/types.mjs').EvidenceBundle} bundle
 * @returns {string}
 */
function evaluate(bundle) {
  if (bundle && bundle.seal && !verifySeal(bundle, bundle.seal.publicKey)) return Verdict.UNVERIFIED;
  return verdict(bundle).state;
}

// ── (b) Forged persisted delta via the app's own internal endpoint ───────────────────
//
// The persisted leg (§1.1/§4) comes ONLY from an out-of-band store handle = HARNESS
// provenance. An app-endpoint read ("GET /orders/:id", an internal COUNT, a /version, a
// PR-shipped verify route) is a *user-surface* receipt, never the persisted oracle. The
// honest harness only ever mints `kind:'delta'` as `harness`; a `delta` labelled `tool`
// or `agent`, or one flagged `sourcePR`, can only come from a driver that swapped the
// oracle for the app's own word. None may satisfy an effect check.

test('(b) forged delta from the app endpoint (tool-provenance) must NOT reach WORKS', () => {
  const b = sealed({
    intent: "The order persisted the discount (per the app's own GET /orders/:id).",
    actorIdentity: 'owner',
    claims: [
      {
        id: 'effect-discount-persists',
        kind: 'effect',
        scope: 'shopper',
        effectCheck: {
          entity: 'order.total',
          expectedAfterRelation: { op: 'equals', value: 40 },
          deltaReceiptId: 'app-endpoint-delta',
          confirmLegReceiptId: 'app-endpoint-fresh',
        },
        receiptIds: ['app-endpoint-delta', 'app-endpoint-fresh'],
      },
    ],
    receipts: [
      // Sourced from the app's OWN GET endpoint (which lies: says 40 while the store holds 50).
      // A driver's own read is at best TOOL provenance — it is not the store handle.
      { id: 'app-endpoint-delta', kind: 'delta', provenance: 'tool', identity: 'shopper', data: { entity: 'order.total', before: null, after: 40 } },
      { id: 'app-endpoint-fresh', kind: 'fresh-session', provenance: 'tool', identity: 'shopper', data: { observed: 40 } },
    ],
    reproduce: { k: 2, n: 2 },
  });
  assert.equal(verifySeal(b, b.seal.publicKey), true, 'seal is intact — the lie is structural, not a tamper');
  assert.notEqual(evaluate(b), Verdict.WORKS, 'a tool-provenance (app-endpoint) delta must never satisfy the persisted leg');
  assert.equal(evaluate(b), Verdict.COULD_NOT_DETERMINE);
});

test('(b) forged delta labelled agent-provenance must NOT reach WORKS', () => {
  const b = sealed({
    intent: 'The order persisted the discount (agent read it back itself).',
    actorIdentity: 'owner',
    claims: [
      {
        id: 'effect-discount-persists',
        kind: 'effect',
        scope: 'shopper',
        effectCheck: {
          entity: 'order.total',
          expectedAfterRelation: { op: 'equals', value: 40 },
          deltaReceiptId: 'agent-delta',
          confirmLegReceiptId: 'fresh',
        },
        receiptIds: ['agent-delta', 'fresh'],
      },
    ],
    receipts: [
      { id: 'agent-delta', kind: 'delta', provenance: 'agent', identity: 'shopper', data: { entity: 'order.total', before: null, after: 40 } },
      { id: 'fresh', kind: 'fresh-session', provenance: 'harness', identity: 'shopper', data: { observed: 40 } },
    ],
    reproduce: { k: 2, n: 2 },
  });
  assert.equal(evaluate(b), Verdict.COULD_NOT_DETERMINE);
});

test("(b) delta from the PR's own internal verification endpoint (sourcePR) must NOT reach WORKS", () => {
  const b = sealed({
    intent: "The order persisted the discount (per the PR's own /internal/verify).",
    actorIdentity: 'owner',
    claims: [
      {
        id: 'effect-discount-persists',
        kind: 'effect',
        scope: 'shopper',
        effectCheck: {
          entity: 'order.total',
          expectedAfterRelation: { op: 'equals', value: 40 },
          deltaReceiptId: 'pr-delta',
          confirmLegReceiptId: 'fresh',
        },
        receiptIds: ['pr-delta', 'fresh'],
      },
    ],
    receipts: [
      { id: 'pr-delta', kind: 'delta', provenance: 'harness', sourcePR: true, identity: 'shopper', data: { entity: 'order.total', before: null, after: 40 } },
      { id: 'fresh', kind: 'fresh-session', provenance: 'harness', identity: 'shopper', data: { observed: 40 } },
    ],
    reproduce: { k: 2, n: 2 },
  });
  assert.equal(evaluate(b), Verdict.COULD_NOT_DETERMINE);
});

test('(b sanity) the SAME effect via a genuine harness store-handle delta DOES reach WORKS', () => {
  // Behaviour-preserving control: only the oracle's provenance changed vs the (b) breach.
  const b = sealed({
    intent: 'The order persisted the discount (read from the store handle out of band).',
    actorIdentity: 'owner',
    claims: [
      {
        id: 'effect-discount-persists',
        kind: 'effect',
        scope: 'shopper',
        effectCheck: {
          entity: 'order.total',
          expectedAfterRelation: { op: 'equals', value: 40 },
          deltaReceiptId: 'store-delta',
          confirmLegReceiptId: 'fresh',
        },
        receiptIds: ['store-delta', 'fresh'],
      },
    ],
    receipts: [
      { id: 'store-delta', kind: 'delta', provenance: 'harness', identity: 'shopper', data: { entity: 'order.total', before: null, after: 40 } },
      { id: 'fresh', kind: 'fresh-session', provenance: 'tool', identity: 'shopper', data: { observed: 40 } },
    ],
    reproduce: { k: 2, n: 2 },
  });
  assert.equal(evaluate(b), Verdict.WORKS);
});

// ── (c) Owner-shadow on a quantified claim ───────────────────────────────────────────
//
// A universal quantifier ("any/all/every user") is not satisfiable by the configuring
// actor's own scope, nor by the same identity counted twice (§1.4/FW-11, M2). WORKS needs
// >=2 DISTINCT non-actor instantiations + a confirmed out-of-scope negative.

test('(c) owner-shadow: the same non-actor identity twice for a quantified claim => not WORKS', () => {
  const b = sealed({
    intent: 'Any user can create a booking; an out-of-scope tenant cannot.',
    actorIdentity: 'owner',
    claims: [
      {
        id: 'effect-any-user-books',
        kind: 'effect',
        quantified: true,
        scope: 'any user',
        effectCheck: {
          entity: 'booking',
          beforeValue: 0,
          expectedAfterRelation: { op: 'increased' },
          deltaReceiptId: 'delta-1',
          confirmLegReceiptId: 'fresh-1',
        },
        receiptIds: ['delta-1', 'fresh-1', 'delta-2', 'fresh-2'],
      },
      { id: 'negative-out-of-scope', kind: 'negative', scope: 'out-of-scope tenant', receiptIds: ['attempt-x', 'delta-x'] },
    ],
    receipts: [
      // Two instantiations, but BOTH ran as 'alice' — one identity wearing two hats.
      { id: 'delta-1', kind: 'delta', provenance: 'harness', identity: 'alice', data: { entity: 'booking:1', before: 0, after: 1 } },
      { id: 'fresh-1', kind: 'fresh-session', provenance: 'harness', identity: 'alice', data: { observed: 1 } },
      { id: 'delta-2', kind: 'delta', provenance: 'harness', identity: 'alice', data: { entity: 'booking:2', before: 0, after: 1 } },
      { id: 'fresh-2', kind: 'fresh-session', provenance: 'harness', identity: 'alice', data: { observed: 1 } },
      { id: 'attempt-x', kind: 'attempt', provenance: 'harness', identity: 'mallory', data: { rejected: true, status: 403 } },
      { id: 'delta-x', kind: 'delta', provenance: 'harness', identity: 'mallory', data: { entity: 'booking:x', before: 0, after: 0, nullDelta: true } },
    ],
    reproduce: { k: 2, n: 2 },
  });
  assert.notEqual(evaluate(b), Verdict.WORKS, 'one identity twice is a single instantiation, not two');
  assert.equal(evaluate(b), Verdict.COULD_NOT_DETERMINE);
});

test('(c) owner-shadow: both instantiations under the configuring actor => not WORKS', () => {
  const b = sealed({
    intent: 'Any user can create a booking.',
    actorIdentity: 'owner',
    claims: [
      {
        id: 'effect-any-user-books',
        kind: 'effect',
        quantified: true,
        scope: 'any user',
        effectCheck: {
          entity: 'booking',
          beforeValue: 0,
          expectedAfterRelation: { op: 'increased' },
          deltaReceiptId: 'delta-1',
          confirmLegReceiptId: 'fresh-1',
        },
        receiptIds: ['delta-1', 'fresh-1', 'delta-2', 'fresh-2'],
      },
    ],
    receipts: [
      { id: 'delta-1', kind: 'delta', provenance: 'harness', identity: 'owner', data: { entity: 'booking:1', before: 0, after: 1 } },
      { id: 'fresh-1', kind: 'fresh-session', provenance: 'harness', identity: 'owner', data: { observed: 1 } },
      { id: 'delta-2', kind: 'delta', provenance: 'harness', identity: 'owner', data: { entity: 'booking:2', before: 0, after: 1 } },
      { id: 'fresh-2', kind: 'fresh-session', provenance: 'harness', identity: 'owner', data: { observed: 1 } },
    ],
    reproduce: { k: 2, n: 2 },
  });
  assert.equal(evaluate(b), Verdict.COULD_NOT_DETERMINE);
});

// ── (d) Vacuous negative ─────────────────────────────────────────────────────────────
//
// A null delta is identical for "correctly blocked" and "the driver never tried" (M1/FW-15).
// A negative claim needs BOTH a null delta AND an attempted-action receipt. Even riding on
// an otherwise-honest, WORKS-worthy effect, a negative missing its attempt receipt is
// NOT_EXECUTED and must sink the whole bundle to CND.

test('(d) vacuous negative: null delta but no attempt receipt, atop a real effect => not WORKS', () => {
  const receipts = [
    // A genuine, WORKS-worthy effect (harness delta + fresh leg, k=2).
    { id: 'delta-e', kind: 'delta', provenance: 'harness', identity: 'alice', data: { entity: 'order.total', before: null, after: 40 } },
    { id: 'fresh-e', kind: 'fresh-session', provenance: 'harness', identity: 'alice', data: { observed: 40 } },
    // The negative's null delta — with NO attempt receipt to prove anything was tried.
    { id: 'delta-null', kind: 'delta', provenance: 'harness', identity: 'attacker', data: { entity: 'order', before: 0, after: 0, nullDelta: true } },
  ];
  const b = sealed({
    intent: 'The discount persists; an out-of-scope actor cannot place an order.',
    actorIdentity: 'owner',
    claims: [
      {
        id: 'effect-discount',
        kind: 'effect',
        scope: 'shopper',
        effectCheck: {
          entity: 'order.total',
          expectedAfterRelation: { op: 'equals', value: 40 },
          deltaReceiptId: 'delta-e',
          confirmLegReceiptId: 'fresh-e',
        },
        receiptIds: ['delta-e', 'fresh-e'],
      },
      { id: 'negative-blocked', kind: 'negative', scope: 'out-of-scope actor', receiptIds: ['delta-null'] },
    ],
    receipts,
    reproduce: { k: 2, n: 2 },
  });
  assert.notEqual(evaluate(b), Verdict.WORKS, 'a null delta with no attempt receipt is untested, not a pass');
  assert.equal(evaluate(b), Verdict.COULD_NOT_DETERMINE);
});

test('(d sanity) adding the attempt receipt to the negative earns WORKS', () => {
  // Behaviour-preserving control: only the M1 attempt receipt is added vs the (d) breach.
  const b = sealed({
    intent: 'The discount persists; an out-of-scope actor cannot place an order.',
    actorIdentity: 'owner',
    claims: [
      {
        id: 'effect-discount',
        kind: 'effect',
        scope: 'shopper',
        effectCheck: {
          entity: 'order.total',
          expectedAfterRelation: { op: 'equals', value: 40 },
          deltaReceiptId: 'delta-e',
          confirmLegReceiptId: 'fresh-e',
        },
        receiptIds: ['delta-e', 'fresh-e'],
      },
      { id: 'negative-blocked', kind: 'negative', scope: 'out-of-scope actor', receiptIds: ['attempt-n', 'delta-null'] },
    ],
    receipts: [
      { id: 'delta-e', kind: 'delta', provenance: 'harness', identity: 'alice', data: { entity: 'order.total', before: null, after: 40 } },
      { id: 'fresh-e', kind: 'fresh-session', provenance: 'harness', identity: 'alice', data: { observed: 40 } },
      { id: 'attempt-n', kind: 'attempt', provenance: 'harness', identity: 'attacker', data: { request: 'POST /orders (out-of-scope)', rejected: true, status: 403 } },
      { id: 'delta-null', kind: 'delta', provenance: 'harness', identity: 'attacker', data: { entity: 'order', before: 0, after: 0, nullDelta: true } },
    ],
    reproduce: { k: 2, n: 2 },
  });
  assert.equal(evaluate(b), Verdict.WORKS);
});
