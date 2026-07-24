// @ts-check
/**
 * exitCodeForVerdict — the frozen exit-code contract (CLAUDE.md) applied to a single verdict
 * state: 0 WORKS / 1 DOES_NOT_WORK / 2 COULD_NOT_DETERMINE / 3 anything else (internal, e.g. a
 * broken-seal UNVERIFIED state). Pure, docker-free: asserts the mapping directly, never a live run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeForVerdict } from '../src/cli.mjs';
import { Verdict } from '../src/types.mjs';

test('exitCodeForVerdict: WORKS => 0', () => {
  assert.equal(exitCodeForVerdict(Verdict.WORKS), 0);
});

test('exitCodeForVerdict: DOES_NOT_WORK => 1', () => {
  assert.equal(exitCodeForVerdict(Verdict.DOES_NOT_WORK), 1);
});

test('exitCodeForVerdict: COULD_NOT_DETERMINE => 2', () => {
  assert.equal(exitCodeForVerdict(Verdict.COULD_NOT_DETERMINE), 2);
});

test('exitCodeForVerdict: anything else (e.g. UNVERIFIED) => 3 (internal)', () => {
  assert.equal(exitCodeForVerdict(Verdict.UNVERIFIED), 3);
  assert.equal(exitCodeForVerdict('bogus'), 3);
});
