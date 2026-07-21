// @ts-check
/**
 * The NOTE-LIFECYCLE Catch (drive.mode:'note-lifecycle', the Lyric class) — CLUSTER-FREE. A fake
 * kubectl runner (port-forward spawn + exec, mirroring conjure.test.mjs's k8s-attach fakes and
 * mongotap.test.mjs's fake exec) and a fake fetchFn (mirroring catch.test.mjs's n8n seams) drive the
 * WHOLE stack — conjure's real conjureK8sAttach/mintK8sAttachIdentity/checkK8sAttachDrift, the real
 * mongotap.tapMongo + resolveMongoQueryPlaceholders, the real proposer.validateProposal(ALLOWED_HTTP_OPS)
 * — through runCatch's note-lifecycle dispatch, with ZERO cluster/network access. These cover:
 *   - the pure helpers: firstPlaceholderName, pickObservableQueryName, checkFreshInstance
 *   - the http walk executor (executeNoteLifecycleWalk) reusing confirmHttpReq's exact request shape
 *   - HAPPY: two fresh instances, the terminal step clears the queued stagecontrols => WORKS
 *   - FALSIFIED: the terminal step never clears them (reproduced) => DOES_NOT_WORK
 *   - fresh_world:'new_instance_per_iteration' — a degenerate (repeated-id) iteration is excluded
 *     from k/kFail entirely, never silently counted
 *   - registry routing + a LOCAL, injected "no cluster reachable" dry probe — the ENG-17397 recipe
 *     fails ONLY on a real attach/connect-shaped error, never a "not implemented" throw
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCatch, firstPlaceholderName, pickObservableQueryName, checkFreshInstance, executeNoteLifecycleWalk } from '../src/catch.mjs';
import { conjure } from '../src/conjure.mjs';
import { tapStore } from '../src/storetap.mjs';
import { resolveCatchSeams } from '../src/registry.mjs';
import { loadRecipe } from '../src/recipe.mjs';
import { Verdict } from '../src/types.mjs';

/** @param {any} x @returns {any} */
const asAny = (x) => x;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LYRIC_RECIPE = join(ROOT, 'recipes', 'lyric-eng17397-stage-controls');

const GOOD_DIGEST = `sha256:${'a'.repeat(64)}`;

// ── Pure helpers ────────────────────────────────────────────────────────────

test('firstPlaceholderName: finds the identifier-shaped placeholder past unrelated mongo object-literal braces', () => {
  assert.equal(firstPlaceholderName("db.stagecontrols.find({executionId:'{child_execution_id}',status:'queued'}).toArray()"), 'child_execution_id');
  assert.equal(firstPlaceholderName('db.x.find().toArray()'), undefined);
  assert.equal(firstPlaceholderName(''), undefined);
});

test('pickObservableQueryName: prefers the store_tap.observables-declared query over the FIRST query name', () => {
  const st = asAny({
    queries: { parent_notes: 'db.executions.findOne({...})', child_execution: 'db.executions.findOne({...})', stage_controls_queued: "db.stagecontrols.find({executionId:'{child_execution_id}'})" },
    observables: { stage_controls_queued: { entity: 'stage_controls_queued.row-count', relation: 'row-count' } },
  });
  assert.equal(pickObservableQueryName(st), 'stage_controls_queued');
  // no observables declared at all → falls back to the first query name
  assert.equal(pickObservableQueryName(asAny({ queries: { only: 'q' } })), 'only');
});

test('checkFreshInstance: the SAME instance id across iterations is flagged degenerate (excluded), a genuinely new id is fresh', () => {
  const seen = new Set();
  assert.deepEqual(checkFreshInstance(seen, 'exec-1'), { fresh: true });
  assert.deepEqual(checkFreshInstance(seen, 'exec-2'), { fresh: true });
  const repeat = checkFreshInstance(seen, 'exec-1');
  assert.equal(repeat.fresh, false);
  assert.match(repeat.reason, /degenerate replay/);
  assert.equal(seen.size, 2); // the repeat never got added a second time
});

