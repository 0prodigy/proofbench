// @ts-check
/**
 * pb prove --json tests — pure, docker-free: exercise buildVerdictJson (the render-layer JSON
 * assembler cli.mjs exports) directly against hand-built CatchResult shapes, never a live `prove`
 * run. Asserts the pb-verdict-v1 schema id, the legs shape, that every field is genuinely valid
 * JSON (a JSON.stringify → JSON.parse round trip loses nothing), and that exit_code always mirrors
 * the SAME pass/fail the human-readable path exits with (0 iff differential PASS, 1 otherwise) —
 * across a WORKS/DOES_NOT_WORK pass, a COULD_NOT_DETERMINE merge leg, and a non-discriminating
 * (both-WORKS) parent leg.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerdictJson } from '../src/cli.mjs';
import { Verdict } from '../src/types.mjs';

/**
 * A hand-built CatchResult (never a live runCatch) — only the fields buildVerdictJson reads.
 * @param {Object} o
 * @param {string} o.sha
 * @param {string} o.state
 * @param {string[]} [o.reasons]
 * @param {string|null} [o.receiptPath]
 * @returns {import('../src/catch.mjs').CatchResult}
 */
function fakeLeg({ sha, state, reasons = [], receiptPath = `/tmp/catch-${sha}.receipt.json` }) {
  return /** @type {any} */ ({
    phase: 'catch',
    sha,
    verdict: { state, reasons, scoreboard: [] },
    diagnosis: [],
    bundle: /** @type {any} */ ({}),
    receiptPath,
    proposal: null,
  });
}

test('buildVerdictJson: schema id is pb-verdict-v1', () => {
  const merge = fakeLeg({ sha: 'MERGESHA', state: Verdict.WORKS });
  const parent = fakeLeg({ sha: 'PARENTSHA', state: Verdict.DOES_NOT_WORK });
  const doc = buildVerdictJson({ recipeName: 'n8n-form-trigger-pr7130', merge, parent, pass: true, exitCode: 0 });
  assert.equal(doc.schema, 'pb-verdict-v1');
  assert.equal(doc.recipe, 'n8n-form-trigger-pr7130');
});

test('buildVerdictJson: WORKS/DOES_NOT_WORK differential PASS => verdict PASS, exit_code 0 (matches the human path)', () => {
  const merge = fakeLeg({ sha: 'aaa111', state: Verdict.WORKS, reasons: ['reproduced 2/2 with a fresh confirm leg'] });
  const parent = fakeLeg({ sha: 'bbb222', state: Verdict.DOES_NOT_WORK, reasons: ['the feature is absent at the parent SHA'] });
  const doc = buildVerdictJson({ recipeName: 'r', merge, parent, pass: true, exitCode: 0 });
  assert.equal(doc.verdict, 'PASS');
  assert.equal(doc.exit_code, 0);
  assert.equal(doc.differential.pass, true);
});

test('buildVerdictJson: merge=COULD_NOT_DETERMINE => differential FAIL, exit_code 1', () => {
  const merge = fakeLeg({ sha: 'ccc333', state: Verdict.COULD_NOT_DETERMINE, reasons: ['a single reproduction confirmed; a lone success cannot yet be WORKS'] });
  const parent = fakeLeg({ sha: 'ddd444', state: Verdict.DOES_NOT_WORK });
  const doc = buildVerdictJson({ recipeName: 'r', merge, parent, pass: false, exitCode: 1 });
  assert.equal(doc.verdict, 'FAIL');
  assert.equal(doc.exit_code, 1);
  assert.equal(doc.legs.merge.verdict, Verdict.COULD_NOT_DETERMINE);
});

test('buildVerdictJson: parent also WORKS (non-discriminating) => differential FAIL, exit_code 1, both leg states preserved', () => {
  const merge = fakeLeg({ sha: 'eee555', state: Verdict.WORKS });
  const parent = fakeLeg({ sha: 'fff666', state: Verdict.WORKS });
  const doc = buildVerdictJson({ recipeName: 'r', merge, parent, pass: false, exitCode: 1 });
  assert.equal(doc.verdict, 'FAIL');
  assert.equal(doc.exit_code, 1);
  assert.equal(doc.legs.merge.verdict, Verdict.WORKS);
  assert.equal(doc.legs.parent.verdict, Verdict.WORKS);
});

test('buildVerdictJson: legs shape carries sha/verdict/reason/case_file for both legs', () => {
  const merge = fakeLeg({ sha: 'shamerge', state: Verdict.WORKS, reasons: ['a', 'b'] });
  const parent = fakeLeg({ sha: 'shaparent', state: Verdict.DOES_NOT_WORK, reasons: [] });
  const doc = buildVerdictJson({ recipeName: 'r', merge, parent, pass: true, exitCode: 0 });
  assert.deepEqual(Object.keys(doc.legs.merge).sort(), ['case_file', 'reason', 'sha', 'verdict']);
  assert.equal(doc.legs.merge.sha, 'shamerge');
  assert.equal(doc.legs.merge.reason, 'a b');
  assert.equal(doc.legs.merge.case_file, '/tmp/catch-shamerge.receipt.json');
  // Empty reasons[] => null, never an empty string (a real absence, not a falsy-but-present value).
  assert.equal(doc.legs.parent.reason, null);
});

test('buildVerdictJson: case_file nulls out when the CatchResult carries no receiptPath', () => {
  const merge = fakeLeg({ sha: 'g1', state: Verdict.WORKS, receiptPath: '' });
  const parent = fakeLeg({ sha: 'g2', state: Verdict.DOES_NOT_WORK });
  const doc = buildVerdictJson({ recipeName: 'r', merge, parent, pass: true, exitCode: 0 });
  assert.equal(doc.legs.merge.case_file, null);
});

test('buildVerdictJson: emits genuinely valid JSON — a stringify/parse round trip loses nothing', () => {
  const merge = fakeLeg({ sha: 'h1', state: Verdict.WORKS, reasons: ['ok'] });
  const parent = fakeLeg({ sha: 'h2', state: Verdict.DOES_NOT_WORK, reasons: ['absent'] });
  const doc = buildVerdictJson({ recipeName: 'my-recipe', merge, parent, pass: true, exitCode: 0 });
  const roundTripped = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(roundTripped, doc);
});
