// @ts-check
/**
 * shop-stale-get — an adversarial pb phase-3 fixture (the decorative-fresh-leg attack).
 *
 * Two services in one process, backed by a JSON-file store (path from env STORE_PATH).
 * The coupon discount IS persisted CORRECTLY to the store, and the POST /orders response
 * reports the correct discounted total — so both the persisted leg and the response agree.
 * The lie is only in the fresh-session read: GET /orders/:id serves a STALE value (the
 * un-discounted base) from a read cache instead of the persisted store. If the confirm
 * leg were decorative (trusting any fresh-session receipt), this would pass; content-
 * binding the fresh observation to the persisted delta (§1.1 dual-leg) catches the
 * inconsistency => not WORKS. pb-ignorant: prints its URLs as one JSON line.
 */
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const STORE_PATH = process.env.STORE_PATH || new URL('./store.json', import.meta.url).pathname;
/** @type {Record<string, number>} */
const CATALOG = { widget: 50, gadget: 120 };
/** @type {Record<string, number>} */
const COUPONS = { SAVE10: 10 };
/** Read cache serving a STALE (un-discounted) total: order id -> the base the GET wrongly returns. */
/** @type {Map<string, {id:string, item:string, total:number}>} */
const STALE = new Map();

/** @returns {{orders: Array<{id:string, item:string, total:number}>}} */
function readStore() {
  if (!existsSync(STORE_PATH)) return { orders: [] };
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { orders: [] };
  }
}
/** @param {{orders: Array<{id:string, item:string, total:number}>}} s */
function writeStore(s) {
  writeFileSync(STORE_PATH, JSON.stringify(s, null, 2));
}
/** @param {import('node:http').IncomingMessage} req @returns {Promise<string>} */
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });
}
/** @param {import('node:http').ServerResponse} res @param {number} status @param {any} obj */
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

let pricingBase = '';

const pricing = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && u.pathname === '/price') {
    const item = u.searchParams.get('item') || '';
    const coupon = u.searchParams.get('coupon') || '';
    const base = CATALOG[item];
    if (base == null) return send(res, 404, { error: 'unknown item' });
    const discount = COUPONS[coupon] || 0;
    return send(res, 200, { item, base, discount, total: base - discount });
  }
  return send(res, 404, { error: 'not found' });
});

const orders = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'POST' && u.pathname === '/orders') {
    let parsed;
    try {
      parsed = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return send(res, 400, { error: 'bad json' });
    }
    const { item, coupon } = parsed;
    const priced = await (
      await fetch(`${pricingBase}/price?item=${encodeURIComponent(item)}&coupon=${encodeURIComponent(coupon || '')}`)
    ).json();
    if (priced.error) return send(res, 400, priced);
    const id = 'ord_' + Math.random().toString(36).slice(2, 10);
    const store = readStore();
    // CORRECT: persist the discounted total, and report it in the response.
    store.orders.push({ id, item, total: priced.total });
    writeStore(store);
    // ...but seed a STALE read cache with the un-discounted base for the fresh GET.
    STALE.set(id, { id, item, total: priced.base });
    return send(res, 201, { id, item, total: priced.total });
  }
  if (req.method === 'GET' && u.pathname.startsWith('/orders/')) {
    const id = u.pathname.slice('/orders/'.length);
    // STALE READ: serve the cached base, NOT the persisted (discounted) store value.
    const stale = STALE.get(id);
    if (stale) return send(res, 200, stale);
    const order = readStore().orders.find((o) => o.id === id);
    if (!order) return send(res, 404, { error: 'not found' });
    return send(res, 200, order);
  }
  return send(res, 404, { error: 'not found' });
});

pricing.listen(0, '127.0.0.1', () => {
  pricingBase = `http://127.0.0.1:${(/** @type {any} */ (pricing.address())).port}`;
  orders.listen(0, '127.0.0.1', () => {
    const ordersBase = `http://127.0.0.1:${(/** @type {any} */ (orders.address())).port}`;
    process.stdout.write(
      JSON.stringify({ ready: true, orders: ordersBase, pricing: pricingBase, store: STORE_PATH }) + '\n'
    );
  });
});
