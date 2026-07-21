// @ts-check
/**
 * Store-tap unit tests — DOCKER-FREE. A fake docker runner is injected so the tap is
 * exercised without a container; the real out-of-band read against a live SUT is proven by
 * the M4 integration probe, not here. These cover the load-bearing behavior: the exact
 * `docker exec sqlite3 -json` argv, -json parsing (incl. the empty-store case), the
 * EXPECTED transient-lock retry, the throw paths, and that mintStoreDelta genuinely goes
 * through the harness mint (an un-minted look-alike is not branded).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tapStore, mintStoreDelta } from '../src/storetap.mjs';
import { isMinted } from '../src/harness.mjs';

/** A minimal fake mongo SUT handle: the tap kubectl-execs into a k8s pod (store_tap.pod), not handle.containerName. */
function makeMongoHandle() {
  return {
    containerName: 'irrelevant-for-mongo',
    recipe: {
      store_tap: {
        engine: 'mongo',
        pod: 'mongodb-0',
        container: 'mongod',
        db: 'lyric',
        credential_secrets: ['mongodb-password'],
        queries: { stage_controls: "db.stagecontrols.find({executionId:'exec1'}).toArray()" },
      },
    },
  };
}

/** A fake kubectl runner: secret reads always succeed with the given creds, then the query runs. */
function fakeKubectlForMongo(/** @type {string} */ queryStdout) {
  /** @type {string[][]} */
  const calls = [];
  return {
    calls,
    run: (/** @type {string[]} */ args) => {
      calls.push(args);
      if (args[0] === 'get' && args[1] === 'secret') {
        const field = args[4].includes('username') ? 'username' : 'password';
        return { status: 0, stdout: Buffer.from(field === 'username' ? 'lyric' : 'pw', 'utf8').toString('base64') };
      }
      return { status: 0, stdout: queryStdout };
    },
  };
}

/** @param {any} x @returns {any} */
const asAny = (x) => x;

/** A minimal fake SUT handle carrying only what tapStore reads. */
function makeHandle(engine = 'sqlite') {
  return {
    containerName: 'pb-sut-n8n-abc',
    recipe: {
      store_tap: {
        engine,
        db_path: '/home/node/.n8n/database.sqlite',
        busy_timeout_ms: 3000,
        queries: { executions: 'SELECT id, workflowId, status, finished FROM execution_entity ORDER BY id;' },
      },
    },
  };
}

/** A minimal fake postgres SUT handle: the tap execs into a SEPARATE DB container (store_tap.container). */
function makePgHandle() {
  return {
    containerName: 'pb-sut-documenso-abc', // the APP container — the postgres tap does NOT exec into this
    recipe: {
      store_tap: {
        engine: 'postgres',
        container: 'documenso-test-database-1',
        user: 'documenso',
        db: 'documenso',
        queries: { fields: 'SELECT count(*) AS n FROM "Field";' },
      },
    },
  };
}

/**
 * A fake docker runner: records every argv, returns the queued response for each call
 * (clamped to the last so a single response repeats).
 * @param {Array<{status:number, stdout?:string, stderr?:string, error?:Error}>} responses
 */
function fakeDocker(responses) {
  /** @type {string[][]} */
  const calls = [];
  return {
    calls,
    run: (/** @type {string[]} */ args) => {
      calls.push(args);
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    },
  };
}

test('storetap: tapStore builds the docker exec sqlite3 -json -cmd .timeout argv and parses -json rows', async () => {
  const docker = fakeDocker([{ status: 0, stdout: '[{"id":1,"workflowId":"wf1","status":"success","finished":1}]' }]);
  const rows = await tapStore(asAny(makeHandle()), 'executions', asAny(docker));
  assert.deepEqual(docker.calls[0], [
    'exec',
    'pb-sut-n8n-abc',
    'sqlite3',
    '-json',
    '-cmd',
    '.timeout 3000',
    '/home/node/.n8n/database.sqlite',
    'SELECT id, workflowId, status, finished FROM execution_entity ORDER BY id;',
  ]);
  assert.deepEqual(rows, [{ id: 1, workflowId: 'wf1', status: 'success', finished: 1 }]);
  assert.equal(docker.calls.length, 1);
});

test('storetap: tapStore returns [] on empty stdout and on a bare []', async () => {
  assert.deepEqual(await tapStore(asAny(makeHandle()), 'executions', asAny(fakeDocker([{ status: 0, stdout: '' }]))), []);
  assert.deepEqual(await tapStore(asAny(makeHandle()), 'executions', asAny(fakeDocker([{ status: 0, stdout: '[]\n' }]))), []);
});

test('storetap: tapStore builds the docker exec psql -U <user> -d <db> -At argv and parses tab rows (postgres, no busy-timeout)', async () => {
  const docker = fakeDocker([{ status: 0, stdout: '0\n' }]);
  const rows = await tapStore(asAny(makePgHandle()), 'fields', asAny(docker));
  assert.deepEqual(docker.calls[0], [
    'exec',
    'documenso-test-database-1', // the SEPARATE DB container (store_tap.container), NOT handle.containerName
    'psql',
    '-U',
    'documenso',
    '-d',
    'documenso',
    '-At',
    '-F',
    '\t',
    '-c',
    'SELECT count(*) AS n FROM "Field";',
  ]);
  assert.deepEqual(rows, [['0']]); // tuples-only, tab-split, no header/footer
  assert.equal(docker.calls.length, 1); // MVCC: a single read, no lock-retry
});

