// @ts-check
/**
 * The verdict function — the deterministic spine of the honesty core.
 *
 * verdict(bundle) is PURE and deterministic: the state is computed LAST from the
 * receipts, never from a claim's own assertion. It implements the rules of
 * docs/phase-3-theory.md §0-§2/§7 in the exact order below:
 *
 *   1. Only tool|harness receipts satisfy a claim; agent receipts corroborate only.
 *   2. Any FALSIFIED claim => DOES_NOT_WORK.
 *   3. An effect claim is CONFIRMED only if its EffectCheck binds a delta receipt
 *      that is harness-provenance AND not sourcePR (M3) AND has a confirm leg
 *      (fresh-session, or egress content-bound to the same delta §1.5); else NOT_EXECUTED.
 *   4. A negative claim is CONFIRMED only with BOTH a null delta AND an attempt
 *      receipt (M1); else NOT_EXECUTED.
 *   5. Quantifier lint (§1.4/FW-11): a quantified claim needs >=2 CONFIRMED
 *      instantiations with DISTINCT identity != actorIdentity, plus >=1 CONFIRMED
 *      negative; else NOT_EXECUTED.
 *   6. WORKS requires >=1 CONFIRMED effect claim, all declared claims CONFIRMED
 *      (or justified-N/A), and reproduce.k >= 2; a single walk is never WORKS (FW-6).
 *   7. Else nothing falsified but something NOT_EXECUTED/missing => COULD_NOT_DETERMINE,
 *      naming what + why.
 */

import {
  Provenance,
  Verdict,
  ClaimState,
  ReceiptKind,
  ClaimKind,
  rankOf,
} from './types.mjs';

const TOOL_RANK = rankOf(Provenance.TOOL);
const HARNESS_RANK = rankOf(Provenance.HARNESS);

/**
 * Stable, key-sorted JSON so structural equality is order-independent.
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
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

/**
 * @param {import('./types.mjs').EvidenceBundle} bundle
 * @returns {Map<string, import('./types.mjs').Receipt>}
 */
function receiptMap(bundle) {
  const m = new Map();
  for (const r of bundle.receipts ?? []) if (r && r.id != null) m.set(r.id, r);
  return m;
}

/**
 * Resolve a claim's receipt ids to the receipts present in the map (missing ids dropped).
 * @param {import('./types.mjs').Claim} claim
 * @param {Map<string, import('./types.mjs').Receipt>} rmap
 * @returns {import('./types.mjs').Receipt[]}
 */
