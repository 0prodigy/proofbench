// @ts-check
/**
 * The MONGO STORE TAP (the Lyric class, ENG-17397 draft §3/G3) — read the conjured k8s SUT's
 * mongo store DIRECTLY via `kubectl exec <pod> -c <container> -- mongosh`, NEVER through
 * appservice's own REST API. This is the §1.1 persisted leg for the mongo engine: a store-of-
 * record observation the driving agent has no write-handle to. It stays HARNESS provenance once
 * the caller brackets before/after and mints via storetap.mjs's EXISTING, engine-agnostic
 * `mintStoreDelta` — the same mint() path sqlite/postgres already go through; nothing new is
 * needed there, and this module mints nothing itself (mirroring tapSqlite/tapPostgres, which
 * also just return raw rows).
 *
 * The credential-resolution shape is the PROVEN one at
 * ~/.claude/skills/lyric-qa/scripts/lyric-mongo.sh: try each recipe-declared `credential_secrets`
 * name IN ORDER, decode {username,password} from the k8s Secret's base64 `.data`, and VALIDATE
 * with a `db.runCommand({ping:1})` before trusting it — a secret's mere PRESENCE is not proof its
 * credentials are current (that script's own finding: a stale secret can sit alongside a live
 * one). Reimplemented here from scratch — this module never shells out to that script — so pb
 * stays a self-contained, zero-runtime-dep tool.
 *
 * Every recipe-declared query is a STATIC read-only mongosh expression (e.g.
 * `db.executions.findOne({...})`). This tap wraps it so mongosh always prints back ONE JSON
 * ARRAY of row objects, normalizing `find().toArray()` (already an array), `findOne()`
 * (object|null), and any other scalar-returning expression into the SAME array-of-rows shape
 * sqlite/postgres already return — so recipe.mjs's `resolveObservable` / catch.mjs's
 * `observedValue` need no mongo-specific branch.
 *
 * Every kubectl call (secret reads AND mongosh execs) carries `--context <kube_context> -n
 * <namespace>` from the recipe's own `conjure.kube_context`/`namespace` — the same
 * operator-supplied world conjure.mjs's bring-up/drift-sentinel already attach through (threaded
 * in by the caller via {@link tapMongo}'s `kubeArgs` param, sourced from the k8s-attach handle's
 * `_k8sAttach.kubeArgs`). Every lyriclet has a `mongodb-0`/`mongod` pod and the same
 * credential-secret names, so an un-scoped kubectl call would SUCCEED against whatever the
 * operator's shell happens to be pointed at and mint plausible rows as harness provenance for the
 * WRONG world — never the operator's ambient current-context/current-namespace.
 *
 * Zero runtime deps: kubectl via child_process (mirroring conjure/storetap/argoworkflows/
 * browserdrive's own runner seams).
 */

import { spawnSync } from 'node:child_process';

const KUBECTL_TIMEOUT_MS = 60000;
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * A kubectl runner — mirrors argoworkflows.mjs's KubectlRunner. Injected in tests so the tap is
 * exercised cluster-free; the default shells out to the real `kubectl` CLI.
 * @typedef {Object} ExecRunner
 * @property {(args:string[], timeoutMs:number) => import('node:child_process').SpawnSyncReturns<string>} run
 */

/** @returns {ExecRunner} the real kubectl child_process runner */
export function defaultExecRunner() {
  return {
    run: (args, timeoutMs) => spawnSync('kubectl', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_BUFFER }),
  };
}

/**
 * The recipe-declared, operator-supplied k8s world every kubectl call in this tap MUST target —
 * never the operator's ambient current-context/current-namespace. Mirrors conjure.mjs's own
 * `{kubeContext, namespace}` shape (conjure.kube_context/namespace) so a single k8s-attach handle's
 * world is what every read — bring-up, drift-sentinel, AND this store tap — actually hits.
 * @typedef {Object} MongoKubeArgs
 * @property {string} kubeContext
 * @property {string} namespace
 */

/**
 * Prefix a kubectl argv with `--context <kubeContext> -n <namespace>` — every call this tap makes
 * (secret reads AND mongosh execs) must carry this, or it silently reads whatever world the
 * operator's shell happens to be pointed at instead of the recipe-declared one.
 * @param {MongoKubeArgs} kubeArgs
 * @param {string[]} args
 * @returns {string[]}
 */
function withKubeArgs(kubeArgs, args) {
  return ['--context', kubeArgs.kubeContext, '-n', kubeArgs.namespace, ...args];
}

/** @param {string} [s] @param {number} [n] */
function tail(s, n = 800) {
  s = s || '';
  return s.length > n ? s.slice(-n) : s;
}

/**
 * Decode one field of a k8s Secret's base64 `.data` (e.g. 'username'|'password') via
 * `kubectl get secret <name> -o jsonpath`. Returns '' on ANY failure (missing secret, missing
 * key, bad base64) — the caller treats that as "this secret doesn't work," never a throw
 * (mirrors lyric-mongo.sh's own fall-through-on-failure stance).
 * @param {ExecRunner} execFn
 * @param {MongoKubeArgs} kubeArgs the recipe-declared world this read must target
 * @param {string} secretName
 * @param {string} field
 * @returns {string}
 */
