// @ts-check
/**
 * Lyric schema-2 manifest → pb SEAL ADAPTER tests — DOCKER-FREE and NETWORK-FREE.
 *
 * The fixture MANIFEST_164002 is a verbatim copy of a REAL Lyric evidence manifest
 * (`~/lyric/.tickets/ENG-17397/evidence/20260710-164002-verify/manifest.json`): schema 2,
 * `selfAttested:true`, unsealed, plain-string `provenance`, a single `pins.repo` SHA, one
 * `harness`-declared curl /health artifact, and L3-health-pass + L4/L5 `not-run` checks.
 *
 * The tests nail the honesty contract the adapter must clear:
 *   - a real schema-2 manifest ingests → a SEALED bundle whose honest verdict is CND (never a
 *     fabricated WORKS: the manifest carries no write-set-bound delta + confirm leg)
 *   - provenance is the MIN of {declared, shape}: an app-surface curl /health declared `harness`
 *     is CAPPED at tool; an out-of-band lyric-mongo.sh read declared `harness` stays harness; an
 *     undeclared / non-command artifact floors to agent
 *   - a plain relabel `provenance:'harness'` does NOT satisfy the persisted leg (newBundle floors
 *     it to agent); only a mint() receipt carries the harness brand — the anti-laundering core
 *   - the ed25519 seal round-trips and any post-seal mutation flips verifySeal to false
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { schema2Manifest, artifactProvenance } from '../src/lyric/manifest-adapter.mjs';
import { newBundle, sealBundle, verifySeal } from '../src/evidence.mjs';
import { verdict } from '../src/verdict.mjs';
import { mint, isMinted } from '../src/harness.mjs';
import { Verdict, ClaimState, Provenance, rankOf } from '../src/types.mjs';

const HARNESS_RANK = rankOf(Provenance.HARNESS);

/**
 * A verbatim copy of the real ENG-17397 schema-2 manifest 20260710-164002-verify: L3 health pass,
 * L4/L5 not-run, full pins, selfAttested, one harness-declared curl /health artifact.
 */
const MANIFEST_164002 = {
  schema: 2,
  ticket: 'ENG-17397',
  runId: '20260710-164002-verify',
  claim: 'ENG-17397 A&C re-validate on akashpathak with pb v0.1.0-dev alone (no lyric-qa); appservice attach + health L3',
  phase: 'verify',
  surface: { substrate: 'k8s-attach' },
  pins: {
    'image.appservice': 'us-docker.pkg.dev/development-367210/lyric/appservice@sha256:a31e0593ca710fc36e60b4a205722393c4793bffc7e48c3f485f9f4a9df97709',
    'image.kafka': 'quay.io/strimzi/kafka@sha256:5e1009de1037f0cfb50a6441d3142bdb32216f8f5c9ed8fd24573885b7cdbfb6',
    'image.mongo': 'docker.io/mongodb/mongodb-community-server@sha256:18f5bfd202ecb50d4f1b2625af6042b0a0f7d2c05408000671ac8f1cc6d300dd',
    'k8s.context': 'akashpathak',
    'k8s.namespace': 'delta',
    repo: '04cfa9b9269f3dc73d842646269de5cb67d84517',
  },
  proofLevel: 'L3',
  selfAttested: true,
  startedAt: '2026-07-10T16:40:02Z',
  finishedAt: '2026-07-10T16:40:15Z',
  checks: [
    { name: 'appservice-up', state: 'pass', level: 'L3', expect: 'exitCode(appservice-up)==0', observed: 'exitCode=0' },
    { name: 'action-resolution', state: 'not-run', level: 'L4', expect: 'jsonpath(execution.json,selectedAction)==$PB_EXPECTED_ACTION', reason: 'required input PB_EXECUTION_ID unset' },
    { name: 'stage-progress', state: 'not-run', level: 'L4', expect: 'contains(execution.json,stages,validate)', reason: 'required input PB_EXECUTION_ID unset' },
    { name: 'stage-log-observed', state: 'not-run', level: 'L5', expect: 'exitCode(stage-log-observed)==0', reason: 'exercise file not found: tests/e2e/eng-17397-stage-log.spec.ts' },
  ],
  artifacts: [
    {
      type: 'command',
      name: 'appservice-up',
      path: '01-appservice-up.log',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      provenance: 'harness',
      meta: { cmd: 'curl -sf -o /dev/null "http://127.0.0.1:64950/health"', durationSec: 0.77188175, exitCode: 0 },
    },
  ],
  verdict: 'pass',
  note: '1 pass, 0 fail, 3 not-run',
};