test('executeNoteLifecycleWalk: reuses the confirmHttpReq request shape — placeholder-resolved path/headers, JSONPath capture', async () => {
  /** @type {{method:string,url:string,headers:any}[]} */
  const seen = [];
  const fetchFn = asAny(async (/** @type {string} */ url, /** @type {any} */ init) => {
    seen.push({ method: init.method, url, headers: init.headers });
    if (init.method === 'POST') return { status: 201, headers: { getSetCookie: () => [], get: () => null }, text: async () => JSON.stringify({ _id: 'p1', notes: [{ _id: 'c1' }] }) };
    return { status: 200, headers: { getSetCookie: () => [], get: () => null }, text: async () => '{}' };
  });
  /** @type {Record<string,any>} */
  const captures = { PB_SCENARIO_ID: 'scn-1', PB_LYRIC_FROM: 'lyriclet-runner' };
  const walk = [
    { op: 'http', args: { method: 'POST', path: '/executions?scenarioId={PB_SCENARIO_ID}', capture: { parent_execution_id: '$._id', child_execution_id: '$.notes[0]._id' } } },
    { op: 'http', args: { method: 'PATCH', path: '/executions/{parent_execution_id}/stages/final' } },
  ];
  const { steps } = await executeNoteLifecycleWalk({ fetchFn, baseUrl: 'http://localhost:18000', walk: asAny(walk), headers: { From: '{PB_LYRIC_FROM}' }, captures });
  assert.deepEqual(steps, [
    { method: 'POST', path: '/executions?scenarioId=scn-1', status: 201 },
    { method: 'PATCH', path: '/executions/p1/stages/final', status: 200 },
  ]);
  assert.equal(captures.child_execution_id, 'c1');
  assert.equal(seen[0].url, 'http://localhost:18000/executions?scenarioId=scn-1');
  assert.equal(seen[0].headers.From, 'lyriclet-runner'); // the header value came from operator_env, never invented
  assert.equal(seen[1].url, 'http://localhost:18000/executions/p1/stages/final');
});

test('executeNoteLifecycleWalk: a PLACEHOLDER-RESOLVED path that becomes hostile (e.g. a captured value smuggling "@attacker" or "http://evil" in) is refused, defense-in-depth — never fetched', async () => {
  const fetchFn = asAny(async () => {
    throw new Error('fetchFn must never be called for a hostile resolved path');
  });
  const hostileResolutions = [
    { captured: '@attacker/x', template: '/executions/{captured_id}' },
    { captured: 'evil', template: 'http://{captured_id}' }, // resolves to 'http://evil'
  ];
  for (const { captured, template } of hostileResolutions) {
    const walk = [{ op: 'http', args: { method: 'GET', path: template } }];
    await assert.rejects(
      executeNoteLifecycleWalk({ fetchFn, baseUrl: 'http://localhost:18000', walk: asAny(walk), headers: {}, captures: { captured_id: captured } }),
      /note-lifecycle 'http' op resolved to an unsafe path/,
      `expected template '${template}' with captured='${captured}' to be refused`
    );
  }
});

test('executeNoteLifecycleWalk: a non-2xx/3xx step throws (an honest could-not-execute, not a silent pass)', async () => {
  const fetchFn = asAny(async () => ({ status: 500, headers: { getSetCookie: () => [], get: () => null }, text: async () => 'boom' }));
  const walk = [{ op: 'http', args: { method: 'GET', path: '/x' } }];
  await assert.rejects(
    executeNoteLifecycleWalk({ fetchFn, baseUrl: 'http://localhost:1', walk: asAny(walk), headers: {}, captures: {} }),
    /walk step 'GET \/x' failed: HTTP 500/
  );
});

// ── runCatch dispatch: the WHOLE note-lifecycle Catch, cluster-free ──────────

/** @param {{name?:string, imageID?:string, restartCount?:number}} [opts] one-pod `kubectl get pods -o json` fixture */
function podList({ name = 'appservice-x', imageID = `img@${GOOD_DIGEST}`, restartCount = 0 } = {}) {
  return { items: [{ metadata: { name }, status: { containerStatuses: [{ name: 'appservice', imageID, restartCount }] } }] };
}

/** A fake `kubectl port-forward` spawner — confirms readiness on the next microtask (mirrors conjure.test.mjs). */
function fakePortForwardSpawn() {
  return () => {
    /** @type {((chunk:string)=>void)[]} */
    const stdoutListeners = [];
    queueMicrotask(() => { for (const l of stdoutListeners) l('Forwarding from 127.0.0.1:1 -> 2\n'); });
    return {
      pid: 1,
      kill: () => {},
      onStdout: (/** @type {(chunk:string)=>void} */ l) => stdoutListeners.push(l),
      onExit: () => {},
      onError: () => {},
    };
  };
}

