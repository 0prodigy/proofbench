// @ts-check
/**
 * Org-config contract tests — the pb-org-v1 loader/validator (docs/pb-extensibility-foundation.md
 * v2 §8-M1). The schema must express BOTH shapes M1 golden-gates on: the Lyric k8s-attach enterprise
 * instance (k8s-attach + argocd + ci_attested + k8s-exec) AND the native single-service local shape
 * (local-docker + from_tree + sqlite). Unknown provider types and smuggled shell metacharacters fail
 * LOUDLY (never a half-load); a missing tap loads but records the CND-ceiling warning. And the
 * single-repo spine (recipe.mjs loading the n8n golden) stays byte-identical — imported and asserted
 * here so a regression surfaces in this suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadOrgConfig } from '../src/orgconfig.mjs';
import { loadRecipe } from '../src/recipe.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const N8N_RECIPE = join(ROOT, 'recipes', 'n8n-form-trigger-pr7130');

/** The Lyric k8s-attach enterprise shape (§6) — attach + argocd gate + ci_attested + k8s-exec tap. */
function lyricOrgConfig() {
  return {
    kind: 'pb-org-v1',
    name: 'lyric-notprod',
    acquire: {
      type: 'k8s-attach',
      namespace: 'lyric-sandbox',
      release_label: 'app.kubernetes.io/instance=studio-dev12345',
      front_door: 'https://studio.dev12345.lyric.tech',
      wake: ['mic', 'byoc', 'power', 'start'],
    },
    readiness: { type: 'argocd', app: 'studio-dev' },
    identity: { type: 'ci_attested', buildrecord: { resolver: 'registry-referrer' } },
    tap: { engine: 'k8s-exec', exec: ['kubectl', 'exec', 'mongodb-0', '-c', 'mongod', '--', 'mongosh'] },
  };
}

/** The native single-service local shape — local-docker + from_tree + sqlite (the zero-integration default). */
function localOrgConfig() {
  return {
    kind: 'pb-org-v1',
    name: 'local-oss',
    acquire: { type: 'local-docker' },
    identity: { type: 'from_tree' },
    tap: { engine: 'sqlite', db_path: '/data/database.sqlite' },
  };
}

/** @param {any} obj @returns {string} temp org dir holding pb-org.json */
function writeOrgDir(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-org-'));
  writeFileSync(join(dir, 'pb-org.json'), JSON.stringify(obj));
  return dir;
}

test('orgconfig: the Lyric k8s-attach org config validates and its per-phase providers resolve', () => {
  const dir = writeOrgDir(lyricOrgConfig());
  try {
    const { config, warnings } = loadOrgConfig(dir);
    assert.equal(config.kind, 'pb-org-v1');
    assert.equal(config.acquire.type, 'k8s-attach');
    assert.equal(/** @type {any} */ (config.acquire).namespace, 'lyric-sandbox');
    assert.equal(config.readiness?.type, 'argocd');
    assert.equal(config.identity.type, 'ci_attested');
    assert.equal(/** @type {any} */ (config.identity).buildrecord.resolver, 'registry-referrer');
    assert.equal(config.tap?.engine, 'k8s-exec');
    assert.deepEqual(warnings, []); // a declared tap → no CND-ceiling warning
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orgconfig: the minimal single-service local org config validates (local-docker + from_tree + sqlite)', () => {
  const dir = writeOrgDir(localOrgConfig());
  try {
    const { config, warnings } = loadOrgConfig(dir);
    assert.equal(config.acquire.type, 'local-docker');
    assert.equal(config.identity.type, 'from_tree');
    assert.equal(config.tap?.engine, 'sqlite');
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orgconfig: an unknown provider type is REJECTED per phase (no org-shipped/plugin providers in v1)', () => {
  /** @type {Array<{label:string, mutate:(o:any)=>void, match:RegExp}>} */
  const cases = [
    { label: 'unknown acquire type', mutate: (o) => (o.acquire = { type: 'terraform' }), match: /acquire\.type/ },
    { label: 'unknown readiness type', mutate: (o) => (o.readiness = { type: 'nagios' }), match: /readiness\.type/ },
    { label: 'unknown identity type', mutate: (o) => (o.identity = { type: 'trust-me' }), match: /identity\.type/ },
    { label: 'unknown tap engine', mutate: (o) => (o.tap = { engine: 'mysql' }), match: /tap\.engine/ },
    { label: 'unknown buildrecord resolver', mutate: (o) => (o.identity = { type: 'ci_attested', buildrecord: { resolver: 'psychic' } }), match: /buildrecord\.resolver/ },
  ];
  for (const { label, mutate, match } of cases) {
    const o = lyricOrgConfig();
    mutate(o);
    const dir = writeOrgDir(o);
    try {
      assert.throws(() => loadOrgConfig(dir), match, label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('orgconfig: shell metacharacters in an exec/param field are REJECTED (array-argv discipline, P6)', () => {
  /** @type {Array<{label:string, mutate:(o:any)=>void, match:RegExp}>} */
  const cases = [
    { label: 'exec argv element with a metachar', mutate: (o) => (o.tap.exec = ['kubectl', 'exec', 'pod;rm -rf /']), match: /tap\.exec\[2\]|metacharacters/ },
    { label: 'exec passed as a shell string (not argv)', mutate: (o) => (o.tap.exec = 'kubectl exec mongodb-0 -- mongosh'), match: /tap\.exec/ },
    { label: 'identifier param with a metachar', mutate: (o) => (o.acquire.namespace = 'ns$(whoami)'), match: /acquire\.namespace/ },
    { label: 'wake argv element with a metachar', mutate: (o) => (o.acquire.wake = ['mic', 'byoc && curl evil']), match: /acquire\.wake/ },
  ];
  for (const { label, mutate, match } of cases) {
    const o = lyricOrgConfig();
    mutate(o);
    const dir = writeOrgDir(o);
    try {
      assert.throws(() => loadOrgConfig(dir), match, label);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('orgconfig: a missing tap loads but records the CND-ceiling warning', () => {
  const o = /** @type {any} */ (localOrgConfig());
  delete o.tap;
  const dir = writeOrgDir(o);
  try {
    const { config, warnings } = loadOrgConfig(dir);
    assert.equal(config.tap, undefined); // valid — never a hard failure
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /CND/); // effect claims can never exceed CND without an out-of-band tap
    assert.match(warnings[0], /tap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orgconfig: SINGLE-REPO UNTOUCHED — loadRecipe still loads the n8n golden unchanged', () => {
  const r = loadRecipe(N8N_RECIPE);
  assert.equal(r.kind, 'pb-recipe-v1');
  assert.equal(r.code_identity.mode, 'from_tree'); // tier 1, byte-identical spine
  assert.equal(
    /** @type {import('../src/recipe.mjs').FromTreeIdentity} */ (r.code_identity).sha,
    '3ddc176dfa2d3d99a328a29a3a8613e35ff456a0'
  );
  assert.equal(r.drive.mode, 'http');
});
