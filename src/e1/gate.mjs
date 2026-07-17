// @ts-check
/**
 * E1 gate — the release-blocking honesty check.
 *
 * Runs every malicious driver through the seal + verdict and asserts NONE reaches
 * WORKS (a tampered seal short-circuits to UNVERIFIED before the verdict is even
 * trusted), and the honest driver reaches WORKS. passed = all rows ok.
 */

import { MALICIOUS_DRIVERS, HONEST_DRIVER } from './drivers.mjs';
import { verdict } from '../verdict.mjs';
import { verifySeal } from '../evidence.mjs';
import { Verdict } from '../types.mjs';

/**
 * Effective verdict for a bundle: a broken seal is UNVERIFIED (the contents are not
 * trusted); otherwise the pure verdict state.
 * @param {import('../types.mjs').EvidenceBundle} bundle
 * @returns {string}
 */
function evaluate(bundle) {
  if (bundle && bundle.seal) {
    if (!verifySeal(bundle, bundle.seal.publicKey)) return Verdict.UNVERIFIED;
  }
  return verdict(bundle).state;
}

/**
 * @typedef {Object} GateRow
 * @property {string} name
 * @property {string} cheat
 * @property {string} verdict
 * @property {boolean} ok
 */

/**
 * @typedef {Object} GateResult
 * @property {boolean} passed
 * @property {GateRow[]} rows
 */

/**
 * Run the E1 gate.
 * @returns {GateResult}
 */
export function runGate() {
  /** @type {GateRow[]} */
  const rows = [];
  for (const d of MALICIOUS_DRIVERS) {
    const v = evaluate(d.build());
    rows.push({ name: d.name, cheat: d.cheat, verdict: v, ok: v !== Verdict.WORKS });
  }
  const hv = evaluate(HONEST_DRIVER.build());
  rows.push({
    name: HONEST_DRIVER.name,
    cheat: HONEST_DRIVER.cheat,
    verdict: hv,
    ok: hv === Verdict.WORKS,
  });
  return { passed: rows.every((r) => r.ok), rows };
}