function readSecretField(execFn, kubeArgs, secretName, field) {
  const res = execFn.run(withKubeArgs(kubeArgs, ['get', 'secret', secretName, '-o', `jsonpath={.data.${field}}`]), KUBECTL_TIMEOUT_MS);
  if (res.error || res.status !== 0) return '';
  const b64 = (res.stdout || '').trim();
  if (!b64) return '';
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Build the mongo connection URI for one credential. `authSource` defaults to the tap's own `db`
 * — the MongoDB Community Operator convention lyric-mongo.sh documents: the user lives in its
 * home DB, not `admin`.
 * @param {import('./recipe.mjs').MongoStoreTap} st
 * @param {string} username
 * @param {string} password
 * @returns {string}
 */
function mongoUri(st, username, password) {
  return `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@localhost:27017/${st.db}?authSource=${st.db}`;
}

/**
 * Run one `kubectl exec <pod> -c <container> -- mongosh <uri> --quiet --eval <script>` — the
 * shared transport both credential-validation (ping) and the real query use.
 * @param {import('./recipe.mjs').MongoStoreTap} st
 * @param {string} uri
 * @param {string} script
 * @param {MongoKubeArgs} kubeArgs the recipe-declared world this exec must target
 * @param {ExecRunner} execFn
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function execMongosh(st, uri, script, kubeArgs, execFn) {
  return execFn.run(withKubeArgs(kubeArgs, ['exec', st.pod, '-c', st.container, '--', 'mongosh', uri, '--quiet', '--eval', script]), KUBECTL_TIMEOUT_MS);
}

/**
 * Resolve a WORKING mongo credential by trying each `credential_secrets` name IN ORDER (the
 * recipe's ordered fallback list) — a candidate is trusted only once its
 * `db.runCommand({ping:1})` actually SUCCEEDS through mongosh, never on the secret's mere
 * presence (a stale secret can sit alongside a live one — lyric-mongo.sh's own finding).
 * @param {import('./recipe.mjs').MongoStoreTap} st
 * @param {MongoKubeArgs} kubeArgs the recipe-declared world every candidate is tried against
 * @param {ExecRunner} execFn
 * @returns {{secretName:string, uri:string}|null}
 */
function resolveWorkingCredential(st, kubeArgs, execFn) {
  for (const secretName of st.credential_secrets) {
    const username = readSecretField(execFn, kubeArgs, secretName, 'username');
    const password = readSecretField(execFn, kubeArgs, secretName, 'password');
    if (!username || !password) continue;
    const uri = mongoUri(st, username, password);
    const res = execMongosh(st, uri, 'db.runCommand({ping:1})', kubeArgs, execFn);
    if (!res.error && res.status === 0) return { secretName, uri };
  }
  return null;
}

/**
 * Wrap a recipe-declared mongosh query EXPRESSION so it always prints back ONE JSON array of row
 * objects — normalizing `find().toArray()` (already an array), `findOne()` (object|null), and any
 * other scalar expression into the SAME shape (see module doc). A trailing `;` is tolerated
 * (stripped) since a recipe author may write the query either way.
 * @param {string} query
 * @returns {string}
 */
export function wrapQueryAsJsonRows(query) {
  const expr = query.trim().replace(/;\s*$/, '');
  return `(function(){var __r=(${expr});if(__r===null||__r===undefined)return print(JSON.stringify([]));if(Array.isArray(__r))return print(JSON.stringify(__r));return print(JSON.stringify([__r]));})()`;
}

/**
 * Parse the `--eval`'d, wrapped mongosh stdout back to a rows array. `--quiet` suppresses the
 * startup banner, so stdout should be exactly the one printed JSON line; parsed leniently (only
 * the LAST non-empty line) so an incidental warning line ahead of it doesn't break parsing.
 * @param {string} stdout
 * @param {string} queryName
 * @returns {any[]}
 */
function parseMongoRows(stdout, queryName) {
  const lines = (stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] || '[]';
  let rows;
  try {
    rows = JSON.parse(last);
  } catch (e) {
    throw new Error(`mongotap: could not parse mongosh output for query '${queryName}': ${e instanceof Error ? e.message : String(e)} — got: ${tail(stdout, 300)}`);
  }
  if (!Array.isArray(rows)) throw new Error(`mongotap: query '${queryName}' did not normalize to a JSON array (got ${typeof rows}) — got: ${tail(stdout, 300)}`);
  return rows;
}

/**
 * The permitted SHAPE for an AGENT-CAPTURED value substituted into a mongo query placeholder (e.g.
 * `{child_execution_id}` — the Lyric class's note-lifecycle drive, catch.mjs): a 24-hex MongoDB
 * ObjectId, OR a conservative `[A-Za-z0-9_-]{1,64}` token. The agent PROPOSED the walk that produced
 * this value (via a `capture` on an http walk step) — it is UNTRUSTED input, so a hostile capture
 * (e.g. `'"};db.dropDatabase();//'`) must never reach the mongosh `--eval` string verbatim; anything
 * outside this shape is refused before it is ever interpolated.
 */
const SAFE_CAPTURED_VALUE = /^(?:[0-9a-fA-F]{24}|[A-Za-z0-9_-]{1,64})$/;

/**
 * Validate an agent-captured value's SHAPE before it is string-substituted into a mongosh query (or,
 * by the same rule, any other kubectl-bound argv) — see {@link SAFE_CAPTURED_VALUE}. Throws (naming
 * the placeholder + the offending value, truncated) rather than interpolate an unsafe shape; the
 * caller treats the throw as an honest could-not-execute (→ CND naming the step), never a bypass.
 * @param {string} name the placeholder name (for the error message)
 * @param {any} value the captured value
 * @returns {string} the value, stringified, once validated safe
 */
export function assertSafeCapturedValue(name, value) {
  const s = String(value);
  if (!SAFE_CAPTURED_VALUE.test(s)) {
    throw new Error(
      `mongotap: captured value for {${name}} has an unsafe shape for a mongo query (must be a 24-hex ObjectId or [A-Za-z0-9_-]{1,64}) — refusing to interpolate ${JSON.stringify(s.slice(0, 80))} into the mongosh --eval string`
    );
  }
  return s;
}

/**
 * Resolve every `{name}` placeholder in a recipe-declared mongo query TEMPLATE with an AGENT-CAPTURED
 * value (e.g. `store_tap.queries.stage_controls_queued`'s `{child_execution_id}`) — each substituted
 * value is shape-validated first ({@link assertSafeCapturedValue}); a placeholder with no capture of
 * that name throws, naming it (never a fabricated blank, mirrors conjure.mjs's resolvePlaceholders).
 * Scoped to the mongo-query injection surface (the note-lifecycle drive's discriminating tap); HTTP
 * walk-step placeholders resolve through conjure.mjs's own resolvePlaceholders/resolveBodyPlaceholders
 * instead (no shell/eval injection surface there).
 *
 * The placeholder pattern is deliberately IDENTIFIER-restricted (`{[A-Za-z_][A-Za-z0-9_]*}`, no
 * closing-`}` search past the first non-word char) — unlike conjure.mjs's URL-template
 * resolvePlaceholders, a mongo query is itself JS/JSON-shaped and is FULL of unrelated `{`/`}`
 * object-literal braces (e.g. `find({executionId:'{child_execution_id}'})`); a greedy `[^}]+` would
 * swallow from the object-literal's own `{` through to the placeholder's closing `}`.
 * @param {string} query
 * @param {Record<string,any>} captures
 * @returns {string}
 */
export function resolveMongoQueryPlaceholders(query, captures) {
  return query.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (!captures || !(name in captures) || captures[name] === undefined) {
      throw new Error(`mongotap: query references {${name}} but no capture named '${name}' was recorded — cannot resolve`);
    }
    return assertSafeCapturedValue(name, captures[name]);
  });
}

