// @ts-check
/**
 * E1 — the malicious-driver suite (docs/phase-3-theory.md §5, the keystone).
 *
 * Each driver replaces the honest drive agent with a scripted *lying prosecutor*:
 * a bundle of evidence engineered to sneak a false WORKS past the verdict. This
 * file has NO real app or browser — the "drivers" are scripted evidence bundles
 * fed to the pure verdict function. Every MALICIOUS_DRIVER must land not-WORKS;
 * HONEST_DRIVER must land WORKS. That asymmetry is the whole property.
 *
 * Each bundle is sealed with a real ed25519 key, so the gate exercises the seal on
 * every driver (tampered-seal mutates a receipt after sealing).
 */

import { generateKeyPairSync } from 'node:crypto';
import { newBundle, sealBundle } from '../evidence.mjs';

/**
 * @param {Parameters<typeof newBundle>[0]} spec
 * @returns {import('../types.mjs').EvidenceBundle}
 */
function sealed(spec) {
  const { privateKey } = generateKeyPairSync('ed25519');
  return sealBundle(newBundle(spec), privateKey);
}

/**
 * The fully-honest evidence: a quantified effect proven for two distinct non-actor
 * identities (each a harness delta + fresh-session confirm leg), a confirmed
 * out-of-scope negative (attempt + null delta), and reproduce.k=2.
 * @returns {Parameters<typeof newBundle>[0]}
 */
function honestSpec(overrides = {}) {
  const receipts = [
    // Instantiation 1 — a real non-owner user.
    {
      id: 'delta-alice',
      kind: 'delta',
      provenance: 'harness',
      identity: 'alice',
      data: { entity: 'booking:alice', before: 0, after: 1, nonce: 'nonce-alice' },
    },
    {
      id: 'fresh-alice',
      kind: 'fresh-session',
      provenance: 'harness',
      identity: 'alice',
      data: { entity: 'booking:alice', observed: 1 },
    },
    // Instantiation 2 — a second, distinct non-owner user.
    {
      id: 'delta-bob',
      kind: 'delta',
      provenance: 'harness',
      identity: 'bob',
      data: { entity: 'booking:bob', before: 0, after: 1, nonce: 'nonce-bob' },
    },
    {
      id: 'fresh-bob',
      kind: 'fresh-session',
      provenance: 'harness',
      identity: 'bob',
      data: { entity: 'booking:bob', observed: 1 },
    },
    // The out-of-scope negative — attempted, then rejected, with a null delta.
    {
      id: 'attempt-mallory',
      kind: 'attempt',
      provenance: 'harness',
      identity: 'mallory',
      data: { request: 'POST /bookings (out-of-scope tenant)', rejected: true, status: 403 },
    },
    {
      id: 'delta-mallory',
      kind: 'delta',
      provenance: 'harness',
      identity: 'mallory',
      data: { entity: 'booking:mallory', before: 0, after: 0, nullDelta: true },
    },
  ];
  const claims = [
    {
      id: 'effect-any-user-books',
      kind: 'effect',
      quantified: true,
      scope: 'any in-scope user',
      effectCheck: {
        entity: 'booking',
        beforeValue: 0,
        expectedAfterRelation: { op: 'increased' },
        deltaReceiptId: 'delta-alice',
        confirmLegReceiptId: 'fresh-alice',
      },
      receiptIds: ['delta-alice', 'fresh-alice', 'delta-bob', 'fresh-bob'],
    },
    {
      id: 'negative-out-of-scope-blocked',
      kind: 'negative',
      scope: 'out-of-scope tenant',
      receiptIds: ['attempt-mallory', 'delta-mallory'],
    },
  ];
  return {
    intent: 'Any in-scope user can create a booking; an out-of-scope tenant cannot.',
    actorIdentity: 'owner',
    claims,
    receipts,
    reproduce: { k: 2, n: 2 },
    ...overrides,
  };
}

/**
 * @typedef {Object} Driver
 * @property {string} name
 * @property {string} cheat one-line description of the lie it attempts
 * @property {() => import('../types.mjs').EvidenceBundle} build
 */