/** An out-of-band lyric-mongo.sh store read (from real manifest 20260710-154935-verify). */
const MONGO_READ_ARTIFACT = {
  type: 'command',
  name: 'action-resolution',
  path: '02-action-resolution.log',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  provenance: 'harness',
  meta: {
    cmd: '~/.claude/skills/lyric-qa/scripts/lyric-mongo.sh --env "$PB_K8S_NAMESPACE" --context "$PB_K8S_CONTEXT" --db lyric --eval "JSON.stringify(db.executions.findOne({_id:\'$PB_EXECUTION_ID\'}))" > execution.json',
    durationSec: 11.998,
    exitCode: 0,
  },
};

test('adapter: a real schema-2 manifest ingests → a SEALED bundle whose honest verdict is CND (no fabricated WORKS)', () => {
  const bundle = schema2Manifest(MANIFEST_164002);
  const { privateKey } = generateKeyPairSync('ed25519');
  const sealed = sealBundle(bundle, privateKey);
  const v = verdict(sealed);

  // The honest outcome for an L3-health / not-run manifest: no CONFIRMED effect → CND.
  assert.equal(v.state, Verdict.COULD_NOT_DETERMINE, v.reasons.join(' | '));
  assert.equal(bundle.reproduce.k, 0);
  assert.ok(v.scoreboard.length === 4 && v.scoreboard.every((s) => s.state === ClaimState.NOT_EXECUTED), 'every check-claim NOT_EXECUTED');
  assert.match(v.reasons.join(' '), /no CONFIRMED effect claim/);

  // The seal is real ed25519 and round-trips against the embedded public key.
  assert.ok(sealed.seal, 'sealed bundle carries a seal');
  assert.equal(sealed.seal.algorithm, 'ed25519');
  assert.equal(verifySeal(sealed, sealed.seal.publicKey), true);

  // The pins minted ONE harness code-identity receipt (identity context, referenced by no claim).
  const ci = bundle.receipts.find((r) => r.id === 'code-identity');
  assert.ok(ci && ci.provenance === Provenance.HARNESS && isMinted(ci), 'code-identity is minted harness');
  assert.equal(ci.kind, 'fingerprint');
  assert.equal(ci.data.repo, '04cfa9b9269f3dc73d842646269de5cb67d84517');
  assert.equal(ci.data.k8s.context, 'akashpathak');
  assert.equal(ci.data.selfAttested, true); // honest: pins are manifest-attested, not re-derived
  assert.ok(!bundle.claims.some((c) => (c.receiptIds || []).includes('code-identity')), 'code-identity grounds no claim');
});

test('adapter: provenance is the MIN of {declared, shape} — app-surface curl /health declared `harness` is CAPPED at tool', () => {
  const bundle = schema2Manifest(MANIFEST_164002);
  const health = bundle.receipts.find((r) => r.id.endsWith(':appservice-up'));
  // The manifest DECLARES harness, but a read through the app's own endpoint is not ground truth.
  assert.equal(MANIFEST_164002.artifacts[0].provenance, 'harness');
  assert.equal(artifactProvenance(MANIFEST_164002.artifacts[0]), Provenance.TOOL);
  assert.ok(health && health.provenance === Provenance.TOOL && isMinted(health), 'health curl minted TOOL, not harness');
  assert.equal(health.data.declaredProvenance, 'harness'); // the claim is recorded for audit
});

