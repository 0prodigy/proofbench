// @ts-check
/**
 * The anti-overfit RECIPE POOL — the literal "don't always test n8n" mechanism.
 *
 * A single hard-wired recipe would let pb (and its authors) overfit to one SUT's quirks. The
 * pool is the counter: listRecipes discovers every loadable recipe on disk, and pickRandom
 * chooses one per run, so which SUT pb proves against is not baked in. listRecipes reuses the
 * existing loadRecipe as the eligibility test — a subdir counts only if its recipe.json actually
 * loads+validates — and SKIPS any that throw, so one malformed dir never breaks the pool. The
 * full-Catch `verify` command will reuse both of these; wiring them into `pb conjure --random`
 * makes "randomly pick each run" a real runnable thing today.
 *
 * Node built-ins only (readdirSync + the existing loadRecipe) — pb's runtime deps stay at ZERO.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadRecipe } from './recipe.mjs';

/**
 * A pool-eligible recipe: its declared name plus the directory it loads from.
 * @typedef {Object} PoolEntry
 * @property {string} name the recipe's declared name (recipe.name)
 * @property {string} dir the recipe directory (relative to recipesDir's parent, as scanned)
 */

/**
 * Scan recipesDir for immediate subdirectories holding a LOADABLE recipe.json. A subdir whose
 * recipe.json is missing or malformed is skipped (loadRecipe throws → not pool-eligible), so a
 * bad dir never breaks the pool; non-directory entries are ignored. Returns entries sorted by
 * dir for deterministic ordering. A missing/unreadable recipesDir yields an empty pool.
 * @param {string} [recipesDir] directory of recipe subdirs (default 'recipes')
 * @returns {PoolEntry[]}
 */
export function listRecipes(recipesDir = 'recipes') {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(recipesDir, { withFileTypes: true });
  } catch {
    return []; // no recipes dir → an empty pool, honestly (the caller decides what that means)
  }
  /** @type {PoolEntry[]} */
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(recipesDir, e.name);
    try {
      out.push({ name: loadRecipe(dir).name, dir });
    } catch {
      // recipe.json absent or malformed → not pool-eligible; skip so one bad dir never breaks the pool
    }
  }
  return out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/**
 * Pick a random element — the anti-overfit choice (pb must not always test the same recipe).
 * rng is injectable so tests are deterministic; pb RUNTIME may use Math.random (that constraint
 * was only for Workflow scripts). Throws a clear error on an empty array.
 * @template T
 * @param {T[]} items
 * @param {() => number} [rng] returns a float in [0,1); defaults to Math.random
 * @returns {T}
 */
export function pickRandom(items, rng = Math.random) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('pickRandom: cannot pick from an empty pool (no loadable recipes found)');
  }
  const i = Math.floor(rng() * items.length);
  return items[Math.min(Math.max(i, 0), items.length - 1)]; // clamp so an out-of-[0,1) rng still lands in-bounds
}
