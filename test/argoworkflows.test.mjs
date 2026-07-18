// @ts-check
/**
 * Argo Workflows drive/observe provider unit tests — CLUSTER-FREE. A fake KubectlRunner is injected
 * so the provider is exercised without a cluster (the real kubectl drive is the DEFERRED live leg,
 * mirroring the seal-adapter "built + unit-proven, live-gated" precedent). These cover the pure
 * helpers, the exact `kubectl` argv each client op issues, the TOOL-only attempt mint, the live-gated
 * tap's throw, AND — through runCatch's argo dispatch — the THREE guardrails as MINT PRECONDITIONS:
 * the happy path mints a satisfying delta (WORKS), and every adversarial negative (a different run
 * observed, a missing nonce readback, an unbound digest, a concurrent-actor global read, a vacuous
 * confirm leg) yields NO satisfying mint (never WORKS) — CND/DOES_NOT_WORK by construction. The
 * frozen core (verdict/harness/evidence) is never touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  openWorkflowRun,
  mintWorkflowAttempt,
  k8sExecTap,
  workflowPhaseFrom,
  isTerminal,
  imageIDsFrom,
  normalizeDigest,
  digestBinds,
  pinnedExactly,
  substituteNonce,
  nonceFromRows,
  stampManifest,
  argoContainerNames,
  NONCE_LABEL,
} from '../src/argoworkflows.mjs';
import { runCatch } from '../src/catch.mjs';
import { isMinted } from '../src/harness.mjs';
import { Verdict } from '../src/types.mjs';

/** @param {any} x @returns {any} */
const asAny = (x) => x;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARGO_RECIPE = join(ROOT, 'recipes', 'lyric-note-run-argo');
/** The recipe's disclosed image_digest (all-zeros placeholder) — the SHA<->digest binding pb reads independently. */
const BOUND_DIGEST = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const GOOD_IMAGEID = `docker.io/lyric/note-runner@${BOUND_DIGEST}`;

/**
 * A fake kubectl runner: records every argv (+ stdin), returns the queued response per call (clamped
 * so the last repeats). Mirrors browserdrive.test.mjs's fakeDocker.
 * @param {Array<{status:number, stdout?:string, stderr?:string}>} responses
 */