/**
 * A fake kubectl exec runner covering BOTH the k8s-attach `get pods` calls (mintK8sAttachIdentity /
 * checkK8sAttachDrift) and the mongotap secret-read + mongosh-eval calls — keyed by argv shape
 * (mirrors conjure.test.mjs's fakeK8sExec + mongotap.test.mjs's fakeKubectl). `afterCountForId(id)`
 * decides what the store shows once the terminal step has run (0 = cleared/WORKS-shaped, 1 =
 * still-queued/DNW-shaped) for a given captured instance id; the FIRST real-query call for any id
 * is always the BEFORE read (1 row — a fresh execution always starts queued).
 * @param {(id:string) => number} afterCountForId
 */
function makeFakeExec(afterCountForId) {
  /** @type {Map<string, number>} */
  const callsPerId = new Map();
  return {
    run: (/** @type {string[]} */ args) => {
      if (args.includes('pods')) return { status: 0, stdout: JSON.stringify(podList()) };
      if (args.includes('secret')) {
        const field = String(args[args.length - 1]).includes('username') ? 'lyric' : 'pw';
        return { status: 0, stdout: Buffer.from(field, 'utf8').toString('base64') };
      }
      if (args.includes('mongosh')) {
        const script = String(args[args.length - 1]);
        if (script === 'db.runCommand({ping:1})') return { status: 0, stdout: '{"ok":1}' };
        const m = /executionId:'([^']+)'/.exec(script);
        const id = m ? m[1] : 'unknown';
        const n = (callsPerId.get(id) || 0) + 1;
        callsPerId.set(id, n);
        const count = n === 1 ? 1 : afterCountForId(id);
        const rows = Array.from({ length: count }, () => ({ executionId: id, status: 'queued' }));
        return { status: 0, stdout: JSON.stringify(rows) };
      }
      return { status: 1, stderr: `unhandled fake exec call: ${args.join(' ')}` };
    },
  };
}

/** A fake fetchFn: POST /executions mints a fresh {parent,child} id pair each call; PATCH the terminal stage 200s. */
function makeFakeFetch() {
  let counter = 0;
  return asAny(async (/** @type {string} */ url, /** @type {any} */ init) => {
    if (init.method === 'POST' && url.includes('/executions?scenarioId=')) {
      counter += 1;
      const body = JSON.stringify({ _id: `parent${counter}`, notes: [{ _id: `child${counter}` }] });
      return { status: 201, headers: { getSetCookie: () => [], get: () => null }, text: async () => body };
    }
    if (init.method === 'PATCH' && /\/executions\/parent\d+\/stages\/final$/.test(url)) {
      return { status: 200, headers: { getSetCookie: () => [], get: () => null }, text: async () => '{}' };
    }
    return { status: 404, headers: { getSetCookie: () => [], get: () => null }, text: async () => 'not found' };
  });
}

const NOTE_PROPOSAL_RAW = {
  walk: [
    { op: 'http', args: { method: 'POST', path: '/executions?scenarioId={PB_SCENARIO_ID}', capture: { parent_execution_id: '$._id', child_execution_id: '$.notes[0]._id' } } },
    { op: 'http', args: { method: 'PATCH', path: '/executions/{parent_execution_id}/stages/final' } },
  ],
  claim: { entity: 'stage_controls_queued.row-count', expectedAfterRelation: { op: 'decreased' }, scope: 'the terminal stage transition clears queued stagecontrols' },
};

