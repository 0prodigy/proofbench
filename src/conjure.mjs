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

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadRecipe } from './recipe.mjs';
import { mint } from './harness.mjs';
import { registerReap, deregisterReap } from './reaper.mjs';

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
 * @property {string} containerName the fresh-world container (unique per conjure)
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
 * @property {() => Promise<void>} teardown
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
 * Walk a simple `$.a.b` JSONPath (the capture syntax). Non-`$` paths and off-path reads
 * return undefined.
 * @param {any} obj
 * @param {string} path
 * @returns {any}
 */
export function extractJsonPath(obj, path) {
  if (typeof path !== 'string' || path[0] !== '$') return undefined;
  let cur = obj;
  for (const key of path.slice(1).split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
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
 * @param {{buildSha?:string}} [opts] buildSha: an alternate from_tree SHA to build (defaults to code_identity.sha)
 * @returns {Promise<SutHandle>}
 */
export async function conjure(recipeDir, opts = {}) {
  const recipe = loadRecipe(recipeDir);
  const docker = detectDocker();
  if (!docker) throw new Error('conjure: docker is not available (`docker version` did not respond — is the daemon running?).');

  const ci = recipe.code_identity;
  const c = recipe.conjure;
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
    for (const step of recipe.setup) {
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
    const lookup = (/** @type {string} */ n) => captures[n] ?? bodyDerived[camelize(n)] ?? bodyDerived[n];
    const frontDoorUrl = `${baseUrl}${resolvePlaceholders(
      recipe.front_door.url_template,
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
 * removes the single container. Both also reap the from-tree checkout. Safe to call twice.
 * @param {SutHandle|null} [handle]
 * @returns {Promise<void>}
 */
export async function teardownSut(handle) {
  if (!handle) return;
  // Normal teardown: drop the interrupt-reap first so the signal handler cannot re-run it (cleanup is
  // idempotent, so a race is harmless either way), then reap.
  if (handle._reap) deregisterReap(handle._reap);
  await cleanup(detectDocker(), handle.containerName, handle._cloneDir, handle._compose);
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
