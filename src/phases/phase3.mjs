// @ts-check
/**
 * Phase 3 — the Catch. HTTP-driven behavioral verification of a conjured fixture app.
 *
 * runPhase3 starts the fixture's two-service HTTP app with a FRESH JSON-file store per
 * reproduction (so pb owns the datastore, §1.1), drives it through the FRONT DOOR with
 * fetch as a user would, and captures — out of band — the write-set-bound STORE delta
 * (read straight from the store handle, never an app endpoint: M3) plus the app's own
 * responses. It PRODUCES harness/tool receipts and calls verdict() — it never decides
 * the tri-state itself:
 *   - the coupon's discount actually PERSISTED (store == the pricing-quoted total), on
 *     both the persisted leg and a fresh-session GET, reproduced k>=2 → WORKS
 *   - the discount was in the response but NOT persisted → effect FALSIFIED → DOES_NOT_WORK
 *   - store handle unreadable / no confirm leg / unrecognized app → NOT_EXECUTED → CND
 * The negative claim (an invalid coupon must not discount) carries an attempted-action
 * receipt (M1). An app with no recognized fixture manifest is an honest CND.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newBundle } from '../evidence.mjs';
import { verdict } from '../verdict.mjs';

const REPRODUCTIONS = 2;
const READY_TIMEOUT_MS = 5000;
const SETTLE_WINDOW_MS = 200; // finality window: how long the persisted leg is watched (§4, FW-5)
const SETTLE_SAMPLE_MS = 15; // spacing between timestamped persisted-leg re-reads

/**
 * @typedef {Object} PhaseResult
 * @property {string} phase
 * @property {import('../types.mjs').VerdictResult} verdict
 * @property {string[]} diagnosis runner-computed deterministic notes (never the tri-state itself)
 * @property {import('../types.mjs').EvidenceBundle} bundle
 */

/**
 * @typedef {Object} Fixture
 * @property {string} kind
 * @property {string} entry
 * @property {string} storeEnv
 * @property {{item:string, coupon:string, invalidCoupon:string}} scenario
 */

/**
 * @param {string} appDir
 * @returns {Fixture|null}
 */
function readFixture(appDir) {
  const p = join(appDir, 'pb-fixture.json');
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    if (!m || m.kind !== 'shop-v1' || !m.entry || !m.storeEnv || !m.scenario) return null;
    return m;
  } catch {
    return null;
  }
}

const enc = encodeURIComponent;

/**
 * @param {string} appDir
 * @param {Fixture} fixture
 * @param {string} storeFile
 * @returns {Promise<{orders:string, pricing:string, stop:() => void}>}
 */
function startApp(appDir, fixture, storeFile) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [fixture.entry], {
      cwd: appDir,
      env: { ...process.env, [fixture.storeEnv]: storeFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    let settled = false;
    const to = setTimeout(() => {
      if (!settled) {
        settled = true;
        stop();
        reject(new Error('fixture app did not become ready in time'));
      }
    }, READY_TIMEOUT_MS);
    if (!child.stdout) {
      clearTimeout(to);
      stop();
      reject(new Error('fixture app produced no stdout'));
      return;
    }
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const line = buf.split('\n').find((l) => l.includes('"ready"'));
      if (line && !settled) {
        try {
          const info = JSON.parse(line);
          if (info.ready) {
            settled = true;
            clearTimeout(to);
            resolve({ orders: info.orders, pricing: info.pricing, stop });
          }
        } catch {
          /* partial line — keep buffering */
        }
      }
    });
    child.on('error', (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(to);
        reject(e);
      }
    });
    child.on('exit', () => {
      if (!settled) {
        settled = true;
        clearTimeout(to);
        reject(new Error('fixture app exited before becoming ready'));
      }
    });
  });
}

