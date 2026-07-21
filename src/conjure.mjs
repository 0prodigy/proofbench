// @ts-check
/**
 * The CONJURE RUNNER — turn a pb-recipe-v1 into a live, drivable SUT.
 *
 * conjure() brings up a REAL system-under-test from a recipe: it binds CODE-IDENTITY
 * (build-from-tree@SHA or a pinned image digest), runs a FRESH world (a brand-new
 * container per call, so fresh_world:recreate holds), polls the disclosed READY signal
 * (the ready response IS the bring-up proof), applies the disclosed setup_overlay, then
 * walks the disclosed REST SETUP through a minimal cookie jar. It is MODE-AWARE per
 * recipe.conjure.mode: 'run' (n8n) `docker run`s a single container; 'compose' (documenso)
 * clones the tree, stages the disclosed compose overlays where the graph expects them, and
 * brings the service graph up with `docker compose … up -d --build` (app + postgres +
 * inbucket), tearing it down with `down -v`. It mints — via the harness
 * mint(), the only path to HARNESS provenance — a code-identity FINGERPRINT and a bring-up
 * receipt (the ready request answered): together they prove "the code actually running is
 * the code under test" (the P3 identity binding). It returns a live SUT handle; the caller
 * drives it (M4/M5) and calls teardownSut() to reap it.
 *
 * A failure tears down partial state (like phase2's finally) but SUCCESS leaves the SUT
 * up — that is the whole point. Zero runtime deps: docker via child_process (mirroring
 * phase2's helper), git via child_process, HTTP via global fetch.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadRecipe } from './recipe.mjs';
import { mint } from './harness.mjs';
import { registerReap, deregisterReap } from './reaper.mjs';
import { normalizeDigest } from './argoworkflows.mjs';

const READY_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_MS = 3000;
const HTTP_TIMEOUT_MS = 10000;
const DOCKER_TIMEOUT_MS = 120000;
const PULL_TIMEOUT_MS = 300000;
const BUILD_TIMEOUT_MS = 600000;
const CLONE_TIMEOUT_MS = 300000;
const GIT_TIMEOUT_MS = 120000;
const MAX_BUFFER = 64 * 1024 * 1024; // docker build logs blow past the 1MB spawnSync default

/**
 * @typedef {Object} Docker
 * @property {(args:string[], timeoutMs:number, opts?:{env?:NodeJS.ProcessEnv}) => import('node:child_process').SpawnSyncReturns<string>} run
 */

/**
 * A live SUT handle returned by {@link conjure}.
 * @typedef {Object} SutHandle
 * @property {import('./recipe.mjs').Recipe} recipe
 * @property {string|null} containerName the fresh-world container (unique per conjure); null for
 *   mode 'k8s-attach' (attach owns no container)
 * @property {string} baseUrl e.g. http://localhost:5678
 * @property {string} frontDoorUrl the user-facing URL, placeholders resolved
 * @property {Record<string,any>} captures values captured from setup responses
 * @property {{name:string, value:string}[]} cookies the setup dance's cookie jar, exposed for a
 *   later drive slice (e.g. carrying a Django csrftoken/sessionid into a driven request);
 *   last-write-wins order
 * @property {import('./types.mjs').Receipt[]} receipts [fingerprint, bringup] — harness provenance
 * @property {string|null} _cloneDir temp from-tree checkout to reap on teardown (null otherwise)
 * @property {ComposeInfo|null} _compose compose project + -f files to `down -v` on teardown (null for run mode)
 * @property {() => (void|Promise<void>)} [_reap] the interrupt-reap registered with the signal reaper (de-registered on normal teardown)
 * @property {K8sAttachState} [_k8sAttach] present only for mode 'k8s-attach' — the port-forward
 *   processes to kill on teardown + the snapshot state {@link mintK8sAttachIdentity} and
 *   {@link checkK8sAttachDrift} read/write (never present for run/compose handles)
 * @property {() => Promise<void>} teardown
 */

/**
 * A point-in-time read of every pod in the attached namespace — the raw material both the
 * code-identity BINDING check and the DRIFT SENTINEL are built from (never through an app
 * endpoint; always a direct `kubectl get pods`).
 * @typedef {Object} ClusterSnapshot
 * @property {string[]} pods pod names, sorted
 * @property {string[]} digests resolved `sha256:` digests observed across every container, sorted+deduped
 * @property {Record<string,number>} restarts `${podName}/${containerName}` -> observed restartCount
 * @property {{ref:string, digest:string}[]} [imageRefs] each container's OWN requested image ref
 *   (repo[:tag], no digest guaranteed) paired with that SAME container's resolved digest — the
 *   ref-matching material {@link expectedImagesBind} needs for a digestless `expected_images` entry
 *   (repo+tag matching); the deduped `digests` set above can't do this since it drops the
 *   ref<->digest pairing. Optional so a pure detectDrift-only test fixture need not supply it.
 */

/**
 * k8s-attach bookkeeping carried on the {@link SutHandle} (present only for mode 'k8s-attach').
 * @typedef {Object} K8sAttachState
 * @property {K8sExecRunner} execFn the injected (or default) blocking kubectl runner
 * @property {{kubeContext:string, namespace:string}} kubeArgs
 * @property {ClusterSnapshot} attachSnapshot read the instant every port-forward confirmed ready
 * @property {ClusterSnapshot|null} driveSnapshot the DRIVE-TIME snapshot {@link mintK8sAttachIdentity}
 *   records — the drift sentinel's "before the verdict window" baseline; null until minted
 * @property {{svc:import('./recipe.mjs').K8sAttachService, proc:PortForwardHandle}[]} forwards the
 *   live port-forward child processes (killed on teardown/interrupt)
 */

/**
 * What teardown needs to reap a compose graph: the project name and the ordered `-f` files
 * (base compose_file + any compose overlays). Present only for mode 'compose'.
 * @typedef {Object} ComposeInfo
 * @property {string} project
 * @property {string[]} files
 */

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; docker-free)
// ---------------------------------------------------------------------------

const DIRECTIVE =
  /^\s*(FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b/i;

/**
 * Inject the disclosed build_overlay just before the corepack line (M1's 2026-corepack-vs-
 * 2023-tree signature fix) — or, when the tree ships no corepack line, before the first
 * package-manager install RUN in each build stage. A bare shell line is RUN-prefixed; a line
 * that already begins with a Dockerfile directive (e.g. `ENV ...`) is emitted verbatim.
 * @param {string} text the original Dockerfile
 * @param {string[]} [overlayLines]
 * @returns {string}
 */
export function overlayDockerfile(text, overlayLines) {
  if (!overlayLines || overlayLines.length === 0) return text;
  const lines = text.split('\n');
  const injected = overlayLines.map((l) => (DIRECTIVE.test(l) ? l : `RUN ${l}`));

  // First choice: a single injection before the corepack line (byte-identical to the original).
  let at = lines.findIndex((l) => /corepack\s+enable/.test(l));
  if (at === -1) at = lines.findIndex((l) => /corepack/.test(l));
  if (at !== -1) return [...lines.slice(0, at), ...injected, ...lines.slice(at)].join('\n');

  // ponytail: no corepack line to anchor on (some trees never invoke corepack) — fall back to the
  // first package-manager install RUN in EACH build stage. corepack's `ENV`/global `npm install -g`
  // do NOT cross a `FROM` boundary, so a multi-stage tree (n8n-custom: builder + runtime, both
  // invoke pnpm) needs the fix re-applied per stage. We walk `FROM` boundaries and, for a RUN whose
  // block (the `RUN` line plus its `\`-continuation lines) mentions pnpm/yarn/npm, inject before the
  // `RUN` line — so a multi-LINE `RUN \` / `pnpm rebuild …` step (n8n stage 2) is caught too.
  /** @type {string[]} */ const out = [];
  let injectedInStage = false;
  let anyInjected = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*FROM\b/i.test(l)) injectedInStage = false;
    if (!injectedInStage && /^\s*RUN\b/.test(l)) {
      // Extend across `\`-continuation lines so a multi-line RUN block is matched as a whole.
      let end = i;
      while (end < lines.length - 1 && /\\\s*$/.test(lines[end])) end++;
      if (/\b(pnpm|yarn|npm)\b/.test(lines.slice(i, end + 1).join('\n'))) {
        out.push(...injected);
        injectedInStage = true;
        anyInjected = true;
      }
    }
    out.push(l);
  }
  if (!anyInjected) throw new Error('conjure: build_overlay is set but no anchor was found — neither a corepack line nor a package-manager (pnpm/yarn/npm) install RUN line exists to anchor the overlay');
  return out.join('\n');
}

