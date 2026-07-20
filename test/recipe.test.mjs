// @ts-check
/**
 * Recipe contract tests — the pb-recipe-v1 loader/validator. The first real recipe
 * (n8n Form Trigger #7130) must load and resolve its load-bearing fields (the honest
 * code-identity SHA, the store tap's query, the on-disk body files); and a malformed
 * recipe must fail LOUDLY, naming the first bad field — never silently half-load.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadRecipe } from '../src/recipe.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const N8N_RECIPE = join(ROOT, 'recipes', 'n8n-form-trigger-pr7130');
const DOCUMENSO_RECIPE = join(ROOT, 'recipes', 'documenso-envelope-fields-pr3031');

/** A minimal, valid pb-recipe-v1 object (fresh each call) to mutate per malformed case. */
function validRecipe() {
  return {
    kind: 'pb-recipe-v1',
    name: 'temp recipe',
    code_identity: { mode: 'pinned_image', image_ref: 'example:1', image_digest: 'sha256:abc' },
    conjure: {
      env: {},
      container_port: 8080,
      published_port: 8080,
      ready_signal: { path: '/healthz', expect_status: 200 },
    },
    fresh_world: { strategy: 'recreate' },
    setup: [{ id: 's1', method: 'POST', path: '/x', body: { a: 1 } }],
    front_door: { url_template: '/f/{id}' },
    store_tap: { engine: 'sqlite', db_path: '/db.sqlite', busy_timeout_ms: 3000, queries: { q: 'SELECT 1;' } },
  };
}

/** @param {any} obj @returns {string} temp recipe dir holding recipe.json */
function writeRecipeDir(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-recipe-'));
  writeFileSync(join(dir, 'recipe.json'), JSON.stringify(obj));
  return dir;
}

test('recipe: the n8n Form Trigger recipe validates and its load-bearing fields resolve', () => {
  const r = loadRecipe(N8N_RECIPE);
  // honest code-identity: from_tree bound to the exact merge SHA
  assert.equal(r.code_identity.mode, 'from_tree');
  assert.equal(
    /** @type {import('../src/recipe.mjs').FromTreeIdentity} */ (r.code_identity).sha,
    '3ddc176dfa2d3d99a328a29a3a8613e35ff456a0'
  );
  // the differential baseline: the merge's SINGLE parent (feature-absent) that the Catch builds via conjure's buildSha override
  assert.equal(
    /** @type {import('../src/recipe.mjs').FromTreeIdentity} */ (r.code_identity).parent_sha,
    '869b8f14caaf334f011bcd87d3928dc8ab41f62e'
  );
  // out-of-band store tap query present
  assert.ok(r.store_tap.queries.executions, 'store_tap.queries.executions present');
  // front door is a template carrying a minted id
  assert.match(r.front_door.url_template, /\{[^}]+\}/);
  // every referenced body_file resolves on disk
  for (const step of r.setup) {
    if (step.body_file) assert.ok(existsSync(join(N8N_RECIPE, step.body_file)), `${step.body_file} exists`);
  }
  // the front-door {webhook_id} is minted from the node's webhookId in workflow.json
  const wf = JSON.parse(readFileSync(join(N8N_RECIPE, 'workflow.json'), 'utf8'));
  assert.ok(wf.nodes[0].webhookId, 'workflow node carries a webhookId (the URL base)');
  // generalized contract: a single-container recipe defaults conjure.mode to 'run', and n8n's
  // front door is the built HTTP drive (not the deferred default)
  assert.equal(r.conjure.mode, 'run');
  assert.equal(r.store_tap.engine, 'sqlite');
  assert.equal(r.drive.mode, 'http');
});

test('recipe: the documenso Envelope Fields recipe validates (compose mode + postgres tap + deferred drive)', () => {
  const r = loadRecipe(DOCUMENSO_RECIPE);
  // compose-mode conjure: the multi-service class, the repo's own testing compose + mem overlays
  assert.equal(r.conjure.mode, 'compose');
  assert.equal(r.conjure.compose_file, 'docker/testing/compose.yml');
  assert.equal(r.conjure.service, 'documenso');
  const overlays = r.conjure.compose_overlays || [];
  assert.ok(overlays.length >= 1, 'compose_overlays present');
  for (const f of overlays) assert.ok(existsSync(join(DOCUMENSO_RECIPE, f)), `overlay ${f} exists on disk`);
  // postgres store tap: a SEPARATE DB container, the PR-mutated "Field" table (double-quoted)
  assert.equal(r.store_tap.engine, 'postgres');
  const pg = /** @type {import('../src/recipe.mjs').PostgresStoreTap} */ (r.store_tap);
  assert.equal(pg.container, 'documenso-test-database-1');
  assert.equal(pg.user, 'documenso');
  assert.equal(pg.db, 'documenso');
  assert.match(pg.queries.fields, /"Field"/); // PascalCase identifier stays double-quoted (no @@map)
  assert.equal(pg.busy_timeout_ms, undefined); // postgres is MVCC → no busy-timeout
  // honest code-identity: from_tree bound to the exact merge SHA
  assert.equal(r.code_identity.mode, 'from_tree');
  assert.equal(
    /** @type {import('../src/recipe.mjs').FromTreeIdentity} */ (r.code_identity).sha,
    '97835b8dbb2ca24670c8a410972d949c982c8f61'
  );
  // drive is honestly deferred (Konva <canvas> front door) → the Catch CNDs for this repo
  assert.equal(r.drive.mode, 'deferred');
  assert.match(r.drive.reason || '', /canvas/i);
  // front door is a URL template carrying a minted id (informational, since drive is deferred)
  assert.match(r.front_door.url_template, /\{[^}]+\}/);
  // documenso self-bootstraps (auto-migrations) → no REST setup dance
  assert.deepEqual(r.setup, []);
});