/**
 * Run the recipe's named mongo store query OUT OF BAND via `kubectl exec ... mongosh` — NEVER
 * through appservice's REST API (§1.1/§4 — an app-sourced read would be agent/tool provenance,
 * not harness). Throws (never falls back to an app read) when no `credential_secrets` entry
 * validates, or when the exec itself fails.
 * @param {import('./recipe.mjs').MongoStoreTap} st
 * @param {string} queryName
 * @param {string} query
 * @param {MongoKubeArgs} kubeArgs the recipe-declared `conjure.kube_context`/`namespace` this read
 *   MUST target (threaded from the k8s-attach handle's own `_k8sAttach.kubeArgs` — the same world
 *   bring-up/drift-sentinel already attach through) — every kubectl call carries it, so a wrong-
 *   world read can never silently succeed against the operator's ambient current-context
 * @param {ExecRunner} [execFn] injected for cluster-free tests; defaults to the real kubectl CLI
 * @returns {Promise<any[]>}
 */
export async function tapMongo(st, queryName, query, kubeArgs, execFn = defaultExecRunner()) {
  const cred = resolveWorkingCredential(st, kubeArgs, execFn);
  if (!cred) {
    throw new Error(
      `mongotap: no WORKING mongo credentials for query '${queryName}' — tried secrets [${st.credential_secrets.join(', ')}] ` +
        `(each needs a 'username'+'password' key AND a passing db.runCommand({ping:1})); never falls back to an app read`
    );
  }
  const res = execMongosh(st, cred.uri, wrapQueryAsJsonRows(query), kubeArgs, execFn);
  if (res.error) throw new Error(`mongotap: kubectl exec for query '${queryName}' failed to run: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`mongotap: query '${queryName}' failed via secret '${cred.secretName}' (exit ${res.status}): ${tail(res.stderr || res.stdout)}`);
  }
  return parseMongoRows(res.stdout, queryName);
}
