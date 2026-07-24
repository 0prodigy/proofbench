// @ts-check
/**
 * The OUT-OF-BAND STORE TAP — read the conjured SUT's persisted store DIRECTLY and mint
 * the DELTA receipt the verdict adjudicates. This is the §1.1 persisted leg (harness
 * provenance): a store-of-record observation the driving agent has NO write-handle to.
 *
 * The read is a `docker exec … <client>` against the store DIRECTLY — NEVER a call to the app's
 * own API. It is engine-discriminated: sqlite (n8n) is a store FILE inside the SUT container read
 * with `sqlite3 -json`; postgres (documenso) is a SEPARATE DB container read with `psql -At`. An
 * app-endpoint read is only TOOL provenance and can never be the persisted leg
 * (docs/internal/phase-3-theory.md §1.1/§4); if the store cannot be read out of band, this module throws
 * rather than fall back to an app read — for every engine.
 *
 * tapStore runs a recipe's named read-only query and returns the parsed rows. Per M1's
 * finding, n8n runs sqlite in rollback-journal mode, so a reader can intermittently collide
 * with a writer; the recipe's busy-timeout makes that invisible, and a transient
 * "database is locked" is EXPECTED — retried, never treated as a SUT failure. Postgres is the
 * opposite: MVCC/read-committed readers never block on writers, so the postgres path takes no
 * busy-timeout and no lock-retry (a single read). mintStoreDelta
 * turns a bracketed before/after into a HARNESS delta receipt via the harness mint() (the
 * only path to harness provenance). This module DECIDES no verdict — it only provides the
 * tap and the mint helper; the caller (M6) brackets a user action with two taps.
 *
 * Zero runtime deps: docker via child_process (mirroring conjure.mjs's helper).
 */

import { spawnSync } from 'node:child_process';
import { mint } from './harness.mjs';

const DOCKER_TIMEOUT_MS = 120000;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_LOCK_RETRIES = 2; // defense-in-depth; the busy-timeout should already prevent locks
const LOCK_BACKOFF_MS = 200;

/**
 * A docker runner — mirrors conjure.mjs's Docker seam. Injected in tests so the tap is
 * exercised docker-free; the default shells out to the real `docker` CLI.
 * @typedef {Object} DockerRunner
 * @property {(args:string[], timeoutMs:number) => import('node:child_process').SpawnSyncReturns<string>} run
 */

/** @returns {DockerRunner} the real docker child_process runner */
function defaultDocker() {
  return {
    run: (args, timeoutMs) =>
      spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER }),
  };
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

/**
 * A transient sqlite contention error (EXPECTED under n8n's rollback-journal sqlite, cleared
 * by the busy-timeout) — not a SUT failure.
 * @param {string} stderr
 * @returns {boolean}
 */
function isTransientLock(stderr) {
  return /database is locked/i.test(stderr) || /database table is locked/i.test(stderr) || /SQLITE_BUSY/i.test(stderr);
}

/**
 * Parse `sqlite3 -json` stdout to a rows array. Empty stdout (or a bare `[]`) is zero rows.
 * @param {string} stdout
 * @returns {any[]}
 */
function parseJsonRows(stdout) {
  const s = (stdout || '').trim();
  if (s === '' || s === '[]') return [];
  let rows;
  try {
    rows = JSON.parse(s);
  } catch (e) {
    throw new Error(`storetap: could not parse sqlite3 -json output: ${e instanceof Error ? e.message : String(e)} — got: ${tail(s, 300)}`);
  }
  if (!Array.isArray(rows)) throw new Error(`storetap: sqlite3 -json returned a non-array (got ${typeof rows})`);
  return rows;
}

/**
 * Parse `psql -At -F '\t'` stdout (tuples only — no header/footer — tab-separated) to rows of
 * string fields. Empty stdout is zero rows. Postgres emits TEXT (no typing); the caller coerces.
 * @param {string} stdout
 * @returns {string[][]}
 */
