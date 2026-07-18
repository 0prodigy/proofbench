// @ts-check
/**
 * Reaper LOGIC tests — the interrupt-reap registry that stops `pb conjure`/`pb prove` from leaking
 * SUT containers when a Ctrl-C (SIGINT) / orchestrator kill (SIGTERM) bypasses the `finally`
 * teardown. NO real OS signal and NO docker: we exercise the registry the signal handler drains
 * (runAllReaps) DIRECTLY — register N reaps → all run even if one throws; de-register removes one;
 * a drained registry never double-reaps. The live signal→process.exit wiring is the thin OS glue the
 * brief deliberately leaves untested (a real signal would kill the test process). Each test drains or
 * de-registers, so the module-level registry starts empty for the next one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerReap, deregisterReap, runAllReaps } from '../src/reaper.mjs';

test('reaper: runAllReaps runs every registered reap, even when one throws (and awaits async reaps)', async () => {
  /** @type {string[]} */
  const calls = [];
  registerReap(() => { calls.push('a'); });
  registerReap(() => { throw new Error('reap b blew up'); }); // a throwing reap must not block the rest
  registerReap(async () => { calls.push('c'); }); // async reaps are awaited
  await runAllReaps();
  assert.deepEqual(calls, ['a', 'c']); // a and c both ran (insertion order); b threw but was swallowed
});

test('reaper: runAllReaps drains the registry — a second run reaps nothing (no double-reap)', async () => {
  let n = 0;
  registerReap(() => { n++; });
  await runAllReaps();
  assert.equal(n, 1);
  await runAllReaps(); // registry already drained → the reap does not run again
  assert.equal(n, 1);
});

test('reaper: deregisterReap removes exactly the one reap (the normal-teardown path)', async () => {
  /** @type {string[]} */
  const calls = [];
  const a = registerReap(() => { calls.push('a'); });
  registerReap(() => { calls.push('b'); });
  deregisterReap(a); // the SUT whose normal teardown already reaped de-registers its own reap
  await runAllReaps();
  assert.deepEqual(calls, ['b']); // only b remained to be reaped — a was removed, not double-reaped
});

test('reaper: registerReap returns the same reference so it can be de-registered', () => {
  const fn = () => {};
  assert.equal(registerReap(fn), fn);
  deregisterReap(fn); // leave the registry empty (this reap must not run in a later runAllReaps)
});

test('reaper: a teardown-shaped async reap (catch.mjs browser/workflow sidecar) is drained + awaited', async () => {
  // Models exactly what catch.mjs registers after openBrowserFn/argoRunFn: an async sidecar teardown
  // wrapped in try/catch. The signal handler drains it just like conjure's SUT reap.
  let toreDown = false;
  const sidecarReap = registerReap(async () => { try { await Promise.resolve(); toreDown = true; } catch { /* already gone */ } });
  await runAllReaps();
  assert.equal(toreDown, true); // the sidecar teardown ran and was awaited
  deregisterReap(sidecarReap); // de-registering after a drain is a safe no-op (the normal-teardown order)
});
