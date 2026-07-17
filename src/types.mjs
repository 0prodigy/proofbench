// @ts-check
/**
 * Core enums + JSDoc typedefs for the pb honesty core (Phase 3 / E1).
 *
 * Node built-ins only, ES modules. These are the frozen nouns every other module
 * reads. See docs/phase-3-theory.md §0-§2, §7 for the property (P') they encode.
 */

/**
 * Evidence provenance, ordered by trust: agent < tool < harness.
 *
 * Rule 1 of the verdict: only tool|harness receipts may SATISFY a claim; an
 * agent-provenance receipt can only corroborate. The whole property rests on the
 * driving agent having no write-handle to satisfying evidence.
 * @readonly
 * @enum {string}
 */
export const Provenance = Object.freeze({
  AGENT: 'agent',
  TOOL: 'tool',
  HARNESS: 'harness',
});

/** @type {Readonly<Record<string, number>>} */
const PROVENANCE_RANK = Object.freeze({ agent: 0, tool: 1, harness: 2 });

/**
 * Trust rank of a provenance (agent=0 < tool=1 < harness=2). An unknown
 * provenance ranks -1, so it can never satisfy a claim.
 * @param {Provenance|string} provenance
 * @returns {number}
 */
export function rankOf(provenance) {
  return Object.prototype.hasOwnProperty.call(PROVENANCE_RANK, provenance)
    ? PROVENANCE_RANK[/** @type {string} */ (provenance)]
    : -1;
}

/**
 * The tri-state verdict, plus UNVERIFIED for a broken seal (a tampered bundle is
 * not judged on its contents at all).
 * @readonly
 * @enum {string}
 */
export const Verdict = Object.freeze({
  WORKS: 'WORKS',
  DOES_NOT_WORK: 'DOES_NOT_WORK',
  COULD_NOT_DETERMINE: 'COULD_NOT_DETERMINE',
  UNVERIFIED: 'UNVERIFIED',
});

/**
 * Per-claim state, computed LAST from sealed receipts — never from the claim's
 * own assertion. NOT_EXECUTED ≡ untested → contributes to CND, never to a pass.
 * @readonly
 * @enum {string}
 */
export const ClaimState = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  FALSIFIED: 'FALSIFIED',
  NOT_EXECUTED: 'NOT_EXECUTED',
});

/**
 * Receipt kinds captured out-of-band by the harness/tool taps.
 * @readonly
 * @enum {string}
 */
export const ReceiptKind = Object.freeze({
  DELTA: 'delta', // observed persisted-state change in a user-action window (§1.1)
  ATTEMPT: 'attempt', // attempted-action receipt: request + app response (M1, §7)
  FRESH_SESSION: 'fresh-session', // re-observation from a fresh user session (§1.1)
  EGRESS: 'egress', // outbound call recorded in the sealed-room egress ledger (§1.5)
  NAV: 'nav', // navigation with its recorded cause (§1.2.4)
});

/**
 * Claim kinds pre-registered before the walk.
 * @readonly
 * @enum {string}
 */
export const ClaimKind = Object.freeze({
  EFFECT: 'effect', // a state-changing outcome confirmed on ground truth
  NEGATIVE: 'negative', // a "cannot happen" outcome (needs an attempt receipt, M1)
  SURVIVE: 'survive', // a hostile-repertoire class the feature withstood
  REACH: 'reach', // the front door was reached via user-shaped navigation
});

/**
 * @typedef {Object} Receipt
 * @property {string} id
 * @property {ReceiptKind|string} kind
 * @property {Provenance|string} provenance
 * @property {string} [sha256] content address of `data` (filled by newBundle)
 * @property {boolean} [sourcePR] true if this oracle is code shipped by the PR under test (M3, FW-19)
 * @property {string} [identity] actor/session identity this receipt ran under (M2, owner-shadow guard)
 * @property {any} data harness-observed payload — never an agent assertion
 */

/**
 * A write-set-bound effect check (§1.1): admissible only if it binds an entity the
 * harness saw change inside a user-action window, confirmed on both a persisted
 * delta leg and a confirm leg (fresh-session, or content-bound egress §1.5).
 * @typedef {Object} EffectCheck
 * @property {string} entity entity identified pre-action
 * @property {any} [beforeValue] pinned comparator baseline (comparator provenance, §1.1)
 * @property {{op:('increased'|'decreased'|'changed'|'unchanged'|'equals'|string), value?:any}} expectedAfterRelation
 * @property {string} deltaReceiptId id of the observed persisted-delta receipt
 * @property {string} confirmLegReceiptId id of the confirm-leg receipt
 */

/**
 * @typedef {Object} Claim
 * @property {string} id
 * @property {ClaimKind|string} kind
 * @property {boolean} [quantified] universal quantifier (any/all/every) → §1.4 lint at verdict
 * @property {string} scope
 * @property {EffectCheck} [effectCheck]
 * @property {string[]} [receiptIds]
 */

/**
 * @typedef {Object} Reproduce
 * @property {number} k successful reproductions from a fresh world
 * @property {number} n attempts (WORKS requires k >= 2; a single walk is never WORKS, FW-6)
 */

/**
 * @typedef {Object} Seal
 * @property {string} algorithm always 'ed25519'
 * @property {string} digest sha256 hex of the canonical manifest
 * @property {string} signature base64 ed25519 signature over the digest bytes
 * @property {string} publicKey base64 SPKI DER public key (not secret; box-owner forgery is out of scope v1)
 */

/**
 * @typedef {Object} EvidenceBundle
 * @property {any} intent
 * @property {string|null} actorIdentity the configuring actor (owner-shadow guard, §1.4)
 * @property {Claim[]} claims
 * @property {Receipt[]} receipts
 * @property {Reproduce} reproduce
 * @property {Seal} [seal]
 */

/**
 * @typedef {Object} ScoreboardEntry
 * @property {string} claimId
 * @property {string} kind
 * @property {boolean} quantified
 * @property {string|null} scope
 * @property {ClaimState|string} state
 * @property {string} detail why the state was assigned
 * @property {boolean} naJustified mechanically-justified N/A (rule 6), proven from a harness receipt
 */

/**
 * @typedef {Object} VerdictResult
 * @property {Verdict|string} state
 * @property {string[]} reasons
 * @property {ScoreboardEntry[]} scoreboard
 */
