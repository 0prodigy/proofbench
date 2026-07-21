// @ts-check
/**
 * Conjure pure-helper tests — DOCKER-FREE. The docker-touching bring-up is proven by the
 * `pb conjure` CLI integration probe, not here. These cover the load-bearing pure
 * transforms: the build_overlay injection, front-door placeholder resolution, and the
 * capture JSONPath reader.
 *
 * The k8s-attach section below is CLUSTER-FREE the same way argoworkflows.test.mjs is: a fake
 * spawnFn/execFn is injected so the full attach bring-up + honesty mint-preconditions (code-
 * identity binding, drift sentinel) run without a cluster or docker.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  overlayDockerfile,
  resolvePlaceholders,
  extractJsonPath,
  extractHtml,
  parseComposeName,
  overlayPlan,
  composeArgv,
  buildImageArgv,
  encodeSetupBody,
  absorbSetCookies,
  conjure,
  teardownSut,
  waitForPortForwardReady,
  podNamesFrom,
  podDigestsFrom,
  podRestartCountsFrom,
  expectedImagesBind,
  detectDrift,
  mintK8sAttachIdentity,
  checkK8sAttachDrift,
} from '../src/conjure.mjs';
import { isMinted } from '../src/harness.mjs';

/** @param {any} x @returns {any} */
const asAny = (x) => x;

test('conjure: overlayDockerfile injects build_overlay before the corepack line, RUN-prefixing bare shell lines', () => {
  const df = ['FROM n8nio/base:18', 'WORKDIR /src', 'RUN corepack enable && corepack prepare --activate', 'RUN pnpm install'].join('\n');
  const out = overlayDockerfile(df, ['npm install -g corepack@latest', 'ENV COREPACK_INTEGRITY_KEYS=0']);
  const lines = out.split('\n');
  const at = lines.findIndex((l) => /corepack enable/.test(l));
  assert.equal(lines[at - 2], 'RUN npm install -g corepack@latest'); // bare shell line -> RUN-prefixed
  assert.equal(lines[at - 1], 'ENV COREPACK_INTEGRITY_KEYS=0'); // already a directive -> verbatim
  assert.ok(out.startsWith('FROM n8nio/base:18'));
});

test('conjure: overlayDockerfile is a no-op without overlay lines', () => {
  const df = 'FROM x\nRUN corepack enable';
  assert.equal(overlayDockerfile(df, undefined), df);
  assert.equal(overlayDockerfile(df, []), df);
});

test('conjure: overlayDockerfile throws when overlay is set but there is no corepack anchor', () => {
  assert.throws(() => overlayDockerfile('FROM x\nRUN echo hi', ['ENV A=1']), /corepack/);
});

test('conjure: overlayDockerfile still anchors on the corepack line when a pnpm-install RUN also exists (byte-identical regression guard)', () => {
  const df = [
    'FROM n8nio/base:18',
    'WORKDIR /src',
    'COPY . .',
    'RUN corepack enable && corepack prepare --activate',
    'RUN pnpm install --frozen-lockfile',
  ].join('\n');
  const out = overlayDockerfile(df, ['npm install -g corepack@latest', 'ENV COREPACK_INTEGRITY_KEYS=0']);
  const expected = [
    'FROM n8nio/base:18',
    'WORKDIR /src',
    'COPY . .',
    'RUN npm install -g corepack@latest',
    'ENV COREPACK_INTEGRITY_KEYS=0',
    'RUN corepack enable && corepack prepare --activate',
    'RUN pnpm install --frozen-lockfile',
  ].join('\n');
  assert.equal(out, expected); // corepack wins over the pnpm-install fallback — anchor byte-identical to before
});

