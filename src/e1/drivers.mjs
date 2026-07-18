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
 * Provenance is unmintable by a proposer: pb (the harness) mints its genuinely-observed
 * receipts via src/harness.mjs, while any receipt a driver FABRICATES rides the proposer
 * path (a plain object) and newBundle stamps it agent. So a scenario that turns on a real
 * pb observation (owner-shadow, a PR-shipped oracle, a vacuous negative, a single walk)
 * mints its legit receipts and is caught by its OWN rule; a scenario that forges the
 * evidence itself (forge-the-row's planted delta, forge-harness-provenance) is downgraded
 * to agent and caught there. Both are honest catches, not shadowing.
 *
 * Each bundle is sealed with a real ed25519 key, so the gate exercises the seal on
 * every driver (tampered-seal mutates a receipt after sealing).
 *
 * The `catch-*` drivers mirror the REAL executed Catch bundle shape (src/catch.mjs: a harness
 * store-delta on the n8n execution id, a TOOL browser attempt, a TOOL fresh-session confirm leg,
 * one op:'increased' effect claim) but cheat exactly one leg — so `pb gate` covers the Catch path,
 * not just the fixture path, and each is held ≠ WORKS for the SAME reason its fixture-shaped twin is.
 */

import { generateKeyPairSync } from 'node:crypto';
import { newBundle, sealBundle } from '../evidence.mjs';
import { mint } from '../harness.mjs';

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
  ].map(mint);
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

/** The store entity the real Catch binds its effect to (mirrors src/catch.mjs EFFECT_ENTITY). */
const CATCH_ENTITY = 'execution_entity.max_id';

/**
 * The REAL M6 Catch bundle shape (src/catch.mjs assembleCatchBundle): a harness store-delta on the
 * n8n execution id (out-of-band sqlite tap), a TOOL browser-drive attempt, a TOOL fresh-session
 * confirm leg, and ONE non-quantified op:'increased' effect claim, reproduced k=2. The honest shape
 * (no cheat) earns WORKS; each `catch-*` driver overrides exactly one leg so the FROZEN verdict
 * holds it ≠ WORKS. `storeDelta`/`freshExecution` are injected so a driver can hand the persisted or
 * confirm leg a plain (un-minted) or mis-provenanced look-alike.
 * @param {{storeDelta?:any, freshExecution?:any, relation?:{op:string,value?:any}}} [cheat]
 * @returns {Parameters<typeof newBundle>[0]}
 */
