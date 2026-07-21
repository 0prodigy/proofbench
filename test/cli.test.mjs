// @ts-check
/**
 * The k8s-attach LEG differential CLI slice — DOCKER-FREE, CLUSTER-FREE, NETWORK-FREE.
 *
 * `pb prove --leg`/`pb differential` fold sealed Catch bundles into case files and verdicts; the
 * live conjure->drive->tap plumbing is proven by an actual `pb prove --leg` run (see RESUME.md).
 * Here the PURE helpers (exported from cli.mjs for exactly this reason) are exercised with
 * hand-built bundles (assembleCatchBundle — the same pure assembler catch.test.mjs uses) so every
 * branch is nailed without a container or a real proposer call:
 *   - sealLegCase: {leg, differential:false} + the frozen {walk,claim} folded into a FRESH seal
 *   - extractFrozenProposal: an intact case yields the walk; a tampered one refuses (UNVERIFIED)
 *   - judgeDifferential: PASS (merge=WORKS ∧ parent=DOES_NOT_WORK), a mismatched-walk FAIL, a
 *     tampered-input refusal, and a recipe-identity mismatch
 *   - exitCodeForVerdict: the frozen 0/1/2/3 contract
 *   - help text carries the new `--leg`/`differential` documentation
 *   - regression: the golden from_tree recipes (#7130/#1170/#3031) are NOT conjure.mode:'k8s-attach',
 *     so cli.mjs's `prove` branch can never route them into the new --leg path (the from_tree
 *     differential stays byte-identical, unreachable from this branch by construction)
 *
 * cli.mjs only dispatches (main()) when it is the process entry point (see its own guard), so
 * importing these exports here never triggers the CLI against this test runner's own argv.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assembleCatchBundle, sealedVerdict } from '../src/catch.mjs';
import { sealBundle } from '../src/evidence.mjs';
import { mint } from '../src/harness.mjs';
import { Verdict } from '../src/types.mjs';
import { loadRecipe } from '../src/recipe.mjs';
import { exitCodeForVerdict, sealLegCase, extractFrozenProposal, extractSealedLeg, judgeDifferential } from '../src/cli.mjs';

/** @param {any} x @returns {any} */
const asAny = (x) => x;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.mjs');
const LYRIC_RECIPE = join(ROOT, 'recipes', 'lyric-eng17397-stage-controls');

/**
 * A hand-built AGENT proposal (what proposer.validateProposal would yield for the Lyric recipe's
 * note-lifecycle http walk) — mirrors notelifecycle.test.mjs's NOTE_PROPOSAL_RAW shape.
 * @type {import('../src/proposer.mjs').Proposal}
 */
const PROPOSAL = {
  walk: [{ op: 'http', args: { method: 'PATCH', path: '/executions/{parent_execution_id}/stages/final' } }],
  claim: { entity: 'stage_controls_queued.row-count', expectedAfterRelation: { op: 'decreased' }, scope: 'the terminal stage transition clears queued stagecontrols' },
};

/**
 * A DIFFERENT frozen proposal — used to prove judgeDifferential catches a non-apples-to-apples replay.
 * @type {import('../src/proposer.mjs').Proposal}
 */
const OTHER_PROPOSAL = {
  walk: [{ op: 'http', args: { method: 'PATCH', path: '/executions/{parent_execution_id}/stages/OTHER' } }],
  claim: PROPOSAL.claim,
};

/** A reproduction where the terminal step cleared the queued stagecontrols (before=2 -> after=1) and a fresh re-read agreed. */
function heldIteration() {
  return { executed: true, effectHeld: true, before: 2, after: 1, freshObserved: 1, entity: PROPOSAL.claim.entity, countBefore: 2, countAfter: 1 };
}
/** A reproduction where the terminal step ran but the stagecontrols stayed queued (no movement — falsifies 'decreased'). */
function unheldIteration() {
  return { executed: true, effectHeld: false, before: 2, after: 2, freshObserved: 2, entity: PROPOSAL.claim.entity, countBefore: 2, countAfter: 2, reason: 'stayed queued' };
}

/**
 * A fake CatchResult (runCatch's return shape), sealed exactly as runNoteLifecycleCatch's own
 * `seal` closure does (generateKeyPairSync + sealBundle + sealedVerdict re-read) — no cluster.
 * @param {Object} args
 * @param {any} args.bundle an UNSEALED bundle from assembleCatchBundle
 * @param {import('../src/proposer.mjs').Proposal|null} [args.proposal]
 * @param {string} [args.sha]
 * @returns {import('../src/catch.mjs').CatchResult}
 */