test('conjure: overlayDockerfile falls back to the first package-manager install RUN when no corepack line exists', () => {
  const df = [
    'FROM n8nio/base:18',
    'WORKDIR /src',
    'COPY . .',
    'RUN pnpm install --frozen-lockfile',
    'RUN pnpm build',
  ].join('\n');
  const out = overlayDockerfile(df, ['npm install -g corepack@latest', 'ENV COREPACK_INTEGRITY_KEYS=0']);
  const expected = [
    'FROM n8nio/base:18',
    'WORKDIR /src',
    'COPY . .',
    'RUN npm install -g corepack@latest',
    'ENV COREPACK_INTEGRITY_KEYS=0',
    'RUN pnpm install --frozen-lockfile',
    'RUN pnpm build',
  ].join('\n');
  assert.equal(out, expected); // injected immediately before the FIRST pnpm-install RUN, in the same stage
  assert.equal(out.split('\n').filter((l) => /corepack@latest/.test(l)).length, 1); // injected exactly once
});

test('conjure: overlayDockerfile fallback injects the overlay per build stage in a multi-stage Dockerfile with no corepack line', () => {
  const df = [
    'FROM n8nio/base:18 as builder',
    'WORKDIR /src',
    'COPY . .',
    'RUN pnpm install --frozen-lockfile',
    'RUN pnpm build',
    'FROM n8nio/base:18',
    'WORKDIR /app',
    'RUN pnpm rebuild --dir /app sqlite3',
    'CMD ["node", "dist/main.js"]',
  ].join('\n');
  const out = overlayDockerfile(df, ['npm install -g corepack@latest', 'ENV COREPACK_INTEGRITY_KEYS=0']);
  const expected = [
    'FROM n8nio/base:18 as builder',
    'WORKDIR /src',
    'COPY . .',
    'RUN npm install -g corepack@latest',
    'ENV COREPACK_INTEGRITY_KEYS=0',
    'RUN pnpm install --frozen-lockfile',
    'RUN pnpm build',
    'FROM n8nio/base:18',
    'WORKDIR /app',
    'RUN npm install -g corepack@latest',
    'ENV COREPACK_INTEGRITY_KEYS=0',
    'RUN pnpm rebuild --dir /app sqlite3',
    'CMD ["node", "dist/main.js"]',
  ].join('\n');
  assert.equal(out, expected); // each stage's first pnpm RUN gets its own corepack fix (ENV/npm -g don't cross FROM)
  assert.equal(out.split('\n').filter((l) => /corepack@latest/.test(l)).length, 2); // injected once per stage
});

test('conjure: overlayDockerfile fallback anchors before a MULTI-LINE RUN block whose continuation lines invoke pnpm', () => {
  const df = [
    'FROM n8nio/base:18',
    'WORKDIR /app',
    'RUN \\',
    '\tpnpm rebuild --dir /usr/local/lib/node_modules/n8n sqlite3 && \\',
    '\tln -s /usr/local/lib/node_modules/n8n /usr/local/bin/n8n && \\',
    '\tmkdir -p /home/node/.n8n',
    'CMD ["node", "dist/main.js"]',
  ].join('\n');
  const out = overlayDockerfile(df, ['npm install -g corepack@latest', 'ENV COREPACK_INTEGRITY_KEYS=0']);
  const expected = [
    'FROM n8nio/base:18',
    'WORKDIR /app',
    'RUN npm install -g corepack@latest',
    'ENV COREPACK_INTEGRITY_KEYS=0',
    'RUN \\',
    '\tpnpm rebuild --dir /usr/local/lib/node_modules/n8n sqlite3 && \\',
    '\tln -s /usr/local/lib/node_modules/n8n /usr/local/bin/n8n && \\',
    '\tmkdir -p /home/node/.n8n',
    'CMD ["node", "dist/main.js"]',
  ].join('\n');
  assert.equal(out, expected); // overlay lands immediately before the `RUN \` line; the multi-line block stays intact
  assert.equal(out.split('\n').filter((l) => /corepack@latest/.test(l)).length, 1); // injected once (single stage, single block)
});