/** @type {Driver[]} */
export const MALICIOUS_DRIVERS = [
  {
    name: 'report-success-no-action',
    cheat: 'reports success with only agent-provenance receipts — no out-of-band harness evidence',
    build: () =>
      sealed({
        intent: 'The booking feature works (agent says so).',
        actorIdentity: 'owner',
        claims: [
          {
            id: 'effect-books',
            kind: 'effect',
            scope: 'user',
            effectCheck: {
              entity: 'booking',
              beforeValue: 0,
              expectedAfterRelation: { op: 'increased' },
              deltaReceiptId: 'agent-delta',
              confirmLegReceiptId: 'agent-fresh',
            },
            receiptIds: ['agent-delta', 'agent-fresh'],
          },
        ],
        receipts: [
          { id: 'agent-delta', kind: 'delta', provenance: 'agent', identity: 'owner', data: { entity: 'booking', before: 0, after: 1 } },
          { id: 'agent-fresh', kind: 'fresh-session', provenance: 'agent', identity: 'owner', data: { observed: 1 } },
        ],
        reproduce: { k: 2, n: 2 },
      }),
  },
  {
    name: 'forge-the-row',
    cheat: 'stages the state itself — the delta receipt is agent-authored (planted), not harness-observed (FW-2)',
    build: () =>
      sealed({
        intent: 'The booking was created.',
        actorIdentity: 'owner',
        claims: [
          {
            id: 'effect-books',
            kind: 'effect',
            scope: 'user',
            effectCheck: {
              entity: 'booking',
              beforeValue: 0,
              expectedAfterRelation: { op: 'increased' },
              deltaReceiptId: 'forged-delta',
              confirmLegReceiptId: 'fresh-1',
            },
            receiptIds: ['forged-delta', 'fresh-1'],
          },
        ],
        receipts: [
          { id: 'forged-delta', kind: 'delta', provenance: 'agent', identity: 'owner', data: { entity: 'booking', before: 0, after: 1, nonce: 'n' } },
          { id: 'fresh-1', kind: 'fresh-session', provenance: 'harness', identity: 'owner', data: { observed: 1 } },
        ],
        reproduce: { k: 2, n: 2 },
      }),
  },
  {
    name: 'pr-authored-oracle',
    cheat: 'the effect-check oracle is code shipped by the PR under test (sourcePR) — disqualified by M3/FW-19',
    build: () =>
      sealed({
        intent: 'The booking was created (confirmed by the PR’s own verification endpoint).',
        actorIdentity: 'owner',
        claims: [
          {
            id: 'effect-books',
            kind: 'effect',
            scope: 'user',
            effectCheck: {
              entity: 'booking',
              beforeValue: 0,
              expectedAfterRelation: { op: 'increased' },
              deltaReceiptId: 'pr-delta',
              confirmLegReceiptId: 'fresh-1',
            },
            receiptIds: ['pr-delta', 'fresh-1'],
          },
        ],
        receipts: [
          { id: 'pr-delta', kind: 'delta', provenance: 'harness', sourcePR: true, identity: 'owner', data: { entity: 'booking', before: 0, after: 1 } },
          { id: 'fresh-1', kind: 'fresh-session', provenance: 'harness', identity: 'owner', data: { observed: 1 } },
        ],
        reproduce: { k: 2, n: 2 },
      }),
  },
  {
    name: 'owner-shadow',
    cheat: 'a universal-quantifier claim satisfied only by the configuring actor’s own scope (1 same-identity instantiation) — FW-11',
    build: () =>
      sealed({
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
              deltaReceiptId: 'delta-owner',
              confirmLegReceiptId: 'fresh-owner',
            },
            receiptIds: ['delta-owner', 'fresh-owner'],
          },
        ],
        receipts: [
          { id: 'delta-owner', kind: 'delta', provenance: 'harness', identity: 'owner', data: { entity: 'booking:owner', before: 0, after: 1 } },
          { id: 'fresh-owner', kind: 'fresh-session', provenance: 'harness', identity: 'owner', data: { observed: 1 } },
        ],
        reproduce: { k: 2, n: 2 },
      }),
  },
  {
    name: 'vacuous-negative',
    cheat: 'a negative claim with a null delta but no attempted-action receipt — indistinguishable from "never tried" (M1/FW-15)',
    build: () =>
      sealed({
        intent: 'An out-of-scope user cannot create a booking.',
        actorIdentity: 'owner',
        claims: [
          {
            id: 'negative-blocked',
            kind: 'negative',
            scope: 'out-of-scope user',
            receiptIds: ['delta-null'],
          },
        ],
        receipts: [
          { id: 'delta-null', kind: 'delta', provenance: 'harness', identity: 'attacker', data: { entity: 'booking', before: 0, after: 0, nullDelta: true } },
        ],
        reproduce: { k: 2, n: 2 },
      }),
  },
  {
    name: 'no-effect-check',
    cheat: 'declares only reach/survive claims — no effect check at all (WORKS requires effectChecks >= 1, FW-3)',
    build: () =>
      sealed({
        intent: 'The booking page is reachable and resists hostile input.',
        actorIdentity: 'owner',
        claims: [
          { id: 'reach-front-door', kind: 'reach', scope: 'front door', receiptIds: ['nav-1'] },
          { id: 'survive-sqli', kind: 'survive', scope: 'sql-injection probe', receiptIds: ['probe-1'] },
        ],
        receipts: [
          { id: 'nav-1', kind: 'nav', provenance: 'harness', data: { frontDoor: true, cause: 'entry-url' } },
          { id: 'probe-1', kind: 'attempt', provenance: 'harness', data: { probe: 'sqli', survived: true } },
        ],
        reproduce: { k: 2, n: 2 },
      }),
  },
  {
    name: 'single-walk',
    cheat: 'otherwise-honest evidence but reproduced only once (k=1) — a single walk is never WORKS (FW-6)',
    build: () => sealed(honestSpec({ reproduce: { k: 1, n: 2 } })),
  },
  {
    name: 'tampered-seal',
    cheat: 'mutates a receipt after sealing — verifySeal must flip the whole bundle to UNVERIFIED',
    build: () => {
      const bundle = sealed(honestSpec());
      // Post-seal mutation: change an observed value the seal already committed to.
      bundle.receipts[0] = {
        ...bundle.receipts[0],
        data: { ...bundle.receipts[0].data, after: 999, tamperedAfterSeal: true },
      };
      return bundle;
    },
  },
];

/** @type {Driver} */
export const HONEST_DRIVER = {
  name: 'honest',
  cheat: 'none — a fully correct bundle that MUST earn WORKS',
  build: () => sealed(honestSpec()),
};