function fakeResult({ bundle, proposal = null, sha = 'appservice@abc1234+metadata-service@def5678' }) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const sealed = sealBundle(bundle, privateKey);
  return { phase: 'catch', sha, verdict: sealedVerdict(sealed), diagnosis: [], bundle: sealed, receiptPath: '/tmp/pb-catch-fake/catch-x.receipt.json', proposal };
}

function worksResult() {
  const bundle = assembleCatchBundle({ intent: 'x', claim: PROPOSAL.claim, iterations: [heldIteration(), heldIteration()] });
  return fakeResult({ bundle, proposal: PROPOSAL });
}
function doesNotWorkResult(/** @type {import('../src/proposer.mjs').Proposal} */ proposal = PROPOSAL) {
  const bundle = assembleCatchBundle({ intent: 'x', claim: proposal.claim, iterations: [unheldIteration(), unheldIteration()] });
  return fakeResult({ bundle, proposal });
}

/**
 * A minted k8s-attach code-identity fingerprint carrying the given DRIVE-TIME digests (as
 * conjure.mjs's mintK8sAttachIdentity would produce — see conjure.mjs:1413-1426).
 * @param {string[]} digests
 */
function fingerprintReceipt(digests) {
  return mint({ id: 'fingerprint', kind: 'fingerprint', provenance: 'harness', data: { mode: 'k8s-attach', drive_time_digests: digests } });
}
/** A worksResult() whose reproduction carries a k8s-attach fingerprint bound to `digests`. */
function worksResultWithDigests(/** @type {string[]} */ digests) {
  const bundle = assembleCatchBundle({ intent: 'x', claim: PROPOSAL.claim, iterations: [{ ...heldIteration(), fingerprint: fingerprintReceipt(digests) }, heldIteration()] });
  return fakeResult({ bundle, proposal: PROPOSAL });
}
/** A doesNotWorkResult() whose reproduction carries a k8s-attach fingerprint bound to `digests`. */
function doesNotWorkResultWithDigests(/** @type {string[]} */ digests) {
  const bundle = assembleCatchBundle({ intent: 'x', claim: PROPOSAL.claim, iterations: [{ ...unheldIteration(), fingerprint: fingerprintReceipt(digests) }, unheldIteration()] });
  return fakeResult({ bundle, proposal: PROPOSAL });
}

const RECIPE = { name: 'lyric test recipe' };

// ── exitCodeForVerdict: the frozen 0/1/2/3 contract, applied to a single leg's own verdict ──────

test('exitCodeForVerdict: the frozen exit-code contract', () => {
  assert.equal(exitCodeForVerdict(Verdict.WORKS), 0);
  assert.equal(exitCodeForVerdict(Verdict.DOES_NOT_WORK), 1);
  assert.equal(exitCodeForVerdict(Verdict.COULD_NOT_DETERMINE), 2);
  assert.equal(exitCodeForVerdict(Verdict.UNVERIFIED), 3);
  assert.equal(exitCodeForVerdict('anything-unexpected'), 3);
});

// ── sealLegCase: {leg, differential:false} + the frozen walk folded into a FRESH seal ───────────

test('sealLegCase: persists {leg, differential:false}, folds the frozen proposal into a NEW tamper-evident seal, and preserves the leg\'s own verdict', () => {
  const result = worksResult();
  assert.equal(result.verdict.state, Verdict.WORKS, result.verdict.reasons.join(' | '));
  const kase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result });
  assert.equal(kase.kind, 'pb-catch-case-v1');
  assert.equal(kase.leg, 'merge');
  assert.equal(kase.differential, false, 'a single leg case can never carry differential:true');
  assert.equal(kase.recipe, RECIPE.name);
  assert.equal(kase.recipeDir, LYRIC_RECIPE);
  assert.ok(kase.bundle.seal, 'the case carries its OWN fresh ed25519 seal');
  assert.equal(sealedVerdict(kase.bundle).state, Verdict.WORKS, 'wrapping never changes the leg\'s own verdict');
  const rec = kase.bundle.receipts.find((/** @type {any} */ r) => r.id === 'agent-proposal');
  assert.ok(rec, 'the frozen {walk,claim} is folded into the sealed bundle, not a loose sibling file');
  assert.equal(rec.provenance, 'agent');
  assert.deepEqual(rec.data, PROPOSAL);
});

