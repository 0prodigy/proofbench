// @ts-check
/**
 * Browser-drive unit tests — DOCKER-FREE and NETWORK-FREE. A fake docker runner and a fake
 * fetch are injected so the primitive is exercised without a container or a real browser; the
 * real containerized-chromium drive against a live conjured SUT is proven by the M5 live probe,
 * not here. These cover the load-bearing behavior: the exact `docker run … --shm-size=2g` boot
 * argv, the readiness poll + session capabilities, the exact W3C WebDriver requests each
 * primitive op issues (incl. the localhost→host.docker.internal rewrite on navigate), the
 * recorded walk, teardown (DELETE session then `docker rm -f`), the throw paths, and that
 * mintDriveAttempt genuinely goes through the harness mint as a TOOL attempt (never harness).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { openBrowser, mintDriveAttempt, hostToContainer, elementIdFrom, CHROMIUM_IMAGE } from '../src/browserdrive.mjs';
import { isMinted } from '../src/harness.mjs';

/** @param {any} x @returns {any} */
const asAny = (x) => x;

/** The stable W3C element-reference key (the literal the protocol wraps element ids in). */
const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/**
 * A fake docker runner: records every argv, returns the queued response for each call (clamped
 * to the last so one response repeats). Mirrors storetap.test.mjs's fakeDocker.
 * @param {Array<{status:number, stdout?:string, stderr?:string}>} responses
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

/**
 * A fake fetch routing on (method, pathname): the handler returns `{status?, value?}`, wrapped
 * as a WebDriver `{value}` envelope. Records every call for assertions.
 * @param {(method:string, path:string, body:any) => {status?:number, value?:any}} handler
 */
function fakeFetch(handler) {
  /** @type {Array<{method:string, url:string, path:string, body:any}>} */
  const calls = [];
  /** @param {string} url @param {any} [init] */
  const fn = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const path = new URL(url).pathname;
    const body = init && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, path, body });
    const r = handler(method, path, body) || {};
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => ({ value: r.value ?? null }) };
  };
  return Object.assign(fn, { calls });
}

/** The happy-path WebDriver router: ready, a session, a findable element, a submit confirmation. */
function happyRouter(/** @type {string} */ method, /** @type {string} */ path) {
  if (path === '/status') return { value: { ready: true } };
  if (path === '/session' && method === 'POST') return { value: { sessionId: 'sess-1' } };
  if (path === '/session/sess-1/element' && method === 'POST') return { value: { [W3C_ELEMENT_KEY]: 'el-9' } };
  if (path === '/session/sess-1/element/el-9/text') return { value: 'Your response has been recorded' };
  if (path === '/session/sess-1/execute/sync') return { value: { title: 'M1 Spike Form' } };
  return { value: null };
}

test('browserdrive: hostToContainer rewrites host localhost/127.0.0.1 and leaves a real host untouched', () => {
  assert.equal(hostToContainer('http://localhost:5678/webhook/abc/n8n-form'), 'http://host.docker.internal:5678/webhook/abc/n8n-form');
  assert.equal(hostToContainer('http://127.0.0.1:3000/'), 'http://host.docker.internal:3000/');
  assert.equal(hostToContainer('https://localhost/x'), 'https://host.docker.internal/x');
  assert.equal(hostToContainer('http://example.com/localhost'), 'http://example.com/localhost'); // only the host is rewritten
  assert.equal(hostToContainer('http://localhostname:80/'), 'http://localhostname:80/'); // not a word-boundary match
});

test('browserdrive: elementIdFrom extracts the W3C element key and returns undefined otherwise', () => {
  assert.equal(elementIdFrom({ [W3C_ELEMENT_KEY]: 'el-1' }), 'el-1');
  assert.equal(elementIdFrom({}), undefined); // no match
  assert.equal(elementIdFrom(null), undefined);
  assert.equal(elementIdFrom('nope'), undefined);
});

