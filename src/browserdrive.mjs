// @ts-check
/**
 * The REPO-AGNOSTIC BROWSER-DRIVE primitive — drive a conjured SUT's front door through a
 * REAL browser and mint the attempt receipt the verdict later adjudicates. This is the
 * user-shaped drive leg (§0 rule 1 / §7 attempted-action): a walk performed through the
 * app's OWN rendered surface, so its receipt is TOOL provenance — trusted more than a raw
 * agent claim (pb actually performed each fetch and recorded the real outcome) but NEVER
 * 'harness'. Ground truth stays the out-of-band store tap (storetap.mjs, harness). This
 * module DECIDES no verdict — it only drives and mints; the caller (M6) brackets the walk
 * with two store taps.
 *
 * The browser lives in a CONTAINER, never in pb: a pinned `selenium/standalone-chromium`
 * sidecar (`selenium/standalone-chromium:4.27.0`) booted with `docker run -d --rm -p
 * <hostport>:4444 --shm-size=2g` (the `--shm-size=2g` is REQUIRED — Chrome crashes at the
 * default 64MB /dev/shm). It is driven over W3C WebDriver as plain JSON over `fetch`, so pb
 * takes NO browser dependency (Playwright-as-pb-dep was rejected); the browser deps are
 * customer-portable, containerized exactly like the SUT. openBrowser boots the sidecar,
 * polls its /status readiness, opens a headless-chrome session, and returns a small CLIENT
 * of primitive ops (navigate/find/click/type/text/execute) the CALLER SCRIPTS — the walk
 * (which selector, what text) is AGENT-PROPOSED and passed in, never read from recipe data
 * (that avoids the Gherkin grave). The recipe declares only `drive.mode:'browser'` + the
 * front-door URL (already resolved into handle.frontDoorUrl by conjure).
 *
 * mintDriveAttempt turns the recorded walk + DOM observations into a TOOL attempt receipt
 * via the harness mint() (the only path off 'agent'); passing provenance:'tool' preserves
 * tool, anything else floors to harness (harness.mjs). This mints evidence only.
 *
 * Zero runtime deps: docker via child_process (mirroring conjure.mjs/storetap.mjs) + the
 * Node built-in global fetch for WebDriver.
 */

import { spawnSync } from 'node:child_process';
import { mint } from './harness.mjs';

/** The PINNED chromium sidecar image — a specific tag, never :latest (recorded here). */
export const CHROMIUM_IMAGE = 'selenium/standalone-chromium:4.27.0';

const CHROMIUM_PORT = 4444; // the WebDriver port inside the selenium container
const DEFAULT_HOST_PORT = 4444; // host port the sidecar is published on (override per run)
const STATUS_TIMEOUT_MS = 60000; // the chromium node takes a few seconds to register as ready
const STATUS_POLL_INTERVAL_MS = 1000;
const STATUS_PROBE_TIMEOUT_MS = 3000;
const WD_TIMEOUT_MS = 30000; // a single WebDriver command (navigate/click) — generous for page loads
const DOCKER_TIMEOUT_MS = 120000;
const PULL_TIMEOUT_MS = 300000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** The W3C element-reference key every find-element response wraps the opaque id in. */
const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/** The session capabilities — headless chrome, exactly the disclosed sandbox-safe args. */
const SESSION_BODY = Object.freeze({
  capabilities: {
    alwaysMatch: {
      browserName: 'chrome',
      'goog:chromeOptions': { args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] },
    },
  },
});

/**
 * A docker runner — mirrors conjure.mjs/storetap.mjs's Docker seam. Injected in tests so the
 * primitive is exercised docker-free; the default shells out to the real `docker` CLI.
 * @typedef {Object} DockerRunner
 * @property {(args:string[], timeoutMs:number) => import('node:child_process').SpawnSyncReturns<string>} run
 */

/**
 * A minimal fetch response the WebDriver calls read. Node's global fetch Response is
 * structurally compatible; a fake is injected in tests so the client is exercised network-free.
 * @typedef {Object} WdResponse
 * @property {boolean} ok
 * @property {number} status
 * @property {() => Promise<any>} json
 */

/** @typedef {(url:string, init?:any) => Promise<WdResponse>} Fetcher */

/**
 * A recorded op in the driven walk — the HARNESS-captured outcome of an AGENT-PROPOSED step
 * (op + its arguments + what the DOM returned). The steps array is the raw walk the caller
 * hands to mintDriveAttempt; each field is what actually happened, not what the agent claimed.
 * @typedef {{ op: string } & Record<string, any>} DriveStep
 */