test('sealLegCase: {leg, differential, recipe, recipeDir} is ALSO folded inside the sealed bundle as a case-routing receipt (not just the un-sealed top-level fields), and extractSealedLeg reads it', () => {
  const kase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResult() });
  const rec = kase.bundle.receipts.find((/** @type {any} */ r) => r.id === 'case-routing');
  assert.ok(rec, 'a case-routing receipt is folded into the sealed bundle');
  assert.equal(rec.provenance, 'harness');
  assert.deepEqual(rec.data, { leg: 'merge', differential: false, recipe: RECIPE.name, recipeDir: LYRIC_RECIPE });
  const extracted = extractSealedLeg(kase);
  assert.deepEqual(extracted, { leg: 'merge' });
});

test('sealLegCase: retagging the sealed leg AFTER sealing (mutating case-routing, not just the top-level .leg) invalidates the seal', () => {
  const kase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResult() });
  const idx = kase.bundle.receipts.findIndex((/** @type {any} */ r) => r.id === 'case-routing');
  assert.ok(idx >= 0);
  const tampered = {
    ...kase,
    leg: 'parent', // an attacker could still flip the UN-sealed top-level field for free...
    bundle: { ...kase.bundle, receipts: kase.bundle.receipts.map((/** @type {any} */ r, /** @type {number} */ i) => (i === idx ? { ...r, data: { ...r.data, leg: 'parent' } } : r)) },
  };
  assert.equal(sealedVerdict(tampered.bundle).state, Verdict.UNVERIFIED, '...but the SEALED copy inside receipts is what is actually protected');
});

test('sealLegCase: a leg whose proposer produced no proposal still writes a case (no agent-proposal receipt to replay later)', () => {
  const bundle = assembleCatchBundle({ intent: 'x', claim: undefined, iterations: [{ executed: false, effectHeld: false, before: 0, countBefore: 0, countAfter: 0, reason: 'could not attach' }] });
  const result = fakeResult({ bundle, proposal: null });
  const kase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result });
  assert.equal(kase.bundle.receipts.find((/** @type {any} */ r) => r.id === 'agent-proposal'), undefined);
});

// ── extractFrozenProposal: an intact case yields the walk; a tampered/malformed one refuses ─────

test('extractFrozenProposal: an intact sealed case yields the FROZEN {walk, claim} verbatim', () => {
  const kase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResult() });
  const extracted = extractFrozenProposal(kase);
  assert.ok(!('error' in extracted), asAny(extracted).error);
  assert.deepEqual(asAny(extracted).proposal, PROPOSAL);
});

test('extractFrozenProposal: a case tampered AFTER sealing refuses (UNVERIFIED) — never yields a walk to replay', () => {
  const kase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResult() });
  const idx = kase.bundle.receipts.findIndex((/** @type {any} */ r) => r.id === 'agent-proposal');
  assert.ok(idx >= 0);
  const tampered = {
    ...kase,
    bundle: { ...kase.bundle, receipts: kase.bundle.receipts.map((/** @type {any} */ r, /** @type {number} */ i) => (i === idx ? { ...r, data: { ...r.data, walk: [] } } : r)) },
  };
  const extracted = extractFrozenProposal(tampered);
  assert.ok('error' in extracted, 'a tampered case must never yield a proposal');
  assert.match(asAny(extracted).error, /UNVERIFIED/);
});

test('extractFrozenProposal: a malformed/non-case file is rejected without touching sealedVerdict', () => {
  assert.match(asAny(extractFrozenProposal(null)).error, /missing \.bundle/);
  assert.match(asAny(extractFrozenProposal({})).error, /missing \.bundle/);
});

test('extractFrozenProposal: a sealed bundle carrying no agent-proposal receipt refuses honestly (not a tamper, just absent)', () => {
  const bundle = assembleCatchBundle({ intent: 'x', claim: PROPOSAL.claim, iterations: [heldIteration(), heldIteration()] });
  const result = fakeResult({ bundle, proposal: null }); // proposal:null => sealLegCase adds no agent-proposal receipt
  const kase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result });
  const extracted = extractFrozenProposal(kase);
  assert.match(asAny(extracted).error, /carries no agent-proposal receipt/);
});

// ── judgeDifferential: PASS / mismatched-walk / tampered-input / recipe-identity mismatch ────────

