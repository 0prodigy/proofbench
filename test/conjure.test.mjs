// @ts-check
/**
 * Conjure pure-helper tests — DOCKER-FREE. The docker-touching bring-up is proven by the
 * `pb conjure` CLI integration probe, not here. These cover the load-bearing pure
 * transforms: the build_overlay injection, front-door placeholder resolution, and the
 * capture JSONPath reader.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
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
} from '../src/conjure.mjs';

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
