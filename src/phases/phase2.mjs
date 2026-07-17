// @ts-check
/**
 * Phase 2 — Environment / Readiness via docker-compose.
 *
 * runPhase2 brings a compose project up (-d), then proves the environment is ALIVE
 * with pb's OWN demonstrated front-door HTTP requests (never trusting compose
 * healthcheck/depends_on, §4), records them as harness receipts, tears the project
 * down (reaped on every path), and calls verdict() — it never decides the tri-state
 * itself:
 *   - the front door served >=2 independent requests (< 500) → reachability CONFIRMED,
 *     k>=2 → WORKS (READY)
 *   - no compose file / docker unavailable / up failed / never served → COULD_NOT_DETERMINE
 * A readiness failure is CND, not DOES_NOT_WORK: an environment that will not come up is
 * not evidence that the feature is broken (§3 nuance 2, pre-walk readiness).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newBundle } from '../evidence.mjs';
import { verdict } from '../verdict.mjs';

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const POLLS = 5;
const POLL_INTERVAL_MS = 1000;
const READY_TARGET = 2;
const PROBE_TIMEOUT_MS = 3000;

/**
 * @typedef {Object} PhaseResult
 * @property {string} phase
 * @property {import('../types.mjs').VerdictResult} verdict
 * @property {string[]} diagnosis runner-computed deterministic notes (never the tri-state itself)
 * @property {import('../types.mjs').EvidenceBundle} bundle
 */

/**
 * @typedef {Object} Docker
 * @property {(args:string[], cwd:string, timeout:number) => import('node:child_process').SpawnSyncReturns<string>} run
 */

/** @returns {Docker|null} */
function detectDocker() {
  const modern = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (!modern.error && modern.status === 0) {
    return { run: (args, cwd, timeout) => spawnSync('docker', ['compose', ...args], { cwd, encoding: 'utf8', timeout }) };
  }
  const legacy = spawnSync('docker-compose', ['version'], { encoding: 'utf8' });
  if (!legacy.error && legacy.status === 0) {
    return { run: (args, cwd, timeout) => spawnSync('docker-compose', args, { cwd, encoding: 'utf8', timeout }) };
  }
  return null;
}

/**
 * Best-effort published-host-port discovery from a compose file (zero-dep, no YAML lib):
 * matches both `"8080:80"` / `127.0.0.1:8080:80` short syntax and `published: 8080` long syntax.
 * @param {string} composeFile
 * @param {number} [port]
 * @returns {string|null}
 */
