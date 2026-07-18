// @ts-check
/**
 * The Lyric schema-2 manifest → pb EvidenceBundle SEAL ADAPTER.
 *
 * Real Lyric evidence manifests (`~/lyric/.tickets/<KEY>/evidence/<run>/manifest.json`) are
 * `selfAttested:true`, UNSEALED, and carry a plain-string `provenance` on each artifact —
 * exactly the shape the pb honesty core downgrades to `agent`. This adapter INGESTS one such
 * schema-2 manifest and maps it onto pb's frozen provenance lattice, so the two evidence models
 * unify WITHOUT laundering self-attestation into a false WORKS.
 *
 * schema2Manifest is PURE (like catch.mjs's assembleCatchBundle): manifest object → an UNSEALED
 * EvidenceBundle. The caller seals it (ed25519 via evidence.mjs) and calls the FROZEN verdict.
 * The honesty core (verdict/harness/evidence/types) is untouched — this is a NEW adapter around it.
 *
 * The mapping, and the honesty invariant each leg clears:
 *
 *   pins {image@digest, k8s.context/namespace, repo SHA} → ONE code-identity harness receipt.
 *     It records WHAT THE MANIFEST PINNED (source + selfAttested flagged in its data), minted by
 *     pb reading the manifest out-of-band. It is a `fingerprint` receipt — carried as identity
 *     CONTEXT, referenced by no claim, so it can never satisfy an effect leg (§ it grounds nothing).
 *
 *   each artifact → one receipt, its provenance the MIN of {declared, shape-ceiling}:
 *     • a well-formed out-of-band command receipt (type:command + meta.cmd + numeric meta.exitCode)
 *       declared `harness` — the lyric-mongo.sh / kubectl-exec / gcloud / git out-of-band reads —
 *       is MINTED harness (via mint — the module-private brand is the ONLY path to satisfying
 *       provenance; a plain relabel through newBundle is floored to `agent`).
 *     • an APP-SURFACE read (an HTTP client hitting the service's own endpoint, e.g. curl /health)
 *       is capped at `tool` EVEN WHEN the manifest declares it `harness` — a read through the app's
 *       own surface is not out-of-band ground truth (draft G3 high bar; verdict.mjs §1.1/§4). This
 *       is the anti-laundering cap: pb's shape analysis can only LOWER the declared provenance.
 *     • anything not a verifiable command receipt (no declared provenance / not command-shaped) is
 *       left UNMINTED → newBundle floors it to `agent`.
 *
 *   each check → one `effect` claim. The manifest's evidence is command-exit codes + jsonpath
 *     assertions — it carries NO write-set-bound delta (before/after) + confirm leg, which the core
 *     requires to CONFIRM an effect. So a passing L3 health check resolves NOT_EXECUTED (its backing
 *     receipt is a tool/app-surface command, not a harness store-delta), and every `not-run` L4/L5
 *     behavioral check resolves NOT_EXECUTED (no receipt). With no CONFIRMED effect, the honest
 *     verdict is COULD_NOT_DETERMINE — the CORRECT outcome for an L3-health / not-run manifest, and
 *     the whole point: Lyric's self-attested "pass" does NOT rise to a pb WORKS without ground truth.
 *
 * Node built-ins only; zero runtime deps.
 */

import { mint } from '../harness.mjs';
import { newBundle } from '../evidence.mjs';
import { Provenance, ClaimKind } from '../types.mjs';

/** @type {Readonly<Record<number, string>>} Provenance by trust rank (agent=0<tool=1<harness=2). */
const PROV_BY_RANK = Object.freeze({ 0: Provenance.AGENT, 1: Provenance.TOOL, 2: Provenance.HARNESS });

/**
 * Trust rank of a DECLARED provenance string (agent<tool<harness); anything unknown ranks 0 (agent).
 * @param {any} p
 * @returns {number}
 */
function provRank(p) {
  return p === Provenance.HARNESS ? 2 : p === Provenance.TOOL ? 1 : 0;
}

/**
 * Whether the artifact is a verifiable out-of-band command receipt: a `command` artifact carrying a
 * non-empty command string and a finite numeric exit code. Only these can be minted — anything else
 * (a bare file, a shapeless blob) is an unverifiable claim and stays `agent`.
 * @param {any} artifact
 * @returns {boolean}
 */