/** @param {string} url @returns {Promise<{status:number, body:any}>} */
async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await parseBody(res) };
}
/** @param {string} url @param {any} obj @returns {Promise<{status:number, body:any}>} */
async function postJson(url, obj) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  return { status: res.status, body: await parseBody(res) };
}
/** @param {Response} res */
async function parseBody(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** @param {string} storeFile @returns {{orders: Array<{id:string, item:string, total:number}>}} */
function readStore(storeFile) {
  if (!existsSync(storeFile)) return { orders: [] };
  try {
    return JSON.parse(readFileSync(storeFile, 'utf8'));
  } catch {
    return { orders: [] };
  }
}
/** @param {{orders: Array<{id:string, total:number}>}} store @param {string|undefined} id */
function orderTotal(store, id) {
  const o = (store.orders || []).find((x) => x.id === id);
  return o ? o.total : null;
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Typed, receipted settle policy (§4, FW-5 — never a bare sleep): re-read the persisted leg
 * at spaced, timestamped points across a stability window and report the SETTLED (final)
 * value plus whether it held. An effect present at read time but rolled back inside the window
 * (a compensating transaction / async saga) is caught here — its settled value is the
 * rolled-back one and `stable` is false — instead of being mistaken for a persisted effect.
 * Sampling stops early the moment a change from the first read is observed.
 * @param {string} storeFile
 * @param {string|undefined} orderId
 * @returns {Promise<{settled:number|null, stable:boolean, samples:Array<{t:number, value:number|null}>}>}
 */
async function settlePersisted(storeFile, orderId) {
  const start = Date.now();
  const first = orderTotal(readStore(storeFile), orderId);
  /** @type {Array<{t:number, value:number|null}>} */
  const samples = [{ t: 0, value: first }];
  let value = first;
  while (Date.now() - start < SETTLE_WINDOW_MS) {
    await sleep(SETTLE_SAMPLE_MS);
    value = orderTotal(readStore(storeFile), orderId);
    samples.push({ t: Date.now() - start, value });
    if (value !== first) break; // change observed — transient; no need to keep sampling
  }
  const stable = samples.every((s) => s.value === first);
  return { settled: value, stable, samples };
}

/**
 * @param {import('../types.mjs').EvidenceBundle} bundle
 * @param {string[]} diagnosis
 * @returns {PhaseResult}
 */
function finalize(bundle, diagnosis) {
  return { phase: 'phase3', verdict: verdict(bundle), diagnosis, bundle };
}

/**
 * Run phase 3 against a fixture app.
 * @param {{appDir?: string, intent?: string}} [opts]
 * @returns {Promise<PhaseResult>}
 */
export async function runPhase3(opts = {}) {
  const appDir = opts.appDir;
  /** @type {string[]} */
  const diagnosis = [];
  const fixture = appDir ? readFixture(appDir) : null;
  const intent =
    opts.intent ||
    (fixture
      ? `A shopper applying coupon ${fixture.scenario.coupon} to ${fixture.scenario.item} persists the discounted total; an invalid coupon does not.`
      : 'Drive the app through the front door and confirm the promised effect persists.');

  if (!fixture || !appDir) {
    diagnosis.push(
      `phase3: conjure/drive is not built for this app (no recognized pb-fixture.json in ${appDir ?? '<none>'}); honest COULD_NOT_DETERMINE.`
    );
    return finalize(
      newBundle({ intent, actorIdentity: 'pb-operator', claims: [], receipts: [], reproduce: { k: 0, n: 0 } }),
      diagnosis
    );
  }

  const { item, coupon, invalidCoupon } = fixture.scenario;

  /** @type {Array<{quoted:any, resp:{status:number, body:any}, before:any, after:any, persisted:number|null, immediatePersisted:number|null, stable:boolean, settle:{settled:number|null, stable:boolean, samples:Array<{t:number, value:number|null}>}, fresh:{status:number, body:any}}>} */
  const iterations = [];
  /** @type {{badResp:{status:number, body:any}, badPersisted:number|null, base:number}|null} */
  let negLeg = null;

  try {
    for (let i = 0; i < REPRODUCTIONS; i++) {
      const storeFile = join(mkdtempSync(join(tmpdir(), 'pb-shop-')), 'store.json');
      let app = null;
      try {
        app = await startApp(appDir, fixture, storeFile);
        // Comparator: quote the price straight from the pricing service (a distinct layer, §1.1).
        const quoted = (await getJson(`${app.pricing}/price?item=${enc(item)}&coupon=${enc(coupon)}`)).body;
        // User action through the orders front door, bracketed by store-handle snapshots.
        const before = readStore(storeFile);
        const resp = await postJson(`${app.orders}/orders`, { item, coupon });
        const after = readStore(storeFile);
        const immediatePersisted = orderTotal(after, resp.body && resp.body.id);
        // Dual-leg confirmation: a fresh-session GET re-reads the persisted order.
        const fresh = await getJson(`${app.orders}/orders/${enc(resp.body && resp.body.id)}`);
        // Settle policy (§4, FW-5): re-read the persisted leg across a stability window so a
        // transient effect that rolls back after the response cannot pass as persisted.
        const settle = await settlePersisted(storeFile, resp.body && resp.body.id);
        const persisted = settle.settled;
        iterations.push({ quoted, resp, before, after, persisted, immediatePersisted, stable: settle.stable, settle, fresh });
        // Negative leg once (M1): an invalid coupon must not persist a discount.
        if (i === 0) {
          const badResp = await postJson(`${app.orders}/orders`, { item, coupon: invalidCoupon });
          const badPersisted = orderTotal(readStore(storeFile), badResp.body && badResp.body.id);
          negLeg = { badResp, badPersisted, base: quoted.base };
        }
      } finally {
        if (app) app.stop();
      }
    }
  } catch (e) {
    diagnosis.push(`phase3: could not conjure/drive the fixture app: ${String((e && /** @type {any} */ (e).message) || e)}.`);
    return finalize(
      newBundle({ intent, actorIdentity: 'pb-operator', claims: [], receipts: [], reproduce: { k: 0, n: 0 } }),
      diagnosis
    );
  }

  const it0 = iterations[0];
  const discounted = it0.quoted.total; // pricing-quoted comparator value
  const base = it0.quoted.base;
  const reported = it0.resp.body && it0.resp.body.total; // what the orders response CLAIMED
  const persisted = it0.persisted; // ground truth read from the store handle
  const freshObserved = it0.fresh.body && it0.fresh.body.total;
  const orderId = it0.resp.body && it0.resp.body.id;

  // reproduce.k: fresh-world iterations where the discount actually persisted AND held stable
  // across the settle window (a transient/rolled-back effect does not count, FW-5).
  const k = iterations.filter((it) => it.stable && it.persisted === it.quoted.total).length;

  /** @type {import('../types.mjs').Receipt[]} */
  const receipts = [
    {
      id: 'pricing-comparator',
      kind: 'comparator',
      provenance: 'tool',
      identity: 'shopper',
      data: { layer: 'pricing-service', item, coupon, base, discounted },
    },
    {
      id: 'orders-response',
      kind: 'attempt',
      provenance: 'tool',
      identity: 'shopper',
      data: { request: `POST /orders {item:${item}, coupon:${coupon}}`, orderId, reportedTotal: reported, status: it0.resp.status },
    },
    {
      id: 'store-delta',
      kind: 'delta',
      provenance: 'harness',
      identity: 'shopper',
      sourcePR: false,
      data: {
        entity: 'orders-store.order.total',
        orderId,
        before: null,
        after: persisted,
        quoted: discounted,
        base,
        stable: it0.stable,
        settleWindowMs: SETTLE_WINDOW_MS,
        immediatePersisted: it0.immediatePersisted,
        settleSamples: it0.settle.samples,
        ordersBefore: (it0.before.orders || []).length,
        ordersAfter: (it0.after.orders || []).length,
      },
    },
    {
      id: 'fresh-get',
      kind: 'fresh-session',
      provenance: 'tool',
      identity: 'shopper',
      data: { entity: 'order.total', orderId, observed: freshObserved },
    },
  ];
  /** @type {import('../types.mjs').Claim[]} */
  const claims = [
    {
      id: 'coupon-persists',
      kind: 'effect',
      scope: `shopper applies coupon ${coupon}`,
      effectCheck: {
        entity: 'order.total',
        expectedAfterRelation: { op: 'equals', value: discounted },
        deltaReceiptId: 'store-delta',
        confirmLegReceiptId: 'fresh-get',
      },
      receiptIds: ['store-delta', 'fresh-get', 'orders-response', 'pricing-comparator'],
    },
  ];

  if (negLeg) {
    const observedDiscount = negLeg.base - (negLeg.badPersisted ?? negLeg.base);
    receipts.push({
      id: 'neg-attempt',
      kind: 'attempt',
      provenance: 'tool',
      identity: 'shopper',
      data: {
        request: `POST /orders {item:${item}, coupon:${invalidCoupon}}`,
        orderId: negLeg.badResp.body && negLeg.badResp.body.id,
        reportedTotal: negLeg.badResp.body && negLeg.badResp.body.total,
        status: negLeg.badResp.status,
      },
    });
    receipts.push({
      id: 'neg-delta',
      kind: 'delta',
      provenance: 'harness',
      identity: 'shopper',
      sourcePR: false,
      data: { entity: 'order.discount', before: 0, after: 0, nullDelta: observedDiscount === 0, observedDiscount },
    });
    claims.push({
      id: 'invalid-coupon-no-discount',
      kind: 'negative',
      scope: `invalid coupon ${invalidCoupon}`,
      receiptIds: ['neg-attempt', 'neg-delta'],
    });
  }

  // Deterministic diagnosis (renderer-computed anomalies, §4) — never the verdict itself.
  if (!it0.stable) {
    diagnosis.push(
      `phase3: transient effect — order.total was ${it0.immediatePersisted} at read time but settled to ${persisted} within the ${SETTLE_WINDOW_MS}ms settle window; the discount rolled back and did not persist (FW-5).`
    );
  }
  if (reported !== persisted) {
    diagnosis.push(
      `phase3: response-vs-store mismatch — the orders service response reported total=${reported} but the persisted store shows total=${persisted}; the coupon was reflected in the response, never persisted.`
    );
  }
  if (persisted !== discounted) {
    diagnosis.push(
      `phase3: persisted total=${persisted} != pricing-quoted discounted total=${discounted} for coupon ${coupon} (base ${base}).`
    );
  }
  if (reported === persisted && persisted === discounted && it0.stable) {
    diagnosis.push(
      `phase3: coupon ${coupon} persisted correctly (store=${persisted}=quoted), confirmed on a fresh session and stable across the ${SETTLE_WINDOW_MS}ms settle window; reproduced k=${k}/${REPRODUCTIONS}.`
    );
  }

  return finalize(newBundle({ intent, actorIdentity: 'pb-operator', claims, receipts, reproduce: { k, n: REPRODUCTIONS } }), diagnosis);
}