function fakeKubectl(responses) {
  /** @type {Array<{args:string[], stdin?:string}>} */
  const calls = [];
  return {
    calls,
    run: (/** @type {string[]} */ args, /** @type {number} */ _t, /** @type {string} */ stdin) => {
      calls.push({ args, stdin });
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    },
  };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

test('argoworkflows: workflowPhaseFrom / isTerminal read status.phase and classify terminality', () => {
  assert.equal(workflowPhaseFrom({ status: { phase: 'Running' } }), 'Running');
  assert.equal(workflowPhaseFrom({ status: {} }), '');
  assert.equal(workflowPhaseFrom(null), '');
  assert.equal(isTerminal('Succeeded'), true);
  assert.equal(isTerminal('Failed'), true);
  assert.equal(isTerminal('Error'), true);
  assert.equal(isTerminal('Running'), false);
  assert.equal(isTerminal(''), false);
});

test('argoworkflows: imageIDsFrom extracts the SELECTED container imageIDs across pods (regular + init)', () => {
  const list = {
    items: [
      { status: { containerStatuses: [{ name: 'main', imageID: GOOD_IMAGEID }, { name: 'wait', imageID: 'sidecar@sha256:dead' }] } },
      { status: { initContainerStatuses: [{ name: 'main', imageID: GOOD_IMAGEID }] } },
    ],
  };
  assert.deepEqual(imageIDsFrom(list, 'main'), [GOOD_IMAGEID, GOOD_IMAGEID]);
  assert.deepEqual(imageIDsFrom(list, 'wait'), ['sidecar@sha256:dead']);
  assert.deepEqual(imageIDsFrom(list, 'absent'), []); // wrong selector → empty (→ CND, never vacuous-true)
  assert.deepEqual(imageIDsFrom({}, 'main'), []);
});

test('argoworkflows: normalizeDigest + digestBinds bind on the resolved @sha256 (mutable tags neutralized)', () => {
  assert.equal(normalizeDigest(GOOD_IMAGEID), BOUND_DIGEST);
  assert.equal(normalizeDigest('no-digest-here:latest'), '');
  assert.equal(digestBinds(GOOD_IMAGEID, BOUND_DIGEST), true);
  assert.equal(digestBinds('other@sha256:' + 'a'.repeat(64), BOUND_DIGEST), false);
  assert.equal(digestBinds('', BOUND_DIGEST), false); // unreadable → never binds
});

test('argoworkflows: pinnedExactly requires the nonce-label list to be EXACTLY the submitted run', () => {
  assert.equal(pinnedExactly({ items: [{ metadata: { name: 'wf-1' } }] }, 'wf-1'), true);
  assert.equal(pinnedExactly({ items: [] }, 'wf-1'), false); // 0 matches → not pinned
  assert.equal(pinnedExactly({ items: [{ metadata: { name: 'wf-1' } }, { metadata: { name: 'wf-2' } }] }, 'wf-1'), false); // >1 → concurrent
  assert.equal(pinnedExactly({ items: [{ metadata: { name: 'other' } }] }, 'wf-1'), false); // a run pb did not create
});

test('argoworkflows: substituteNonce requires the {nonce} placeholder and substitutes the harness nonce', () => {
  assert.equal(substituteNonce("find({ m: '{nonce}' })", 'abc'), "find({ m: 'abc' })");
  assert.throws(() => substituteNonce('SELECT max(id) FROM t', 'abc'), /must contain the \{nonce\} placeholder/);
});

test('argoworkflows: nonceFromRows returns the nonce ONLY when a row actually carries it (never stamped)', () => {
  const n = 'nonce-xyz';
  assert.equal(nonceFromRows([{ pb_marker: n, id: 3 }], n), n);
  assert.equal(nonceFromRows([n], n), n);
  assert.equal(nonceFromRows([{ pb_marker: 'someone-else' }], n), undefined); // concurrent actor's row ≠ pb's nonce
  assert.equal(nonceFromRows([], n), undefined); // absent → did not round-trip
});

test('argoworkflows: stampManifest sets generateName, the pb.run/nonce label, and injects the nonce param (deep clone)', () => {
  const manifest = { metadata: { name: 'lyric-note-run' }, spec: { arguments: { parameters: [{ name: 'note_id', value: 'N1' }] }, templates: [] } };
  const stamped = stampManifest(manifest, { nonceParameter: 'pb_nonce', nonce: 'n-1' });
  assert.equal(stamped.metadata.generateName, 'lyric-note-run-');
  assert.equal('name' in stamped.metadata, false); // generateName owns identity (single-run pin)
  assert.equal(stamped.metadata.labels[NONCE_LABEL], 'n-1');
  assert.deepEqual(stamped.spec.arguments.parameters, [{ name: 'note_id', value: 'N1' }, { name: 'pb_nonce', value: 'n-1' }]);
  // the loaded recipe data is never mutated
  assert.equal(manifest.metadata.name, 'lyric-note-run');
  assert.equal(manifest.spec.arguments.parameters.length, 1);
});

test('argoworkflows: argoContainerNames reads template container + containerSet names', () => {
  const m = { spec: { templates: [{ container: { name: 'main' } }, { containerSet: { containers: [{ name: 'a' }, { name: 'b' }] } }] } };
  assert.deepEqual(argoContainerNames(m), ['main', 'a', 'b']);
  assert.deepEqual(argoContainerNames({}), []);
});

// ── openWorkflowRun: the exact kubectl argv, cluster-free ─────────────────────

test('argoworkflows: submit does `kubectl create -f -` with the manifest on stdin and returns the generated name', async () => {
  const kubectl = fakeKubectl([{ status: 0, stdout: JSON.stringify({ metadata: { name: 'lyric-note-run-abcde' } }) }]);
  const client = await openWorkflowRun({ namespace: 'lyric-notes', kubectl: asAny(kubectl) });
  const name = await client.submit({ kind: 'Workflow' });
  assert.equal(name, 'lyric-note-run-abcde');
  assert.deepEqual(kubectl.calls[0].args, ['create', '-n', 'lyric-notes', '-o', 'json', '-f', '-']);
  assert.deepEqual(JSON.parse(asAny(kubectl.calls[0].stdin)), { kind: 'Workflow' });
  assert.deepEqual(client.steps[0], { op: 'submit', name: 'lyric-note-run-abcde' });
});

test('argoworkflows: awaitTerminal polls status.phase until terminal; podDigests + pinCheck + teardown issue the exact argv', async () => {
  const kubectl = fakeKubectl([
    { status: 0, stdout: JSON.stringify({ status: { phase: 'Succeeded' } }) }, // awaitTerminal
    { status: 0, stdout: JSON.stringify({ items: [{ status: { containerStatuses: [{ name: 'main', imageID: GOOD_IMAGEID }] } }] }) }, // podDigests
    { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'wf-1' } }] }) }, // pinCheck
    { status: 0, stdout: '' }, // teardown
  ]);
  const client = await openWorkflowRun({ namespace: 'lyric-notes', kubectl: asAny(kubectl) });
  const { phase } = await client.awaitTerminal('wf-1');
  assert.equal(phase, 'Succeeded');
  assert.deepEqual(kubectl.calls[0].args, ['get', 'workflow', 'wf-1', '-n', 'lyric-notes', '-o', 'json']);
  assert.deepEqual(await client.podDigests('wf-1', 'main'), [GOOD_IMAGEID]);
  assert.deepEqual(kubectl.calls[1].args, ['get', 'po', '-n', 'lyric-notes', '-l', 'workflows.argoproj.io/workflow=wf-1', '-o', 'json']);
  assert.equal(await client.pinCheck('n-1', 'wf-1'), true);
  assert.deepEqual(kubectl.calls[2].args, ['get', 'wf', '-n', 'lyric-notes', '-l', `${NONCE_LABEL}=n-1`, '-o', 'json']);
  await client.teardown('n-1');
  assert.deepEqual(kubectl.calls[3].args, ['delete', 'wf', '-n', 'lyric-notes', '-l', `${NONCE_LABEL}=n-1`, '--ignore-not-found']);
});