test('judgeDifferential: PASS iff merge=WORKS and parent=DOES_NOT_WORK on the SAME frozen {walk, claim}', () => {
  const mergeCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResult() });
  const parentCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'parent', result: doesNotWorkResult() });
  const { exitCode, lines } = judgeDifferential({ mergeCase, parentCase, mergePath: 'merge.json', parentPath: 'parent.json' });
  assert.equal(exitCode, 0, lines.join('\n'));
  assert.match(lines.join('\n'), /DIFFERENTIAL: PASS/);
});

test('judgeDifferential: two case files sealed under the SAME leg label are refused (exit 2, named) — a merge-labeled case can never double as the parent', () => {
  const mergeCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResult() });
  // A mislabeled swap: the file passed in the PARENT slot was ALSO sealed with leg:'merge'.
  const parentCaseMislabeled = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: doesNotWorkResult() });
  const { exitCode, lines } = judgeDifferential({ mergeCase, parentCase: parentCaseMislabeled, mergePath: 'merge.json', parentPath: 'parent.json' });
  assert.equal(exitCode, 2);
  assert.match(lines.join(' '), /SAME sealed leg label/);
});

test('judgeDifferential: retagging only the UN-sealed top-level `.leg` (not the sealed case-routing receipt) does NOT fool the sealed-leg check', () => {
  const mergeCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResult() });
  const parentCaseClean = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'parent', result: doesNotWorkResult() });
  // Flip the outer, un-sealed .leg field to 'merge' too — the sealed case-routing receipt still says 'parent'.
  const parentCaseRetagged = { ...parentCaseClean, leg: 'merge' };
  const { exitCode, lines } = judgeDifferential({ mergeCase, parentCase: parentCaseRetagged, mergePath: 'merge.json', parentPath: 'parent.json' });
  assert.equal(exitCode, 0, lines.join('\n')); // sealed leg labels ('merge'/'parent') still differ, so this legitimately passes
  assert.match(lines.join('\n'), /DIFFERENTIAL: PASS/);
});

test('judgeDifferential: identical drive-time digests on both legs refuses PASS (exit 2, named) even when merge=WORKS and parent=DOES_NOT_WORK — no deploy swap occurred', () => {
  const digests = [`sha256:${'a'.repeat(64)}`];
  const mergeCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResultWithDigests(digests) });
  const parentCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'parent', result: doesNotWorkResultWithDigests(digests) });
  const { exitCode, lines } = judgeDifferential({ mergeCase, parentCase, mergePath: 'merge.json', parentPath: 'parent.json' });
  assert.equal(exitCode, 2);
  assert.match(lines.join(' '), /REFUSED.*same deployed digests.*no deploy swap occurred/);
});

test('judgeDifferential: DISTINCT drive-time digests on the two legs still PASS (merge=WORKS, parent=DOES_NOT_WORK) and both digest sets are surfaced in the summary', () => {
  const mergeDigests = [`sha256:${'a'.repeat(64)}`];
  const parentDigests = [`sha256:${'b'.repeat(64)}`];
  const mergeCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResultWithDigests(mergeDigests) });
  const parentCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'parent', result: doesNotWorkResultWithDigests(parentDigests) });
  const { exitCode, lines } = judgeDifferential({ mergeCase, parentCase, mergePath: 'merge.json', parentPath: 'parent.json' });
  assert.equal(exitCode, 0, lines.join('\n'));
  assert.match(lines.join('\n'), /DIFFERENTIAL: PASS/);
  assert.match(lines.join('\n'), new RegExp(`merge {2}drive-time digests: \\[${mergeDigests[0]}\\]`));
  assert.match(lines.join('\n'), new RegExp(`parent drive-time digests: \\[${parentDigests[0]}\\]`));
});

test('judgeDifferential: merge=WORKS but parent=WORKS-too (non-discriminating) is an honest FAIL, not a PASS', () => {
  const mergeCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResult() });
  const parentCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'parent', result: worksResult() });
  const { exitCode, lines } = judgeDifferential({ mergeCase, parentCase, mergePath: 'merge.json', parentPath: 'parent.json' });
  assert.equal(exitCode, 2);
  assert.match(lines.join('\n'), /DIFFERENTIAL: FAIL/);
  assert.match(lines.join('\n'), /parent is WORKS, not DOES_NOT_WORK/);
});

