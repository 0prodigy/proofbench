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

test('recipe: a malformed recipe fails loudly, each error naming the bad field', () => {
  /** @type {Array<{label:string, mutate:(o:any)=>void, match:RegExp}>} */
  const cases = [
    { label: 'wrong kind', mutate: (o) => (o.kind = 'nope'), match: /kind/ },
    { label: 'empty name', mutate: (o) => (o.name = '   '), match: /name/ },
    { label: 'bogus code_identity.mode', mutate: (o) => (o.code_identity = { mode: 'bogus' }), match: /code_identity\.mode/ },
    { label: 'from_tree missing sha', mutate: (o) => (o.code_identity = { mode: 'from_tree', repo: 'r', dockerfile: 'd', context: '.' }), match: /code_identity\.sha/ },
    { label: 'pinned_image missing digest', mutate: (o) => (o.code_identity = { mode: 'pinned_image', image_ref: 'x:1' }), match: /code_identity\.image_digest/ },
    { label: 'non-recreate fresh_world', mutate: (o) => (o.fresh_world = { strategy: 'reuse' }), match: /fresh_world\.strategy/ },
    { label: 'empty setup', mutate: (o) => (o.setup = []), match: /setup/ },
    { label: 'setup step with both body and body_file', mutate: (o) => (o.setup = [{ id: 's', method: 'POST', path: '/x', body: {}, body_file: 'b.json' }]), match: /both/ },
    { label: 'setup body_file missing on disk', mutate: (o) => (o.setup = [{ id: 's', method: 'POST', path: '/x', body_file: 'nope.json' }]), match: /body_file.*missing|missing.*body_file/ },
    { label: 'front_door url_template without placeholder', mutate: (o) => (o.front_door = { url_template: '/static' }), match: /url_template.*placeholder/ },
    { label: 'missing store_tap', mutate: (o) => delete o.store_tap, match: /store_tap/ },
    { label: 'store_tap with empty queries', mutate: (o) => (o.store_tap.queries = {}), match: /store_tap\.queries/ },
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