function isCommandReceipt(artifact) {
  return (
    !!artifact &&
    artifact.type === 'command' &&
    !!artifact.meta &&
    typeof artifact.meta.cmd === 'string' &&
    artifact.meta.cmd.length > 0 &&
    typeof artifact.meta.exitCode === 'number' &&
    Number.isFinite(artifact.meta.exitCode)
  );
}

/**
 * Whether a command is an APP-SURFACE read: an HTTP client (curl/wget/httpie) hitting an http(s)
 * URL — i.e. a read through the service's OWN network endpoint. Such a read is `tool` at best, never
 * harness ground truth (verdict.mjs §1.1/§4). Out-of-band reads (kubectl exec / mongosh / gcloud /
 * git / gh / the lyric-mongo.sh tap) do not match and keep their declared harness provenance.
 * @param {string} cmd
 * @returns {boolean}
 */
function isAppSurfaceCommand(cmd) {
  return /\b(curl|wget|httpie)\b/.test(cmd) && /\bhttps?:\/\//.test(cmd);
}

/**
 * Classify an artifact's pb provenance: the MIN of what the manifest DECLARES and what the artifact's
 * SHAPE can bear. pb's analysis can only LOWER the declared value, never raise it — a manifest can
 * never launder itself into more trust than its shape supports. Exported for the anti-laundering /
 * anti-overfit tests: the classification is the load-bearing contract.
 * @param {any} artifact
 * @returns {Provenance|string} agent | tool | harness
 */
export function artifactProvenance(artifact) {
  if (!isCommandReceipt(artifact)) return Provenance.AGENT; // unverifiable shape → never minted
  const declared = provRank(artifact.provenance);
  const ceiling = isAppSurfaceCommand(artifact.meta.cmd) ? 1 /* tool */ : 2 /* harness */;
  return PROV_BY_RANK[Math.min(declared, ceiling)];
}

/**
 * One artifact → one receipt. Its data faithfully records the command, exit code, the manifest's own
 * content address of the log, AND the provenance the manifest DECLARED (so the classification is
 * auditable). Minted iff the classification is tool|harness — the mint brand is the only path to
 * satisfying provenance; an `agent` result is returned UNMINTED so newBundle floors it.
 * @param {any} artifact
 * @param {number} index
 * @returns {import('../types.mjs').Receipt}
 */
function artifactReceipt(artifact, index) {
  const provenance = artifactProvenance(artifact);
  const meta = (artifact && artifact.meta) || {};
  /** @type {import('../types.mjs').Receipt} */
  const receipt = {
    id: `artifact:${index}:${artifact && artifact.name}`,
    kind: 'command', // a command-exit receipt, NOT a write-set store delta — cannot satisfy an effect leg
    provenance,
    data: {
      name: artifact && artifact.name,
      cmd: meta.cmd,
      exitCode: meta.exitCode,
      logSha256: artifact && artifact.sha256, // the manifest's own content address of the log
      path: artifact && artifact.path,
      ...(meta.durationSec !== undefined ? { durationSec: meta.durationSec } : {}),
      declaredProvenance: (artifact && artifact.provenance) ?? null, // what the manifest CLAIMED
      selfAttested: true,
    },
  };
  return provenance === Provenance.AGENT ? receipt : mint(receipt);
}

/**
 * The pins → ONE code-identity harness receipt. It records what the manifest pinned (single repo
 * SHA, image ref@digest map, k8s context/namespace, substrate) and flags `selfAttested` in its data,
 * because these pins were READ FROM the self-attested manifest, not re-derived from a live checkout.
 * Minted harness (pb read it out-of-band from the manifest) but referenced by NO claim, so it is pure
 * identity context and can never satisfy an effect leg.
 * @param {any} manifest
 * @returns {import('../types.mjs').Receipt}
 */
