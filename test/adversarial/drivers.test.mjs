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
import { mint } from '../../src/harness.mjs';
import { verdict } from '../../src/verdict.mjs';
import { Verdict } from '../../src/types.mjs';
import { MALICIOUS_DRIVERS } from '../../src/e1/drivers.mjs';

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
      mint({ id: 'app-endpoint-delta', kind: 'delta', provenance: 'tool', identity: 'shopper', data: { entity: 'order.total', before: null, after: 40 } }),
      mint({ id: 'app-endpoint-fresh', kind: 'fresh-session', provenance: 'tool', identity: 'shopper', data: { observed: 40 } }),
    ],
    reproduce: { k: 2, n: 2 },
  });
  assert.ok(b.seal, 'sealed bundle carries a seal');
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
      // The agent read it back itself — a proposer receipt (no mint), forced to agent.
      { id: 'agent-delta', kind: 'delta', provenance: 'agent', identity: 'shopper', data: { entity: 'order.total', before: null, after: 40 } },
      mint({ id: 'fresh', kind: 'fresh-session', provenance: 'harness', identity: 'shopper', data: { observed: 40 } }),
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
      mint({ id: 'pr-delta', kind: 'delta', provenance: 'harness', sourcePR: true, identity: 'shopper', data: { entity: 'order.total', before: null, after: 40 } }),
      mint({ id: 'fresh', kind: 'fresh-session', provenance: 'harness', identity: 'shopper', data: { observed: 40 } }),
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
      mint({ id: 'store-delta', kind: 'delta', provenance: 'harness', identity: 'shopper', data: { entity: 'order.total', before: null, after: 40 } }),
      mint({ id: 'fresh', kind: 'fresh-session', provenance: 'tool', identity: 'shopper', data: { observed: 40 } }),
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
    ].map(mint),
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
    ].map(mint),
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
  ].map(mint);
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
    ].map(mint),
    reproduce: { k: 2, n: 2 },
  });
  assert.equal(evaluate(b), Verdict.WORKS);
});

// ── (e) Seed-match null-delta tautology (FW-1 / §1.1 write-set-bound) ─────────────────
//
// An effect claim is admissible only if it binds an entity the harness saw CHANGE. An
// op:'equals'/'unchanged' check aimed at a row the action never changed (before == after) is a
// tautology: relationHolds ignores `before`, so a GENUINE harness delta of a no-op would
// otherwise green WORKS. evalEffect rejects a null delta for EVERY op → NOT_EXECUTED → CND.

test('(e) seed-match: a null-delta (before==after) equals check must NOT reach WORKS', () => {
  const b = sealed({
    intent: 'The coupon sets the total to 20 (the row was already seeded at 20).',
    actorIdentity: 'owner',
    claims: [
      {
        id: 'effect-total-equals',
        kind: 'effect',
        scope: 'shopper',
        effectCheck: {
          entity: 'order.total',
          expectedAfterRelation: { op: 'equals', value: 20 },
          deltaReceiptId: 'seed-delta',
          confirmLegReceiptId: 'seed-fresh',
        },
        receiptIds: ['seed-delta', 'seed-fresh'],
      },
    ],
    receipts: [
      // Genuine harness receipts — but of a no-op: before == after == 20.
      mint({ id: 'seed-delta', kind: 'delta', provenance: 'harness', identity: 'shopper', data: { entity: 'order.total', before: 20, after: 20 } }),
      mint({ id: 'seed-fresh', kind: 'fresh-session', provenance: 'harness', identity: 'shopper', data: { observed: 20 } }),
    ],
    reproduce: { k: 2, n: 2 },
  });
  assert.ok(b.seal, 'sealed bundle carries a seal');
  assert.equal(verifySeal(b, b.seal.publicKey), true, 'seal is intact — the lie is structural, not a tamper');
  assert.notEqual(evaluate(b), Verdict.WORKS, 'a no-op (null delta) can never confirm an effect');
  assert.equal(evaluate(b), Verdict.COULD_NOT_DETERMINE);
});