test('argoworkflows: a non-zero kubectl exit throws (could-not-execute → CND upstream)', async () => {
  const kubectl = fakeKubectl([{ status: 1, stderr: 'error: no kubeconfig' }]);
  const client = await openWorkflowRun({ namespace: 'x', kubectl: asAny(kubectl) });
  await assert.rejects(() => client.submit({ kind: 'Workflow' }), /kubectl create failed \(exit 1\)[\s\S]*no kubeconfig/);
});

test('argoworkflows: mintWorkflowAttempt is a minted TOOL attempt (never harness); a look-alike is not minted', () => {
  const r = mintWorkflowAttempt({ name: 'wf-1', nonce: 'n-1', phase: 'Succeeded', steps: [{ op: 'submit', name: 'wf-1' }], digests: [GOOD_IMAGEID], identity: 'pb-note-runner' });
  assert.equal(r.provenance, 'tool'); // the driven surface — TOOL, never harness (ground truth is the out-of-band tap)
  assert.equal(r.kind, 'attempt');
  assert.equal(r.id, 'argo-drive');
  assert.equal(r.data.name, 'wf-1');
  assert.equal(r.data.phase, 'Succeeded'); // the terminal phase lives HERE, never on the delta
  assert.deepEqual(r.data.digests, [GOOD_IMAGEID]);
  assert.ok(isMinted(r));
  const fake = { id: 'argo-drive', kind: 'attempt', provenance: 'harness', data: {} };
  assert.equal(isMinted(fake), false); // labeling can't forge the brand, and never harness
});

test('argoworkflows: the default k8s-exec tap THROWS (live-gated; never falls back to an app read)', async () => {
  await assert.rejects(() => k8sExecTap(), /k8s-exec store tap is LIVE-GATED[\s\S]*NEVER fall back to an app-API read/);
});

// ── runArgoCatch: the THREE guardrails as MINT PRECONDITIONS (via runCatch dispatch) ──

/** The good agent proposal for the argo leg: a one-op trigger + an in-menu nonce-scoped effect claim. */
const ARGO_PROPOSAL_RAW = {
  walk: [{ op: 'trigger', args: {} }],
  claim: { entity: 'note_run_markers.pb_nonce', expectedAfterRelation: { op: 'increased' }, scope: 'a note run persists its nonce-scoped marker' },
};

