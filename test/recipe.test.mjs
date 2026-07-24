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
import { loadRecipe, resolveObservable } from '../src/recipe.mjs';

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

/**
 * Small helper for the tests that index/iterate `setup` (SetupStep[]).
 * @param {import('../src/recipe.mjs').Recipe} r
 * @returns {import('../src/recipe.mjs').SetupStep[]}
 */
function asSteps(r) {
  return /** @type {import('../src/recipe.mjs').SetupStep[]} */ (r.setup);
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
  // §6 generic effect binding: the recipe declares its observable relation explicitly, preserving
  // the exact entity string the pre-existing confirm leg bound to.
  assert.equal(resolveObservable(r.store_tap, 'executions').entity, 'execution_entity.max_id');
  assert.equal(resolveObservable(r.store_tap, 'executions').relation, 'max-id');
  // §6 generic confirm leg: a recipe-declared fresh-session re-observation (same schema as setup)
  assert.ok(r.confirm);
  assert.equal(r.confirm.length, 2);
  assert.equal(r.confirm[1].capture?.observed, '$.data.id');
  // front door is a template carrying a minted id
  assert.match(/** @type {string} */ (r.front_door.url_template), /\{[^}]+\}/);
  // every referenced body_file resolves on disk
  for (const step of asSteps(r)) {
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

test('recipe: the documenso Envelope Fields recipe validates (compose mode + postgres tap + browser drive, the discriminating multiselect differential)', () => {
  const r = loadRecipe(DOCUMENSO_RECIPE);
  // compose-mode conjure: the multi-service class, the repo's own testing compose + mem overlays
  assert.equal(r.conjure.mode, 'compose');
  assert.equal(r.conjure.compose_file, 'docker/testing/compose.yml');
  assert.equal(r.conjure.service, 'documenso');
  const overlays = r.conjure.compose_overlays || [];
  assert.ok(overlays.length >= 1, 'compose_overlays present');
  for (const f of overlays) assert.ok(existsSync(join(DOCUMENSO_RECIPE, f)), `overlay ${f} exists on disk`);
  // postgres store tap: a SEPARATE DB container, the PR-mutated "Field" table (double-quoted),
  // switched to a row LISTING (row-count) so the claim can bind an exact 'equals 1', with a
  // settle spec riding out the editor's autosave debounce.
  assert.equal(r.store_tap.engine, 'postgres');
  const pg = /** @type {import('../src/recipe.mjs').PostgresStoreTap} */ (r.store_tap);
  assert.equal(pg.container, 'documenso-test-database-1');
  assert.equal(pg.user, 'documenso');
  assert.equal(pg.db, 'documenso');
  assert.match(pg.queries.fields, /"Field"/); // PascalCase identifier stays double-quoted (no @@map)
  assert.equal(pg.busy_timeout_ms, undefined); // postgres is MVCC → no busy-timeout
  assert.equal(resolveObservable(pg, 'fields').relation, 'row-count');
  assert.equal(pg.settle?.quiet_ms, 3000);
  assert.equal(pg.settle?.max_ms, 30000);
  // honest code-identity: from_tree bound to the exact merge SHA + its disclosed differential parent
  assert.equal(r.code_identity.mode, 'from_tree');
  const ci = /** @type {import('../src/recipe.mjs').FromTreeIdentity} */ (r.code_identity);
  assert.equal(ci.sha, '97835b8dbb2ca24670c8a410972d949c982c8f61');
  assert.equal(ci.parent_sha, '977d07330b97ce451fb834447807b9d4163fc6bd');
  // drive is now the real browser Catch (Konva canvas capability proven live, R1 second engine)
  assert.equal(r.drive.mode, 'browser');
  // front door lands on the addFields step, both minted ids resolved
  assert.match(/** @type {string} */ (r.front_door.url_template), /\{team_url\}.*\{envelope_id\}/);
  // setup: signup -> an exec-capture team lookup (no REST route exists for it at this SHA) ->
  // inbucket capture -> verify-email -> a REAL multipart envelope-create call
  const docSetup = asSteps(r);
  assert.equal(docSetup.length, 6);
  assert.equal(docSetup[1].exec?.engine, 'postgres');
  assert.deepEqual(docSetup[1].capture, { team_id: 0, team_url: 1 });
  const createStep = docSetup[5];
  assert.equal(createStep.content_type, 'multipart');
  assert.equal(createStep.headers?.['x-team-id'], '{team_id}');
  assert.ok(existsSync(join(DOCUMENSO_RECIPE, createStep.files?.[0].path || '')), 'the multipart file asset exists on disk');
  // confirm: a genuinely fresh login re-reads the SAME envelope (captured at setup) via x-team-id
  assert.ok(r.confirm);
  assert.equal(r.confirm.length, 3);
  assert.equal(r.confirm[2].capture?.observed, '$.fields.length');
  assert.equal(r.confirm[2].headers?.['x-team-id'], '{team_id}');
  // the intent carries no universal quantifier (stays off rule 5) and names the discriminating claim
  assert.doesNotMatch(r.intent || '', /\b(any|all|every|each|whole)\b/i);
  assert.match(r.intent || '', /exactly one field row/);
});

test('recipe: a setup step may combine headers/origin/multipart+files, an exec-capture step validates its own shape, and store_tap.settle loads', () => {
  {
    const o = /** @type {any} */ (validRecipe());
    o.store_tap = { engine: 'postgres', container: 'c', user: 'u', db: 'd', queries: { q: 'SELECT 1;' }, settle: { quiet_ms: 2000, max_ms: 15000 } };
    o.setup = [
      { id: 'lookup-team', exec: { engine: 'postgres', container: 'c', user: 'u', db: 'd', query: "SELECT id, url FROM \"Team\" WHERE 1=1;" }, capture: { team_id: 0, team_url: 1 } },
      {
        id: 'create-envelope',
        method: 'POST',
        path: '/api/v2/envelope/create',
        content_type: 'multipart',
        headers: { 'x-team-id': '{team_id}' },
        origin: 'http://localhost:3000',
        body: { payload: '{"title":"x"}' },
        files: [{ field: 'files', path: 'blank.pdf', content_type: 'application/pdf' }],
        capture: { envelope_id: '$.id' },
      },
    ];
    const rdir = writeRecipeDir(o);
    // writeRecipeDir made ITS OWN tmpdir; blank.pdf must live there, not in `dir`.
    writeFileSync(join(rdir, 'blank.pdf'), '%PDF-1.4 fake');
    try {
      const r = loadRecipe(rdir);
      const steps = asSteps(r);
      assert.equal(steps[0].exec?.engine, 'postgres');
      assert.deepEqual(steps[0].capture, { team_id: 0, team_url: 1 });
      assert.equal(steps[1].headers?.['x-team-id'], '{team_id}');
      assert.equal(steps[1].origin, 'http://localhost:3000');
      assert.equal(steps[1].files?.[0].field, 'files');
      assert.equal(/** @type {any} */ (r.store_tap).settle.quiet_ms, 2000);
    } finally {
      rmSync(rdir, { recursive: true, force: true });
    }
  }
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
  for (const mode of ['http', 'browser', 'deferred']) {
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
    assert.equal(asSteps(r)[0].content_type, 'form');
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
    const capture = asSteps(r)[0].capture;
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

test('recipe: store_tap.observables — absent per-query falls back to an engine-honest default (§6)', () => {
  // sqlite: max-id over 'id' (n8n's autoincrement shape, unchanged when the recipe declares nothing).
  const sqlite = /** @type {import('../src/recipe.mjs').SqliteStoreTap} */ (/** @type {any} */ ({ engine: 'sqlite', queries: { q: 'SELECT id FROM t;' } }));
  assert.deepEqual(resolveObservable(sqlite, 'q'), { entity: 'q.max-id', relation: 'max-id', field: undefined, column: undefined });
  // postgres: named-scalar over column 0 (documenso's `SELECT count(*) AS n` shape).
  const postgres = /** @type {import('../src/recipe.mjs').PostgresStoreTap} */ (/** @type {any} */ ({ engine: 'postgres', queries: { fields: 'SELECT count(*) AS n FROM "Field";' } }));
  assert.deepEqual(resolveObservable(postgres, 'fields'), { entity: 'fields.named-scalar', relation: 'named-scalar', field: undefined, column: undefined });
});

test('recipe: store_tap.observables — an explicit per-query override wins over the engine default', () => {
  const o = /** @type {any} */ (validRecipe());
  o.store_tap = {
    engine: 'sqlite',
    db_path: '/db.sqlite',
    busy_timeout_ms: 3000,
    queries: { q: 'SELECT id FROM t;' },
    observables: { q: { entity: 'thing.count', relation: 'row-count' } },
  };
  const dir = writeRecipeDir(o);
  try {
    const r = loadRecipe(dir);
    assert.deepEqual(resolveObservable(r.store_tap, 'q'), { entity: 'thing.count', relation: 'row-count', field: undefined, column: undefined });
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
    { label: 'empty intent', mutate: (o) => (o.intent = '   '), match: /intent/ },
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
    { label: 'observables key not a declared query', mutate: (o) => (o.store_tap.observables = { bogus: { relation: 'row-count' } }), match: /store_tap\.observables\.bogus/ },
    { label: 'observables bogus relation', mutate: (o) => (o.store_tap.observables = { q: { relation: 'sum' } }), match: /store_tap\.observables\.q\.relation/ },
    { label: 'observables non-number column', mutate: (o) => (o.store_tap.observables = { q: { column: 'zero' } }), match: /store_tap\.observables\.q\.column/ },
    { label: 'bogus drive.mode', mutate: (o) => (o.drive = { mode: 'telepathy' }), match: /drive\.mode/ },
    { label: 'setup step bogus header value', mutate: (o) => (o.setup = [{ id: 's', method: 'POST', path: '/x', headers: { 'x-team-id': 7 } }]), match: /headers\.x-team-id/ },
    { label: 'setup step bogus origin', mutate: (o) => (o.setup = [{ id: 's', method: 'GET', path: '/x', origin: 'not-a-url' }]), match: /origin/ },
    { label: 'setup step files without multipart content_type', mutate: (o) => (o.setup = [{ id: 's', method: 'POST', path: '/x', files: [{ field: 'files', path: 'blank.pdf' }] }]), match: /content_type.*multipart/ },
    { label: 'setup step files entry missing on disk', mutate: (o) => (o.setup = [{ id: 's', method: 'POST', path: '/x', content_type: 'multipart', files: [{ field: 'files', path: 'nope.pdf' }] }]), match: /missing file/ },
    { label: 'exec step combined with method', mutate: (o) => (o.setup = [{ id: 's', method: 'GET', exec: { engine: 'postgres', container: 'c', user: 'u', db: 'd', query: 'SELECT 1;' } }]), match: /must not combine exec with method/ },
    { label: 'exec step bogus engine', mutate: (o) => (o.setup = [{ id: 's', exec: { engine: 'mysql', container: 'c', user: 'u', db: 'd', query: 'SELECT 1;' } }]), match: /exec\.engine/ },
    { label: 'exec step missing query', mutate: (o) => (o.setup = [{ id: 's', exec: { engine: 'postgres', container: 'c', user: 'u', db: 'd' } }]), match: /exec\.query/ },
    { label: 'exec step capture non-integer column', mutate: (o) => (o.setup = [{ id: 's', exec: { engine: 'postgres', container: 'c', user: 'u', db: 'd', query: 'SELECT 1;' }, capture: { x: 'zero' } }]), match: /non-negative integer column/ },
    { label: 'store_tap.settle missing max_ms', mutate: (o) => (o.store_tap.settle = { quiet_ms: 100 }), match: /store_tap\.settle\.max_ms/ },
    { label: 'front_door bogus mode', mutate: (o) => (o.front_door = { mode: 'carrier-pigeon' }), match: /front_door\.mode/ },
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
