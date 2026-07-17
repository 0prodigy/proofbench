// @ts-check
/**
 * The harness mint — pb's out-of-band evidence tap, and the ONLY constructor that
 * yields tool|harness provenance.
 *
 * pb (the harness: the honest driver + the phase runners) mints its own out-of-band
 * observations here. Every OTHER path — the proposer-facing newBundle — forces
 * provenance:'agent', so a driving agent can never *label* a receipt it fabricated as
 * satisfying evidence (docs/phase-3-theory.md §0 rule 1, §1.1). The seam is the whole
 * guard: a module-private brand no proposer can reach, plus default-agent everywhere
 * else. There is deliberately no capability system, no identity ledger, and no
 * per-actor key — just this one module boundary.
 *
 * Node built-ins only. Its content addressing mirrors evidence.mjs by construction
 * (identical stable-stringify + sha256); the two modules stay independent on purpose.
 */

import { createHash } from 'node:crypto';
import { Provenance } from './types.mjs';

/**
 * The brand a minted receipt carries. Module-private and never exported — a proposer
 * (or the proposer-facing newBundle) has no handle to set it, so only mint() can.
 */
const MINTED = Symbol('pb.harness.minted');

/**
 * Stable, key-sorted JSON so the content address is order-independent (mirrors
 * evidence.mjs; the duplication is intentional — modules stay independent).
 * @param {any} value
 * @returns {string}
 */
function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}
/**
 * @param {any} v
 * @returns {any}
 */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/**
 * Mint a harness/tool receipt: stamp its provenance (tool|harness only — the harness
 * never mints agent, so anything else is floored to harness), its content address, and
 * the unforgeable module-private brand. This is the sole path to satisfying provenance.
 * @param {import('./types.mjs').Receipt} receipt
 * @returns {import('./types.mjs').Receipt}
 */
export function mint(receipt) {
  const provenance = receipt && receipt.provenance === Provenance.TOOL ? Provenance.TOOL : Provenance.HARNESS;
  const minted = {
    ...receipt,
    provenance,
    sha256: sha256Hex(stableStringify((receipt && receipt.data) ?? null)),
  };
  // Non-enumerable so it is invisible to JSON, to Object.keys (the seal manifest), and to
  // the verdict — it is a pure in-process tag, never serialized nor signed over.
  Object.defineProperty(minted, MINTED, { value: true, enumerable: false });
  return minted;
}

/**
 * Whether a receipt carries the harness brand (i.e. came from mint). The proposer-facing
 * newBundle uses this to decide whether to preserve provenance or force it to agent.
 * @param {any} receipt
 * @returns {boolean}
 */
export function isMinted(receipt) {
  return !!receipt && receipt[MINTED] === true;
}

/**
 * @param {string} str
 * @returns {string}
 */
function sha256Hex(str) {
  return createHash('sha256').update(Buffer.from(str, 'utf8')).digest('hex');
}