/**
 * The primitive-op client openBrowser returns — the caller scripts the walk against it.
 * @typedef {Object} BrowserClient
 * @property {string} containerName the chromium sidecar container (unique per open)
 * @property {number} hostPort the host port the sidecar is published on
 * @property {string} sessionId the W3C session
 * @property {DriveStep[]} steps the recorded walk (raw observations for the caller)
 * @property {(url:string)=>Promise<void>} navigate GET-navigate the browser (host localhost rewritten)
 * @property {(css:string)=>Promise<string>} find find one element by CSS → its W3C element id
 * @property {(elementId:string)=>Promise<void>} click click a found element
 * @property {(elementId:string, text:string)=>Promise<void>} type send keys to a found element
 * @property {(elementId:string)=>Promise<string>} text read an element's rendered text
 * @property {(script:string, args?:any[])=>Promise<any>} execute run JS in the page (the canvas/escape hatch)
 * @property {()=>Promise<void>} teardown DELETE the session then `docker rm -f` the sidecar (idempotent)
 */

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; docker-free, network-free)
// ---------------------------------------------------------------------------

/**
 * Rewrite a HOST-facing localhost/127.0.0.1 URL so it resolves from INSIDE the chromium
 * container, where `localhost` is the container itself, not the host. The SUT is published on
 * the host at localhost:<published_port>; the browser must reach it via host.docker.internal.
 * A non-loopback host is left untouched.
 * @param {string} url
 * @returns {string}
 */
export function hostToContainer(url) {
  // ponytail: host.docker.internal works on Docker Desktop (macOS/Windows) and Docker Engine
  // on Linux; add --add-host=host.docker.internal:host-gateway / a shared docker network for
  // bare-Linux CI where it does not resolve by default.
  return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/i, '$1host.docker.internal');
}

/**
 * Extract the opaque element id from a W3C find-element `value` object. Returns undefined when
 * the value is not an element reference (e.g. an empty match).
 * @param {any} value the `value` field of a find-element response
 * @returns {string|undefined}
 */
export function elementIdFrom(value) {
  if (!value || typeof value !== 'object') return undefined;
  const id = value[W3C_ELEMENT_KEY];
  return typeof id === 'string' && id ? id : undefined;
}

/** @param {string} [s] @param {number} [n] */
function tail(s, n = 400) {
  s = s || '';
  return s.length > n ? s.slice(-n) : s;
}

/** @param {string} s @param {number} n keep the HEAD (for a long script in the step log) */
function head(s, n = 160) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {string} url @returns {string} the pathname for a terse error, host/session elided */
function wdPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Docker + WebDriver-over-fetch (child_process + global fetch)
// ---------------------------------------------------------------------------

/** @returns {DockerRunner} the real docker child_process runner */
function defaultDocker() {
  return {
    run: (args, timeoutMs) =>
      spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER }),
  };
}

/**
 * One WebDriver command as JSON over fetch. POSTs/GETs/DELETEs the endpoint, parses the
 * `{value}` envelope, and throws (naming the endpoint + the WebDriver error) on a non-2xx —
 * a WebDriver error is exceptional, so it propagates to the caller's try/finally rather than
 * being swallowed. Returns the unwrapped `value`.
 * @param {Fetcher} fetchFn
 * @param {'GET'|'POST'|'DELETE'} method
 * @param {string} url
 * @param {any} [body] JSON body for POST (omit for GET/DELETE)
 * @returns {Promise<any>}
 */
async function wd(fetchFn, method, url, body) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), WD_TIMEOUT_MS);
  try {
    /** @type {any} */
    const init = { method, signal: controller.signal };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetchFn(url, init);
    let json;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const err = (json && json.value) || {};
      throw new Error(
        `browserdrive: ${method} ${wdPath(url)} failed (HTTP ${res.status}${err.error ? ` ${err.error}` : ''}): ${tail(String(err.message || ''))}`
      );
    }
    return json ? json.value : undefined;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Poll the sidecar's /status until the node reports ready. The /status envelope is
 * `{value:{ready:boolean,...}}`; an unreachable sidecar (still booting) reads as not-ready.
 * @param {Fetcher} fetchFn
 * @param {string} statusUrl
 * @returns {Promise<boolean>}
 */
async function probeReady(fetchFn, statusUrl) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(statusUrl, { signal: controller.signal });
    const json = await res.json();
    return !!(json && json.value && json.value.ready);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** @param {DockerRunner} docker @param {string} containerName reap the sidecar (no-op if gone) */