/**
 * A mock Argo run client factory (injected as argoRunFn). Each precondition is independently
 * togglable so an adversarial negative can force exactly one guardrail to fail.
 * @param {{pin?:boolean, phase?:string, digests?:string[]}} [o]
 */
function mockArgoRun({ pin = true, phase = 'Succeeded', digests = [GOOD_IMAGEID] } = {}) {
  return asAny(async (/** @type {any} */ opts) => ({
    namespace: opts.namespace,
    steps: [{ op: 'submit', name: 'lyric-note-run-abc' }],
    submit: async () => 'lyric-note-run-abc',
    pinCheck: async () => pin,
    awaitTerminal: async () => ({ phase, workflow: { status: { phase } } }),
    podDigests: async () => digests,
    teardown: async () => {},
  }));
}

/**
 * A mock argo tap. `mode` selects the nonce-scoped read behavior:
 *  - 'roundtrip' : both reads return pb's nonce row (honest positive)
 *  - 'absent'    : the nonce never round-tripped (a real negative)
 *  - 'concurrent': a concurrent actor's row is returned but with a DIFFERENT marker (global-count vector)
 *  - 'vacuous'   : the delta read sees the nonce, but the independent confirm read does NOT
 * @param {'roundtrip'|'absent'|'concurrent'|'vacuous'} mode
 */
function mockArgoTap(mode) {
  let call = 0;
  return asAny(async (/** @type {any} */ _h, /** @type {string} */ _q, /** @type {string} */ nonce) => {
    const i = call++;
    if (mode === 'roundtrip') return [{ pb_marker: nonce, id: i }];
    if (mode === 'absent') return [];
    if (mode === 'concurrent') return [{ pb_marker: 'concurrent-actor-nonce', id: i }]; // count increases, but not pb's nonce
    // 'vacuous': even calls (delta reads) see the nonce; odd calls (confirm reads) do not
    return i % 2 === 0 ? [{ pb_marker: nonce, id: i }] : [];
  });
}

/**
 * Run the argo Catch with injected seams against a fresh run dir; returns the CatchResult.
 * @param {{argoRunFn?:any, argoTapFn?:any}} seams
 */