function deriveUrl(composeFile, port) {
  if (port) return `http://127.0.0.1:${port}/`;
  let text = '';
  try {
    text = readFileSync(composeFile, 'utf8');
  } catch {
    return null;
  }
  const ports = [];
  const shortRe = /["']?(?:\d{1,3}(?:\.\d{1,3}){3}:)?(\d{2,5}):\d{2,5}["']?/g;
  const longRe = /published:\s*["']?(\d{2,5})/g;
  let m;
  while ((m = shortRe.exec(text))) ports.push(Number(m[1]));
  while ((m = longRe.exec(text))) ports.push(Number(m[1]));
  return ports.length ? `http://127.0.0.1:${ports[0]}/` : null;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {string} url @returns {Promise<{served:boolean, status:number|null, error?:string}>} */
async function probe(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return { served: res.status < 500, status: res.status };
  } catch (e) {
    return { served: false, status: null, error: String((e && /** @type {any} */ (e).message) || e) };
  } finally {
    clearTimeout(t);
  }
}

/** @param {string} s @param {number} [n] */
function tail(s, n = 1000) {
  s = s || '';
  return s.length > n ? s.slice(-n) : s;
}

/**
 * @param {import('../types.mjs').EvidenceBundle} bundle
 * @param {string[]} diagnosis
 * @returns {PhaseResult}
 */
function finalize(bundle, diagnosis) {
  return { phase: 'phase2', verdict: verdict(bundle), diagnosis, bundle };
}

/**
 * Run phase 2 against a repo containing a docker-compose file.
 * @param {string} repoDir
 * @param {{url?: string, port?: number}} [opts]
 * @returns {Promise<PhaseResult>}
 */
export async function runPhase2(repoDir, opts = {}) {
  /** @type {string[]} */
  const diagnosis = [];
  const intent = `The docker-compose environment in ${repoDir} comes up and serves its front door.`;
  /** @param {string} msg */
  const cnd = (msg) => {
    diagnosis.push(msg);
    return finalize(newBundle({ intent, actorIdentity: 'pb', claims: [], receipts: [], reproduce: { k: 0, n: 0 } }), diagnosis);
  };

  const composeFile = COMPOSE_FILES.map((f) => join(repoDir, f)).find((p) => existsSync(p));
  if (!composeFile) {
    return cnd(`phase2: no docker-compose file found in ${repoDir} (looked for ${COMPOSE_FILES.join(', ')}).`);
  }
  const docker = detectDocker();
  if (!docker) {
    return cnd('phase2: docker is not available (neither `docker compose` nor `docker-compose` responded).');
  }
  const url = opts.url || deriveUrl(composeFile, opts.port);
  if (!url) {
    return cnd(`phase2: could not derive a front-door URL (no published port in ${composeFile}); pass opts.url or opts.port.`);
  }

  const project = `pb-${Date.now().toString(36)}`;
  let broughtUp = false;
  try {
    const up = docker.run(['-f', composeFile, '-p', project, 'up', '-d'], repoDir, 120000);
    if (up.status !== 0) {
      diagnosis.push(`phase2: \`compose up -d\` failed (exit ${up.status}): ${tail(`${up.stdout || ''}${up.stderr || ''}`)}`);
      return finalize(newBundle({ intent, actorIdentity: 'pb', claims: [], receipts: [], reproduce: { k: 0, n: 0 } }), diagnosis);
    }
    broughtUp = true;

    /** @type {Array<{served:boolean, status:number|null, error?:string}>} */
    const polls = [];
    for (let i = 0; i < POLLS; i++) {
      polls.push(await probe(url));
      if (i < POLLS - 1) await sleep(POLL_INTERVAL_MS);
    }
    const served = polls.filter((p) => p.served);
    const k = served.length;

    if (k >= READY_TARGET) {
      /** @type {import('../types.mjs').Receipt[]} */
      const receipts = [
        { id: 'compose-up', kind: 'attempt', provenance: 'harness', identity: 'pb', data: { cmd: 'compose up -d', project } },
        {
          id: 'front-door-delta',
          kind: 'delta',
          provenance: 'harness',
          identity: 'pb',
          sourcePR: false,
          data: { entity: `front-door ${url}`, before: 'pre-request', after: 'served', status: served[0].status },
        },
        {
          id: 'front-door-fresh',
          kind: 'fresh-session',
          provenance: 'harness',
          identity: 'pb',
          data: { entity: `front-door ${url}`, observed: 'served', status: served[1].status },
        },
      ];
      const claims = [
        {
          id: 'front-door-ready',
          kind: 'effect',
          scope: `front door ${url}`,
          effectCheck: {
            entity: `front-door ${url}`,
            expectedAfterRelation: { op: 'equals', value: 'served' },
            deltaReceiptId: 'front-door-delta',
            confirmLegReceiptId: 'front-door-fresh',
          },
          receiptIds: ['front-door-delta', 'front-door-fresh'],
        },
      ];
      diagnosis.push(`phase2: front door ${url} served ${k}/${POLLS} independent requests (READY).`);
      return finalize(newBundle({ intent, actorIdentity: 'pb', claims, receipts, reproduce: { k, n: POLLS } }), diagnosis);
    }

    // Came up but did not serve enough independent requests => attempted, not confirmed => CND.
    const statuses = polls.map((p) => (p.served ? String(p.status) : p.error || 'no-response')).join(', ');
    /** @type {import('../types.mjs').Receipt[]} */
    const receipts = polls.map((p, idx) => ({
      id: `probe-${idx + 1}`,
      kind: 'attempt',
      provenance: 'harness',
      identity: 'pb',
      data: { entity: `front-door ${url}`, served: p.served, status: p.status, error: p.error },
    }));
    const claims = [
      {
        id: 'front-door-ready',
        kind: 'effect',
        scope: `front door ${url}`,
        effectCheck: {
          entity: `front-door ${url}`,
          expectedAfterRelation: { op: 'equals', value: 'served' },
          deltaReceiptId: 'probe-1',
          confirmLegReceiptId: 'probe-2',
        },
        receiptIds: receipts.map((r) => r.id),
      },
    ];
    diagnosis.push(`phase2: environment came up but the front door ${url} served only ${k}/${POLLS} requests (${statuses}) — not ready.`);
    return finalize(newBundle({ intent, actorIdentity: 'pb', claims, receipts, reproduce: { k, n: POLLS } }), diagnosis);
  } finally {
    if (broughtUp) docker.run(['-f', composeFile, '-p', project, 'down', '-v'], repoDir, 120000);
  }
}
