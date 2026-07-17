// @ts-check
/**
 * Evidence: content addressing, bundle construction, and the real ed25519 seal.
 *
 * The seal binds a manifest digest over intent + claims + receipts + the derived
 * verdict, and signs it with a real ed25519 key (node:crypto). verifySeal recomputes
 * the digest from the CURRENT bundle and verifies the signature — so ANY post-seal
 * mutation of intent/claims/receipts (or the verdict they derive) flips it to false.
 *
 * Honesty ceiling (docs/phase-3-theory.md threat table): this is tamper-EVIDENT,
 * not tamper-RESISTANT — a box owner who holds the private key can forge at rest.
 * That residual is out of scope for v1 and disclosed, not hidden.
 */

import { createHash, sign, verify, createPublicKey } from 'node:crypto';
import { verdict } from './verdict.mjs';

/** Stable, key-sorted JSON so the manifest digest is order-independent. */
function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/**
 * Content address (sha256 hex) of bytes.
 * @param {string|Buffer|Uint8Array} bytes
 * @returns {string}
 */
export function contentAddress(bytes) {
  const buf =
    typeof bytes === 'string'
      ? Buffer.from(bytes, 'utf8')
      : Buffer.isBuffer(bytes)
        ? bytes
        : ArrayBuffer.isView(bytes)
          ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : Buffer.from(String(bytes), 'utf8');
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build an evidence bundle. Each receipt's sha256 is (re)computed from its data,
 * so a driver cannot hand-fake a content address.
 * @param {{intent?:any, actorIdentity?:string|null, claims?:import('./types.mjs').Claim[], receipts?:import('./types.mjs').Receipt[], reproduce?:import('./types.mjs').Reproduce}} [spec]
 * @returns {import('./types.mjs').EvidenceBundle}
 */
export function newBundle(spec = {}) {
  const {
    intent = null,
    actorIdentity = null,
    claims = [],
    receipts = [],
    reproduce = { k: 0, n: 0 },
  } = spec;
  const addressed = receipts.map((r) => ({
    ...r,
    sha256: contentAddress(stableStringify(r.data ?? null)),
  }));
  return { intent, actorIdentity, claims, receipts: addressed, reproduce };
}

/**
 * The canonical manifest digest over intent + claims + receipts + verdict.
 * @param {import('./types.mjs').EvidenceBundle} bundle
 * @returns {string}
 */
function manifestDigest(bundle) {
  const manifest = stableStringify({
    intent: bundle.intent ?? null,
    claims: bundle.claims ?? [],
    receipts: bundle.receipts ?? [],
    verdict: verdict(bundle),
  });
  return contentAddress(manifest);
}

/**
 * Seal a bundle with a real ed25519 private key. Returns a new bundle carrying the seal.
 * @param {import('./types.mjs').EvidenceBundle} bundle
 * @param {import('node:crypto').KeyObject} privKey ed25519 private key
 * @returns {import('./types.mjs').EvidenceBundle}
 */
export function sealBundle(bundle, privKey) {
  const digest = manifestDigest(bundle);
  const signature = sign(null, Buffer.from(digest, 'hex'), privKey).toString('base64');
  const publicKey = createPublicKey(privKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  return { ...bundle, seal: { algorithm: 'ed25519', digest, signature, publicKey } };
}

/**
 * Verify a sealed bundle. Recomputes the digest from the current bundle and verifies
 * the ed25519 signature. ANY post-seal mutation => false. A bundle with no seal => false.
 * @param {import('./types.mjs').EvidenceBundle} bundle
 * @param {import('node:crypto').KeyObject|string} [pubKey] KeyObject, PEM, or base64 SPKI DER; defaults to the sealed public key
 * @returns {boolean}
 */
export function verifySeal(bundle, pubKey) {
  if (!bundle || !bundle.seal) return false;
  const { digest, signature, publicKey } = bundle.seal;
  if (!digest || !signature) return false;
  const currentDigest = manifestDigest(bundle);
  if (currentDigest !== digest) return false;
  let key;
  try {
    key = normalizeKey(pubKey ?? publicKey);
  } catch {
    return false;
  }
  try {
    return verify(null, Buffer.from(currentDigest, 'hex'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * @param {import('node:crypto').KeyObject|string} pubKey
 * @returns {import('node:crypto').KeyObject}
 */
function normalizeKey(pubKey) {
  if (pubKey && typeof pubKey === 'object' && typeof (/** @type {any} */ (pubKey).export) === 'function') {
    return /** @type {import('node:crypto').KeyObject} */ (pubKey);
  }
  if (typeof pubKey === 'string') {
    if (pubKey.includes('BEGIN')) return createPublicKey(pubKey);
    return createPublicKey({ key: Buffer.from(pubKey, 'base64'), format: 'der', type: 'spki' });
  }
  throw new Error('unsupported public key');
}
