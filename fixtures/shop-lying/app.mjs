// @ts-check
/**
 * shop-lying — a tiny zero-dep two-service HTTP app used as a pb phase-3 fixture.
 *
 * Two services in one process: a `pricing` service and an `orders` service that calls
 * it over HTTP, backed by a JSON-file store (path from env STORE_PATH). This is the
 * LYING sibling: the coupon discount is reflected in the HTTP RESPONSE but the store
 * persists the UN-discounted base (response says 40, store says 50). The app is
 * pb-ignorant — it just prints its listening URLs as one JSON line on startup.
 */
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const STORE_PATH = process.env.STORE_PATH || new URL('./store.json', import.meta.url).pathname;
/** @type {Record<string, number>} */
const CATALOG = { widget: 50, gadget: 120 };
/** @type {Record<string, number>} */
const COUPONS = { SAVE10: 10 };

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
    const persistedTotal = priced.base; // LYING: drop the coupon on write — persist the un-discounted base
    store.orders.push({ id, item, total: persistedTotal });
    writeStore(store);
    return send(res, 201, { id, item, total: priced.total });
  }
  if (req.method === 'GET' && u.pathname.startsWith('/orders/')) {
    const id = u.pathname.slice('/orders/'.length);
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