function parsePsqlRows(stdout) {
  const lines = (stdout || '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // drop the trailing newline
  return lines.map((line) => line.split('\t'));
}

/**
 * Run the recipe's named store query OUT OF BAND against the conjured SUT's persisted store and
 * return the parsed rows. NEVER touches the app's API — this is the harness-provenance persisted
 * leg (§1.1/§4). Dispatches on the recipe's store engine (sqlite | postgres).
 *
 * @param {import('./conjure.mjs').SutHandle} handle a live conjured SUT
 * @param {string} queryName a key of recipe.store_tap.queries
 * @param {DockerRunner} [docker] injected for docker-free tests; defaults to the real docker CLI
 * @returns {Promise<any[]>} the query's rows ([] when the store holds none)
 */
export async function tapStore(handle, queryName, docker = defaultDocker()) {
  const st = handle.recipe.store_tap;
  const query = st.queries[queryName];
  if (typeof query !== 'string' || !query) {
    throw new Error(`storetap: unknown query '${queryName}' — recipe store_tap.queries has: ${Object.keys(st.queries).join(', ') || '(none)'}`);
  }
  if (st.engine === 'sqlite') return tapSqlite(handle, st, queryName, query, docker);
  if (st.engine === 'postgres') return tapPostgres(st, queryName, query, docker);
  throw new Error(`storetap: unsupported engine '${String(/** @type {any} */ (st).engine)}' — only 'sqlite' and 'postgres' are supported`);
}

/**
 * sqlite tap: `docker exec <sut> sqlite3 -json -cmd ".timeout N" <db_path> "<query>"` against the
 * store file INSIDE the SUT container. A transient "database is locked" is EXPECTED under
 * rollback-journal contention — retried, never a SUT failure.
 * @param {import('./conjure.mjs').SutHandle} handle
 * @param {import('./recipe.mjs').SqliteStoreTap} st
 * @param {string} queryName
 * @param {string} query
 * @param {DockerRunner} docker
 * @returns {Promise<any[]>}
 */
async function tapSqlite(handle, st, queryName, query, docker) {
  const args = ['exec', /** @type {string} */ (handle.containerName), 'sqlite3', '-json', '-cmd', `.timeout ${st.busy_timeout_ms}`, st.db_path, query];

  for (let attempt = 0; ; attempt++) {
    const res = docker.run(args, DOCKER_TIMEOUT_MS);
    if (res.error) throw new Error(`storetap: docker exec for query '${queryName}' failed to run: ${res.error.message}`);
    if (res.status === 0) return parseJsonRows(res.stdout);

    const stderr = res.stderr || '';
    if (isTransientLock(stderr)) {
      // EXPECTED (rollback-journal contention). The busy-timeout normally hides it; retry a
      // couple times as defense-in-depth — never count it as a SUT failure.
      if (attempt < MAX_LOCK_RETRIES) {
        await sleep(LOCK_BACKOFF_MS);
        continue;
      }
      throw new Error(
        `storetap: query '${queryName}' still saw a transient store lock after ${MAX_LOCK_RETRIES + 1} attempts ` +
          `(EXPECTED under n8n rollback-journal sqlite, normally cleared by the ${st.busy_timeout_ms}ms busy-timeout — not a SUT failure): ${tail(stderr)}`
      );
    }
    throw new Error(`storetap: query '${queryName}' failed (exit ${res.status}): ${tail(stderr || res.stdout)}`);
  }
}

/**
 * postgres tap: `docker exec <container> psql -U <user> -d <db> -At -F '\t' -c "<query>"` against
 * a SEPARATE DB container. Postgres is MVCC/read-committed → readers never block on writers, so
 * there is NO busy-timeout and NO lock-retry (a single read, the opposite of sqlite). Rows come
 * back tuples-only (no header/footer), tab-separated, parsed to a string[][]. Throws rather than
 * fall back to an app read — the persisted leg must be read out of band (§1.1/§4).
 * @param {import('./recipe.mjs').PostgresStoreTap} st
 * @param {string} queryName
 * @param {string} query
 * @param {DockerRunner} docker
 * @returns {string[][]}
 */
function tapPostgres(st, queryName, query, docker) {
  const args = ['exec', st.container, 'psql', '-U', st.user, '-d', st.db, '-At', '-F', '\t', '-c', query];
  const res = docker.run(args, DOCKER_TIMEOUT_MS);
  if (res.error) throw new Error(`storetap: docker exec for query '${queryName}' failed to run: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`storetap: query '${queryName}' failed (exit ${res.status}): ${tail(res.stderr || res.stdout)}`);
  return parsePsqlRows(res.stdout);
}

/**
 * Mint a HARNESS delta receipt for a bracketed before/after — the exact shape
 * verdict.evalEffect consumes ({ kind:'delta', provenance:'harness', identity, sourcePR,
 * data:{ entity, before, after, ...extra } }). It goes through the harness mint() so it
 * carries harness provenance and the unforgeable minted brand; `id` MUST be passed here
 * (never spread on afterward — the brand is non-enumerable and a re-spread would drop it).
 * This mints evidence only; it decides no verdict.
 *
 * @param {Object} args
 * @param {string} [args.id] receipt id the caller's EffectCheck.deltaReceiptId references (defaults to `delta:<entity>`)
 * @param {string} args.entity the store entity observed (e.g. `execution_entity.count`)
 * @param {any} args.before value observed before the user action
 * @param {any} args.after value observed after the user action
 * @param {string} args.identity actor/session identity the tap ran under
 * @param {boolean} [args.sourcePR] true only if this oracle is code shipped by the PR under test (disqualifying, M3/FW-19)
 * @param {Record<string,any>} [args.extra] extra data fields merged into the receipt payload
 * @returns {import('./types.mjs').Receipt} a minted harness delta receipt
 */
export function mintStoreDelta({ id, entity, before, after, identity, sourcePR = false, extra }) {
  /** @type {import('./types.mjs').Receipt} */
  const receipt = {
    id: id ?? `delta:${entity}`,
    kind: 'delta',
    provenance: 'harness',
    identity,
    sourcePR,
    data: { entity, before, after, ...(extra || {}) },
  };
  return mint(receipt);
}