function catchSpec({ storeDelta, freshExecution, relation } = {}) {
  const delta =
    storeDelta ||
    mint({ id: 'store-delta', kind: 'delta', provenance: 'harness', sourcePR: false, identity: 'form-visitor', data: { entity: CATCH_ENTITY, before: 6, after: 7, countBefore: 6, countAfter: 7, workflowId: 'wf-7130', status: 'success', nonce: 'pb-3ddc176-r0' } });
  const fresh =
    freshExecution ||
    mint({ id: 'fresh-execution', kind: 'fresh-session', provenance: 'tool', identity: 'form-visitor', data: { entity: CATCH_ENTITY, executionId: 7, observed: 7 } });
  return {
    intent: 'A visitor submitting the n8n Form Trigger front door persists an execution, reproduced across fresh worlds (SHA 3ddc176).',
    actorIdentity: 'pb-operator',
    claims: [
      {
        id: 'form-submit-persists-execution',
        kind: 'effect',
        scope: 'a visitor submitting the Form Trigger front door persists an execution (execution_entity)',
        effectCheck: {
          entity: CATCH_ENTITY,
          expectedAfterRelation: relation || { op: 'increased' },
          deltaReceiptId: 'store-delta',
          confirmLegReceiptId: 'fresh-execution',
        },
        receiptIds: ['store-delta', 'browser-drive', 'fresh-execution'],
      },
    ],
    receipts: [
      mint({ id: 'fingerprint', kind: 'fingerprint', provenance: 'harness', data: { mode: 'from_tree', sha: '3ddc176dfa2d3d99a328a29a3a8613e35ff456a0', container: 'pb-sut-3ddc176' } }),
      delta,
      mint({ id: 'browser-drive', kind: 'attempt', provenance: 'tool', identity: 'form-visitor', data: { request: 'browser-drive http://localhost:5678/webhook/abc/n8n-form', frontDoorUrl: 'http://localhost:5678/webhook/abc/n8n-form', steps: [{ op: 'navigate', url: 'http://host.docker.internal:5678/webhook/abc/n8n-form' }, { op: 'type', elementId: 'el-1', text: 'pb-3ddc176-r0' }, { op: 'click', elementId: 'el-2' }], observed: 'Your response has been recorded', nonce: 'pb-3ddc176-r0', executionId: 7 } }),
      fresh,
    ],
    reproduce: { k: 2, n: 2, kFail: 0 },
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
          // The planted delta rides the proposer path (no mint) — newBundle stamps it agent.
          { id: 'forged-delta', kind: 'delta', provenance: 'agent', identity: 'owner', data: { entity: 'booking', before: 0, after: 1, nonce: 'n' } },
          // A genuine harness confirm leg cannot rescue an agent-authored persisted leg.
          mint({ id: 'fresh-1', kind: 'fresh-session', provenance: 'harness', identity: 'owner', data: { observed: 1 } }),
        ],
        reproduce: { k: 2, n: 2 },
      }),
  },
  {
    name: 'forge-harness-provenance',
    cheat:
      'fabricates a full honest-shaped bundle and LABELS every receipt provenance:harness — but builds it via the proposer path, so newBundle overrides them to agent; a self-minted "harness" oracle cannot satisfy (§0 rule 1)',
    build: () =>
      // Byte-for-byte the honest bundle's shape — the ONLY difference from HONEST_DRIVER is
      // that these receipts are plain objects (never minted), so newBundle stamps them agent.
      sealed({
        intent: 'Any in-scope user can create a booking (per receipts the driver labelled harness).',
        actorIdentity: 'owner',
        claims: [
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
        ],
        receipts: [
          { id: 'delta-alice', kind: 'delta', provenance: 'harness', identity: 'alice', data: { entity: 'booking:alice', before: 0, after: 1, nonce: 'nonce-alice' } },
          { id: 'fresh-alice', kind: 'fresh-session', provenance: 'harness', identity: 'alice', data: { entity: 'booking:alice', observed: 1 } },
          { id: 'delta-bob', kind: 'delta', provenance: 'harness', identity: 'bob', data: { entity: 'booking:bob', before: 0, after: 1, nonce: 'nonce-bob' } },
          { id: 'fresh-bob', kind: 'fresh-session', provenance: 'harness', identity: 'bob', data: { entity: 'booking:bob', observed: 1 } },
          { id: 'attempt-mallory', kind: 'attempt', provenance: 'harness', identity: 'mallory', data: { request: 'POST /bookings (out-of-scope tenant)', rejected: true, status: 403 } },
          { id: 'delta-mallory', kind: 'delta', provenance: 'harness', identity: 'mallory', data: { entity: 'booking:mallory', before: 0, after: 0, nullDelta: true } },
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
          mint({ id: 'pr-delta', kind: 'delta', provenance: 'harness', sourcePR: true, identity: 'owner', data: { entity: 'booking', before: 0, after: 1 } }),
          mint({ id: 'fresh-1', kind: 'fresh-session', provenance: 'harness', identity: 'owner', data: { observed: 1 } }),
        ],
        reproduce: { k: 2, n: 2 },
      }),
  },
  {
    name: 'seed-match-null-delta',
    cheat:
      'aims an equals check at a seeded row the user action never changed — a GENUINE harness delta with before==after (null delta) that greens a no-op (FW-1, §1.1 write-set-bound)',
    build: () =>
      sealed({
        intent: 'The coupon sets the total to 20 (the row was already seeded at 20; the action changed nothing).',
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
          // A GENUINE harness observation — but of a no-op: before==after==20, nothing changed.
          mint({ id: 'seed-delta', kind: 'delta', provenance: 'harness', identity: 'shopper', data: { entity: 'order.total', before: 20, after: 20 } }),
          mint({ id: 'seed-fresh', kind: 'fresh-session', provenance: 'harness', identity: 'shopper', data: { observed: 20 } }),
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
          mint({ id: 'delta-owner', kind: 'delta', provenance: 'harness', identity: 'owner', data: { entity: 'booking:owner', before: 0, after: 1 } }),
          mint({ id: 'fresh-owner', kind: 'fresh-session', provenance: 'harness', identity: 'owner', data: { observed: 1 } }),
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
          mint({ id: 'delta-null', kind: 'delta', provenance: 'harness', identity: 'attacker', data: { entity: 'booking', before: 0, after: 0, nullDelta: true } }),
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
          mint({ id: 'nav-1', kind: 'nav', provenance: 'harness', data: { frontDoor: true, cause: 'entry-url' } }),
          mint({ id: 'probe-1', kind: 'attempt', provenance: 'harness', data: { probe: 'sqli', survived: true } }),
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
    name: 'catch-labeled-harness-delta',
    cheat: 'a Catch store-delta the driver LABELS provenance:harness but never minted — newBundle downgrades it to agent, so the persisted leg is unsatisfied (NOT_EXECUTED)',
    build: () =>
      sealed(
        catchSpec({
          // A plain object (no mint) — it rides the proposer path, so newBundle stamps it agent.
          storeDelta: { id: 'store-delta', kind: 'delta', provenance: 'harness', sourcePR: false, identity: 'form-visitor', data: { entity: CATCH_ENTITY, before: 6, after: 7, countBefore: 6, countAfter: 7, workflowId: 'wf-7130', status: 'success', nonce: 'pb-3ddc176-r0' } },
        })
      ),
  },
  {
    name: 'catch-app-endpoint-delta',
    cheat: "presents the app's OWN n8n REST read (GET /rest/executions) as the persisted leg, minted TOOL not HARNESS — an app-surface read is not the out-of-band store handle (§1.1/§4, M3), so it cannot satisfy the persisted leg (NOT_EXECUTED)",
    build: () =>
      sealed(
        catchSpec({
          storeDelta: mint({ id: 'store-delta', kind: 'delta', provenance: 'tool', identity: 'form-visitor', data: { entity: CATCH_ENTITY, before: 6, after: 7, source: 'GET /rest/executions' } }),
        })
      ),
  },
  {
    name: 'catch-null-delta-tautology',
    cheat: "aims an op:'equals' check at the UNCHANGED max execution id (before==after==7) — a genuine harness delta of a no-op the submit never changed; the null-delta guard fires (FW-1/§1.1 write-set-bound → NOT_EXECUTED)",
    build: () =>
      sealed(
        catchSpec({
          storeDelta: mint({ id: 'store-delta', kind: 'delta', provenance: 'harness', sourcePR: false, identity: 'form-visitor', data: { entity: CATCH_ENTITY, before: 7, after: 7, countBefore: 7, countAfter: 7 } }),
          relation: { op: 'equals', value: 7 },
        })
      ),
  },
  {
    name: 'catch-stale-confirm-leg',
    cheat: "the fresh REST re-read observed a STALE id (6) that disagrees with the store delta's after (7) — the confirm leg is not content-bound to the delta, so a real increase cannot be CONFIRMED (§1.1 dual-leg → NOT_EXECUTED)",
    build: () =>
      sealed(
        catchSpec({
          freshExecution: mint({ id: 'fresh-execution', kind: 'fresh-session', provenance: 'tool', identity: 'form-visitor', data: { entity: CATCH_ENTITY, executionId: 6, observed: 6 } }),
        })
      ),
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
