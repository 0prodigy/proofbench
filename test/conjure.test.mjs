// @ts-check
/**
 * Conjure pure-helper tests — DOCKER-FREE. The docker-touching bring-up is proven by the
 * `pb conjure` CLI integration probe, not here. These cover the load-bearing pure
 * transforms: the build_overlay injection, front-door placeholder resolution, and the
 * capture JSONPath reader.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayDockerfile, resolvePlaceholders, extractJsonPath, parseComposeName, overlayPlan, composeArgv } from '../src/conjure.mjs';

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