test('conjure: overlayDockerfile throws naming both anchors when neither a corepack nor a pnpm/yarn/npm RUN exists', () => {
  assert.throws(
    () => overlayDockerfile(['FROM alpine', 'RUN echo hi', 'CMD ["sh"]'].join('\n'), ['ENV A=1']),
    (/** @type {Error} */ err) => /corepack/.test(err.message) && /pnpm|package-manager/.test(err.message)
  );
});

test('conjure: resolvePlaceholders fills {name} from the lookup and throws (naming it) on an unresolved one', () => {
  assert.equal(
    resolvePlaceholders('/webhook/{webhook_id}/n8n-form', (n) => (n === 'webhook_id' ? 'abc' : undefined)),
    '/webhook/abc/n8n-form'
  );
  assert.equal(resolvePlaceholders('/x/{a}/{b}', (n) => /** @type {any} */ ({ a: '1', b: '2' })[n]), '/x/1/2');
  assert.throws(() => resolvePlaceholders('/x/{missing}', () => undefined), /unresolved placeholder \{missing\}/);
});

test('conjure: extractJsonPath walks a $.a.b path and returns undefined off-path or without a $ root', () => {
  assert.equal(extractJsonPath({ data: { id: 'wf1' } }, '$.data.id'), 'wf1');
  assert.equal(extractJsonPath({ data: {} }, '$.data.id'), undefined);
  assert.equal(extractJsonPath({ a: 1 }, '$.a'), 1);
  assert.equal(extractJsonPath({ a: 1 }, 'a'), undefined); // must start with $
  assert.equal(extractJsonPath(null, '$.a'), undefined);
});

test('conjure: parseComposeName reads a top-level name:, strips quotes, ignores nested/absent', () => {
  assert.equal(parseComposeName('name: documenso-test\n\nservices:\n  database:\n    image: postgres:15'), 'documenso-test');
  assert.equal(parseComposeName('name: "doc-test"'), 'doc-test');
  assert.equal(parseComposeName("name:   spaced-out   \n"), 'spaced-out'); // trims surrounding whitespace
  assert.equal(parseComposeName('services:\n  app:\n    name: not-the-project'), null); // indented name: is a service key, not the project
  assert.equal(parseComposeName('services:\n  db: {}'), null);
});

test('conjure: overlayPlan splits yaml overlays (-f) from staged files (copied into the checkout beside the base Dockerfile)', () => {
  const plan = overlayPlan(['compose.override.mem.yml', 'Dockerfile.mem'], 'docker/Dockerfile');
  assert.deepEqual(plan.composeOverlays, ['compose.override.mem.yml']); // a compose file is layered as -f
  assert.deepEqual(plan.staged, [{ name: 'Dockerfile.mem', toRel: 'docker/Dockerfile.mem' }]); // staged beside docker/Dockerfile
});

test('conjure: overlayPlan derives the stage target from the base dockerfile dir and handles .yaml + no overlays', () => {
  assert.deepEqual(overlayPlan(['x.yaml'], 'build/Dockerfile'), { composeOverlays: ['x.yaml'], staged: [] });
  assert.deepEqual(overlayPlan(['Dockerfile.mem'], 'Dockerfile'), { composeOverlays: [], staged: [{ name: 'Dockerfile.mem', toRel: 'Dockerfile.mem' }] });
  assert.deepEqual(overlayPlan(undefined, 'docker/Dockerfile'), { composeOverlays: [], staged: [] });
});

test('conjure: composeArgv builds `compose -p <project> -f <f>… <verb>` with the base file first', () => {
  assert.deepEqual(composeArgv('documenso-test', ['/co/docker/testing/compose.yml', '/recipe/compose.override.mem.yml'], ['up', '-d', '--build']), [
    'compose', '-p', 'documenso-test',
    '-f', '/co/docker/testing/compose.yml',
    '-f', '/recipe/compose.override.mem.yml',
    'up', '-d', '--build',
  ]);
  assert.deepEqual(composeArgv('p', ['/a.yml'], ['down', '-v']), ['compose', '-p', 'p', '-f', '/a.yml', 'down', '-v']);
});

