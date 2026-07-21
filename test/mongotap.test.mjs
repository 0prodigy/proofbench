// @ts-check
/**
 * Mongo store-tap unit tests — CLUSTER-FREE. A fake kubectl runner is injected so the tap is
 * exercised without a real pod/cluster; the real out-of-band read against a live SUT is a later
 * live-leg proof, not here. These cover the load-bearing behavior: the ordered credential-secret
 * fallback (validated by a ping, never trusted on presence alone), the exact `kubectl exec …
 * mongosh` argv, the query-wrap-to-JSON-array normalization (find/findOne/scalar), and the throw
 * paths (no working credential; a failing exec) — mongotap never falls back to an app read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tapMongo, wrapQueryAsJsonRows } from '../src/mongotap.mjs';

/** @param {any} x @returns {any} */
const asAny = (x) => x;

function makeStoreTap(overrides = {}) {
  return {
    engine: 'mongo',
    pod: 'mongodb-0',
    container: 'mongod',
    db: 'lyric',
    credential_secrets: ['mongodb-password', 'mongodb-lyric-lyric'],
    queries: { stage_controls: "db.stagecontrols.find({executionId:'exec1'}).toArray()" },
    ...overrides,
  };
}

/** base64 helper for fake secret data */
const b64 = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('base64');

/**
 * A fake kubectl runner keyed on a handler function so tests can script secret reads + mongosh
 * execs by argv shape without a giant queued-response list.
 * @param {(args:string[]) => {status:number, stdout?:string, stderr?:string, error?:Error}} handler
 */
function fakeKubectl(handler) {
  /** @type {string[][]} */
  const calls = [];
  return {
    calls,
    run: (/** @type {string[]} */ args) => {
      calls.push(args);
      return handler(args);
    },
  };
}

test('mongotap: wrapQueryAsJsonRows normalizes find/findOne/scalar/null into a JSON array', () => {
  assert.equal(wrapQueryAsJsonRows('db.x.find({}).toArray()'), wrapQueryAsJsonRows('db.x.find({}).toArray();')); // trailing ; tolerated
  assert.ok(wrapQueryAsJsonRows("db.x.findOne({_id:1})").includes('Array.isArray(__r)'));
});

test('mongotap: tries credential_secrets IN ORDER, validates each with a ping, and uses the first that authenticates', async () => {
  const kubectl = fakeKubectl((args) => {
    if (args[0] === 'get' && args[1] === 'secret') {
      const name = args[2];
      const field = args[4].includes('username') ? 'username' : 'password';
      if (name === 'mongodb-password') return { status: 0, stdout: b64(field === 'username' ? 'lyric' : 'wrong-pass') };
      if (name === 'mongodb-lyric-lyric') return { status: 0, stdout: b64(field === 'username' ? 'lyric' : 'right-pass') };
      return { status: 1, stderr: 'not found' };
    }
    // mongosh exec (ping or real query)
    const uri = args[args.indexOf('mongosh') + 1];
    const script = args[args.indexOf('--eval') + 1];
    if (script === 'db.runCommand({ping:1})') {
      // only the second secret's password authenticates
      return uri.includes('right-pass') ? { status: 0, stdout: '{ ok: 1 }' } : { status: 1, stderr: 'Authentication failed.' };
    }
    return { status: 0, stdout: '[{"executionId":"exec1","status":"expired"}]' };
  });

  const rows = await tapMongo(asAny(makeStoreTap()), 'stage_controls', makeStoreTap().queries.stage_controls, asAny(kubectl));
  assert.deepEqual(rows, [{ executionId: 'exec1', status: 'expired' }]);

  // both secrets' username+password were read, both pinged, only the working one drove the real query
  const pingCalls = kubectl.calls.filter((c) => c.includes('--eval') && c[c.indexOf('--eval') + 1] === 'db.runCommand({ping:1})');
  assert.equal(pingCalls.length, 2);
  const realQueryCall = kubectl.calls[kubectl.calls.length - 1];
  assert.ok(realQueryCall[realQueryCall.indexOf('mongosh') + 1].includes('right-pass'));
});

test('mongotap: builds the exact kubectl exec argv (pod, container, mongosh, --quiet, --eval)', async () => {
  const kubectl = fakeKubectl((args) => {
    if (args[0] === 'get' && args[1] === 'secret') {
      const field = args[4].includes('username') ? 'username' : 'password';
      return { status: 0, stdout: b64(field === 'username' ? 'lyric' : 'pw') };
    }
    return { status: 0, stdout: '[]' };
  });
  await tapMongo(asAny(makeStoreTap({ credential_secrets: ['only-secret'] })), 'stage_controls', "db.stagecontrols.find({}).toArray()", asAny(kubectl));
  const execCall = kubectl.calls.find((c) => c[0] === 'exec');
  assert.ok(execCall);
  assert.equal(execCall[0], 'exec');
  assert.equal(execCall[1], 'mongodb-0');
  assert.equal(execCall[2], '-c');
  assert.equal(execCall[3], 'mongod');
  assert.equal(execCall[4], '--');
  assert.equal(execCall[5], 'mongosh');
  assert.ok(execCall[6].startsWith('mongodb://lyric:pw@localhost:27017/lyric?authSource=lyric'));
  assert.equal(execCall[7], '--quiet');
  assert.equal(execCall[8], '--eval');
});