test('storetap: the postgres tap parses multi-column tab rows and an empty result set', async () => {
  assert.deepEqual(
    await tapStore(asAny(makePgHandle()), 'fields', asAny(fakeDocker([{ status: 0, stdout: '1\tSIGNATURE\n2\tTEXT\n' }]))),
    [
      ['1', 'SIGNATURE'],
      ['2', 'TEXT'],
    ]
  );
  assert.deepEqual(await tapStore(asAny(makePgHandle()), 'fields', asAny(fakeDocker([{ status: 0, stdout: '' }]))), []);
});

test('storetap: the postgres tap throws (never falls back to an app read) on a non-zero psql exit', async () => {
  const docker = fakeDocker([{ status: 1, stderr: 'ERROR:  relation "field" does not exist' }]);
  await assert.rejects(
    () => tapStore(asAny(makePgHandle()), 'fields', asAny(docker)),
    /query 'fields' failed \(exit 1\)[\s\S]*relation "field" does not exist/
  );
  assert.equal(docker.calls.length, 1); // no retry (MVCC), no fallback
});

test('storetap: tapStore treats a transient "database is locked" as EXPECTED — retries then succeeds', async () => {
  const docker = fakeDocker([
    { status: 1, stderr: 'Error: near line 1: database is locked' },
    { status: 0, stdout: '[{"id":1}]' },
  ]);
  const rows = await tapStore(asAny(makeHandle()), 'executions', asAny(docker));
  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(docker.calls.length, 2); // retried once, then succeeded — never a SUT failure
});

test('storetap: tapStore throws on an unknown queryName and never touches docker', async () => {
  const docker = fakeDocker([{ status: 0, stdout: '[]' }]);
  await assert.rejects(() => tapStore(asAny(makeHandle()), 'nope', asAny(docker)), /unknown query 'nope'/);
  assert.equal(docker.calls.length, 0);
});

test('storetap: tapStore throws on a non-lock error, naming the query and the stderr tail', async () => {
  const docker = fakeDocker([{ status: 1, stderr: 'Error: no such table: execution_entity' }]);
  await assert.rejects(
    () => tapStore(asAny(makeHandle()), 'executions', asAny(docker)),
    /query 'executions' failed \(exit 1\)[\s\S]*no such table: execution_entity/
  );
  assert.equal(docker.calls.length, 1); // a real error is not retried
});

test('storetap: tapStore throws a clear "unsupported engine" error for an engine that is neither sqlite, postgres, nor mongo', async () => {
  const docker = fakeDocker([{ status: 0, stdout: '[]' }]);
  await assert.rejects(() => tapStore(asAny(makeHandle('mysql')), 'executions', asAny(docker)), /unsupported engine 'mysql'/);
  assert.equal(docker.calls.length, 0);
});

test('storetap: tapStore dispatches engine "mongo" to a kubectl-exec mongosh tap (via the injected execFn seam) and parses rows', async () => {
  const kubectl = fakeKubectlForMongo('[{"executionId":"exec1","status":"expired"}]');
  const rows = await tapStore(asAny(makeMongoHandle()), 'stage_controls', asAny(fakeDocker([])), asAny(kubectl));
  assert.deepEqual(rows, [{ executionId: 'exec1', status: 'expired' }]);
  assert.ok(kubectl.calls.some((c) => c[0] === 'exec' && c[1] === 'mongodb-0' && c[3] === 'mongod'));
});

test('storetap: the mongo tap throws (never falls back to an app read) when no credential_secrets entry authenticates', async () => {
  const kubectl = {
    calls: /** @type {string[][]} */ ([]),
    run: (/** @type {string[]} */ args) => {
      kubectl.calls.push(args);
      if (args[0] === 'get' && args[1] === 'secret') return { status: 1, stderr: 'not found' };
      return { status: 1, stderr: 'Authentication failed.' };
    },
  };
  await assert.rejects(
    () => tapStore(asAny(makeMongoHandle()), 'stage_controls', asAny(fakeDocker([])), asAny(kubectl)),
    /no WORKING mongo credentials[\s\S]*never falls back to an app read/
  );
});

test('storetap: mintStoreDelta returns a minted HARNESS delta with the right data shape', () => {
  const d = mintStoreDelta({ entity: 'execution_entity.count', before: 0, after: 1, identity: 'anon' });
  assert.equal(d.provenance, 'harness');
  assert.equal(d.kind, 'delta');
  assert.equal(d.sourcePR, false);
  assert.equal(d.identity, 'anon');
  assert.deepEqual(d.data, { entity: 'execution_entity.count', before: 0, after: 1 });
  assert.equal(d.id, 'delta:execution_entity.count'); // derived default id
  assert.ok(typeof d.sha256 === 'string' && /** @type {string} */ (d.sha256).length === 64); // mint content-addressed data
  assert.ok(isMinted(d)); // carries the unforgeable harness brand
});

test('storetap: mintStoreDelta honors an explicit id and merges extra into data', () => {
  const d = mintStoreDelta({ id: 'store-delta', entity: 'x.count', before: 1, after: 2, identity: 'owner', extra: { workflowId: 'wf1' } });
  assert.equal(d.id, 'store-delta');
  assert.deepEqual(d.data, { entity: 'x.count', before: 1, after: 2, workflowId: 'wf1' });
});

test('storetap: a fabricated plain delta is NOT minted even if it labels itself harness — only mint() brands', () => {
  const fake = { id: 'fake', kind: 'delta', provenance: 'harness', identity: 'anon', sourcePR: false, data: { entity: 'x', before: 0, after: 1 } };
  assert.equal(isMinted(fake), false); // labeling can't forge the brand
  assert.equal(isMinted(mintStoreDelta({ entity: 'x', before: 0, after: 1, identity: 'anon' })), true);
});