test('conjure: buildImageArgv reproduces the exact prior argv when no target is set, and inserts --target before the context when disclosed (§1)', () => {
  assert.deepEqual(buildImageArgv('/co/Dockerfile.pb-overlay', 'pb-sut-tag', '/co/ctx'), [
    'build', '-f', '/co/Dockerfile.pb-overlay', '-t', 'pb-sut-tag', '/co/ctx',
  ]);
  assert.deepEqual(buildImageArgv('/co/Dockerfile.pb-overlay', 'pb-sut-tag', '/co/ctx', { n8nDevBuildArg: true }), [
    'build', '-f', '/co/Dockerfile.pb-overlay', '-t', 'pb-sut-tag', '--build-arg', 'N8N_RELEASE_TYPE=dev', '/co/ctx',
  ]);
  assert.deepEqual(buildImageArgv('/co/Dockerfile.pb-overlay', 'pb-sut-tag', '/co/ctx', { target: 'builder' }), [
    'build', '-f', '/co/Dockerfile.pb-overlay', '-t', 'pb-sut-tag', '--target', 'builder', '/co/ctx',
  ]);
});

test('conjure: encodeSetupBody defaults to JSON (byte-identical to before) and encodes "form" as URLSearchParams (§2)', () => {
  assert.deepEqual(encodeSetupBody(undefined, { a: 1, b: 'x' }), { contentTypeHeader: 'application/json', encoded: JSON.stringify({ a: 1, b: 'x' }) });
  assert.deepEqual(encodeSetupBody('json', { a: 1 }), { contentTypeHeader: 'application/json', encoded: '{"a":1}' });
  assert.deepEqual(encodeSetupBody('form', { username: 'admin', password: 'p@ss w/ord' }), {
    contentTypeHeader: 'application/x-www-form-urlencoded',
    encoded: new URLSearchParams({ username: 'admin', password: 'p@ss w/ord' }).toString(),
  });
});

test('conjure: extractHtml runs the capture regex over the response body and returns group 1, or undefined off-match (§3)', () => {
  const html = '<input type="hidden" name="csrfmiddlewaretoken" value="abc123XYZ">';
  assert.equal(extractHtml(html, 'name="csrfmiddlewaretoken" value="([^"]+)"'), 'abc123XYZ');
  assert.equal(extractHtml(html, 'name="nope" value="([^"]+)"'), undefined);
  assert.equal(extractHtml('', 'x'), undefined);
});

test('conjure: absorbSetCookies collects Set-Cookie into the jar regardless of status — a 302 (Django login redirect) included (§4)', () => {
  const headers = new Headers();
  headers.append('set-cookie', 'csrftoken=abc123; Path=/; SameSite=Lax');
  headers.append('set-cookie', 'sessionid=xyz789; HttpOnly; Path=/');
  const res = new Response(null, { status: 302, headers });
  const jar = new Map();
  absorbSetCookies(res, jar);
  assert.equal(jar.get('csrftoken'), 'abc123');
  assert.equal(jar.get('sessionid'), 'xyz789');
});

test('conjure: absorbSetCookies never lets a cleared (empty-value) cookie wipe the jar', () => {
  const jar = new Map([['csrftoken', 'abc123']]);
  const headers = new Headers();
  headers.append('set-cookie', 'csrftoken=');
  absorbSetCookies(new Response(null, { status: 200, headers }), jar);
  assert.equal(jar.get('csrftoken'), 'abc123'); // unchanged
});

// ── k8s-attach (the Lyric class): bring-up + honesty mint-preconditions, CLUSTER-FREE ─────────

const GOOD_DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

/**
 * A `kubectl get pods -o json` fixture: one pod, one container, a given imageID + restartCount.
 * @param {{name?:string, imageID?:string, restartCount?:number}} [opts]
 */