test('adapter: an out-of-band lyric-mongo.sh read declared `harness` STAYS harness (not overfit to the curl case)', () => {
  assert.equal(artifactProvenance(MONGO_READ_ARTIFACT), Provenance.HARNESS);
  const manifest = { ...MANIFEST_164002, artifacts: [...MANIFEST_164002.artifacts, MONGO_READ_ARTIFACT] };
  const bundle = schema2Manifest(manifest);
  const mongo = bundle.receipts.find((r) => r.id.endsWith(':action-resolution'));
  assert.ok(mongo && mongo.provenance === Provenance.HARNESS && isMinted(mongo), 'mongo read minted harness');
});

test('adapter: an undeclared / non-command artifact floors to agent (never minted)', () => {
  assert.equal(artifactProvenance({ type: 'command', name: 'x', meta: { cmd: 'kubectl get pods', exitCode: 0 } }), Provenance.AGENT, 'no declared provenance → agent');
  assert.equal(artifactProvenance({ type: 'file', name: 'y', provenance: 'harness' }), Provenance.AGENT, 'not a command receipt → agent');
  assert.equal(artifactProvenance({ type: 'command', name: 'z', provenance: 'harness', meta: { cmd: 'kubectl get pods' } }), Provenance.AGENT, 'no exit code → agent');
});

test('anti-laundering: a plain relabel `provenance:\'harness\'` does NOT satisfy the persisted leg; only a mint() receipt does', () => {
  const deltaData = { before: 0, after: 1, nonce: 'n1' };
  const claim = {
    id: 'c',
    kind: 'effect',
    scope: 'x',
    effectCheck: { entity: 'e', expectedAfterRelation: { op: 'increased' }, deltaReceiptId: 'd', confirmLegReceiptId: 'f' },
    receiptIds: ['d', 'f'],
  };

  // PLAIN relabel (what a forger / a naive adapter that trusts the string would produce): a delta
  // object claiming harness, handed straight to newBundle → FLOORED to agent → fails the persisted leg.
  const relabeled = newBundle({
    claims: [claim],
    receipts: [
      { id: 'd', kind: 'delta', provenance: 'harness', data: deltaData },
      mint({ id: 'f', kind: 'fresh-session', provenance: 'tool', identity: 'v', data: { observed: 1, nonce: 'n1' } }),
    ],
  });
  const relabelDelta = relabeled.receipts.find((r) => r.id === 'd');
  assert.ok(relabelDelta, 'relabel delta present');
  assert.equal(relabelDelta.provenance, Provenance.AGENT);
  assert.ok(rankOf(relabelDelta.provenance) < HARNESS_RANK, 'relabel cannot reach the harness persisted-leg rank');
  const vRelabel = verdict(relabeled);
  const relabelState = vRelabel.scoreboard.find((s) => s.claimId === 'c');
  assert.equal(relabelState?.state, ClaimState.NOT_EXECUTED, 'relabel delta → persisted leg unsatisfied');

  // MINTED delta (the ONLY path — the module-private brand): harness provenance preserved → CONFIRMED.
  const minted = newBundle({
    claims: [claim],
    receipts: [
      mint({ id: 'd', kind: 'delta', provenance: 'harness', data: deltaData }),
      mint({ id: 'f', kind: 'fresh-session', provenance: 'tool', identity: 'v', data: { observed: 1, nonce: 'n1' } }),
    ],
  });
  const mintedDelta = minted.receipts.find((r) => r.id === 'd');
  assert.ok(mintedDelta, 'minted delta present');
  assert.equal(mintedDelta.provenance, Provenance.HARNESS);
  const vMint = verdict(minted);
  const mintState = vMint.scoreboard.find((s) => s.claimId === 'c');
  assert.equal(mintState?.state, ClaimState.CONFIRMED, 'minted harness delta + confirm leg → CONFIRMED');
});

test('seal: any post-seal mutation of an adapter receipt flips verifySeal to false (tamper-evident)', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const sealed = sealBundle(schema2Manifest(MANIFEST_164002), privateKey);
  assert.ok(sealed.seal, 'sealed bundle carries a seal');
  assert.equal(verifySeal(sealed, sealed.seal.publicKey), true);
  sealed.receipts[0].data.exitCode = 999; // tamper with the code-identity receipt after sealing
  assert.equal(verifySeal(sealed, sealed.seal.publicKey), false);
});
