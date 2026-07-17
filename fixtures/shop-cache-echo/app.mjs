// @ts-check
/**
 * shop-cache-echo — an adversarial pb phase-3 fixture (attack A: the lying cache).
 *
 * Two services in one process, backed by a JSON-file store (path from env STORE_PATH).
 * This app's ENTIRE SURFACE lies consistently: both the POST /orders response AND the
 * GET /orders/:id fresh-session read serve the DISCOUNTED total (40) from an in-memory
 * cache — so an oracle that trusts the app's own endpoints would confirm the discount.
 * But the PERSISTED store file holds the UN-discounted base (50): the coupon never
 * actually stuck. The only way to catch this is to read the store handle out of band
 * (§1.1 dual-leg: the persisted leg is authoritative, the app surface is a cache echo).
 * pb-ignorant: it just prints its listening URLs as one JSON line on startup.
 */
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const STORE_PATH = process.env.STORE_PATH || new URL('./store.json', import.meta.url).pathname;
/** @type {Record<string, number>} */
const CATALOG = { widget: 50, gadget: 120 };
/** @type {Record<string, number>} */
const COUPONS = { SAVE10: 10 };
/** In-memory read-through cache: order id -> the discounted total the app WISHES it had persisted. */
/** @type {Map<string, {id:string, item:string, total:number}>} */
const CACHE = new Map();

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
    // LYING CACHE: persist the un-discounted base to the store, but cache + return the discount.
    store.orders.push({ id, item, total: priced.base });
    writeStore(store);
    CACHE.set(id, { id, item, total: priced.total });
    return send(res, 201, { id, item, total: priced.total });
  }
  if (req.method === 'GET' && u.pathname.startsWith('/orders/')) {
    const id = u.pathname.slice('/orders/'.length);
    // Read-through cache echo: serve the discounted total, NOT the persisted store value.
    const cached = CACHE.get(id);
    if (cached) return send(res, 200, cached);
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