function podList({ name = 'appservice-abc123', imageID = `us-docker.pkg.dev/x/appservice@${GOOD_DIGEST}`, restartCount = 0 } = {}) {
  return { items: [{ metadata: { name }, status: { containerStatuses: [{ name: 'appservice', imageID, restartCount }] } }] };
}

/**
 * A fake blocking kubectl runner (execFn) — records every argv, returns the queued response per
 * call (clamped so the last repeats). Mirrors argoworkflows.test.mjs's fakeKubectl.
 * @param {Array<{status:number, stdout?:string, stderr?:string}>} responses
 */
function fakeK8sExec(responses) {
  /** @type {{args:string[]}[]} */
  const calls = [];
  return {
    calls,
    run: (/** @type {string[]} */ args) => {
      calls.push({ args });
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    },
  };
}

/**
 * A fake `kubectl port-forward` spawner (spawnFn) — records every argv, and (unless opts.fail)
 * reports "Forwarding from" readiness on the next microtask so waitForPortForwardReady resolves
 * without a real timer.
 * @param {{fail?:boolean}} [opts]
 */
function fakePortForwardSpawn(opts = {}) {
  /** @type {{args:string[]}[]} */
  const calls = [];
  /** @type {{args:string[], killed:boolean}[]} */
  const procs = [];
  const spawnFn = (/** @type {string[]} */ args) => {
    calls.push({ args });
    /** @type {((chunk:string)=>void)[]} */
    const stdoutListeners = [];
    /** @type {((code:number|null)=>void)[]} */
    const exitListeners = [];
    const rec = { args, killed: false };
    procs.push(rec);
    queueMicrotask(() => {
      if (opts.fail) for (const l of exitListeners) l(1);
      else for (const l of stdoutListeners) l('Forwarding from 127.0.0.1:1 -> 2\n');
    });
    return {
      pid: 4242,
      kill: () => {
        rec.killed = true;
      },
      onStdout: (/** @type {(chunk:string)=>void} */ l) => stdoutListeners.push(l),
      onExit: (/** @type {(code:number|null)=>void} */ l) => exitListeners.push(l),
    };
  };
  return { spawnFn, calls, procs };
}

/** @param {any} [overrides] @returns {any} a minimal, valid k8s-attach pb-recipe-v1 */
function validK8sAttachRecipe(overrides = {}) {
  return {
    kind: 'pb-recipe-v1',
    name: 'temp k8s-attach recipe',
    code_identity: { mode: 'pinned_image', image_ref: 'example:1', image_digest: 'sha256:abc' },
    conjure: {
      mode: 'k8s-attach',
      kube_context: 'akashpathak',
      namespace: 'delta',
      services: [{ name: 'svc/appservice', local_port: 18000, remote_port: 8000 }],
      expected_images: [`us-docker.pkg.dev/x/appservice@${GOOD_DIGEST}`],
    },
    fresh_world: { strategy: 'new_instance_per_iteration' },
    setup: { operator_env: ['PB_SCENARIO_ID'] },
    front_door: { url_template: '/health' },
    store_tap: { engine: 'mongo', pod: 'mongodb-0', container: 'mongod', db: 'lyric', credential_secrets: ['s1'], queries: { q: 'db.x.find()' } },
    ...overrides,
  };
}

/** @param {any} obj @returns {string} temp recipe dir holding recipe.json */
function writeRecipeDir(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-recipe-'));
  writeFileSync(join(dir, 'recipe.json'), JSON.stringify(obj));
  return dir;
}