test('mongotap: findOne (object) and a null/absent findOne both normalize to a rows array', async () => {
  const kubectlObj = fakeKubectl((args) => {
    if (args[0] === 'get') return { status: 0, stdout: b64('u') };
    return { status: 0, stdout: '[{"_id":"e1","status":"queued"}]' }; // wrapper already prints the array form
  });
  const rows = await tapMongo(asAny(makeStoreTap({ credential_secrets: ['s'] })), 'q', "db.executions.findOne({_id:'e1'})", asAny(kubectlObj));
  assert.deepEqual(rows, [{ _id: 'e1', status: 'queued' }]);

  const kubectlNull = fakeKubectl((args) => {
    if (args[0] === 'get') return { status: 0, stdout: b64('u') };
    return { status: 0, stdout: '[]' };
  });
  const rowsNull = await tapMongo(asAny(makeStoreTap({ credential_secrets: ['s'] })), 'q', "db.executions.findOne({_id:'missing'})", asAny(kubectlNull));
  assert.deepEqual(rowsNull, []);
});

test('mongotap: throws naming every tried secret when NONE authenticates (never falls back to an app read)', async () => {
  const kubectl = fakeKubectl((args) => {
    if (args[0] === 'get' && args[1] === 'secret') {
      const field = args[4].includes('username') ? 'username' : 'password';
      return { status: 0, stdout: b64(field === 'username' ? 'lyric' : 'wrong') };
    }
    return { status: 1, stderr: 'Authentication failed.' };
  });
  await assert.rejects(
    () => tapMongo(asAny(makeStoreTap()), 'stage_controls', 'db.stagecontrols.find({}).toArray()', asAny(kubectl)),
    /no WORKING mongo credentials[\s\S]*mongodb-password, mongodb-lyric-lyric[\s\S]*never falls back to an app read/
  );
});

test('mongotap: a secret missing username or password is skipped without a ping attempt', async () => {
  const kubectl = fakeKubectl((args) => {
    if (args[0] === 'get' && args[1] === 'secret') {
      const name = args[2];
      const field = args[4].includes('username') ? 'username' : 'password';
      if (name === 'incomplete-secret') return field === 'username' ? { status: 0, stdout: b64('lyric') } : { status: 1, stderr: 'no key password' };
      return { status: 0, stdout: b64(field === 'username' ? 'lyric' : 'pw') };
    }
    return { status: 0, stdout: '[]' };
  });
  await tapMongo(asAny(makeStoreTap({ credential_secrets: ['incomplete-secret', 'good-secret'] })), 'q', 'db.x.find({}).toArray()', asAny(kubectl));
  const pingCalls = kubectl.calls.filter((c) => c.includes('--eval') && c[c.indexOf('--eval') + 1] === 'db.runCommand({ping:1})');
  assert.equal(pingCalls.length, 1); // only good-secret ever reached a ping
});

test('mongotap: throws on a failing real-query exec (distinct from a credential failure)', async () => {
  const kubectl = fakeKubectl((args) => {
    if (args[0] === 'get') return { status: 0, stdout: b64('u') };
    const script = args[args.indexOf('--eval') + 1];
    if (script === 'db.runCommand({ping:1})') return { status: 0, stdout: '{ok:1}' };
    return { status: 1, stderr: 'MongoServerError: Unrecognized pipeline stage' };
  });
  await assert.rejects(
    () => tapMongo(asAny(makeStoreTap({ credential_secrets: ['s'] })), 'stage_controls', 'db.stagecontrols.find({}).toArray()', asAny(kubectl)),
    /query 'stage_controls' failed via secret 's' \(exit 1\)[\s\S]*Unrecognized pipeline stage/
  );
});

test('mongotap: a docker/kubectl runner error (e.g. binary not found) surfaces distinctly from a nonzero exit', async () => {
  const kubectl = fakeKubectl((args) => {
    if (args[0] === 'get') return { status: 0, stdout: b64('u') };
    if (args[args.indexOf('--eval') + 1] === 'db.runCommand({ping:1})') return { status: 0, stdout: '{ok:1}' };
    return { status: /** @type {any} */ (null), error: new Error('spawnSync kubectl ENOENT') };
  });
  await assert.rejects(
    () => tapMongo(asAny(makeStoreTap({ credential_secrets: ['s'] })), 'q', 'db.x.find({}).toArray()', asAny(kubectl)),
    /kubectl exec for query 'q' failed to run: spawnSync kubectl ENOENT/
  );
});