/** @param {any} [overrides] @returns {any} a minimal valid multi_repo/k8s-attach/mongo/note-lifecycle recipe */
function noteLifecycleRecipe(overrides = {}) {
  return {
    kind: 'pb-recipe-v1',
    name: 'note-lifecycle test recipe',
    code_identity: { mode: 'multi_repo', repos: [{ name: 'appservice', sha: 'abc1234' }], wheels: [{ name: 'lyric-py', version: '1.0.0' }] },
    conjure: {
      mode: 'k8s-attach',
      kube_context: 'test-ctx',
      namespace: 'test-ns',
      services: [{ name: 'svc/appservice', local_port: 18000, remote_port: 8000 }],
      expected_images: [`img@${GOOD_DIGEST}`],
    },
    fresh_world: { strategy: 'new_instance_per_iteration' },
    setup: { operator_env: ['PB_SCENARIO_ID'] },
    front_door: { mode: 'rest', base_url_template: 'http://{appservice_host}:{appservice_port}', entrypoint: 'POST /executions?scenarioId={PB_SCENARIO_ID}' },
    store_tap: {
      engine: 'mongo',
      pod: 'mongodb-0',
      container: 'mongod',
      db: 'lyric',
      credential_secrets: ['s1'],
      queries: { stage_controls_queued: "db.stagecontrols.find({executionId:'{child_execution_id}',status:'queued'}).toArray()" },
      observables: { stage_controls_queued: { entity: 'stage_controls_queued.row-count', relation: 'row-count' } },
    },
    drive: { mode: 'note-lifecycle', surface: 'appservice-api+mongo' },
    ...overrides,
  };
}

/** @param {any} obj @returns {string} temp recipe dir holding recipe.json */
function writeRecipeDir(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-notelifecycle-'));
  writeFileSync(join(dir, 'recipe.json'), JSON.stringify(obj));
  return dir;
}

/**
 * Run the note-lifecycle Catch end to end (cluster-free): a real conjureK8sAttach bring-up over a
 * fake port-forward/kubectl, a real mongotap read, a mock llmFn (frozen proposal). Sets/restores
 * PB_SCENARIO_ID for the duration (operator_env is read from process.env, never fabricated).
 * @param {(id:string)=>number} afterCountForId
 */