/**
 * Resolve every `{name}` in a template via lookup(name); throw (naming it) if unresolved.
 * @param {string} template
 * @param {(name:string)=>any} lookup
 * @returns {string}
 */
export function resolvePlaceholders(template, lookup) {
  return template.replace(/\{([^}]+)\}/g, (_, name) => {
    const v = lookup(name);
    if (v === undefined || v === null) throw new Error(`conjure: unresolved placeholder {${name}} in "${template}"`);
    return String(v);
  });
}

/**
 * Resolve `{name}` placeholders in a setup/confirm step's body — recursively, over string
 * leaves only (object/array shape passes through unchanged) — via the same lookup + throw-if-
 * unresolved contract as {@link resolvePlaceholders}. Previously `body`/`body_file` were sent
 * byte-verbatim with no substitution from `captures`, so a capture like a CSRF token had nowhere
 * to land (R1 gap A, `recipes/linkding-default-mark-shared-pr1170/recipe.json` notes).
 * @param {any} node
 * @param {(name:string)=>any} lookup
 * @returns {any}
 */
export function resolveBodyPlaceholders(node, lookup) {
  if (typeof node === 'string') return resolvePlaceholders(node, lookup);
  if (Array.isArray(node)) return node.map((x) => resolveBodyPlaceholders(x, lookup));
  if (node && typeof node === 'object') {
    /** @type {Record<string,any>} */ const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = resolveBodyPlaceholders(v, lookup);
    return out;
  }
  return node;
}

/**
 * Walk a simple `$.a.b` / `$.a[0].b` JSONPath (the capture syntax): a dot-separated key, each
 * OPTIONALLY followed by one or more `[N]` array-index suffixes (e.g. the Lyric class's
 * `$.notes[0]._id` — resolving parent.notes[0] to the child note-exec id). Non-`$` paths, an
 * off-path read, or an out-of-range index all return undefined.
 * @param {any} obj
 * @param {string} path
 * @returns {any}
 */
export function extractJsonPath(obj, path) {
  if (typeof path !== 'string' || path[0] !== '$') return undefined;
  let cur = obj;
  for (const rawKey of path.slice(1).split('.').filter(Boolean)) {
    const m = /^([^[\]]+)((?:\[\d+\])*)$/.exec(rawKey);
    if (!m) return undefined;
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[m[1]];
    for (const idx of m[2].match(/\[(\d+)\]/g) || []) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[Number(idx.slice(1, -1))];
    }
  }
  return cur;
}

/**
 * Run an HTML-capture regex (<=200 chars, one capture group — validated at recipe load) over a
 * setup response body and return its first capture group, or undefined if it doesn't match.
 * The alternative capture source to {@link extractJsonPath} (e.g. Django's csrfmiddlewaretoken
 * hidden input, which a JSON-only capture cannot reach).
 * @param {string} text
 * @param {string} pattern
 * @returns {string|undefined}
 */
export function extractHtml(text, pattern) {
  const m = new RegExp(pattern).exec(text || '');
  return m ? m[1] : undefined;
}

/** @param {string} s @returns {string} docker-safe slug */
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sut';
}