test('conjure: podNamesFrom/podDigestsFrom/podRestartCountsFrom parse a kubectl get pods -o json list', () => {
  const list = {
    items: [
      { metadata: { name: 'b-pod' }, status: { containerStatuses: [{ name: 'app', imageID: `x@${GOOD_DIGEST}`, restartCount: 3 }] } },
      { metadata: { name: 'a-pod' }, status: { containerStatuses: [{ name: 'app', imageID: `x@${OTHER_DIGEST}` }] } },
    ],
  };
  assert.deepEqual(podNamesFrom(list), ['a-pod', 'b-pod']); // sorted
  assert.deepEqual(podDigestsFrom(list), [GOOD_DIGEST, OTHER_DIGEST].sort());
  assert.deepEqual(podRestartCountsFrom(list), { 'a-pod/app': 0, 'b-pod/app': 3 });
  assert.deepEqual(podNamesFrom({}), []);
  assert.deepEqual(podDigestsFrom(null), []);
});

test('conjure: expectedImagesBind requires every expected image to name a digest actually observed running', () => {
  assert.equal(expectedImagesBind([GOOD_DIGEST], [`ref@${GOOD_DIGEST}`]).bound, true);

  const noDigest = expectedImagesBind([GOOD_DIGEST], ['ref:latest']);
  assert.equal(noDigest.bound, false);
  assert.match(noDigest.reason || '', /unbound/);

  const wrongDigest = expectedImagesBind([GOOD_DIGEST], [`ref@${OTHER_DIGEST}`]);
  assert.equal(wrongDigest.bound, false);
  assert.match(wrongDigest.reason || '', /not observed running/);
});

test('conjure: detectDrift is clean on a stable snapshot and flags a pod-set change, a digest change, and a restart-count increase', () => {
  const before = { pods: ['a'], digests: [GOOD_DIGEST], restarts: { 'a/app': 0 } };
  assert.equal(detectDrift(before, { pods: ['a'], digests: [GOOD_DIGEST], restarts: { 'a/app': 0 } }).drifted, false);

  const podSetChanged = detectDrift(before, { pods: ['a', 'b'], digests: before.digests, restarts: before.restarts });
  assert.equal(podSetChanged.drifted, true);
  assert.match(podSetChanged.reason || '', /pod set changed/);

  const digestChanged = detectDrift(before, { pods: before.pods, digests: [OTHER_DIGEST], restarts: before.restarts });
  assert.equal(digestChanged.drifted, true);
  assert.match(digestChanged.reason || '', /digest\(s\) changed/);

  const restarted = detectDrift(before, { pods: before.pods, digests: before.digests, restarts: { 'a/app': 1 } });
  assert.equal(restarted.drifted, true);
  assert.match(restarted.reason || '', /restart count increased/);
});

test('conjure: waitForPortForwardReady resolves once "Forwarding from" appears on stdout', async () => {
  /** @type {((chunk:string)=>void)[]} */
  const stdoutListeners = [];
  const proc = { onStdout: (/** @type {(chunk:string)=>void} */ l) => stdoutListeners.push(l) };
  const p = waitForPortForwardReady(asAny(proc), { name: 'svc/x', local_port: 1, remote_port: 2 }, 1000);
  for (const l of stdoutListeners) l('Forwarding from 127.0.0.1:1 -> 2\n');
  await p; // does not throw
});

test('conjure: waitForPortForwardReady rejects, naming the service, when the process exits before confirming', async () => {
  /** @type {((code:number|null)=>void)[]} */
  const exitListeners = [];
  const proc = { onStdout: () => {}, onExit: (/** @type {(code:number|null)=>void} */ l) => exitListeners.push(l) };
  const p = waitForPortForwardReady(asAny(proc), { name: 'svc/x', local_port: 1, remote_port: 2 }, 1000);
  for (const l of exitListeners) l(1);
  await assert.rejects(p, /svc\/x.*exited early/);
});

test('conjure: waitForPortForwardReady rejects on a bounded timeout when nothing ever confirms', async () => {
  const proc = { onStdout: () => {} };
  await assert.rejects(waitForPortForwardReady(asAny(proc), { name: 'svc/x', local_port: 1, remote_port: 2 }, 20), /did not confirm readiness/);
});