async function runNoteLifecycle(afterCountForId) {
  const dir = writeRecipeDir(noteLifecycleRecipe());
  const runDir = mkdtempSync(join(tmpdir(), 'pb-notelifecycle-run-'));
  const priorEnv = process.env.PB_SCENARIO_ID;
  process.env.PB_SCENARIO_ID = 'scn-1';
  try {
    const conjureFn = asAny((/** @type {string} */ d, /** @type {any} */ o) =>
      conjure(d, { ...o, spawnFn: asAny(fakePortForwardSpawn()), execFn: asAny(makeFakeExec(afterCountForId)) })
    );
    return await runCatch({ recipeDir: dir, runDir, conjureFn, fetchFn: makeFakeFetch(), llmFn: asAny(async () => NOTE_PROPOSAL_RAW) });
  } finally {
    if (priorEnv === undefined) delete process.env.PB_SCENARIO_ID;
    else process.env.PB_SCENARIO_ID = priorEnv;
    rmSync(dir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
}

test('runNoteLifecycleCatch HAPPY: two fresh instances, the terminal step clears the queued stagecontrols => WORKS', async () => {
  const result = await runNoteLifecycle(() => 0); // after the terminal step: 0 rows left queued (cleared)
  assert.equal(result.verdict.state, Verdict.WORKS, result.verdict.reasons.join(' | '));
  const delta = result.bundle.receipts.find((r) => r.id === 'store-delta');
  assert.ok(delta && delta.provenance === 'harness');
  assert.equal(delta.data.before, 1);
  assert.equal(delta.data.after, 0);
  const attempt = result.bundle.receipts.find((r) => r.id === 'note-lifecycle-drive');
  assert.ok(attempt && attempt.provenance === 'tool' && attempt.kind === 'attempt', 'the http drive attempt is TOOL, never harness');
  assert.equal(attempt.data.steps.length, 2);
  assert.equal(result.bundle.claims[0].effectCheck?.entity, 'stage_controls_queued.row-count');
  const fp = result.bundle.receipts.find((r) => r.kind === 'fingerprint');
  assert.ok(fp, 'a k8s-attach identity fingerprint was minted');
  assert.deepEqual(fp.data.repos, [{ name: 'appservice', sha: 'abc1234' }]);
});

test('runNoteLifecycleCatch FALSIFIED: the terminal step never clears the queued stagecontrols (reproduced) => DOES_NOT_WORK', async () => {
  const result = await runNoteLifecycle(() => 1); // stays queued after the terminal step, every rep
  assert.equal(result.verdict.state, Verdict.DOES_NOT_WORK, result.verdict.reasons.join(' | '));
  const delta = result.bundle.receipts.find((r) => r.id === 'store-delta');
  assert.ok(delta && delta.data.before === delta.data.after, 'a non-satisfying delta — the observable never moved');
});

test('runNoteLifecycleCatch: fresh_world enforcement — a degenerate repeated instance id is excluded from k/kFail, never silently counted', async () => {
  // A hostile/broken conjureFn that returns the SAME child id every iteration (never a fresh unit).
  const dir = writeRecipeDir(noteLifecycleRecipe());
  const runDir = mkdtempSync(join(tmpdir(), 'pb-notelifecycle-run-'));
  const priorEnv = process.env.PB_SCENARIO_ID;
  process.env.PB_SCENARIO_ID = 'scn-1';
  const fetchFn = asAny(async (/** @type {string} */ url, /** @type {any} */ init) => {
    if (init.method === 'POST') return { status: 201, headers: { getSetCookie: () => [], get: () => null }, text: async () => JSON.stringify({ _id: 'parent-same', notes: [{ _id: 'child-same' }] }) };
    return { status: 200, headers: { getSetCookie: () => [], get: () => null }, text: async () => '{}' };
  });
  try {
    const conjureFn = asAny((/** @type {string} */ d, /** @type {any} */ o) =>
      conjure(d, { ...o, spawnFn: asAny(fakePortForwardSpawn()), execFn: asAny(makeFakeExec(() => 0)) })
    );
    const result = await runCatch({ recipeDir: dir, runDir, conjureFn, fetchFn, llmFn: asAny(async () => NOTE_PROPOSAL_RAW) });
    // 2 reproductions were ATTEMPTED (n=2, unchanged — mirrors assembleArgoBundle/assembleCatchBundle's
    // own n:its.length convention); only the FIRST genuinely fresh id counts toward k (k=1) — the
    // SECOND, a repeated id, counts toward NEITHER k nor kFail (excluded, not silently folded into
    // either bucket). k=1 alone can never reach WORKS (the existing "a single walk is never WORKS" rule).
    assert.equal(result.bundle.reproduce.n, 2);
    assert.equal(result.bundle.reproduce.k, 1);
    assert.equal(result.bundle.reproduce.kFail, 0);
    assert.match(result.diagnosis.join(' '), /degenerate replay/);
    assert.equal(result.verdict.state, Verdict.COULD_NOT_DETERMINE, result.verdict.reasons.join(' | '));
  } finally {
    if (priorEnv === undefined) delete process.env.PB_SCENARIO_ID;
    else process.env.PB_SCENARIO_ID = priorEnv;
    rmSync(dir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ── LYRIC E2E DRY (task end-state bar): resolveCatchSeams + pre-attach validation, LOCAL-ONLY ────

test('LYRIC E2E DRY: the ENG-17397 recipe loads clean and resolveCatchSeams routes it end-to-end (no "not implemented"/"no registered provider" rejection)', () => {
  const recipe = loadRecipe(LYRIC_RECIPE);
  assert.equal(recipe.code_identity.mode, 'multi_repo');
  assert.equal(recipe.conjure.mode, 'k8s-attach');
  assert.equal(recipe.store_tap.engine, 'mongo');
  assert.equal(recipe.drive.mode, 'note-lifecycle');
  const seams = resolveCatchSeams({}, recipe);
  assert.equal(seams.conjureFn, conjure);
  assert.equal(seams.tapStoreFn, tapStore);
});

test('LYRIC E2E DRY: conjure() on the real recipe dir fails ONLY on a simulated cluster-absence (attach/connect) error, never a "not implemented" throw', async () => {
  // A LOCAL, injected simulation of "no real cluster reachable" — kubectl's own port-forward process
  // exits immediately when the context/apiserver is unreachable. No real kubectl binary or network
  // is touched (the task's LOCAL-ONLY constraint) — this is the pre-attach validation dry probe.
  const failingSpawn = () => {
    /** @type {((code:number|null)=>void)[]} */
    const exitListeners = [];
    queueMicrotask(() => { for (const l of exitListeners) l(1); });
    return {
      pid: 1,
      kill: () => {},
      onStdout: () => {},
      onExit: (/** @type {(code:number|null)=>void} */ l) => exitListeners.push(l),
      onError: () => {},
    };
  };
  await assert.rejects(conjure(LYRIC_RECIPE, { spawnFn: asAny(failingSpawn) }), (/** @type {any} */ err) => {
    assert.match(String(err.message), /exited early/); // an honest attach/connect-shaped failure
    assert.doesNotMatch(String(err.message), /not yet implemented|not implemented|is not supported/i);
    return true;
  });
});
