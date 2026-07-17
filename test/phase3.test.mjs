// @ts-check
/**
 * Phase 3 tests — the Catch. The lying shop (coupon in the response, not the store)
 * must land DOES_NOT_WORK and name the response-vs-store mismatch; the honest shop must
 * earn WORKS; and removing the store-read (delta) receipt — pb's ground-truth handle —
 * must demote the honest run to COULD_NOT_DETERMINE (nothing left to confirm the effect).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newBundle } from '../src/evidence.mjs';
import { verdict } from '../src/verdict.mjs';
import { runPhase3 } from '../src/phases/phase3.mjs';
import { Verdict } from '../src/types.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LYING = join(ROOT, 'fixtures', 'shop-lying');
const HONEST = join(ROOT, 'fixtures', 'shop-honest');

test('phase3 Catch: shop-lying => DOES_NOT_WORK, naming the response-vs-store mismatch', async () => {
  const r = await runPhase3({ appDir: LYING });
  assert.equal(r.verdict.state, Verdict.DOES_NOT_WORK, r.verdict.reasons.join(' | '));
  const surface = [...r.diagnosis, ...r.verdict.reasons].join(' ');
  assert.match(surface, /response/i);
  assert.match(surface, /store|persist/i);
});

test('phase3 Catch: shop-honest => WORKS', async () => {
  const r = await runPhase3({ appDir: HONEST });
  assert.equal(r.verdict.state, Verdict.WORKS, r.verdict.reasons.join(' | '));
});

test('phase3 Catch: deleting the store-read (delta) receipt => COULD_NOT_DETERMINE', async () => {
  const r = await runPhase3({ appDir: HONEST });
  assert.equal(r.verdict.state, Verdict.WORKS, r.verdict.reasons.join(' | '));
  const effect = r.bundle.claims.find((c) => c.kind === 'effect');
  assert.ok(effect && effect.effectCheck, 'effect claim present');
  const deltaId = effect.effectCheck.deltaReceiptId;
  const stripped = newBundle({
    intent: r.bundle.intent,
    actorIdentity: r.bundle.actorIdentity,
    claims: r.bundle.claims,
    receipts: r.bundle.receipts.filter((rc) => rc.id !== deltaId),
    reproduce: r.bundle.reproduce,
  });
  assert.equal(verdict(stripped).state, Verdict.COULD_NOT_DETERMINE);
});

test('phase3: an app with no fixture manifest => COULD_NOT_DETERMINE', async () => {
  const r = await runPhase3({ appDir: ROOT });
  assert.equal(r.verdict.state, Verdict.COULD_NOT_DETERMINE);
  assert.match(r.diagnosis.join(' '), /not built|conjure|drive/i);
});
