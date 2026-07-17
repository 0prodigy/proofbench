// @ts-check
/**
 * Phase 1 tests: the runner maps a repo's OWN test suite to the tri-state — a passing
 * suite is WORKS, a failing suite is DOES_NOT_WORK, and a zero-test or stack-less repo
 * is COULD_NOT_DETERMINE (never rounded up to green).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPhase1 } from '../src/phases/phase1.mjs';
import { Verdict } from '../src/types.mjs';

/**
 * @param {string|null} testBody a *.test.mjs body, or null for a repo with no test files
 * @returns {string} the temp repo dir
 */
function makeRepo(testBody) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-phase1-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true, type: 'module', scripts: { test: 'node --test' } })
  );
  if (testBody != null) writeFileSync(join(dir, 'example.test.mjs'), testBody);
  return dir;
}

const PASSING = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds', () => assert.equal(1 + 1, 2));\n`;
const FAILING = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => assert.equal(1, 2));\n`;

test('phase1: a repo whose committed suite passes => WORKS', async () => {
  const dir = makeRepo(PASSING);
  try {
    const r = await runPhase1(dir);
    assert.equal(r.verdict.state, Verdict.WORKS, r.verdict.reasons.join(' | '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phase1: a repo whose committed suite fails => DOES_NOT_WORK', async () => {
  const dir = makeRepo(FAILING);
  try {
    const r = await runPhase1(dir);
    assert.equal(r.verdict.state, Verdict.DOES_NOT_WORK, r.verdict.reasons.join(' | '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phase1: a test script that runs zero tests => COULD_NOT_DETERMINE (zero-tests hole)', async () => {
  const dir = makeRepo(null);
  try {
    const r = await runPhase1(dir);
    assert.equal(r.verdict.state, Verdict.COULD_NOT_DETERMINE, r.verdict.reasons.join(' | '));
    assert.match(r.diagnosis.join(' '), /0 tests|zero-tests/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phase1: a dir with no supported stack => COULD_NOT_DETERMINE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-phase1-'));
  try {
    const r = await runPhase1(dir);
    assert.equal(r.verdict.state, Verdict.COULD_NOT_DETERMINE);
    assert.match(r.diagnosis.join(' '), /no supported stack/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
