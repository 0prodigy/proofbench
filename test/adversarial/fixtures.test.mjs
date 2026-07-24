// @ts-check
/**
 * Adversarial FIXTURE attacks on phase 3 — real two-service HTTP apps driven end to end
 * through the actual runPhase3 entrypoint (docs/internal/phase-3-theory.md §1.1, FW-1/FW-5).
 *
 * (a) shop-cache-echo — the whole app surface lies (response AND fresh GET echo the
 *     discount from a cache) while the store handle holds the un-discounted base. The
 *     persisted leg, read out of band, must still catch it => DOES_NOT_WORK.
 * (e) shop-rollback  — the discount IS persisted at read time, then a compensating
 *     transaction rolls it back after the response. A settle re-read of the persisted
 *     leg must catch the transient effect => not WORKS.
 *
 * Behaviour preservation is asserted alongside: the honest shop still earns WORKS.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPhase3 } from '../../src/phases/phase3.mjs';
import { Verdict } from '../../src/types.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CACHE_ECHO = join(ROOT, 'fixtures', 'shop-cache-echo');
const ROLLBACK = join(ROOT, 'fixtures', 'shop-rollback');
const STALE_GET = join(ROOT, 'fixtures', 'shop-stale-get');
const HONEST = join(ROOT, 'fixtures', 'shop-honest');

test('(a) cache/echo: app surface lies (cached discount) but the store handle holds base => DOES_NOT_WORK', async () => {
  const r = await runPhase3({ appDir: CACHE_ECHO });
  assert.equal(r.verdict.state, Verdict.DOES_NOT_WORK, r.verdict.reasons.join(' | '));
  const surface = [...r.diagnosis, ...r.verdict.reasons].join(' ');
  // The persisted leg (store handle), not the app's cached surface, is what decided it.
  assert.match(surface, /persist|store/i);
});

test('(e) async settle: discount persisted at read time then rolled back => not WORKS', async () => {
  const r = await runPhase3({ appDir: ROLLBACK });
  assert.notEqual(r.verdict.state, Verdict.WORKS, `a transient (rolled-back) effect must never be WORKS: ${r.verdict.reasons.join(' | ')}`);
  // The rolled-back persisted value contradicts the discounted claim, or the settle window
  // recorded the value as unstable — either way, honestly not-WORKS.
  const surface = [...r.diagnosis, ...r.verdict.reasons].join(' ');
  assert.match(surface, /roll|settle|unstable|persist|transient/i);
});

test('(f) decorative fresh leg: store persists correctly but GET serves a stale value => not WORKS', async () => {
  const r = await runPhase3({ appDir: STALE_GET });
  // The persisted leg is correct, but the fresh-session GET disagrees with it — content-binding
  // the confirm leg (§1.1 dual-leg) refuses to confirm, so this cannot be WORKS.
  assert.notEqual(r.verdict.state, Verdict.WORKS, `a stale fresh-session read cannot confirm the effect: ${r.verdict.reasons.join(' | ')}`);
  const surface = [...r.diagnosis, ...r.verdict.reasons].join(' ');
  assert.match(surface, /stale|fresh|confirm/i);
});

test('(control) the honest shop still earns WORKS under the settle policy', async () => {
  const r = await runPhase3({ appDir: HONEST });
  assert.equal(r.verdict.state, Verdict.WORKS, r.verdict.reasons.join(' | '));
});