test('browserdrive: openBrowser pulls, boots with --shm-size=2g, polls /status, and opens a headless session', async () => {
  const docker = fakeDocker([{ status: 0, stdout: 'container-id' }]);
  const fetchFn = fakeFetch(happyRouter);
  const client = await openBrowser({ docker: asAny(docker), fetchFn: asAny(fetchFn), hostPort: 4444 });

  // boot argv: pull the pinned image, then run it detached, auto-removing, with the required shm size
  assert.deepEqual(docker.calls[0], ['pull', CHROMIUM_IMAGE]);
  assert.deepEqual(docker.calls[1], [
    'run', '-d', '--rm', '--name', client.containerName, '-p', '4444:4444', '--shm-size=2g', CHROMIUM_IMAGE,
  ]);
  // readiness + session
  assert.ok(fetchFn.calls.some((c) => c.path === '/status'));
  const session = fetchFn.calls.find((c) => c.path === '/session');
  assert.deepEqual(session?.body, {
    capabilities: {
      alwaysMatch: {
        browserName: 'chrome',
        'goog:chromeOptions': {
          args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1200'],
        },
      },
    },
  });
  assert.equal(client.sessionId, 'sess-1');
});

test('browserdrive: the client ops issue the exact W3C requests, rewrite the host on navigate, and record the walk', async () => {
  const docker = fakeDocker([{ status: 0, stdout: 'container-id' }]);
  const fetchFn = fakeFetch(happyRouter);
  const client = await openBrowser({ docker: asAny(docker), fetchFn: asAny(fetchFn), hostPort: 4444 });

  await client.navigate('http://localhost:5678/webhook/abc/n8n-form');
  const el = await client.find('input[name="Your name"]');
  await client.type(el, 'proofbench');
  await client.click(el);
  const confirm = await client.text(el);

  const byPath = (/** @type {string} */ p, /** @type {string} */ m) => fetchFn.calls.find((c) => c.path === p && c.method === m);
  // navigate rewrites the host localhost → host.docker.internal so the container can reach the SUT
  assert.deepEqual(byPath('/session/sess-1/url', 'POST')?.body, { url: 'http://host.docker.internal:5678/webhook/abc/n8n-form' });
  assert.deepEqual(byPath('/session/sess-1/element', 'POST')?.body, { using: 'css selector', value: 'input[name="Your name"]' });
  assert.deepEqual(byPath('/session/sess-1/element/el-9/value', 'POST')?.body, { text: 'proofbench' });
  assert.ok(byPath('/session/sess-1/element/el-9/click', 'POST'));
  assert.ok(byPath('/session/sess-1/element/el-9/text', 'GET'));
  assert.equal(el, 'el-9');
  assert.equal(confirm, 'Your response has been recorded');

  // the recorded walk is the raw observation the caller hands to mintDriveAttempt
  assert.deepEqual(client.steps, [
    { op: 'navigate', url: 'http://host.docker.internal:5678/webhook/abc/n8n-form' },
    { op: 'find', css: 'input[name="Your name"]', elementId: 'el-9' },
    { op: 'type', elementId: 'el-9', text: 'proofbench' },
    { op: 'click', elementId: 'el-9' },
    { op: 'text', elementId: 'el-9', value: 'Your response has been recorded' },
  ]);
});

test('browserdrive: execute runs JS in the page and records a head-truncated script step', async () => {
  const docker = fakeDocker([{ status: 0, stdout: 'container-id' }]);
  const fetchFn = fakeFetch(happyRouter);
  const client = await openBrowser({ docker: asAny(docker), fetchFn: asAny(fetchFn) });
  const value = await client.execute('return document.title', []);
  const exec = fetchFn.calls.find((c) => c.path === '/session/sess-1/execute/sync');
  assert.deepEqual(exec?.body, { script: 'return document.title', args: [] });
  assert.deepEqual(value, { title: 'M1 Spike Form' });
  assert.deepEqual(client.steps[0], { op: 'execute', script: 'return document.title', value: { title: 'M1 Spike Form' } });
});