test('(e sanity) the SAME equals check on a REAL change (before != after) still earns WORKS', () => {
  // Behaviour-preserving control: only `before` differs from the (e) breach (40 -> 20 is a real delta).
  const b = sealed({
    intent: 'The coupon changes the total from 40 to 20.',
    actorIdentity: 'owner',
    claims: [
      {
        id: 'effect-total-equals',
        kind: 'effect',
        scope: 'shopper',
        effectCheck: {
          entity: 'order.total',
          expectedAfterRelation: { op: 'equals', value: 20 },
          deltaReceiptId: 'store-delta',
          confirmLegReceiptId: 'fresh',
        },
        receiptIds: ['store-delta', 'fresh'],
      },
    ],
    receipts: [
      mint({ id: 'store-delta', kind: 'delta', provenance: 'harness', identity: 'shopper', data: { entity: 'order.total', before: 40, after: 20 } }),
      mint({ id: 'fresh', kind: 'fresh-session', provenance: 'harness', identity: 'shopper', data: { observed: 20 } }),
    ],
    reproduce: { k: 2, n: 2 },
  });
  assert.equal(evaluate(b), Verdict.WORKS);
});

// ── Catch-shaped drivers (M7) — the REAL executed Catch bundle shape, one leg cheating ────
//
// (a)-(d) above attack the FIXTURE shape; these attack the shape `pb prove` actually assembles
// (src/catch.mjs: n8n execution-id store-delta + browser attempt + fresh-session confirm leg + one
// op:'increased' claim). Each is sealed (a STRUCTURAL lie, not a tamper — the seal verifies) and
// must be held ≠ WORKS by the frozen verdict. The honest Catch shape earning WORKS is the
// discriminating control (assembler-level in test/catch.test.mjs; sealed-level below).

test('(catch) every catch-shaped driver: seal intact, held at CND (never WORKS)', () => {
  const expected = /** @type {Record<string, string>} */ ({
    'catch-labeled-harness-delta': 'labelled harness but never minted → downgraded to agent → persisted leg unsatisfied',
    'catch-app-endpoint-delta': 'tool-provenance app-endpoint read is not the out-of-band store handle',
    'catch-null-delta-tautology': "op:'equals' on an unchanged max id (before==after) → null-delta guard",
    'catch-stale-confirm-leg': 'fresh re-read disagrees with the delta → confirm leg not content-bound',
  });
  const catchDrivers = MALICIOUS_DRIVERS.filter((d) => d.name.startsWith('catch-'));
  assert.equal(catchDrivers.length, 4, 'all four catch-shaped drivers registered on the gate');
  for (const d of catchDrivers) {
    assert.ok(expected[d.name], `unexpected catch driver ${d.name}`);
    const b = d.build();
    assert.ok(b.seal, `${d.name} is sealed`);
    assert.equal(verifySeal(b, b.seal.publicKey), true, `${d.name}: the lie is structural, not a tampered seal`);
    assert.equal(evaluate(b), Verdict.COULD_NOT_DETERMINE, `${d.name} (${expected[d.name]}) must be held at CND`);
  }
});

test('(catch sanity) the honest Catch shape (harness delta + content-bound fresh leg, k=2) earns WORKS', () => {
  // Behaviour-preserving control: the exact shape the catch-* drivers cheat on, but every leg honest.
  const b = sealed({
    intent: 'A visitor submitting the n8n Form Trigger front door persists an execution.',
    actorIdentity: 'pb-operator',
    claims: [
      {
        id: 'form-submit-persists-execution',
        kind: 'effect',
        scope: 'a visitor submitting the Form Trigger front door persists an execution',
        effectCheck: {
          entity: 'execution_entity.max_id',
          expectedAfterRelation: { op: 'increased' },
          deltaReceiptId: 'store-delta',
          confirmLegReceiptId: 'fresh-execution',
        },
        receiptIds: ['store-delta', 'browser-drive', 'fresh-execution'],
      },
    ],
    receipts: [
      mint({ id: 'fingerprint', kind: 'fingerprint', provenance: 'harness', data: { mode: 'from_tree', sha: '3ddc176d', container: 'pb-sut-3ddc176' } }),
      mint({ id: 'store-delta', kind: 'delta', provenance: 'harness', sourcePR: false, identity: 'form-visitor', data: { entity: 'execution_entity.max_id', before: 6, after: 7 } }),
      mint({ id: 'browser-drive', kind: 'attempt', provenance: 'tool', identity: 'form-visitor', data: { frontDoorUrl: 'http://localhost:5678/webhook/abc/n8n-form', steps: [{ op: 'navigate' }, { op: 'click' }] } }),
      mint({ id: 'fresh-execution', kind: 'fresh-session', provenance: 'tool', identity: 'form-visitor', data: { entity: 'execution_entity.max_id', executionId: 7, observed: 7 } }),
    ],
    reproduce: { k: 2, n: 2, kFail: 0 },
  });
  assert.equal(evaluate(b), Verdict.WORKS);
});