test('recipe: absent setup and absent drive default honestly (empty setup, deferred drive)', () => {
  const o = /** @type {any} */ (validRecipe());
  delete o.setup; // a SUT that self-bootstraps needs no REST dance
  delete o.drive;
  const dir = writeRecipeDir(o);
  try {
    const r = loadRecipe(dir);
    assert.deepEqual(r.setup, []); // defaulted to empty — never a forced fit
    assert.equal(r.drive.mode, 'deferred'); // absent drive → honest CND, never over-claims
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recipe: every drive mode validates and resolves', () => {
  for (const mode of ['http', 'browser', 'note-lifecycle', 'deferred']) {
    const o = /** @type {any} */ (validRecipe());
    o.drive = { mode };
    const dir = writeRecipeDir(o);
    try {
      assert.equal(loadRecipe(dir).drive.mode, mode);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('recipe: a minimal recipe with all required fields validates', () => {
  const dir = writeRecipeDir(validRecipe());
  try {
    const r = loadRecipe(dir);
    assert.equal(r.kind, 'pb-recipe-v1');
    assert.equal(r.fresh_world.strategy, 'recreate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recipe: code_identity.target (from_tree only) is optional and passes through when present', () => {
  const o = /** @type {any} */ (validRecipe());
  o.code_identity = { mode: 'from_tree', repo: 'r', sha: 's', dockerfile: 'd', context: '.', target: 'builder' };
  const dir = writeRecipeDir(o);
  try {
    const r = loadRecipe(dir);
    assert.equal(/** @type {import('../src/recipe.mjs').FromTreeIdentity} */ (r.code_identity).target, 'builder');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recipe: setup step content_type "form" validates and defaults to unset (json) when absent', () => {
  const o = /** @type {any} */ (validRecipe());
  o.setup = [{ id: 's1', method: 'POST', path: '/x', body: { a: 1 }, content_type: 'form' }];
  const dir = writeRecipeDir(o);
  try {
    const r = loadRecipe(dir);
    assert.equal(r.setup[0].content_type, 'form');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recipe: setup step capture accepts an {from:"html", pattern} regex capture alongside the existing JSONPath string form', () => {
  const o = /** @type {any} */ (validRecipe());
  o.setup = [{
    id: 's1',
    method: 'GET',
    path: '/x',
    capture: { csrf_token: { from: 'html', pattern: 'name="csrfmiddlewaretoken" value="([^"]+)"' }, id: '$.data.id' },
  }];
  const dir = writeRecipeDir(o);
  try {
    const r = loadRecipe(dir);
    const capture = r.setup[0].capture;
    assert.ok(capture);
    assert.deepEqual(capture.csrf_token, { from: 'html', pattern: 'name="csrfmiddlewaretoken" value="([^"]+)"' });
    assert.equal(capture.id, '$.data.id'); // JSONPath capture stays untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recipe: confirm is validated with the exact setup step schema and defaults to empty when absent', () => {
  const withConfirm = /** @type {any} */ (validRecipe());
  withConfirm.confirm = [{ id: 'c1', method: 'GET', path: '/y', content_type: 'form', capture: { tok: { from: 'html', pattern: '(x)' } } }];
  let dir = writeRecipeDir(withConfirm);
  try {
    const r = loadRecipe(dir);
    assert.ok(r.confirm);
    assert.equal(r.confirm.length, 1);
    assert.equal(r.confirm[0].id, 'c1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const withoutConfirm = /** @type {any} */ (validRecipe());
  delete withoutConfirm.confirm;
  dir = writeRecipeDir(withoutConfirm);
  try {
    assert.deepEqual(loadRecipe(dir).confirm, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recipe: front_door.url_template with no {placeholder} validates and is used verbatim (optional per §5)', () => {
  const o = /** @type {any} */ (validRecipe());
  o.front_door = { url_template: '/static/create' };
  const dir = writeRecipeDir(o);
  try {
    const r = loadRecipe(dir);
    assert.equal(r.front_door.url_template, '/static/create');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recipe: a malformed recipe fails loudly, each error naming the bad field', () => {
  /** @type {Array<{label:string, mutate:(o:any)=>void, match:RegExp}>} */
  const cases = [
    { label: 'wrong kind', mutate: (o) => (o.kind = 'nope'), match: /kind/ },
    { label: 'empty name', mutate: (o) => (o.name = '   '), match: /name/ },
    { label: 'bogus code_identity.mode', mutate: (o) => (o.code_identity = { mode: 'bogus' }), match: /code_identity\.mode/ },
    { label: 'from_tree missing sha', mutate: (o) => (o.code_identity = { mode: 'from_tree', repo: 'r', dockerfile: 'd', context: '.' }), match: /code_identity\.sha/ },
    { label: 'from_tree empty parent_sha', mutate: (o) => (o.code_identity = { mode: 'from_tree', repo: 'r', sha: 's', dockerfile: 'd', context: '.', parent_sha: '' }), match: /code_identity\.parent_sha/ },
    { label: 'pinned_image missing digest', mutate: (o) => (o.code_identity = { mode: 'pinned_image', image_ref: 'x:1' }), match: /code_identity\.image_digest/ },
    { label: 'non-recreate fresh_world', mutate: (o) => (o.fresh_world = { strategy: 'reuse' }), match: /fresh_world\.strategy/ },
    { label: 'non-array setup', mutate: (o) => (o.setup = 'nope'), match: /setup/ },
    { label: 'setup step with both body and body_file', mutate: (o) => (o.setup = [{ id: 's', method: 'POST', path: '/x', body: {}, body_file: 'b.json' }]), match: /both/ },
    { label: 'setup body_file missing on disk', mutate: (o) => (o.setup = [{ id: 's', method: 'POST', path: '/x', body_file: 'nope.json' }]), match: /body_file.*missing|missing.*body_file/ },
    { label: 'front_door missing url_template', mutate: (o) => (o.front_door = {}), match: /front_door\.url_template/ },
    { label: 'from_tree empty target', mutate: (o) => (o.code_identity = { mode: 'from_tree', repo: 'r', sha: 's', dockerfile: 'd', context: '.', target: '' }), match: /code_identity\.target/ },
    { label: 'setup step bogus content_type', mutate: (o) => (o.setup = [{ id: 's', method: 'POST', path: '/x', body: { a: 1 }, content_type: 'xml' }]), match: /content_type/ },
    { label: 'html capture missing pattern', mutate: (o) => (o.setup = [{ id: 's', method: 'GET', path: '/x', capture: { csrf: { from: 'html' } } }]), match: /pattern/ },
    { label: 'html capture pattern too long', mutate: (o) => (o.setup = [{ id: 's', method: 'GET', path: '/x', capture: { csrf: { from: 'html', pattern: 'a'.repeat(201) } } }]), match: /200/ },
    { label: 'html capture pattern does not compile', mutate: (o) => (o.setup = [{ id: 's', method: 'GET', path: '/x', capture: { csrf: { from: 'html', pattern: '(unterminated' } } }]), match: /compile/ },
    { label: 'confirm step missing id', mutate: (o) => (o.confirm = [{ method: 'POST', path: '/x' }]), match: /confirm\[0\]\.id/ },
    { label: 'bogus conjure.mode', mutate: (o) => (o.conjure.mode = 'swarm'), match: /conjure\.mode/ },
    { label: 'compose mode missing compose_file', mutate: (o) => (o.conjure.mode = 'compose'), match: /conjure\.compose_file/ },
    { label: 'missing store_tap', mutate: (o) => delete o.store_tap, match: /store_tap/ },
    { label: 'store_tap with empty queries', mutate: (o) => (o.store_tap.queries = {}), match: /store_tap\.queries/ },
    { label: 'bogus store_tap.engine', mutate: (o) => (o.store_tap = { engine: 'mysql', queries: { q: 'SELECT 1;' } }), match: /store_tap\.engine/ },
    { label: 'postgres tap missing container', mutate: (o) => (o.store_tap = { engine: 'postgres', user: 'u', db: 'd', queries: { q: 'SELECT 1;' } }), match: /store_tap\.container/ },
    { label: 'bogus drive.mode', mutate: (o) => (o.drive = { mode: 'telepathy' }), match: /drive\.mode/ },
  ];
  for (const { label, mutate, match } of cases) {
    const o = validRecipe();
    mutate(o);
    const dir = writeRecipeDir(o);
    try {
      assert.throws(() => loadRecipe(dir), match, label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('recipe: a directory with no recipe.json throws naming recipe.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-recipe-'));
  try {
    assert.throws(() => loadRecipe(dir), /recipe\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