test('browserdrive: clickAt drives a W3C Actions pointer click at viewport coords and records the step', async () => {
  const docker = fakeDocker([{ status: 0, stdout: 'container-id' }]);
  const fetchFn = fakeFetch(happyRouter);
  const client = await openBrowser({ docker: asAny(docker), fetchFn: asAny(fetchFn) });
  await client.clickAt(210, 320);
  // the coordinate/canvas escape hatch: one 'mouse' pointer source, move(viewport)→down→pause→up
  const actions = fetchFn.calls.find((c) => c.path === '/session/sess-1/actions' && c.method === 'POST');
  assert.deepEqual(actions?.body, {
    actions: [
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', duration: 10, origin: 'viewport', x: 210, y: 320 },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 60 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  });
  assert.deepEqual(client.steps[0], { op: 'clickAt', x: 210, y: 320 });
});

test('browserdrive: clickAt({shift:true}) drives a two-source W3C Actions payload (pointer + held Shift key) and records shift:true', async () => {
  const docker = fakeDocker([{ status: 0, stdout: 'container-id' }]);
  const fetchFn = fakeFetch(happyRouter);
  const client = await openBrowser({ docker: asAny(docker), fetchFn: asAny(fetchFn) });
  await client.clickAt(150, 260, { shift: true });
  const actions = fetchFn.calls.find((c) => c.path === '/session/sess-1/actions' && c.method === 'POST');
  assert.deepEqual(actions?.body, {
    actions: [
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', duration: 10, origin: 'viewport', x: 150, y: 260 },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 60 },
          { type: 'pointerUp', button: 0 },
        ],
      },
      {
        type: 'key',
        id: 'keyboard',
        actions: [
          { type: 'keyDown', value: '' },
          { type: 'pause', duration: 0 },
          { type: 'pause', duration: 0 },
          { type: 'keyUp', value: '' },
        ],
      },
    ],
  });
  assert.deepEqual(client.steps[0], { op: 'clickAt', x: 150, y: 260, shift: true });
});

test('browserdrive: clickAt rounds fractional viewport coords to ints (W3C Actions 400s on a float x/y)', async () => {
  const docker = fakeDocker([{ status: 0, stdout: 'container-id' }]);
  const fetchFn = fakeFetch(happyRouter);
  const client = await openBrowser({ docker: asAny(docker), fetchFn: asAny(fetchFn) });
  // The agent computes coordinates from introspected rects (getBoundingClientRect — legitimately
  // fractional), e.g. a canvas center point; the primitive must never forward that float verbatim.
  await client.clickAt(349.6, 211.4);
  const actions = fetchFn.calls.find((c) => c.path === '/session/sess-1/actions' && c.method === 'POST');
  const pointerMove = /** @type {any} */ (actions?.body).actions[0].actions[0];
  assert.deepEqual(pointerMove, { type: 'pointerMove', duration: 10, origin: 'viewport', x: 350, y: 211 });
  assert.deepEqual(client.steps[0], { op: 'clickAt', x: 350, y: 211 });
});

test('browserdrive: pointer drives a raw W3C pointer-action sequence and records the walk verbatim', async () => {
  const docker = fakeDocker([{ status: 0, stdout: 'container-id' }]);
  const fetchFn = fakeFetch(happyRouter);
  const client = await openBrowser({ docker: asAny(docker), fetchFn: asAny(fetchFn) });
  const seq = [
    { type: 'pointerMove', duration: 0, origin: 'viewport', x: 5, y: 6 },
    { type: 'pointerDown', button: 0 },
    { type: 'pointerUp', button: 0 },
  ];
  await client.pointer(seq);
  const actions = fetchFn.calls.find((c) => c.path === '/session/sess-1/actions' && c.method === 'POST');
  assert.deepEqual(actions?.body, { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: seq }] });
  assert.deepEqual(client.steps[0], { op: 'pointer', pointerType: 'mouse', actions: seq });
});

test('browserdrive: addCookie issues W3C Add Cookie with the name+value and records only the name', async () => {
  const docker = fakeDocker([{ status: 0, stdout: 'container-id' }]);
  const fetchFn = fakeFetch(happyRouter);
  const client = await openBrowser({ docker: asAny(docker), fetchFn: asAny(fetchFn) });
  await client.addCookie({ name: 'n8n-auth', value: 'super-secret-session-token' });
  const call = fetchFn.calls.find((c) => c.path === '/session/sess-1/cookie' && c.method === 'POST');
  assert.deepEqual(call?.body, { cookie: { name: 'n8n-auth', value: 'super-secret-session-token' } });
  // the recorded step carries the cookie NAME only — the value is a live session token, not evidence
  assert.deepEqual(client.steps[0], { op: 'addCookie', name: 'n8n-auth' });
});

test('browserdrive: teardown DELETEs the session then `docker rm -f`s the sidecar', async () => {
  const docker = fakeDocker([{ status: 0, stdout: 'container-id' }]);
  const fetchFn = fakeFetch(happyRouter);
  const client = await openBrowser({ docker: asAny(docker), fetchFn: asAny(fetchFn) });
  await client.teardown();
  assert.ok(fetchFn.calls.some((c) => c.method === 'DELETE' && c.path === '/session/sess-1'));
  assert.deepEqual(docker.calls[docker.calls.length - 1], ['rm', '-f', client.containerName]);
});