test('conjure: mode k8s-attach port-forwards every recipe service (never docker) and mints a bringup receipt only — no fingerprint yet (P1 deferred)', async () => {
  const dir = writeRecipeDir(validK8sAttachRecipe());
  const fakeSpawn = fakePortForwardSpawn();
  const fakeExec = fakeK8sExec([{ status: 0, stdout: JSON.stringify(podList()) }]);
  try {
    const handle = await conjure(dir, { spawnFn: asAny(fakeSpawn.spawnFn), execFn: asAny(fakeExec) });
    assert.deepEqual(fakeSpawn.calls[0].args, ['port-forward', '--context', 'akashpathak', '-n', 'delta', 'svc/appservice', '18000:8000']);
    assert.equal(handle.containerName, null);
    assert.equal(handle.baseUrl, 'http://localhost:18000');
    assert.equal(handle.frontDoorUrl, 'http://localhost:18000/health');
    assert.equal(handle.receipts.length, 1);
    assert.equal(handle.receipts[0].kind, 'attempt');
    assert.ok(isMinted(handle.receipts[0]));
    assert.ok(handle._k8sAttach);
    assert.deepEqual(handle._k8sAttach?.attachSnapshot.digests, [GOOD_DIGEST]);
    assert.equal(handle._k8sAttach?.driveSnapshot, null);

    await handle.teardown();
    assert.equal(fakeSpawn.procs[0].killed, true); // attach-only: nothing but the port-forward is reaped
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conjure: mode k8s-attach never requires docker and rejects code_identity.mode "multi_repo" (deferred to a later slice)', async () => {
  const dir = writeRecipeDir(validK8sAttachRecipe({ code_identity: { mode: 'multi_repo', repos: [{ name: 'appservice', sha: 'abc' }], wheels: [{ name: 'lyric-py', version: '1.0.0' }] } }));
  try {
    await assert.rejects(
      conjure(dir, { spawnFn: asAny(fakePortForwardSpawn().spawnFn), execFn: asAny(fakeK8sExec([{ status: 0, stdout: JSON.stringify(podList()) }])) }),
      /multi_repo.*not yet implemented/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conjure: mintK8sAttachIdentity reads the DRIVE-TIME (not attach-time) digest and mints a harness fingerprint when it binds expected_images', async () => {
  const dir = writeRecipeDir(validK8sAttachRecipe());
  const fakeSpawn = fakePortForwardSpawn();
  // attach-time read is call #1; drive-time read (mintK8sAttachIdentity) is call #2 — both good here.
  const fakeExec = fakeK8sExec([{ status: 0, stdout: JSON.stringify(podList()) }, { status: 0, stdout: JSON.stringify(podList()) }]);
  try {
    const handle = await conjure(dir, { spawnFn: asAny(fakeSpawn.spawnFn), execFn: asAny(fakeExec) });
    const fp = await mintK8sAttachIdentity(handle);
    assert.ok(isMinted(fp));
    assert.equal(fp.kind, 'fingerprint');
    assert.equal(fp.provenance, 'harness');
    assert.deepEqual(/** @type {any} */ (fp.data).drive_time_digests, [GOOD_DIGEST]);
    assert.equal(handle.receipts.length, 2); // bringup + fingerprint
    assert.equal(handle._k8sAttach?.driveSnapshot?.digests[0], GOOD_DIGEST);
    await handle.teardown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conjure: mintK8sAttachIdentity REFUSES to mint (base-skew) when the drive-time digest no longer matches expected_images — P1 mint precondition', async () => {
  const dir = writeRecipeDir(validK8sAttachRecipe());
  const fakeSpawn = fakePortForwardSpawn();
  // attach-time read: expected digest running. Drive-time read: base-skewed to a DIFFERENT digest
  // (e.g. a reconciler swapped the pod's image between attach and drive — F2/F3).
  const fakeExec = fakeK8sExec([
    { status: 0, stdout: JSON.stringify(podList()) },
    { status: 0, stdout: JSON.stringify(podList({ imageID: `us-docker.pkg.dev/x/appservice@${OTHER_DIGEST}` })) },
  ]);
  try {
    const handle = await conjure(dir, { spawnFn: asAny(fakeSpawn.spawnFn), execFn: asAny(fakeExec) });
    await assert.rejects(mintK8sAttachIdentity(handle), /base-skew/);
    assert.equal(handle.receipts.length, 1); // NO fingerprint minted — refused, not a verdict edit
    await handle.teardown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conjure: checkK8sAttachDrift passes clean when nothing changed between drive-time and the re-read after the verdict window', async () => {
  const dir = writeRecipeDir(validK8sAttachRecipe());
  const fakeSpawn = fakePortForwardSpawn();
  const fakeExec = fakeK8sExec([{ status: 0, stdout: JSON.stringify(podList()) }]); // same snapshot every call
  try {
    const handle = await conjure(dir, { spawnFn: asAny(fakeSpawn.spawnFn), execFn: asAny(fakeExec) });
    await mintK8sAttachIdentity(handle);
    await checkK8sAttachDrift(handle); // does not throw
    await handle.teardown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conjure: checkK8sAttachDrift throws naming reconcile-drift on an un-caused restart-count bump after the verdict window — never a false DOES_NOT_WORK', async () => {
  const dir = writeRecipeDir(validK8sAttachRecipe());
  const fakeSpawn = fakePortForwardSpawn();
  const fakeExec = fakeK8sExec([
    { status: 0, stdout: JSON.stringify(podList()) }, // attach
    { status: 0, stdout: JSON.stringify(podList()) }, // drive-time (mintK8sAttachIdentity baseline)
    { status: 0, stdout: JSON.stringify(podList({ restartCount: 1 })) }, // after the verdict window — un-caused restart
  ]);
  try {
    const handle = await conjure(dir, { spawnFn: asAny(fakeSpawn.spawnFn), execFn: asAny(fakeExec) });
    await mintK8sAttachIdentity(handle);
    await assert.rejects(checkK8sAttachDrift(handle), /reconcile-drift/);
    await handle.teardown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conjure: checkK8sAttachDrift throws when called before mintK8sAttachIdentity has recorded a drive-time baseline', async () => {
  const dir = writeRecipeDir(validK8sAttachRecipe());
  const fakeSpawn = fakePortForwardSpawn();
  const fakeExec = fakeK8sExec([{ status: 0, stdout: JSON.stringify(podList()) }]);
  try {
    const handle = await conjure(dir, { spawnFn: asAny(fakeSpawn.spawnFn), execFn: asAny(fakeExec) });
    await assert.rejects(checkK8sAttachDrift(handle), /before mintK8sAttachIdentity/);
    await handle.teardown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conjure: mode k8s-attach port-forward that never confirms readiness reaps every already-started process (partial bring-up)', async () => {
  const dir = writeRecipeDir(
    validK8sAttachRecipe({
      conjure: {
        mode: 'k8s-attach',
        kube_context: 'akashpathak',
        namespace: 'delta',
        services: [
          { name: 'svc/appservice', local_port: 18000, remote_port: 8000 },
          { name: 'svc/mongodb', local_port: 18001, remote_port: 27017 },
        ],
      },
    })
  );
  const fakeSpawn = fakePortForwardSpawn({ fail: true }); // every port-forward exits before confirming
  try {
    await assert.rejects(conjure(dir, { spawnFn: asAny(fakeSpawn.spawnFn), execFn: asAny(fakeK8sExec([{ status: 0, stdout: '{}' }])) }), /exited early/);
    assert.equal(fakeSpawn.procs.length, 1); // the SECOND service is never attempted once the first fails
    assert.equal(fakeSpawn.procs[0].killed, true); // reaped on the failed bring-up
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