function reap(docker, containerName) {
  docker.run(['rm', '-f', containerName], DOCKER_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// openBrowser / mintDriveAttempt
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BrowserOpts
 * @property {string} [image] pinned chromium image (defaults to {@link CHROMIUM_IMAGE})
 * @property {number} [hostPort] host port to publish the sidecar's 4444 on (default 4444)
 * @property {DockerRunner} [docker] injected for docker-free tests
 * @property {Fetcher} [fetchFn] injected for network-free tests
 */

/**
 * Boot a pinned chromium sidecar and open a headless W3C WebDriver session, returning a
 * primitive-op client the caller scripts. Pulls the pinned image, `docker run -d --rm …
 * --shm-size=2g`s it (the shm-size is required or Chrome crashes), polls /status to ready,
 * then POSTs /session. A failure during boot reaps the partial sidecar before throwing; on
 * success the sidecar stays up until the client's teardown().
 * @param {BrowserOpts} [opts]
 * @returns {Promise<BrowserClient>}
 */
export async function openBrowser(opts = {}) {
  const docker = opts.docker || defaultDocker();
  const fetchFn = opts.fetchFn || /** @type {Fetcher} */ (/** @type {unknown} */ (fetch));
  const image = opts.image || CHROMIUM_IMAGE;
  const hostPort = opts.hostPort || DEFAULT_HOST_PORT;
  const containerName = `pb-chromium-${Date.now().toString(36)}`;
  const origin = `http://localhost:${hostPort}`;

  const pull = docker.run(['pull', image], PULL_TIMEOUT_MS);
  if (pull.status !== 0) throw new Error(`browserdrive: docker pull ${image} failed (exit ${pull.status}): ${tail(pull.stderr || pull.stdout)}`);

  const run = docker.run(
    ['run', '-d', '--rm', '--name', containerName, '-p', `${hostPort}:${CHROMIUM_PORT}`, '--shm-size=2g', image],
    DOCKER_TIMEOUT_MS
  );
  if (run.status !== 0) throw new Error(`browserdrive: docker run ${image} failed (exit ${run.status}): ${tail(run.stderr || run.stdout)}`);

  try {
    // Ready: poll /status — the sidecar answers before the chromium node has registered.
    let ready = false;
    const deadline = Date.now() + STATUS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await probeReady(fetchFn, `${origin}/status`)) {
        ready = true;
        break;
      }
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
    if (!ready) throw new Error(`browserdrive: chromium sidecar did not report ready at ${origin}/status within ${STATUS_TIMEOUT_MS / 1000}s`);

    // Session: headless chrome with the disclosed sandbox-safe args.
    const session = await wd(fetchFn, 'POST', `${origin}/session`, SESSION_BODY);
    const sessionId = session && session.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('browserdrive: POST /session did not return a sessionId');

    const base = `${origin}/session/${sessionId}`;
    /** @type {DriveStep[]} */
    const steps = [];

    /** @type {BrowserClient} */
    const client = {
      containerName,
      hostPort,
      sessionId,
      steps,
      async navigate(url) {
        const target = hostToContainer(url);
        await wd(fetchFn, 'POST', `${base}/url`, { url: target });
        steps.push({ op: 'navigate', url: target });
      },
      async find(css) {
        const value = await wd(fetchFn, 'POST', `${base}/element`, { using: 'css selector', value: css });
        const elementId = elementIdFrom(value);
        if (!elementId) throw new Error(`browserdrive: find('${css}') matched no element`);
        steps.push({ op: 'find', css, elementId });
        return elementId;
      },
      async click(elementId) {
        await wd(fetchFn, 'POST', `${base}/element/${elementId}/click`, {});
        steps.push({ op: 'click', elementId });
      },
      async type(elementId, text) {
        await wd(fetchFn, 'POST', `${base}/element/${elementId}/value`, { text });
        steps.push({ op: 'type', elementId, text });
      },
      async text(elementId) {
        const value = await wd(fetchFn, 'GET', `${base}/element/${elementId}/text`);
        steps.push({ op: 'text', elementId, value });
        return value;
      },
      async execute(script, args) {
        const value = await wd(fetchFn, 'POST', `${base}/execute/sync`, { script, args: args || [] });
        steps.push({ op: 'execute', script: head(script), value });
        return value;
      },
      async teardown() {
        try {
          await wd(fetchFn, 'DELETE', base);
        } catch {
          /* session already gone / sidecar down — reap the container anyway */
        }
        reap(docker, containerName);
      },
    };
    return client;
  } catch (e) {
    reap(docker, containerName); // reap the partial sidecar before surfacing the boot failure
    throw e;
  }
}

/**
 * Mint a TOOL attempt receipt for a browser-driven walk — the AGENT-PROPOSED action observed
 * through the app's OWN surface (§0 rule 1 / §7 attempted-action): provenance:'tool',
 * kind:'attempt', NEVER 'harness' (ground truth stays the store tap). It goes through the
 * harness mint() so it is content-addressed and carries the unforgeable brand; `id` MUST be
 * passed here (never spread on afterward — the brand is non-enumerable and a re-spread drops
 * it). This mints evidence only; it decides no verdict.
 *
 * @param {Object} args
 * @param {string} [args.id] receipt id (defaults to 'browser-drive')
 * @param {string} args.frontDoorUrl the front door the walk drove
 * @param {DriveStep[]} args.steps the recorded walk (client.steps)
 * @param {any} [args.observed] what the caller observed in the DOM (e.g. a confirmation text)
 * @param {string} args.identity actor/session identity the walk ran under (owner-shadow guard, M2)
 * @param {Record<string,any>} [args.extra] extra data fields merged into the receipt payload
 * @returns {import('./types.mjs').Receipt} a minted TOOL attempt receipt
 */
export function mintDriveAttempt({ id, frontDoorUrl, steps, observed, identity, extra }) {
  return mint({
    id: id ?? 'browser-drive',
    kind: 'attempt',
    provenance: 'tool',
    identity,
    data: {
      request: `browser-drive ${frontDoorUrl}`,
      frontDoorUrl,
      steps,
      ...(observed !== undefined ? { observed } : {}),
      ...(extra || {}),
    },
  });
}