test('browserdrive: find throws when the selector matches no element (never invents an id)', async () => {
  const docker = fakeDocker([{ status: 0, stdout: 'container-id' }]);
  const fetchFn = fakeFetch((_method, path) => {
    if (path === '/status') return { value: { ready: true } };
    if (path === '/session') return { value: { sessionId: 'sess-1' } };
    if (path === '/session/sess-1/element') return { value: {} }; // matched nothing
    return { value: null };
  });
  const client = await openBrowser({ docker: asAny(docker), fetchFn: asAny(fetchFn) });
  await assert.rejects(() => client.find('#missing'), /find\('#missing'\) matched no element/);
});

test('browserdrive: a WebDriver error (non-2xx) throws naming the endpoint and the error', async () => {
  const docker = fakeDocker([{ status: 0, stdout: 'container-id' }]);
  const fetchFn = fakeFetch((_method, path) => {
    if (path === '/status') return { value: { ready: true } };
    if (path === '/session') return { value: { sessionId: 'sess-1' } };
    if (path === '/session/sess-1/url') return { status: 500, value: { error: 'unknown error', message: 'net::ERR_CONNECTION_REFUSED' } };
    return { value: null };
  });
  const client = await openBrowser({ docker: asAny(docker), fetchFn: asAny(fetchFn) });
  await assert.rejects(() => client.navigate('http://localhost:5678/'), /POST \/session\/sess-1\/url failed \(HTTP 500 unknown error\)[\s\S]*ERR_CONNECTION_REFUSED/);
});

test('browserdrive: openBrowser reaps the partial sidecar when session creation fails', async () => {
  const docker = fakeDocker([{ status: 0, stdout: 'container-id' }]);
  const fetchFn = fakeFetch((_method, path) => {
    if (path === '/status') return { value: { ready: true } };
    if (path === '/session') return { status: 500, value: { error: 'session not created', message: 'no chrome binary' } }; // boot half-fails
    return { value: null };
  });
  await assert.rejects(
    () => openBrowser({ docker: asAny(docker), fetchFn: asAny(fetchFn) }),
    /POST \/session failed \(HTTP 500 session not created\)/
  );
  // the container was still reaped (pull, run, then rm -f) so a failed boot leaks nothing
  assert.deepEqual(docker.calls[docker.calls.length - 1].slice(0, 2), ['rm', '-f']);
});

test('browserdrive: mintDriveAttempt returns a minted TOOL attempt with the right data shape', () => {
  const steps = [{ op: 'navigate', url: 'http://host.docker.internal:5678/webhook/abc/n8n-form' }];
  const r = mintDriveAttempt({ frontDoorUrl: 'http://localhost:5678/webhook/abc/n8n-form', steps, observed: 'recorded', identity: 'anon' });
  assert.equal(r.provenance, 'tool'); // the app's own surface — TOOL, never harness (ground truth is the store tap)
  assert.equal(r.kind, 'attempt');
  assert.equal(r.id, 'browser-drive'); // default id
  assert.equal(r.identity, 'anon');
  assert.deepEqual(r.data, {
    request: 'browser-drive http://localhost:5678/webhook/abc/n8n-form',
    frontDoorUrl: 'http://localhost:5678/webhook/abc/n8n-form',
    steps,
    observed: 'recorded',
  });
  assert.ok(typeof r.sha256 === 'string' && /** @type {string} */ (r.sha256).length === 64); // content-addressed
  assert.ok(isMinted(r)); // carries the unforgeable brand
});

test('browserdrive: mintDriveAttempt honors an explicit id and merges extra; a fabricated look-alike is NOT minted', () => {
  const r = mintDriveAttempt({ id: 'walk', frontDoorUrl: 'http://x/', steps: [], identity: 'owner', extra: { workflowId: 'wf1' } });
  assert.equal(r.id, 'walk');
  assert.equal(r.data.workflowId, 'wf1');
  assert.equal('observed' in r.data, false); // omitted when not provided
  const fake = { id: 'walk', kind: 'attempt', provenance: 'tool', identity: 'owner', data: { request: 'browser-drive http://x/', frontDoorUrl: 'http://x/', steps: [] } };
  assert.equal(isMinted(fake), false); // labeling can't forge the brand
});