test('judgeDifferential: a mismatched walk between legs is an honest FAIL — not apples-to-apples (exit 2, named)', () => {
  const mergeCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResult() });
  const parentCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'parent', result: doesNotWorkResult(OTHER_PROPOSAL) });
  const { exitCode, lines } = judgeDifferential({ mergeCase, parentCase, mergePath: 'merge.json', parentPath: 'parent.json' });
  assert.equal(exitCode, 2);
  assert.match(lines.join(' '), /did NOT replay the SAME/);
});

test('judgeDifferential: a case tampered after sealing refuses with UNVERIFIED (exit 3), never folds into a verdict', () => {
  const mergeCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResult() });
  const parentCaseClean = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'parent', result: doesNotWorkResult() });
  const idx = parentCaseClean.bundle.receipts.findIndex((/** @type {any} */ r) => r.id === 'store-delta');
  const parentCase = {
    ...parentCaseClean,
    bundle: { ...parentCaseClean.bundle, receipts: parentCaseClean.bundle.receipts.map((/** @type {any} */ r, /** @type {number} */ i) => (i === idx ? { ...r, data: { ...r.data, after: 999 } } : r)) },
  };
  const { exitCode, lines } = judgeDifferential({ mergeCase, parentCase, mergePath: 'merge.json', parentPath: 'parent.json' });
  assert.equal(exitCode, 3);
  assert.match(lines.join(' '), /UNVERIFIED/);
});

test('judgeDifferential: a recipe-identity mismatch between legs is refused (exit 2, named) before any verdict folding', () => {
  const mergeCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResult() });
  const parentCase = sealLegCase({ recipe: { name: 'a different recipe' }, recipeDir: LYRIC_RECIPE, leg: 'parent', result: doesNotWorkResult() });
  const { exitCode, lines } = judgeDifferential({ mergeCase, parentCase, mergePath: 'merge.json', parentPath: 'parent.json' });
  assert.equal(exitCode, 2);
  assert.match(lines.join(' '), /recipe identity mismatch/);
});

test('judgeDifferential: a case file missing .bundle is refused (exit 3), not silently folded', () => {
  const mergeCase = sealLegCase({ recipe: RECIPE, recipeDir: LYRIC_RECIPE, leg: 'merge', result: worksResult() });
  const { exitCode, lines } = judgeDifferential({ mergeCase, parentCase: {}, mergePath: 'merge.json', parentPath: 'parent.json' });
  assert.equal(exitCode, 3);
  assert.match(lines.join(' '), /missing \.bundle/);
});

// ── help text carries the new commands ───────────────────────────────────────────────────────

test('CLI help: documents `prove --leg` and `differential`', () => {
  const res = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /--leg <label>/);
  assert.match(res.stdout, /--replay-walk/);
  assert.match(res.stdout, /differential <merge-case\.json> <parent-case\.json>/);
});

// ── argv validation (safe to spawn: errors before any cluster/proposer call) ─────────────────

test('CLI: `pb prove <k8s-attach recipe>` without --leg refuses (exit 2) before touching any cluster', () => {
  const res = spawnSync(process.execPath, [CLI, 'prove', LYRIC_RECIPE], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--leg: missing <label>/);
});

test('CLI: `pb differential` with missing args refuses (exit 2)', () => {
  const res = spawnSync(process.execPath, [CLI, 'differential', 'only-one.json'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /missing <merge-case\.json> <parent-case\.json>/);
});

// ── regression: the golden from_tree recipes never reach the --leg branch (byte-identical path) ─

test('regression: the golden from_tree recipes (#7130/#1170/#3031) are NOT conjure.mode:\'k8s-attach\', so cli.mjs\'s `prove` never routes them into the new --leg path', () => {
  for (const dir of ['n8n-form-trigger-pr7130', 'linkding-default-mark-shared-pr1170', 'documenso-envelope-fields-pr3031']) {
    const recipe = loadRecipe(join(ROOT, 'recipes', dir));
    assert.notEqual(recipe.conjure && recipe.conjure.mode, 'k8s-attach', `${dir} must stay off the --leg branch`);
    assert.equal(recipe.code_identity.mode, 'from_tree');
  }
  // the Lyric recipe is the one exception this slice adds a path for.
  const lyric = loadRecipe(LYRIC_RECIPE);
  assert.equal(lyric.conjure.mode, 'k8s-attach');
  assert.equal(lyric.code_identity.mode, 'multi_repo');
});