async function runArgo(seams) {
  const runDir = mkdtempSync(join(tmpdir(), 'pb-argo-'));
  try {
    return await runCatch({ recipeDir: ARGO_RECIPE, runDir, llmFn: asAny(async () => ARGO_PROPOSAL_RAW), ...seams });
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

test('runArgoCatch HAPPY: pinned run + bound digest + nonce round-trip (twice, independent) => WORKS', async () => {
  const result = await runArgo({ argoRunFn: mockArgoRun(), argoTapFn: mockArgoTap('roundtrip') });
  assert.equal(result.verdict.state, Verdict.WORKS, result.verdict.reasons.join(' | '));
  const delta = result.bundle.receipts.find((r) => r.id === 'store-delta');
  assert.ok(delta && delta.provenance === 'harness', 'the persisted delta is HARNESS ground truth');
  assert.equal(delta.data.before, 0);
  assert.equal(delta.data.after, 1);
  assert.equal('phase' in delta.data, false, 'the terminal phase is NEVER carried on the delta');
  const attempt = result.bundle.receipts.find((r) => r.id === 'argo-drive');
  assert.ok(attempt && attempt.provenance === 'tool' && attempt.kind === 'attempt', 'the workflow attempt is TOOL');
  assert.equal(attempt.data.phase, 'Succeeded');
  // the effect claim came from the agent proposal (entity in the disclosed menu), not hardcoded
  assert.equal(result.bundle.claims[0].effectCheck?.entity, 'note_run_markers.pb_nonce');
});

test('runArgoCatch GUARD single-run pinning: a DIFFERENT run observed (pinCheck fails) => no delta => CND', async () => {
  const result = await runArgo({ argoRunFn: mockArgoRun({ pin: false }), argoTapFn: mockArgoTap('roundtrip') });
  assert.equal(result.verdict.state, Verdict.COULD_NOT_DETERMINE, result.verdict.reasons.join(' | '));
  assert.equal(result.bundle.receipts.find((r) => r.id === 'store-delta'), undefined, 'no delta minted when the run could not be pinned');
});

test('runArgoCatch GUARD digest<->SHA: an UNBOUND step-pod image (wrong digest) => no delta => CND', async () => {
  const result = await runArgo({ argoRunFn: mockArgoRun({ digests: ['other/img@sha256:' + 'b'.repeat(64)] }), argoTapFn: mockArgoTap('roundtrip') });
  assert.equal(result.verdict.state, Verdict.COULD_NOT_DETERMINE, result.verdict.reasons.join(' | '));
  assert.equal(result.bundle.receipts.find((r) => r.id === 'store-delta'), undefined, 'no delta minted when the digest is unbound');
  assert.match(result.diagnosis.join(' '), /digest<->SHA binding failed/);
});

test('runArgoCatch GUARD digest<->SHA: pods GCd before the read (empty digests) => no delta => CND', async () => {
  const result = await runArgo({ argoRunFn: mockArgoRun({ digests: [] }), argoTapFn: mockArgoTap('roundtrip') });
  assert.equal(result.verdict.state, Verdict.COULD_NOT_DETERMINE, result.verdict.reasons.join(' | '));
  assert.equal(result.bundle.receipts.find((r) => r.id === 'store-delta'), undefined);
});

test('runArgoCatch GUARD nonce round-trip: the nonce never persisted => a real negative, no satisfying mint (≠ WORKS)', async () => {
  const result = await runArgo({ argoRunFn: mockArgoRun(), argoTapFn: mockArgoTap('absent') });
  assert.notEqual(result.verdict.state, Verdict.WORKS, result.verdict.reasons.join(' | '));
  const delta = result.bundle.receipts.find((r) => r.id === 'store-delta');
  assert.ok(delta && delta.data.before === delta.data.after, 'a non-satisfying delta (before == after) — the nonce did not round-trip');
});

test('runArgoCatch ADVERSARIAL concurrent-actor: a global count bump with a DIFFERENT nonce cannot green (≠ WORKS)', async () => {
  // Even if a mis-scoped query returned a concurrent actor's row (count 0→1), the nonce did not round
  // trip (readback ≠ pb's nonce) so no confirm leg binds → the increase cannot green.
  const result = await runArgo({ argoRunFn: mockArgoRun(), argoTapFn: mockArgoTap('concurrent') });
  assert.notEqual(result.verdict.state, Verdict.WORKS, result.verdict.reasons.join(' | '));
  const claim = result.bundle.claims[0];
  assert.equal(claim.effectCheck?.confirmLegReceiptId, 'argo-confirm');
  assert.equal(result.bundle.receipts.find((r) => r.id === 'argo-confirm'), undefined, 'no confirm leg when the nonce did not round-trip');
});

test('runArgoCatch ADVERSARIAL vacuous confirm: the independent confirm read must re-observe the nonce (else CND)', async () => {
  // The delta read sees the nonce (a real 0→1 delta) but the SECOND, independent out-of-band read
  // does NOT — the confirm leg is genuinely observed, never stamped, so it cannot confirm → CND.
  const result = await runArgo({ argoRunFn: mockArgoRun(), argoTapFn: mockArgoTap('vacuous') });
  assert.equal(result.verdict.state, Verdict.COULD_NOT_DETERMINE, result.verdict.reasons.join(' | '));
  assert.equal(result.bundle.receipts.find((r) => r.id === 'argo-confirm'), undefined, 'no confirm leg minted from a non-independent read');
  const delta = result.bundle.receipts.find((r) => r.id === 'store-delta');
  assert.ok(delta && delta.data.after === 1, 'the delta read did see a real increase');
});

test('runArgoCatch: the sealed evidence is judged from the on-disk artifact and the frozen proposal is returned', async () => {
  // runCatch persists the sealed bundle, RE-READS it, and computes the verdict from that artifact —
  // result.bundle IS the re-read on-disk evidence (carrying the ed25519 seal).
  const result = await runArgo({ argoRunFn: mockArgoRun(), argoTapFn: mockArgoTap('roundtrip') });
  assert.ok(result.bundle.seal, 'the returned bundle carries the ed25519 seal it was judged from');
  assert.equal(result.bundle.seal?.algorithm, 'ed25519');
  assert.ok(result.proposal, 'runArgoCatch returns the frozen agent proposal');
  assert.equal(result.proposal?.walk[0].op, 'trigger');
});