function claimReceipts(claim, rmap) {
  /** @type {import('./types.mjs').Receipt[]} */
  const out = [];
  for (const id of claim.receiptIds || []) {
    const r = rmap.get(id);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Rule 1: a receipt can satisfy a claim only if it is tool|harness provenance.
 * @param {import('./types.mjs').Receipt|undefined} r
 * @returns {r is import('./types.mjs').Receipt}
 */
function satisfies(r) {
  return !!r && rankOf(r.provenance) >= TOOL_RANK;
}

/**
 * The persisted leg (a `delta` receipt) is the store-of-record ground truth (§1.1) and is
 * admissible only if it is HARNESS provenance — an out-of-band store-handle observation the
 * driving agent has no write-handle to. A tool/agent `delta` is an app-surface read (the
 * app's own endpoint / an internal verify route) masquerading as ground truth (§4, M3/FW-19);
 * it may corroborate as a confirm leg but can never satisfy the persisted leg.
 * @param {import('./types.mjs').Receipt|undefined} r
 * @returns {r is import('./types.mjs').Receipt}
 */
function satisfiesPersisted(r) {
  return !!r && rankOf(r.provenance) >= HARNESS_RANK;
}

/**
 * A delta is "null" when the harness saw no change in the window.
 * @param {import('./types.mjs').Receipt} deltaReceipt
 * @returns {boolean}
 */
function isNullDelta(deltaReceipt) {
  const d = (deltaReceipt && deltaReceipt.data) || {};
  if (d.nullDelta === true) return true;
  if ('before' in d && 'after' in d) return deepEqual(d.before, d.after);
  return false;
}

/**
 * Whether the observed before/after satisfies the effect check's relation.
 * @param {{op:string, value?:any}|undefined} rel
 * @param {any} before
 * @param {any} after
 * @returns {boolean}
 */
function relationHolds(rel, before, after) {
  if (!rel || typeof rel.op !== 'string') return false;
  switch (rel.op) {
    case 'increased':
      return Number(after) > Number(before);
    case 'decreased':
      return Number(after) < Number(before);
    case 'changed':
      return !deepEqual(before, after);
    case 'unchanged':
      return deepEqual(before, after);
    case 'equals':
      return deepEqual(after, rel.value);
    default:
      return false;
  }
}

/**
 * A confirm leg is valid iff it is tool|harness AND either a fresh-session
 * re-observation, or an egress receipt content-bound to the same delta (§1.5).
 * @param {import('./types.mjs').Receipt|undefined} leg
 * @param {import('./types.mjs').Receipt} delta
 */
function isValidConfirmLeg(leg, delta) {
  if (!satisfies(leg)) return false;
  if (leg.kind === ReceiptKind.FRESH_SESSION) return true;
  if (leg.kind === ReceiptKind.EGRESS) return contentBinds(leg, delta);
  return false;
}

/**
 * Egress content-binding: a shared same-window nonce, or a hash of the delta content.
 * @param {import('./types.mjs').Receipt} egress
 * @param {import('./types.mjs').Receipt} delta
 * @returns {boolean}
 */
function contentBinds(egress, delta) {
  const en = egress && egress.data ? egress.data.nonce : undefined;
  const dn = delta && delta.data ? delta.data.nonce : undefined;
  if (en != null && dn != null && deepEqual(en, dn)) return true;
  const cb = egress && egress.data ? egress.data.contentBoundSha : undefined;
  if (cb && delta && cb === delta.sha256) return true;
  return false;
}

/**
 * Rule 3 base evaluation for an effect claim (before the quantifier lint).
 * @param {import('./types.mjs').Claim} claim
 * @param {Map<string, import('./types.mjs').Receipt>} rmap
 */
function evalEffect(claim, rmap) {
  const ec = claim.effectCheck;
  if (!ec) return { state: ClaimState.NOT_EXECUTED, detail: 'effect claim has no effectCheck' };
  const delta = rmap.get(ec.deltaReceiptId);
  if (!satisfiesPersisted(delta) || delta.kind !== ReceiptKind.DELTA) {
    return {
      state: ClaimState.NOT_EXECUTED,
      detail:
        'delta receipt missing or not a HARNESS store-handle observation — a tool/agent or app-endpoint read cannot satisfy the persisted leg (§1.1/§4, M3)',
    };
  }
  if (delta.sourcePR === true) {
    return {
      state: ClaimState.NOT_EXECUTED,
      detail: 'delta oracle is code shipped by the PR under test (sourcePR) — disqualified (M3/FW-19)',
    };
  }
  const leg = rmap.get(ec.confirmLegReceiptId);
  if (!isValidConfirmLeg(leg, delta)) {
    return {
      state: ClaimState.NOT_EXECUTED,
      detail: 'no valid confirm leg (needs fresh-session, or egress content-bound to the delta)',
    };
  }
  const dd = delta.data || {};
  const before = 'before' in dd ? dd.before : ec.beforeValue;
  if (ec.beforeValue !== undefined && !deepEqual(ec.beforeValue, before)) {
    return {
      state: ClaimState.NOT_EXECUTED,
      detail: 'comparator baseline mismatch (pinned beforeValue != observed delta before)',
    };
  }
  if (relationHolds(ec.expectedAfterRelation, before, dd.after)) {
    return { state: ClaimState.CONFIRMED, detail: 'effect confirmed on a harness delta + confirm leg' };
  }
  return { state: ClaimState.FALSIFIED, detail: 'harness delta does not satisfy the expected relation' };
}

/**
 * Rule 4: a negative claim needs BOTH a null delta AND an attempt receipt (M1).
 * @param {import('./types.mjs').Claim} claim
 * @param {Map<string, import('./types.mjs').Receipt>} rmap
 */
function evalNegative(claim, rmap) {
  const receipts = claimReceipts(claim, rmap);
  const attempt = receipts.find((r) => r.kind === ReceiptKind.ATTEMPT && satisfies(r));
  const delta = receipts.find((r) => r.kind === ReceiptKind.DELTA && satisfiesPersisted(r));
  if (!attempt) {
    return {
      state: ClaimState.NOT_EXECUTED,
      detail: 'no attempted-action receipt (M1) — a null delta cannot distinguish "blocked" from "never tried"',
    };
  }
  if (!delta) {
    return { state: ClaimState.NOT_EXECUTED, detail: 'no delta receipt to prove no state change occurred' };
  }
  if (isNullDelta(delta)) {
    return { state: ClaimState.CONFIRMED, detail: 'attempt was made and produced no persisted change (blocked)' };
  }
  return { state: ClaimState.FALSIFIED, detail: 'the "cannot" was violated — the attempt persisted a change' };
}

/**
 * A reach claim is CONFIRMED only via a front-door navigation receipt; a deep link
 * (typed non-entry URL) does not confirm reach (§1.2.4).
 * @param {import('./types.mjs').Claim} claim
 * @param {Map<string, import('./types.mjs').Receipt>} rmap
 */
function evalReach(claim, rmap) {
  const receipts = claimReceipts(claim, rmap);
  const nav = receipts.find((r) => r.kind === ReceiptKind.NAV && satisfies(r));
  if (!nav) return { state: ClaimState.NOT_EXECUTED, detail: 'no navigation receipt' };
  if (nav.data && nav.data.frontDoor === true) {
    return { state: ClaimState.CONFIRMED, detail: 'front door reached via user-shaped navigation' };
  }
  return { state: ClaimState.NOT_EXECUTED, detail: 'navigation was a deep link, not the front door — reach not confirmed' };
}

/**
 * A survive claim is CONFIRMED only if a harness/tool probe receipt records the
 * hostile class was withstood; an errored/absent probe is never "survived" (§1.3).
 * @param {import('./types.mjs').Claim} claim
 * @param {Map<string, import('./types.mjs').Receipt>} rmap
 */
function evalSurvive(claim, rmap) {
  const receipts = claimReceipts(claim, rmap);
  const probe = receipts.find((r) => satisfies(r) && r.data && 'survived' in r.data);
  if (!probe) return { state: ClaimState.NOT_EXECUTED, detail: 'no hostile-probe receipt' };
  if (probe.data.survived === true) return { state: ClaimState.CONFIRMED, detail: 'hostile-repertoire class survived' };
  return { state: ClaimState.FALSIFIED, detail: 'hostile-repertoire probe breached the feature' };
}

/**
 * Mechanically-justified N/A (rule 6): a survive/reach class proven inapplicable by
 * a harness/tool receipt (e.g. "no form element present"). Agent-declared N/A is not a green.
 * @param {import('./types.mjs').Claim} claim
 * @param {Map<string, import('./types.mjs').Receipt>} rmap
 */
function naJustified(claim, rmap) {
  if (claim.kind !== ClaimKind.SURVIVE && claim.kind !== ClaimKind.REACH) return false;
  const receipts = claimReceipts(claim, rmap);
  return receipts.some((r) => satisfies(r) && r.data && r.data.naJustification);
}

/**
 * Rule 5 support: distinct non-actor identities with a CONFIRMED effect instantiation
 * (a harness, non-sourcePR delta + a same-identity valid confirm leg + relation holds).
 * @param {import('./types.mjs').Claim} claim
 * @param {Map<string, import('./types.mjs').Receipt>} rmap
 * @param {string|null} actorIdentity
 * @returns {Set<string>}
 */
function distinctInstantiations(claim, rmap, actorIdentity) {
  const receipts = claimReceipts(claim, rmap);
  const deltas = receipts.filter(
    (r) => r.kind === ReceiptKind.DELTA && satisfiesPersisted(r) && r.sourcePR !== true
  );
  const ec = claim.effectCheck;
  /** @type {Set<string>} */
  const identities = new Set();
  for (const d of deltas) {
    const identity = d.identity;
    if (identity == null || identity === actorIdentity) continue;
    const leg = receipts.find(
      (r) =>
        (r.kind === ReceiptKind.FRESH_SESSION || r.kind === ReceiptKind.EGRESS) &&
        r.identity === identity &&
        isValidConfirmLeg(r, d)
    );
    if (!leg) continue;
    const dd = d.data || {};
    const before = 'before' in dd ? dd.before : ec ? ec.beforeValue : undefined;
    if (ec && ec.beforeValue !== undefined && !deepEqual(ec.beforeValue, before)) continue;
    if (ec && !relationHolds(ec.expectedAfterRelation, before, dd.after)) continue;
    identities.add(identity);
  }
  return identities;
}

/**
 * Compute the verdict for a bundle. Pure and deterministic.
 * @param {import('./types.mjs').EvidenceBundle} bundle
 * @returns {import('./types.mjs').VerdictResult}
 */
export function verdict(bundle) {
  const rmap = receiptMap(bundle || /** @type {any} */ ({}));
  const actorIdentity = (bundle && bundle.actorIdentity) ?? null;
  const claims = (bundle && bundle.claims) || [];
  /** @type {string[]} */
  const reasons = [];

  // Pass 1: base state for every claim (rules 1, 3, 4, and reach/survive).
  /** @type {import('./types.mjs').ScoreboardEntry[]} */
  const scoreboard = claims.map((c) => {
    let res;
    switch (c.kind) {
      case ClaimKind.EFFECT:
        res = evalEffect(c, rmap);
        break;
      case ClaimKind.NEGATIVE:
        res = evalNegative(c, rmap);
        break;
      case ClaimKind.REACH:
        res = evalReach(c, rmap);
        break;
      case ClaimKind.SURVIVE:
        res = evalSurvive(c, rmap);
        break;
      default:
        res = { state: ClaimState.NOT_EXECUTED, detail: `unknown claim kind '${c.kind}'` };
    }
    return {
      claimId: c.id,
      kind: c.kind,
      quantified: !!c.quantified,
      scope: c.scope ?? null,
      state: res.state,
      detail: res.detail,
      naJustified: naJustified(c, rmap),
    };
  });

  // Pass 2: rule 5 quantifier lint — can only TIGHTEN a would-be pass, never loosen.
  for (let i = 0; i < claims.length; i++) {
    const c = claims[i];
    const entry = scoreboard[i];
    if (!c.quantified || entry.state !== ClaimState.CONFIRMED) continue;
    const distinct = distinctInstantiations(c, rmap, actorIdentity);
    const hasConfirmedNegative = scoreboard.some(
      (s) => s.kind === ClaimKind.NEGATIVE && s.state === ClaimState.CONFIRMED
    );
    if (distinct.size >= 2 && hasConfirmedNegative) {
      entry.detail += `; quantifier satisfied (${distinct.size} distinct non-actor instantiations + a confirmed negative)`;
    } else {
      entry.state = ClaimState.NOT_EXECUTED;
      const missing = [];
      if (distinct.size < 2) missing.push(`${distinct.size} distinct non-actor instantiation(s) (need >=2)`);
      if (!hasConfirmedNegative) missing.push('no confirmed out-of-scope negative');
      entry.detail = `quantifier lint failed (§1.4/FW-11): ${missing.join('; ')}`;
    }
  }

  // Rule 2: any FALSIFIED claim => DOES_NOT_WORK.
  const falsified = scoreboard.filter((s) => s.state === ClaimState.FALSIFIED);
  if (falsified.length > 0) {
    for (const s of falsified) reasons.push(`FALSIFIED ${s.claimId} (${s.kind}): ${s.detail}`);
    return { state: Verdict.DOES_NOT_WORK, reasons, scoreboard };
  }

  // Rule 6: WORKS.
  const confirmedEffect = scoreboard.some(
    (s) => s.kind === ClaimKind.EFFECT && s.state === ClaimState.CONFIRMED
  );
  const incomplete = scoreboard.filter(
    (s) => !(s.state === ClaimState.CONFIRMED || s.naJustified)
  );
  const k = (bundle && bundle.reproduce && bundle.reproduce.k) || 0;
  if (confirmedEffect && incomplete.length === 0 && k >= 2) {
    reasons.push(
      `WORKS: >=1 confirmed effect claim, all ${scoreboard.length} claim(s) satisfied, reproduced k=${k}.`
    );
    return { state: Verdict.WORKS, reasons, scoreboard };
  }

  // Rule 7: COULD_NOT_DETERMINE — name what + why.
  if (!confirmedEffect) {
    reasons.push('COULD_NOT_DETERMINE: no CONFIRMED effect claim (WORKS requires effectChecks >= 1, rechecked at verdict).');
  }
  for (const s of incomplete) {
    reasons.push(`COULD_NOT_DETERMINE: claim ${s.claimId} (${s.kind}) is ${s.state} — ${s.detail}`);
  }
  if (confirmedEffect && incomplete.length === 0 && k < 2) {
    reasons.push(`COULD_NOT_DETERMINE: reproduced only k=${k} (WORKS requires k>=2; a single walk is never WORKS, FW-6).`);
  }
  return { state: Verdict.COULD_NOT_DETERMINE, reasons, scoreboard };
}