function codeIdentityReceipt(manifest) {
  const pins = (manifest && manifest.pins) || {};
  /** @type {Record<string, any>} */
  const images = {};
  for (const [k, v] of Object.entries(pins)) {
    if (k.startsWith('image.')) images[k.slice('image.'.length)] = v;
  }
  return mint({
    id: 'code-identity',
    kind: 'fingerprint',
    provenance: Provenance.HARNESS,
    data: {
      source: 'lyric-schema2-manifest',
      substrate: manifest && manifest.surface ? manifest.surface.substrate : undefined,
      repo: pins.repo ?? null, // the manifest pins a SINGLE repo SHA (not per-repo)
      images,
      k8s: { context: pins['k8s.context'] ?? null, namespace: pins['k8s.namespace'] ?? null },
      selfAttested: manifest && manifest.selfAttested === true,
    },
  });
}

/**
 * One check → one `effect` claim. deltaReceiptId joins to the artifact receipt sharing the check's
 * name (checks and artifacts co-name in the schema, e.g. `appservice-up`); a not-run check has no
 * artifact, so it points at an absent id → NOT_EXECUTED. The manifest's own self-attested `state`
 * (pass/fail/not-run) is echoed into `scope` for the audit trail but NEVER fed to verdict() — the
 * claim state is recomputed from the sealed receipts alone.
 * @param {any} check
 * @param {Map<string,string>} receiptByName
 * @returns {import('../types.mjs').Claim}
 */
function checkClaim(check, receiptByName) {
  const name = check && check.name;
  const receiptId = name != null ? receiptByName.get(name) : undefined;
  const level = (check && check.level) || 'L?';
  const selfState = (check && check.state) || 'unknown';
  return {
    id: `check:${name}`,
    kind: ClaimKind.EFFECT, // a user-observable feature outcome — needs write-set ground truth to CONFIRM
    scope: `${level} ${name} [manifest:${selfState}]: ${(check && check.expect) || ''}`.trim(),
    effectCheck: {
      entity: String(name),
      // Never load-bearing here: every claim short-circuits at the persisted-leg gate (no harness
      // store-delta exists in the manifest), so the relation is a placeholder the eval never reaches.
      expectedAfterRelation: { op: 'changed' },
      deltaReceiptId: receiptId || `absent:${name}`, // absent / not a harness store-delta → NOT_EXECUTED
      confirmLegReceiptId: `absent-confirm:${name}`, // the manifest carries no fresh-session confirm leg
    },
    receiptIds: receiptId ? [receiptId] : [],
  };
}

/**
 * Adapt a Lyric schema-2 evidence manifest to a pb EvidenceBundle (UNSEALED, pure). Seal it with
 * evidence.mjs sealBundle + an ed25519 key and pass it to the frozen verdict; the recorded L3-health
 * / not-run runs yield the honest COULD_NOT_DETERMINE.
 * @param {any} manifest a parsed schema-2 manifest.json object
 * @returns {import('../types.mjs').EvidenceBundle}
 */
export function schema2Manifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError('schema2Manifest: manifest must be a parsed manifest object');
  }

  /** @type {import('../types.mjs').Receipt[]} */
  const receipts = [codeIdentityReceipt(manifest)];
  /** @type {Map<string,string>} the FIRST artifact receipt per name (the check→artifact join key) */
  const receiptByName = new Map();
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  artifacts.forEach((/** @type {any} */ a, /** @type {number} */ i) => {
    const r = artifactReceipt(a, i);
    receipts.push(r);
    if (a && a.name != null && !receiptByName.has(a.name)) receiptByName.set(a.name, r.id);
  });

  const checks = Array.isArray(manifest.checks) ? manifest.checks : [];
  const claims = checks.map((/** @type {any} */ c) => checkClaim(c, receiptByName));

  const intent = `Lyric ${manifest.ticket || '?'} ${manifest.runId || ''} (schema ${manifest.schema}, ${
    manifest.surface ? manifest.surface.substrate : '?'
  }): ${manifest.claim || ''}`.trim();

  // One recorded run → n=1; no CONFIRMED effect → k=0; no reproduced feature failure → kFail=0.
  return newBundle({
    intent,
    actorIdentity: 'lyric-verify', // the self-attesting Lyric agent (owner-shadow context)
    claims,
    receipts,
    reproduce: { k: 0, n: 1, kFail: 0 },
  });
}
