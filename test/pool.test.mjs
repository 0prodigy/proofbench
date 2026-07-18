// @ts-check
/**
 * Recipe POOL tests — the anti-overfit mechanism (pb must NOT always test n8n). DOCKER-FREE:
 * listRecipes only reads recipe.json off disk (via loadRecipe) and pickRandom is pure. The
 * docker-touching random bring-up is proven by the `pb conjure --random` CLI probe, not here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { listRecipes, pickRandom } from '../src/pool.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RECIPES = join(ROOT, 'recipes');

/** A minimal, valid pb-recipe-v1 object (for the synthetic-pool test). */
const VALID_RECIPE = {
  kind: 'pb-recipe-v1',
  name: 'temp pool recipe',
  code_identity: { mode: 'pinned_image', image_ref: 'example:1', image_digest: 'sha256:abc' },
  conjure: { env: {}, container_port: 8080, published_port: 8080, ready_signal: { path: '/healthz', expect_status: 200 } },
  fresh_world: { strategy: 'recreate' },
  front_door: { url_template: '/f/{id}' },
  store_tap: { engine: 'sqlite', db_path: '/db.sqlite', busy_timeout_ms: 3000, queries: { q: 'SELECT 1;' } },
};

test('pool: listRecipes finds both shipped recipes (>=2, names present, sorted by dir)', () => {
  const found = listRecipes(RECIPES);
  assert.ok(found.length >= 2, `expected >=2 loadable recipes, got ${found.length}`);
  const byDir = new Map(found.map((r) => [basename(r.dir), r]));
  // both shipped recipe dirs are pool-eligible…
  assert.ok(byDir.has('n8n-form-trigger-pr7130'), 'n8n recipe dir present');
  assert.ok(byDir.has('documenso-envelope-fields-pr3031'), 'documenso recipe dir present');
  // …and each carries its declared name (loadRecipe resolved it)
  assert.equal(byDir.get('n8n-form-trigger-pr7130')?.name, 'n8n Form Trigger (PR #7130)');
  assert.equal(byDir.get('documenso-envelope-fields-pr3031')?.name, 'documenso Envelope Fields (PR #3031)');
  // deterministic ordering: sorted by dir
  const dirs = found.map((r) => r.dir);
  assert.deepEqual(dirs, [...dirs].sort());
});

test('pool: listRecipes skips a non-recipe dir and a malformed recipe, ignoring stray files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-pool-'));
  try {
    // a loadable recipe…
    mkdirSync(join(dir, 'good'));
    writeFileSync(join(dir, 'good', 'recipe.json'), JSON.stringify(VALID_RECIPE));
    // …a bare dir with no recipe.json (must be skipped)…
    mkdirSync(join(dir, 'not-a-recipe'));
    writeFileSync(join(dir, 'not-a-recipe', 'notes.txt'), 'not a recipe');
    // …a dir whose recipe.json fails to validate (must be skipped, never break the pool)…
    mkdirSync(join(dir, 'broken'));
    writeFileSync(join(dir, 'broken', 'recipe.json'), '{ not valid json');
    // …and a stray top-level file (not a directory)
    writeFileSync(join(dir, 'stray.txt'), 'ignore me');

    const found = listRecipes(dir);
    assert.equal(found.length, 1, 'only the one loadable recipe is pool-eligible');
    assert.equal(basename(found[0].dir), 'good');
    assert.equal(found[0].name, 'temp pool recipe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pool: listRecipes on a missing dir yields an empty pool (no throw)', () => {
  assert.deepEqual(listRecipes(join(ROOT, 'recipes-does-not-exist')), []);
});

test('pool: pickRandom picks deterministically under an injected rng and throws on an empty pool', () => {
  const items = ['a', 'b', 'c'];
  assert.equal(pickRandom(items, () => 0), 'a'); // rng 0 → first
  assert.equal(pickRandom(items, () => 0.999), 'c'); // rng →1 → last
  assert.throws(() => pickRandom([]), /empty pool/i); // empty array → clear error
});