/** @param {string} s snake_case -> camelCase (so `{webhook_id}` finds a `webhookId` field) */
function camelize(s) {
  return s.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

/**
 * Collect scalar leaf fields (first-wins) from a setup body, so a front-door placeholder
 * can resolve to a minted id carried in the body (e.g. the workflow node's webhookId).
 * @param {any} node
 * @param {Record<string,any>} out
 */
function collectScalars(node, out) {
  if (Array.isArray(node)) {
    for (const x of node) collectScalars(x, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (v !== null && typeof v === 'object') collectScalars(v, out);
      else if (!(k in out)) out[k] = v;
    }
  }
}

/**
 * Best-effort FROM base derivation (resolving ARG defaults), so we can pre-pull the base
 * the way M1 proved. If a var stays unresolved, return null and let `docker build` pull it.
 * @param {string} text
 * @returns {string|null}
 */
function deriveBaseImage(text) {
  /** @type {Record<string,string>} */
  const args = {};
  const lines = text.split('\n');
  for (const line of lines) {
    const m = /^\s*ARG\s+([A-Za-z_]\w*)=(.+?)\s*$/.exec(line);
    if (m) args[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  for (const line of lines) {
    const m = /^\s*FROM\s+(\S+)/i.exec(line);
    if (!m) continue;
    const ref = m[1]
      .replace(/\$\{([A-Za-z_]\w*)\}/g, (_, n) => args[n] ?? '$?')
      .replace(/\$([A-Za-z_]\w*)/g, (_, n) => args[n] ?? '$?');
    return ref.includes('$') ? null : ref;
  }
  return null;
}

/** @param {string} [s] @param {number} [n] */
function tail(s, n = 800) {
  s = s || '';
  return s.length > n ? s.slice(-n) : s;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Compose arg-building (pure; unit-tested; docker-free)
// ---------------------------------------------------------------------------

/**
 * The compose project name is the graph's identity — the recipe's postgres store_tap.container
 * (`<project>-<service>-N`) is authored to match it. Read the compose file's own top-level
 * `name:` (a column-0 key; a nested/indented `name:` is ignored). Returns null when absent.
 * @param {string} text the compose file contents
 * @returns {string|null}
 */
export function parseComposeName(text) {
  const m = /^name:[ \t]*(.+?)[ \t]*(?:#.*)?$/m.exec(text || '');
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, '') || null;
}

/**
 * Classify the disclosed compose_overlays: a compose (`.yml`/`.yaml`) overlay is layered as an
 * extra `-f`; any other overlay (e.g. the mem Dockerfile) is STAGED into the checkout beside the
 * base Dockerfile — where the override's `build.dockerfile` points (RECIPE-FACTS: Dockerfile.mem
 * → the checkout's docker/Dockerfile.mem). The stage target is derived from the base dockerfile's
 * directory, never hardcoded.
 * @param {string[]|undefined} overlays
 * @param {string} dockerfile the from_tree dockerfile path (e.g. docker/Dockerfile)
 * @returns {{composeOverlays:string[], staged:{name:string, toRel:string}[]}}
 */
export function overlayPlan(overlays, dockerfile) {
  /** @type {string[]} */ const composeOverlays = [];
  /** @type {{name:string, toRel:string}[]} */ const staged = [];
  for (const ov of overlays || []) {
    if (/\.ya?ml$/i.test(ov)) composeOverlays.push(ov);
    else staged.push({ name: ov, toRel: join(dirname(dockerfile), ov) });
  }
  return { composeOverlays, staged };
}

/**
 * Build a `docker compose -p <project> -f <f1> [-f <f2>…] <verb…>` argv. The base compose_file
 * MUST come first so compose anchors relative build.context/env_file/volumes to its directory.
 * @param {string} project
 * @param {string[]} files ordered `-f` files (base first, overlays after)
 * @param {string[]} verb e.g. ['up','-d','--build'] or ['down','-v']
 * @returns {string[]}
 */
export function composeArgv(project, files, verb) {
  const args = ['compose', '-p', project];
  for (const f of files) args.push('-f', f);
  return args.concat(verb);
}

/**
 * Build a `docker build -f <overlayPath> -t <tag> [--build-arg …] [--target <target>] <context>`
 * argv for a from_tree run-mode SUT. `--target` (§1) lets a recipe pick a non-default build stage
 * (e.g. linkding's real default stage isn't the last; the last stage's build 404s on an upstream
 * bug). Omitting opts.target reproduces the exact prior argv (byte-identical for shipped recipes).
 * @param {string} overlayPath
 * @param {string} tag
 * @param {string} context absolute docker build context dir
 * @param {{n8nDevBuildArg?:boolean, target?:string}} [opts]
 * @returns {string[]}
 */
export function buildImageArgv(overlayPath, tag, context, opts = {}) {
  const args = ['build', '-f', overlayPath, '-t', tag];
  if (opts.n8nDevBuildArg) args.push('--build-arg', 'N8N_RELEASE_TYPE=dev');
  if (opts.target) args.push('--target', opts.target);
  args.push(context);
  return args;
}

// ---------------------------------------------------------------------------
// Docker / git / HTTP (child_process + global fetch; mirrors phase2's helper)
// ---------------------------------------------------------------------------

/** @returns {Docker|null} */
function detectDocker() {
  const v = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) return null;
  return {
    run: (args, timeoutMs, opts) =>
      spawnSync('docker', args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: (opts && opts.env) || process.env,
      }),
  };
}

/** @param {string[]} args @param {number} timeoutMs */
function git(args, timeoutMs) {
  return spawnSync('git', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER });
}

/** @param {string} url @returns {Promise<number|null>} the status, or null if unreachable */
async function probeStatus(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** @param {Response} res @returns {string[]} */
function readSetCookies(res) {
  const h = /** @type {any} */ (res.headers);
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const raw = res.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/** @param {Map<string,string>} jar */
function cookieHeader(jar) {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Absorb any Set-Cookie headers from a setup-step response into the jar (last-write-wins;
 * never let a cleared cookie wipe the jar). Status-independent by design — `readSetCookies`
 * reads headers regardless of status, so a 3xx redirect (e.g. Django's post-login redirect)
 * absorbs cookies exactly like a 2xx.
 * @param {Response} res
 * @param {Map<string,string>} jar
 */
export function absorbSetCookies(res, jar) {
  for (const c of readSetCookies(res)) {
    const first = c.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) {
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name && value) jar.set(name, value);
    }
  }
}

/**
 * Encode a setup-step body per content_type: 'json' (default, byte-identical to before) sends
 * `application/json` + JSON.stringify; 'form' sends `application/x-www-form-urlencoded` via
 * URLSearchParams over the body object (the shape a Django-style HTML form login expects);
 * 'multipart' sends `multipart/form-data` — a hand-rolled boundary encoder (zero deps): each of
 * `body`'s top-level fields becomes a form field (non-string values JSON.stringify'd, e.g.
 * documenso's `payload` field), followed by one part per `opts.files` entry (the recipe-local
 * asset read off disk, e.g. a blank PDF). Returns a Buffer for 'multipart' (binary-safe); a
 * string for 'json'/'form' (unchanged).
 * @param {string|undefined} contentType 'json' (default) | 'form' | 'multipart'
 * @param {any} body
 * @param {{files?:import('./recipe.mjs').SetupStep['files'], recipeDir?:string}} [opts] required for 'multipart' when files are attached
 * @returns {{contentTypeHeader:string, encoded:string|Buffer}}
 */
export function encodeSetupBody(contentType, body, opts = {}) {
  if (contentType === 'form') {
    return { contentTypeHeader: 'application/x-www-form-urlencoded', encoded: new URLSearchParams(body).toString() };
  }
  if (contentType === 'multipart') {
    const boundary = `pbBoundary${randomUUID().replace(/-/g, '')}`;
    /** @type {Buffer[]} */
    const parts = [];
    for (const [name, v] of Object.entries(body || {})) {
      const value = typeof v === 'string' ? v : JSON.stringify(v);
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
    }
    for (const f of opts.files || []) {
      const data = readFileSync(opts.recipeDir ? join(opts.recipeDir, f.path) : f.path);
      const ct = f.content_type || 'application/octet-stream';
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${basename(f.path)}"\r\nContent-Type: ${ct}\r\n\r\n`,
          'utf8'
        )
      );
      parts.push(data);
      parts.push(Buffer.from('\r\n', 'utf8'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return { contentTypeHeader: `multipart/form-data; boundary=${boundary}`, encoded: Buffer.concat(parts) };
  }
  return { contentTypeHeader: 'application/json', encoded: JSON.stringify(body) };
}

/**
 * A single setup HTTP request through a minimal cookie jar: sends the accumulated cookies,
 * absorbs any Set-Cookie from the response, returns status + parsed JSON.
 * @param {string} method
 * @param {string} url
 * @param {any} body inline body, or undefined for none
 * @param {Map<string,string>} jar
 * @param {string} [contentType] 'json' (default) | 'form' | 'multipart' — how `body` is encoded on the wire
 * @param {{headers?:Record<string,string>, files?:import('./recipe.mjs').SetupStep['files'], recipeDir?:string}} [extra] extra request headers (already placeholder-resolved) + the multipart file parts
 * @returns {Promise<{status:number, text:string, json:any}>}
 */
async function httpReq(method, url, body, jar, contentType, extra = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    /** @type {Record<string,string>} */
    const headers = { ...(extra.headers || {}) };
    const cookie = cookieHeader(jar);
    if (cookie) headers['Cookie'] = cookie;
    /** @type {RequestInit} */
    const init = { method, headers, signal: controller.signal, redirect: 'manual' };
    if (body !== undefined && body !== null) {
      const { contentTypeHeader, encoded } = encodeSetupBody(contentType, body, extra);
      headers['Content-Type'] = contentTypeHeader;
      init.body = /** @type {any} */ (encoded); // BodyInit narrows string|Buffer; Buffer (multipart) is genuinely valid at runtime
    }
    const res = await fetch(url, init);
    absorbSetCookies(res, jar);
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Image (code-identity) resolution
// ---------------------------------------------------------------------------

/**
 * Shallow partial-clone the from_tree repo and checkout the given SHA into a fresh temp dir.
 * The checkout SHA is passed in (not read from ci) so the differential runner can build an
 * ALTERNATE sha (the parent) from the same repo. Registers the dir via onCloneDir the instant
 * it exists, so a mid-clone failure still gets reaped. Shared by resolveImage (run mode) and
 * bringUpCompose (compose mode).
 * @param {import('./recipe.mjs').FromTreeIdentity} ci
 * @param {string} sha the exact SHA to checkout (ci.sha, or an override like ci.parent_sha)
 * @param {(dir:string)=>void} onCloneDir
 * @returns {string} the checkout dir
 */
function cloneAtSha(ci, sha, onCloneDir) {
  const cloneDir = mkdtempSync(join(tmpdir(), 'pb-conjure-'));
  onCloneDir(cloneDir);
  const clone = git(['clone', '--filter=blob:none', ci.repo, cloneDir], CLONE_TIMEOUT_MS);
  if (clone.status !== 0) throw new Error(`conjure: git clone ${ci.repo} failed (exit ${clone.status}): ${tail(clone.stderr || clone.stdout)}`);
  const co = git(['-C', cloneDir, 'checkout', sha], GIT_TIMEOUT_MS);
  if (co.status !== 0) throw new Error(`conjure: git checkout ${sha} failed (exit ${co.status}): ${tail(co.stderr || co.stdout)}`);
  return cloneDir;
}

/**
 * Resolve the SUT image and its digest per code_identity. from_tree: shallow partial-clone
 * @SHA (buildSha overrides ci.sha for the differential parent build), overlay the Dockerfile,
 * build (cache-skipping if the per-SHA tag already exists). pinned_image: pull and verify the
 * digest matches (buildSha does not apply). cloneDir is registered via onCloneDir the instant
 * it exists, so a mid-clone failure still gets reaped. The returned `sha` is the ACTUAL sha
 * built, so the fingerprint records the real code-identity (merge vs parent).
 * @param {Docker} docker
 * @param {import('./recipe.mjs').Recipe} recipe
 * @param {(dir:string)=>void} onCloneDir
 * @param {string|undefined} buildSha overrides the from_tree checkout SHA when set
 * @returns {Promise<{image:string, imageDigest:string|undefined, sha:string|undefined}>}
 */
async function resolveImage(docker, recipe, onCloneDir, buildSha) {
  const ci = recipe.code_identity;

  if (ci.mode === 'pinned_image') {
    const pull = docker.run(['pull', ci.image_ref], PULL_TIMEOUT_MS);
    if (pull.status !== 0) throw new Error(`conjure: docker pull ${ci.image_ref} failed (exit ${pull.status}): ${tail(pull.stderr || pull.stdout)}`);
    const insp = docker.run(['image', 'inspect', ci.image_ref, '--format', '{{json .RepoDigests}}'], DOCKER_TIMEOUT_MS);
    /** @type {string[]} */
    let digests = [];
    try {
      digests = JSON.parse((insp.stdout || '[]').trim()) || [];
    } catch {
      digests = [];
    }
    const shas = digests.map((d) => String(d).split('@')[1] || '').filter(Boolean);
    if (!shas.includes(ci.image_digest)) {
      throw new Error(`conjure: pinned image ${ci.image_ref} digest mismatch — recipe pins ${ci.image_digest} but pulled ${shas.join(', ') || '(none)'}`);
    }
    return { image: ci.image_ref, imageDigest: ci.image_digest, sha: undefined };
  }

  // from_tree — build the effective sha (buildSha overrides ci.sha for the differential parent).
  // (multi_repo pairs with conjure.mode 'k8s-attach', not 'run'/'compose' — no committed recipe
  // combines them; this guard narrows the type and fails loudly rather than reading undefined
  // from_tree-only fields if one ever did.)
  if (ci.mode !== 'from_tree') {
    throw new Error(`conjure: mode 'run' requires code_identity.mode 'from_tree' or 'pinned_image'; got '${ci.mode}'`);
  }
  const sha = buildSha || ci.sha;
  const tag = `pb-sut-${slug(recipe.name)}-${sha.slice(0, 7)}`;
  const cached = docker.run(['image', 'inspect', tag], DOCKER_TIMEOUT_MS).status === 0;
  if (!cached) {
    const cloneDir = cloneAtSha(ci, sha, onCloneDir);

    const dfPath = join(cloneDir, ci.dockerfile);
    if (!existsSync(dfPath)) throw new Error(`conjure: dockerfile ${ci.dockerfile} not found in the checkout of ${sha}`);
    const overlaid = overlayDockerfile(readFileSync(dfPath, 'utf8'), ci.build_overlay);
    const overlayPath = join(cloneDir, 'Dockerfile.pb-overlay');
    writeFileSync(overlayPath, overlaid);

    const base = deriveBaseImage(overlaid);
    if (base) docker.run(['pull', base], PULL_TIMEOUT_MS); // best-effort; the build pulls FROM if this misses

    // Supply the M1-disclosed dev build-type only when the tree declares that arg (derived, not
    // blind); pass --target only when the recipe discloses one (§1).
    const buildArgs = buildImageArgv(overlayPath, tag, join(cloneDir, ci.context), {
      n8nDevBuildArg: /^\s*ARG\s+N8N_RELEASE_TYPE\b/im.test(overlaid),
      target: ci.target,
    });
    const build = docker.run(buildArgs, BUILD_TIMEOUT_MS, { env: { ...process.env, DOCKER_BUILDKIT: '1' } });
    if (build.status !== 0) throw new Error(`conjure: docker build failed (exit ${build.status}): ${tail(build.stderr || build.stdout)}`);
  }
  const idInsp = docker.run(['image', 'inspect', tag, '--format', '{{.Id}}'], DOCKER_TIMEOUT_MS);
  const imageDigest = (idInsp.stdout || '').trim() || undefined;
  return { image: tag, imageDigest, sha };
}

/**
 * Bring up a mode 'compose' SUT (documenso): clone the tree @SHA, STAGE the disclosed compose
 * overlays where the graph expects them (a yaml overlay is an extra `-f`; the mem Dockerfile is
 * copied into the checkout beside the base Dockerfile), then `docker compose -p <project> -f …
 * up -d --build` (BuildKit, like run mode). The project name is the compose file's own top-level
 * `name:` — the identity the recipe's store_tap.container is aligned to — so `down -v` and the
 * postgres tap both find the right containers. cloneDir + composeInfo are registered via
 * callbacks the instant they exist, so a mid-bring-up failure still reaps (the finally calls
 * `down -v`). Returns the code-identity + app container for the fingerprint/handle.
 * @param {Docker} docker
 * @param {import('./recipe.mjs').Recipe} recipe
 * @param {string} recipeDir
 * @param {(dir:string)=>void} onCloneDir
 * @param {(info:ComposeInfo)=>void} onCompose
 * @param {string|undefined} buildSha overrides the from_tree checkout SHA when set
 * @returns {{image:string, imageDigest:string|undefined, sha:string, containerName:string}}
 */
function bringUpCompose(docker, recipe, recipeDir, onCloneDir, onCompose, buildSha) {
  const ci = recipe.code_identity;
  const c = recipe.conjure;
  if (ci.mode !== 'from_tree') {
    throw new Error(`conjure: mode 'compose' requires code_identity.mode 'from_tree' (the compose graph builds the SUT from the tree); got '${ci.mode}'`);
  }
  if (!c.compose_file) throw new Error("conjure: mode 'compose' requires conjure.compose_file");
  const sha = buildSha || ci.sha;
  const cloneDir = cloneAtSha(ci, sha, onCloneDir);

  // Stage the disclosed overlays where the compose graph expects them.
  const plan = overlayPlan(c.compose_overlays, ci.dockerfile);
  for (const s of plan.staged) {
    const from = join(recipeDir, s.name);
    if (!existsSync(from)) throw new Error(`conjure: compose overlay '${s.name}' not found in ${recipeDir}`);
    copyFileSync(from, join(cloneDir, s.toRel));
  }
  // Base compose_file FIRST (compose anchors relative build.context/env_file/volumes to its dir);
  // yaml overlays are layered after, referenced from the recipe dir.
  const files = [join(cloneDir, c.compose_file), ...plan.composeOverlays.map((o) => join(recipeDir, o))];

  const composeText = readFileSync(join(cloneDir, c.compose_file), 'utf8');
  const project = parseComposeName(composeText) || `pb-sut-${slug(recipe.name)}`;
  onCompose({ project, files }); // register before `up` so a partial bring-up still reaps via down -v

  const up = docker.run(composeArgv(project, files, ['up', '-d', '--build']), BUILD_TIMEOUT_MS, {
    env: { ...process.env, DOCKER_BUILDKIT: '1' },
  });
  if (up.status !== 0) throw new Error(`conjure: docker compose up failed (exit ${up.status}): ${tail(up.stderr || up.stdout)}`);

  // Compose V2 single-replica naming: the app service's container is <project>-<service>-1, and
  // its built image (no `image:` set) is <project>-<service>. Both derived, never hardcoded.
  const containerName = c.service ? `${project}-${c.service}-1` : project;
  const imageName = c.service ? `${project}-${c.service}` : project;
  const idInsp = docker.run(['image', 'inspect', imageName, '--format', '{{.Id}}'], DOCKER_TIMEOUT_MS);
  const imageDigest = (idInsp.stdout || '').trim() || undefined;
  return { image: imageName, imageDigest, sha, containerName };
}

// ---------------------------------------------------------------------------
// conjure / teardown
// ---------------------------------------------------------------------------

/**
 * Bring up a real SUT from a pb-recipe-v1 and return a live, drivable handle. A failure
 * reaps partial state; success leaves the SUT running for the caller to drive.
 *
 * opts.buildSha overrides the from_tree checkout SHA — the differential runner (M6) builds
 * the SUT at BOTH code_identity.sha (merge) and code_identity.parent_sha (parent) from the
 * same recipe, and the fingerprint records whichever sha actually built, so the merge and
 * parent bundles carry DIFFERENT code-identity (the whole point of the differential Catch).
 * @param {string} recipeDir directory holding recipe.json (+ body files)
 * @param {{buildSha?:string, spawnFn?:PortForwardSpawnFn, execFn?:K8sExecRunner}} [opts] buildSha:
 *   an alternate from_tree SHA to build (defaults to code_identity.sha); spawnFn/execFn: injected
 *   kubectl seams for mode 'k8s-attach' (cluster-free unit tests)
 * @returns {Promise<SutHandle>}
 */
export async function conjure(recipeDir, opts = {}) {
  const recipe = loadRecipe(recipeDir);
  const ci = recipe.code_identity;
  const c = recipe.conjure;

  // k8s-attach owns no container and needs no docker daemon at all — dispatch (including its own
  // multi_repo identity handling) before the docker gate below (which stays run/compose-only).
  if (c.mode === 'k8s-attach') {
    return conjureK8sAttach(recipe, opts);
  }

  // multi_repo identity (the Lyric class) pairs with conjure.mode 'k8s-attach' ONLY — a from_tree/
  // pinned_image single-container build has no shape for repos[]/wheels[]/images[]. Every OTHER
  // conjure mode (run/compose, handled below) rejects it by name — never reading an undefined
  // from_tree/pinned_image field further down.
  if (ci.mode === 'multi_repo') {
    throw new Error(`conjure: code_identity.mode 'multi_repo' pairs with conjure.mode 'k8s-attach' only (got conjure.mode ${JSON.stringify(c.mode)})`);
  }

  const docker = detectDocker();
  if (!docker) throw new Error('conjure: docker is not available (`docker version` did not respond — is the daemon running?).');

  const buildSha = opts.buildSha;
  const baseUrl = `http://localhost:${c.published_port}`;

  /** @type {string|null} */ let containerName = null;
  /** @type {string|null} */ let cloneDir = null;
  /** @type {ComposeInfo|null} */ let composeInfo = null;
  let success = false;
  // Reap on interrupt too: the `finally` below reaps a thrown-error bring-up, but a Ctrl-C (SIGINT) /
  // orchestrator kill (SIGTERM) bypasses it and leaks the SUT. Register a best-effort reap of the
  // CURRENT bring-up state — the closure reads the live locals at signal time, so it reaps whatever is
  // up (partial or complete) — and de-register it on normal teardown. See reaper.mjs.
  const reap = () => cleanup(docker, containerName, cloneDir, composeInfo);
  registerReap(reap);
  try {
    /** @type {string} */ let image;
    /** @type {string|undefined} */ let imageDigest;
    /** @type {string|undefined} */ let sha;

    if (c.mode === 'compose') {
      // Compose class (documenso): bring the service graph up from the tree with the disclosed overlays.
      const bring = bringUpCompose(
        docker,
        recipe,
        recipeDir,
        (d) => { cloneDir = d; },
        (info) => { composeInfo = info; },
        buildSha
      );
      ({ image, imageDigest, sha } = bring);
      containerName = bring.containerName;
    } else {
      // Run class (n8n): a single container from the resolved image.
      ({ image, imageDigest, sha } = await resolveImage(docker, recipe, (d) => {
        cloneDir = d;
      }, buildSha));

      // Fresh world: a unique container name per conjure => fresh_world:recreate is a brand-new container.
      const runtag = Date.now().toString(36);
      containerName = `pb-sut-${slug(recipe.name)}-${runtag}`;
      const envArgs = Object.entries(c.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const run = docker.run(['run', '-d', '--name', containerName, '-p', `${c.published_port}:${c.container_port}`, ...envArgs, image], DOCKER_TIMEOUT_MS);
      if (run.status !== 0) throw new Error(`conjure: docker run failed (exit ${run.status}): ${tail(run.stderr || run.stdout)}`);
    }

    // Ready: poll the disclosed ready signal — the ready response IS the bring-up proof.
    const readyUrl = `${baseUrl}${c.ready_signal.path}`;
    const expect = c.ready_signal.expect_status;
    /** @type {number|null} */ let readyStatus = null;
    let lastSeen = 'no-response';
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const s = await probeStatus(readyUrl);
      lastSeen = s === null ? 'no-response' : String(s);
      if (s === expect) {
        readyStatus = s;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (readyStatus === null) throw new Error(`conjure: SUT did not answer ${readyUrl} with ${expect} within ${READY_TIMEOUT_MS / 1000}s (last: ${lastSeen})`);

    // setup_overlay: disclosed setup-time fixups (e.g. `apk add sqlite` for the store tap).
    for (const line of c.setup_overlay || []) {
      const ex = docker.run(['exec', '-u', 'root', containerName, 'sh', '-c', line], DOCKER_TIMEOUT_MS);
      if (ex.status !== 0) throw new Error(`conjure: setup_overlay "${line}" failed (exit ${ex.status}): ${tail(ex.stderr || ex.stdout)}`);
    }

    // auth_preflight + setup: a minimal cookie jar, ordered steps, captures.
    /** @type {Map<string,string>} */ const jar = new Map();
    if (recipe.auth_preflight) {
      await httpReq(recipe.auth_preflight.method, `${baseUrl}${recipe.auth_preflight.path}`, undefined, jar);
    }
    /** @type {Record<string,any>} */ const captures = {};
    /** @type {Record<string,any>} */ const bodyDerived = {};
    // The operator_env OBJECT form (G5, the Lyric class) has no REST steps to walk here — it is
    // not built by this bring-up (k8s-attach is guarded off above); the array form is the only
    // shape 'run'/'compose' ever produces.
    if (!Array.isArray(recipe.setup)) {
      throw new Error("conjure: setup as an operator_env object is not supported by mode 'run'/'compose' (array-form setup only)");
    }
    const setupSteps = recipe.setup;
    for (const step of setupSteps) {
      if (step.exec) {
        // An out-of-band SETUP-TIME store read (§6 fallback for a bootstrap value with no REST
        // route, e.g. a just-created team's id/url) — never the store_tap ground-truth read.
        const query = resolvePlaceholders(step.exec.query, (n) => captures[n]);
        const execRes = docker.run(['exec', step.exec.container, 'psql', '-U', step.exec.user, '-d', step.exec.db, '-At', '-F', '\t', '-c', query], DOCKER_TIMEOUT_MS);
        if (execRes.status !== 0) throw new Error(`conjure: setup step "${step.id}" (exec) failed (exit ${execRes.status}): ${tail(execRes.stderr || execRes.stdout)}`);
        const firstRow = (execRes.stdout || '').split('\n')[0] || '';
        const cols = firstRow.split('\t');
        if (step.capture) {
          for (const [name, col] of Object.entries(step.capture)) captures[name] = cols[/** @type {any} */ (col)];
        }
        continue;
      }
      const origin = step.origin ? resolvePlaceholders(step.origin, (n) => captures[n]) : baseUrl;
      const path = resolvePlaceholders(/** @type {string} */ (step.path), (n) => captures[n]);
      /** @type {Record<string,string>|undefined} */
      let headers;
      if (step.headers) {
        headers = {};
        for (const [hk, hv] of Object.entries(step.headers)) headers[hk] = resolvePlaceholders(hv, (n) => captures[n]);
      }
      let body;
      if (step.body_file !== undefined) body = JSON.parse(readFileSync(join(recipeDir, step.body_file), 'utf8'));
      else if (step.body !== undefined) body = step.body;
      if (body !== undefined) body = resolveBodyPlaceholders(body, (n) => captures[n]);
      if (body !== undefined) collectScalars(body, bodyDerived);
      const res = await httpReq(/** @type {string} */ (step.method), `${origin}${path}`, body, jar, step.content_type, { headers, files: step.files, recipeDir });
      // 2xx and 3xx both mean "the app accepted the request" (redirect: manual, so a 3xx here is
      // an unfollowed redirect, not a client error) — a Django-style form login answers a SUCCESSFUL
      // POST with 302 to LOGIN_REDIRECT_URL and only re-renders 200-with-errors on failure; treating
      // 3xx as a step failure would misreport that success as a setup error. Only 4xx/5xx fail.
      if (res.status < 200 || res.status >= 400) {
        throw new Error(`conjure: setup step "${step.id}" failed: HTTP ${res.status} ${tail(res.text, 300)}`);
      }
      if (step.capture) {
        for (const [name, cap] of Object.entries(step.capture)) {
          captures[name] = typeof cap === 'string' ? extractJsonPath(res.json, cap) : extractHtml(res.text, cap.pattern);
        }
      }
    }

    // Front door: resolve placeholders from captures, else a minted id in a setup body. In
    // compose mode a deferred-drive front door (documenso) mints no ids, so an unresolved
    // placeholder stays literal (informational URL) instead of throwing; run mode stays strict.
    // mode 'rest' (G6, the Lyric class) has no url_template at all — not built by this bring-up.
    if (typeof recipe.front_door.url_template !== 'string') {
      throw new Error("conjure: front_door.mode 'rest' (no url_template) is not supported by mode 'run'/'compose'");
    }
    const urlTemplate = recipe.front_door.url_template;
    const lookup = (/** @type {string} */ n) => captures[n] ?? bodyDerived[camelize(n)] ?? bodyDerived[n];
    const frontDoorUrl = `${baseUrl}${resolvePlaceholders(
      urlTemplate,
      c.mode === 'compose' ? (n) => lookup(n) ?? `{${n}}` : lookup
    )}`;

    // Identity + bring-up proof: minted (harness provenance) — the code running IS the code under test.
    const fingerprint = mint({
      id: 'fingerprint',
      kind: 'fingerprint',
      provenance: 'harness',
      data: {
        mode: ci.mode,
        ...(sha ? { sha } : {}),
        ...(imageDigest ? { image_digest: imageDigest } : {}),
        version_label: ci.version_label,
        image_ref_or_tag: image,
        container: containerName,
      },
    });
    const bringup = mint({
      id: 'bringup',
      kind: 'attempt',
      provenance: 'harness',
      data: { request: `GET ${readyUrl}`, status: readyStatus, ready: true },
    });

    /** @type {SutHandle} */
    const handle = {
      recipe,
      containerName,
      baseUrl,
      frontDoorUrl,
      captures,
      cookies: Array.from(jar, ([name, value]) => ({ name, value })),
      receipts: [fingerprint, bringup],
      _cloneDir: cloneDir,
      _compose: composeInfo,
      _reap: reap,
      teardown: () => teardownSut(handle),
    };
    success = true;
    return handle;
  } finally {
    // Success keeps `reap` registered (a later signal during the drive still reaps this SUT); normal
    // teardown de-registers it via handle._reap. A failed bring-up reaps here AND de-registers, so the
    // signal handler never re-runs it.
    if (!success) {
      deregisterReap(reap);
      await cleanup(docker, containerName, cloneDir, composeInfo);
    }
  }
}

/**
 * Reap a conjured SUT: compose mode `down -v`s the whole graph (services + volumes); run mode
 * removes the single container; k8s-attach kills its port-forward child processes (it never
 * created a cluster object, so there is nothing else to reap). Safe to call twice.
 * @param {SutHandle|null} [handle]
 * @returns {Promise<void>}
 */
export async function teardownSut(handle) {
  if (!handle) return;
  // Normal teardown: drop the interrupt-reap first so the signal handler cannot re-run it (cleanup is
  // idempotent, so a race is harmless either way), then reap.
  if (handle._reap) deregisterReap(handle._reap);
  if (handle._k8sAttach) {
    for (const f of handle._k8sAttach.forwards) {
      try {
        f.proc.kill();
      } catch {
        /* already gone */
      }
    }
    return;
  }
  await cleanup(detectDocker(), handle.containerName, handle._cloneDir, handle._compose);
}

// ---------------------------------------------------------------------------
// k8s-attach (the Lyric class): ATTACH to an existing k8s deploy — pb port-forwards named
// Services as its own child processes and NEVER creates or mutates a cluster object (ADR-0011
// Shape-A). Honesty is a MINT PRECONDITION (docs/pb-extensibility-foundation.md §3, P1/P3), not a
// verdict edit: mintK8sAttachIdentity/checkK8sAttachDrift THROW (naming the precondition) rather
// than mint a satisfying receipt — the caller's existing could-not-execute → executed:false → CND
// handling (catch.mjs) does the rest, with zero frozen-core changes.
// ---------------------------------------------------------------------------

const K8S_GET_TIMEOUT_MS = 30000;
const PORT_FORWARD_READY_TIMEOUT_MS = 15000;

/**
 * A blocking kubectl call (`get pods`, …) — mirrors argoworkflows.mjs's KubectlRunner. Injected via
 * opts.execFn so digest/restart reads run WITHOUT a cluster; the default shells to the real kubectl.
 * @typedef {Object} K8sExecRunner
 * @property {(args:string[], timeoutMs:number) => import('node:child_process').SpawnSyncReturns<string>} run
 */

/** @returns {K8sExecRunner} the real kubectl child_process runner */
function defaultK8sExec() {
  return {
    run: (args, timeoutMs) => spawnSync('kubectl', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER }),
  };
}

/**
 * A long-lived `kubectl port-forward` child process. Injected via opts.spawnFn so port-forward
 * bring-up is exercised WITHOUT a cluster; the default shells to the real kubectl.
 * @typedef {Object} PortForwardHandle
 * @property {number} [pid]
 * @property {() => void} kill
 * @property {(onData:(chunk:string)=>void) => void} onStdout
 * @property {(onExit:(code:number|null)=>void) => void} [onExit]
 * @property {(onError:(err:Error)=>void) => void} [onError]
 */
/** @typedef {(args:string[]) => PortForwardHandle} PortForwardSpawnFn */

/** @returns {PortForwardSpawnFn} the real `kubectl port-forward` spawner */
function defaultPortForwardSpawn() {
  return (args) => {
    const child = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    /** @type {((code:number|null)=>void)[]} */
    const exitListeners = [];
    /** @type {((err:Error)=>void)[]} */
    const errorListeners = [];
    child.on('exit', (code) => {
      for (const l of exitListeners) l(code);
    });
    child.on('error', (err) => {
      for (const l of errorListeners) l(err);
    });
    return {
      pid: child.pid,
      kill: () => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      },
      onStdout: (onData) => {
        if (child.stdout) child.stdout.on('data', (d) => onData(String(d)));
      },
      onExit: (l) => exitListeners.push(l),
      onError: (l) => errorListeners.push(l),
    };
  };
}

/**
 * Wait for a port-forward to confirm readiness — kubectl writes "Forwarding from …" to stdout the
 * instant the tunnel is live (the same "the bring-up response IS the proof" stance run/compose use
 * for their HTTP ready signal, generalized to a non-HTTP attach). Rejects, naming the service, if
 * the process exits/errors first or the confirmation never arrives within the bound.
 * @param {PortForwardHandle} proc
 * @param {import('./recipe.mjs').K8sAttachService} svc
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export function waitForPortForwardReady(proc, svc, timeoutMs = PORT_FORWARD_READY_TIMEOUT_MS) {
  return new Promise((resolveReady, reject) => {
    let settled = false;
    const to = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`conjure: k8s-attach port-forward to ${svc.name} did not confirm readiness ("Forwarding from") within ${timeoutMs}ms`));
    }, timeoutMs);
    proc.onStdout((chunk) => {
      if (settled || !/Forwarding from/i.test(chunk)) return;
      settled = true;
      clearTimeout(to);
      resolveReady();
    });
    if (proc.onExit) {
      proc.onExit((code) => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        reject(new Error(`conjure: k8s-attach port-forward to ${svc.name} exited early (code ${code}) before confirming readiness`));
      });
    }
    if (proc.onError) {
      proc.onError((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        reject(new Error(`conjure: k8s-attach port-forward to ${svc.name} failed to start: ${err.message}`));
      });
    }
  });
}

/**
 * The pod names present in a `kubectl get pods -o json` list, sorted.
 * @param {any} poList
 * @returns {string[]}
 */
export function podNamesFrom(poList) {
  const items = poList && Array.isArray(poList.items) ? poList.items : [];
  /** @type {string[]} */
  const names = [];
  for (const pod of items) {
    if (pod && pod.metadata && typeof pod.metadata.name === 'string' && pod.metadata.name) names.push(pod.metadata.name);
  }
  return names.sort();
}

/**
 * The resolved `sha256:` digests of every (init or regular) container observed across a
 * `kubectl get pods -o json` list, deduped and sorted.
 * @param {any} poList
 * @returns {string[]}
 */
export function podDigestsFrom(poList) {
  const items = poList && Array.isArray(poList.items) ? poList.items : [];
  /** @type {Set<string>} */
  const digests = new Set();
  for (const pod of items) {
    const st = (pod && pod.status) || {};
    const statuses = [...(st.containerStatuses || []), ...(st.initContainerStatuses || [])];
    for (const cs of statuses) {
      const d = normalizeDigest(cs && cs.imageID);
      if (d) digests.add(d);
    }
  }
  return Array.from(digests).sort();
}

/**
 * Per-container restart counts across a `kubectl get pods -o json` list, keyed
 * `${podName}/${containerName}` — the drift sentinel's raw material.
 * @param {any} poList
 * @returns {Record<string,number>}
 */
export function podRestartCountsFrom(poList) {
  const items = poList && Array.isArray(poList.items) ? poList.items : [];
  /** @type {Record<string,number>} */
  const out = {};
  for (const pod of items) {
    const name = pod && pod.metadata && pod.metadata.name;
    if (typeof name !== 'string' || !name) continue;
    const st = (pod && pod.status) || {};
    const statuses = [...(st.containerStatuses || []), ...(st.initContainerStatuses || [])];
    for (const cs of statuses) {
      if (!cs || typeof cs.name !== 'string' || !cs.name) continue;
      out[`${name}/${cs.name}`] = typeof cs.restartCount === 'number' ? cs.restartCount : 0;
    }
  }
  return out;
}

/**
 * Read a point-in-time {@link ClusterSnapshot} of every pod in the attached namespace — a
 * store-DIRECT `kubectl get pods` read, never through an app endpoint.
 * @param {K8sExecRunner} execFn
 * @param {{kubeContext:string, namespace:string}} kubeArgs
 * @returns {Promise<ClusterSnapshot>}
 */
async function snapshotCluster(execFn, { kubeContext, namespace }) {
  const res = execFn.run(['--context', kubeContext, '-n', namespace, 'get', 'pods', '-o', 'json'], K8S_GET_TIMEOUT_MS);
  if (res.error) throw new Error(`conjure: k8s-attach kubectl get pods failed to run: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`conjure: k8s-attach kubectl get pods failed (exit ${res.status}): ${tail(res.stderr || res.stdout)}`);
  let list;
  try {
    list = JSON.parse((res.stdout || '').trim());
  } catch (e) {
    throw new Error(`conjure: k8s-attach could not parse 'get pods -o json' output: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    pods: podNamesFrom(list),
    digests: podDigestsFrom(list),
    restarts: podRestartCountsFrom(list),
    imageRefs: podImageRefsFrom(list),
  };
}

/**
 * The {ref, digest} pairs observed across every (init or regular) container in a `kubectl get pods
 * -o json` list — `ref` is that SAME container's OWN requested image (`spec.containers[].image` /
 * `spec.initContainers[].image`, matched by container name; falls back to `status.containerStatuses[].image`
 * when no spec is present, e.g. a test fixture), `digest` is the resolved `sha256:` digest
 * (`status.containerStatuses[].imageID`). A container with no resolvable digest is skipped (nothing to
 * bind against). Used by {@link expectedImagesBind}'s ref-matching path.
 * @param {any} poList
 * @returns {{ref:string, digest:string}[]}
 */
export function podImageRefsFrom(poList) {
  const items = poList && Array.isArray(poList.items) ? poList.items : [];
  /** @type {{ref:string, digest:string}[]} */
  const out = [];
  for (const pod of items) {
    const spec = (pod && pod.spec) || {};
    const st = (pod && pod.status) || {};
    const specContainers = [...(spec.containers || []), ...(spec.initContainers || [])];
    const statuses = [...(st.containerStatuses || []), ...(st.initContainerStatuses || [])];
    for (const cs of statuses) {
      if (!cs) continue;
      const digest = normalizeDigest(cs.imageID);
      if (!digest) continue;
      const specC = typeof cs.name === 'string' ? specContainers.find((c) => c && c.name === cs.name) : undefined;
      const ref = (specC && typeof specC.image === 'string' && specC.image) || (typeof cs.image === 'string' ? cs.image : '');
      if (ref) out.push({ ref, digest });
    }
  }
  return out;
}

/** @param {string} ref @returns {string} strip a trailing `@sha256:...` digest, if present */
function stripDigestSuffix(ref) {
  return String(ref || '').replace(/@sha256:[0-9a-f]{64}/i, '');
}

/**
 * Split a digestless image ref into {repo, tag} — the LAST `:` after the LAST `/` is the tag
 * (so a `host:port/repo` registry address is never mistaken for a tag); a ref with no such `:`
 * has an undefined tag (a bare repo reference).
 * @param {string} ref
 * @returns {{repo:string, tag:string|undefined}}
 */
function splitRepoTag(ref) {
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  if (lastColon > lastSlash) return { repo: ref.slice(0, lastColon), tag: ref.slice(lastColon + 1) };
  return { repo: ref, tag: undefined };
}

/**
 * The CODE-IDENTITY mint precondition (P1/P4, docs/pb-extensibility-foundation.md §3): every
 * recipe-declared `conjure.expected_images` entry must BIND to a running pod:
 *   - an entry carrying an explicit `@sha256:` digest binds ONLY on that exact digest actually
 *     being observed running (unchanged prior behavior).
 *   - a DIGESTLESS entry (the Lyric class: `git_tag_overwrite` dev-build tags, never a stable
 *     digest, live in the recipe) binds by REPO+TAG against a running pod's OWN requested image ref
 *     (an untagged entry matches by repo alone) — the OBSERVED digest for that SAME container is
 *     what actually gets sealed (mintK8sAttachIdentity), never the recipe's claimed tag.
 * No match (either form) is `unbound` — never WORKS-capable (§4.3's binding ladder; fail-safe: a
 * base-skewed cluster refuses to mint rather than seal a wrong identity).
 * @param {string[]} observedDigests
 * @param {string[]} expectedImages
 * @param {{ref:string, digest:string}[]} [observedRefs] per-container {ref,digest} pairs (see
 *   {@link podImageRefsFrom}) — required only for the digestless ref-matching path; omitted callers
 *   (or a digest-only expected_images list) are unaffected.
 * @returns {{bound:boolean, reason?:string}}
 */
export function expectedImagesBind(observedDigests, expectedImages, observedRefs = []) {
  const observed = new Set(observedDigests);
  /** @type {string[]} */
  const problems = [];
  for (const ref of expectedImages) {
    const digest = normalizeDigest(ref);
    if (digest) {
      if (!observed.has(digest)) {
        problems.push(`${ref} — digest ${digest} was not observed running on any attached pod`);
      }
      continue;
    }
    // Digestless: bind by REPO+TAG against a running pod's own requested image ref — the recipe's
    // tag is an EXPECTATION, never sealed itself (the observed digest is what gets sealed).
    const expected = splitRepoTag(stripDigestSuffix(ref));
    const matched = observedRefs.some((o) => {
      const obs = splitRepoTag(stripDigestSuffix(o.ref));
      return expected.tag !== undefined ? obs.repo === expected.repo && obs.tag === expected.tag : obs.repo === expected.repo;
    });
    if (!matched) {
      problems.push(
        `${ref} names no sha256 digest and matched no running pod's image ref by repo${expected.tag !== undefined ? '+tag' : ''} — unbound, never WORKS-capable`
      );
    }
  }
  return problems.length ? { bound: false, reason: problems.join('; ') } : { bound: true };
}

/**
 * The DRIFT SENTINEL comparison: because k8s-attach NEVER creates or mutates a cluster object, pb
 * itself can cause none of a pod-set change, a running-digest change, or a restart-count increase —
 * so ANY observed delta between two snapshots is by construction un-caused (a reconciler re-render,
 * a reschedule, a crash-restart) and must CND, never be misread as a false DOES_NOT_WORK.
 * @param {ClusterSnapshot} before
 * @param {ClusterSnapshot} after
 * @returns {{drifted:boolean, reason?:string}}
 */
export function detectDrift(before, after) {
  /** @type {string[]} */
  const reasons = [];
  if (before.pods.join(',') !== after.pods.join(',')) {
    reasons.push(`pod set changed (before=[${before.pods.join(', ')}] after=[${after.pods.join(', ')}]) — likely rescheduled/reconciled`);
  }
  if (before.digests.join(',') !== after.digests.join(',')) {
    reasons.push(`running image digest(s) changed (before=[${before.digests.join(', ')}] after=[${after.digests.join(', ')}]) — likely reconciled to a different ref`);
  }
  for (const [key, beforeCount] of Object.entries(before.restarts)) {
    const afterCount = after.restarts[key];
    if (typeof afterCount === 'number' && afterCount > beforeCount) {
      reasons.push(`${key} restart count increased (${beforeCount} -> ${afterCount})`);
    }
  }
  return reasons.length ? { drifted: true, reason: reasons.join('; ') } : { drifted: false };
}

/**
 * The `{<slug>_host}`/`{<slug>_port}` placeholders a k8s-attach `front_door.base_url_template`
 * (mode 'rest') resolves against — one pair per recipe-declared `conjure.services[]` entry, the
 * slug DERIVED (never hardcoded) from the k8s Service name's own last path segment (e.g.
 * `svc/appservice` -> `appservice_host`/`appservice_port`; non-alnum runs collapsed to `_` so
 * `svc/mongodb-svc` still yields a valid placeholder identifier, `mongodb_svc_host`). Every
 * k8s-attach service is reached through pb's OWN port-forward, so the host is always `localhost`.
 * @param {import('./recipe.mjs').K8sAttachService[]} services
 * @returns {Record<string,string|number>}
 */
function k8sServicePlaceholders(services) {
  /** @type {Record<string,string|number>} */
  const out = {};
  for (const svc of services) {
    const last = String(svc.name).split('/').pop() || svc.name;
    const slug = last.replace(/[^a-zA-Z0-9]+/g, '_');
    out[`${slug}_host`] = 'localhost';
    out[`${slug}_port`] = svc.local_port;
  }
  return out;
}

/**
 * Bring up a k8s-attach SUT: port-forward the recipe's declared Services as pb-owned child
 * processes (registered with the reaper) — NEVER creating or mutating a cluster object. Mints only
 * the 'bringup' receipt here; the code-identity 'fingerprint' is deferred to
 * {@link mintK8sAttachIdentity} (a mint PRECONDITION, not a bring-up fact — the DRIVE-TIME digest
 * read is what gets sealed, never this attach-time one, per P1/F2/F3: the running image can be
 * reconciled/swapped between attach and drive).
 * @param {import('./recipe.mjs').Recipe} recipe
 * @param {{spawnFn?:PortForwardSpawnFn, execFn?:K8sExecRunner}} opts
 * @returns {Promise<SutHandle>}
 */
async function conjureK8sAttach(recipe, opts) {
  const c = recipe.conjure;
  const services = /** @type {import('./recipe.mjs').K8sAttachService[]} */ (/** @type {any} */ (c).services);
  const kubeArgs = {
    kubeContext: /** @type {string} */ (/** @type {any} */ (c).kube_context),
    namespace: /** @type {string} */ (/** @type {any} */ (c).namespace),
  };
  const spawnFn = opts.spawnFn || defaultPortForwardSpawn();
  const execFn = opts.execFn || defaultK8sExec();

  /** @type {{svc:import('./recipe.mjs').K8sAttachService, proc:PortForwardHandle}[]} */
  const forwards = [];
  let success = false;
  // Reap on interrupt too (mirrors run/compose): the closure reads the live `forwards` array at
  // signal time, so it kills whatever is up (partial or complete); killing an already-dead process
  // is a no-op, so a double-kill from normal teardown racing the handler is harmless.
  const reap = () => {
    for (const f of forwards) {
      try {
        f.proc.kill();
      } catch {
        /* already gone */
      }
    }
  };
  registerReap(reap);
  try {
    for (const svc of services) {
      const proc = spawnFn(['port-forward', '--context', kubeArgs.kubeContext, '-n', kubeArgs.namespace, svc.name, `${svc.local_port}:${svc.remote_port}`]);
      forwards.push({ svc, proc });
      await waitForPortForwardReady(proc, svc);
    }

    // Attach-time snapshot: recorded for diagnostics; the code-identity BINDING check is
    // drive-time only (mintK8sAttachIdentity) — never this one (F2/F3).
    const attachSnapshot = await snapshotCluster(execFn, kubeArgs);

    let baseUrl = `http://localhost:${services[0].local_port}`;
    const fd = recipe.front_door;
    /** @type {string} */
    let frontDoorUrl;
    if (fd.mode === 'rest') {
      // The Lyric class: no single user-facing page — the door is a REST base (resolved against
      // every port-forwarded Service, {slug_host}/{slug_port}) + a disclosed entrypoint the DRIVE
      // fires at drive time (catch.mjs), never here (the entrypoint's own placeholders are
      // operator_env values, not known at conjure time). frontDoorUrl mirrors the resolved base —
      // there is no separate page to point at.
      const svcPlaceholders = k8sServicePlaceholders(services);
      baseUrl = resolvePlaceholders(/** @type {string} */ (fd.base_url_template), (n) => svcPlaceholders[n]);
      frontDoorUrl = baseUrl;
    } else {
      // No REST setup dance runs for k8s-attach (operator_env, not steps) — an unresolved
      // placeholder stays literal for a later drive slice to fill, mirroring compose's
      // deferred-drive leniency.
      const literalLookup = (/** @type {string} */ n) => `{${n}}`;
      frontDoorUrl = `${baseUrl}${resolvePlaceholders(/** @type {string} */ (fd.url_template), literalLookup)}`;
    }

    const bringup = mint({
      id: 'bringup',
      kind: 'attempt',
      provenance: 'harness',
      data: {
        request: `port-forward ${services.map((s) => s.name).join(', ')}`,
        services: services.map((s) => ({ name: s.name, local_port: s.local_port, remote_port: s.remote_port })),
        ready: true,
      },
    });

    /** @type {SutHandle} */
    const handle = {
      recipe,
      containerName: null,
      baseUrl,
      frontDoorUrl,
      captures: {},
      cookies: [],
      receipts: [bringup],
      _cloneDir: null,
      _compose: null,
      _reap: reap,
      _k8sAttach: { execFn, kubeArgs, attachSnapshot, driveSnapshot: null, forwards },
      teardown: () => teardownSut(handle),
    };
    success = true;
    return handle;
  } finally {
    if (!success) {
      deregisterReap(reap);
      for (const f of forwards) {
        try {
          f.proc.kill();
        } catch {
          /* already gone */
        }
      }
    }
  }
}

/**
 * The CODE-IDENTITY mint precondition (P1, docs/pb-extensibility-foundation.md §3): read the pod
 * imageID digests AT DRIVE TIME — never the attach-time snapshot (F2/F3: the running image can be
 * reconciled/swapped between attach and drive) — and require every recipe-declared
 * `conjure.expected_images` entry to bind (see {@link expectedImagesBind}). An unbound entry
 * REFUSES to mint: the caller gets no satisfying fingerprint, so the run degrades to an honest CND
 * (never a false WORKS sealed against a base-skewed pod). The drive-time snapshot becomes the
 * drift sentinel's "before the verdict window" baseline for {@link checkK8sAttachDrift}.
 * @param {SutHandle} handle a handle {@link conjure} returned for a k8s-attach recipe
 * @returns {Promise<import('./types.mjs').Receipt>} the minted harness 'fingerprint' receipt
 */
export async function mintK8sAttachIdentity(handle) {
  const attach = handle._k8sAttach;
  if (!attach) throw new Error('conjure: mintK8sAttachIdentity called on a non-k8s-attach handle');
  const driveSnapshot = await snapshotCluster(attach.execFn, attach.kubeArgs);
  const expectedImages = /** @type {any} */ (handle.recipe.conjure).expected_images || [];
  if (expectedImages.length) {
    const { bound, reason } = expectedImagesBind(driveSnapshot.digests, expectedImages, driveSnapshot.imageRefs);
    if (!bound) {
      throw new Error(`conjure: k8s-attach code-identity refuses to mint — base-skew: ${reason}`);
    }
  }
  const ci = handle.recipe.code_identity;
  // multi_repo (the Lyric class): seal the recipe's OWN repos[]/wheels[] declarations alongside the
  // DRIVE-TIME observed digests above — the recipe's images[].tag claims are expectations only and
  // are NEVER what gets sealed here (the running digest is).
  const multiRepoIdentity =
    ci.mode === 'multi_repo'
      ? {
          repos: /** @type {import('./recipe.mjs').MultiRepoIdentity} */ (ci).repos,
          wheels: /** @type {import('./recipe.mjs').MultiRepoIdentity} */ (ci).wheels,
        }
      : {};
  const fingerprint = mint({
    id: 'fingerprint',
    kind: 'fingerprint',
    provenance: 'harness',
    data: {
      mode: 'k8s-attach',
      code_identity_mode: ci.mode,
      kube_context: attach.kubeArgs.kubeContext,
      namespace: attach.kubeArgs.namespace,
      drive_time_digests: driveSnapshot.digests,
      expected_images: expectedImages,
      ...multiRepoIdentity,
    },
  });
  handle.receipts.push(fingerprint);
  attach.driveSnapshot = driveSnapshot;
  return fingerprint;
}

/**
 * The DRIFT SENTINEL mint precondition: re-read the same snapshot (pod set, digests, per-container
 * restart counts) AFTER the verdict window closes and compare it to the drive-time baseline
 * {@link mintK8sAttachIdentity} recorded, via {@link detectDrift}. Any un-caused change refuses to
 * confirm — CND naming reconcile-drift, never a false DOES_NOT_WORK.
 * @param {SutHandle} handle
 * @returns {Promise<void>} resolves when no drift is detected; throws (naming reconcile-drift) otherwise
 */
export async function checkK8sAttachDrift(handle) {
  const attach = handle._k8sAttach;
  if (!attach) throw new Error('conjure: checkK8sAttachDrift called on a non-k8s-attach handle');
  if (!attach.driveSnapshot) throw new Error('conjure: checkK8sAttachDrift called before mintK8sAttachIdentity (no drive-time baseline snapshot)');
  const after = await snapshotCluster(attach.execFn, attach.kubeArgs);
  const { drifted, reason } = detectDrift(attach.driveSnapshot, after);
  if (drifted) {
    throw new Error(`conjure: k8s-attach drift sentinel — reconcile-drift: ${reason}`);
  }
}

/**
 * @param {Docker|null} docker
 * @param {string|null} containerName
 * @param {string|null} cloneDir
 * @param {ComposeInfo|null} [compose] when set, reap the compose graph via `down -v` instead of `rm -f`
 */
async function cleanup(docker, containerName, cloneDir, compose = null) {
  if (docker) {
    if (compose) {
      // Reap the whole graph + volumes; runs BEFORE the checkout is removed (the -f files live
      // in it). No-op if nothing came up. Failure still lets the checkout reap in the finally.
      docker.run(composeArgv(compose.project, compose.files, ['down', '-v']), DOCKER_TIMEOUT_MS);
    } else if (containerName) {
      docker.run(['rm', '-f', containerName], DOCKER_TIMEOUT_MS); // no-op if already gone
    }
  }
  if (cloneDir) {
    try {
      rmSync(cloneDir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}
