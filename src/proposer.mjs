// @ts-check
/**
 * The PROPOSER — the agent seam that turns an intent + a harness-owned introspection snapshot
 * into a validated {walk, claim}, and the pure validator that makes the untrusted proposal safe.
 *
 * This is the ONLY place a driving agent's judgement enters the Catch: WHICH gestures to perform
 * and WHICH persisted effect to claim. Everything the agent hands back is UNTRUSTED raw data —
 * validateProposal is the gate that lets only a safe, in-menu shape through; anything else throws
 * (the caller treats a throw as an honest could-not-execute → CND, never a scripting surface and
 * never an error to route around). The gate closes the P1 framework-weaknesses at the door:
 *   FW-P1-C  the claim's `entity` MUST be one of the harness-enumerated observables (the recipe's
 *            disclosed store taps) — a free-form entity is rejected, so the agent cannot point the
 *            effect at something the harness never observed.
 *   FW-P1-D  the walk's ops are the browser-drive vocabulary MINUS `execute` and `navigate` — no
 *            arbitrary JS and no re-staging of the world (the JS/staging escape is shut).
 *
 * MINT-BOUNDARY: this module imports NEITHER the harness mint NOR the evidence seal — a proposal
 * is pure data with no path to satisfying provenance. The harness (catch.mjs) alone mints receipts
 * from what it OBSERVED; the agent only ever proposes what to try and what to claim.
 *
 * llmFn is the seam (mirrors openBrowserFn/tapStoreFn/fetchFn in catch.mjs): defaultLlmFn calls the
 * real Anthropic Messages API over the Node built-in global fetch — NO SDK, so pb's runtime deps
 * stay ZERO. A SECOND seam — claudeCliLlmFn — drives a real Sonnet via the LOCAL `claude` CLI
 * (subscription OAuth, NO API key) by shelling out with spawnSync exactly like pb already shells to
 * docker (browserdrive/storetap), so deps stay ZERO on either path. Tests inject a mock/adversarial
 * llmFn (or a fake CLI exec), so the whole validate→assemble→verdict path is proven auth-free (the
 * stronger honesty test: a hostile proposal degrades to ≠WORKS).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The walk op vocabulary the browser-drive executor maps to (browserdrive.mjs's
 * find/type/click/clickAt/pointer) MINUS `execute` and `navigate`. Excluding those two shuts the
 * JS/staging escape (FW-P1-D): a proposal can never run arbitrary page JS nor re-navigate/re-stage
 * the world — the harness owns navigation and every out-of-band read.
 * @type {readonly string[]}
 */
export const ALLOWED_WALK_OPS = Object.freeze(['find', 'type', 'click', 'clickAt', 'pointer']);

/**
 * The walk vocabulary for the ARGO drive (drive.mode:'argo-workflows'): a single `trigger` op — the
 * user gesture is "run the DAG" (the workflow manifest is disclosed config, like the front-door URL).
 * Kept a one-op vocabulary so agent-proposes/harness-disposes stays uniform and reuses this validator
 * (the harness owns the run-nonce, the observe, and every out-of-band read). Selected via the
 * `allowedOps` parameter of validateProposal/proposeWalkAndClaim; the browser default is unchanged.
 * @type {readonly string[]}
 */
export const ALLOWED_ARGO_OPS = Object.freeze(['trigger']);

/**
 * The walk vocabulary for the NOTE-LIFECYCLE drive (drive.mode:'note-lifecycle', the Lyric class): a
 * single `http` op — the user gesture is "call the disclosed REST surface" (method/path/body/capture,
 * the same shape conjure.mjs's setup steps / catch.mjs's confirm steps already use). Kept a one-op
 * vocabulary so agent-proposes/harness-disposes stays uniform and reuses this validator (the harness
 * owns the port-forwarded transport, the headers, and every out-of-band mongo read). Selected via the
 * `allowedOps` parameter of validateProposal/proposeWalkAndClaim.
 * @type {readonly string[]}
 */
export const ALLOWED_HTTP_OPS = Object.freeze(['http']);

/**
 * The relation set the FROZEN verdict adjudicates (verdict.mjs relationHolds). Mirrored here as the
 * proposer's input allowlist so a bad op is rejected at the door as an honest CND, rather than
 * reaching the verdict (where an unknown op relationHolds→false → FALSIFIED anyway). Kept in lockstep
 * with the frozen set by the adversarial "bad relation op" test.
 * @type {readonly string[]}
 */
export const ALLOWED_RELATION_OPS = Object.freeze(['increased', 'decreased', 'changed', 'unchanged', 'equals']);

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 1024;
const PROPOSE_TOOL_NAME = 'propose_walk';

const SYSTEM_PROMPT = [
  'You propose how a real first-time visitor would drive a web app\'s ALREADY-LOADED front-door page',
  'to exercise ONE feature, plus the single persisted effect that proves it worked. Reply ONLY via the',
  'propose_walk tool.',
  '',
  '- walk: the ordered user gestures. Use ONLY find/type/click (clickAt/pointer for a canvas surface',
  '  with no DOM node). Reference elements by STABLE selectors built from name/type/tag (e.g.',
  '  input[name="..."], button[type="submit"], textarea) — never a generated #id or an absolute',
  '  element handle. The introspection also lists `buttons` (each with type/title/ariaLabel/text +',
  '  a computed `selector` CSS path) for a button with no distinguishing name/aria-label attribute —',
  '  match it by its `text`, then find/click ITS `selector` verbatim. It also lists `canvases` (each',
  '  with a `selector` and its viewport x/y/width/height) for a DOM-less surface (e.g. a PDF/Konva',
  '  editor): compute a clickAt point as the canvas rect\'s x/y PLUS an offset inside it (e.g.',
  '  canvas.x+120, canvas.y+140), never raw page coordinates. The introspection also lists `viewport`',
  '  (width/height of what is ACTUALLY visible) — a canvas can be taller/wider than the viewport, so',
  '  every clickAt x/y MUST also satisfy 0 <= x < viewport.width and 0 <= y < viewport.height, or the',
  '  click is off-screen and the driver rejects it. clickAt -> {"x":n,"y":n,"shift":true?} (hold Shift',
  '  for the click — a multi-select gesture on a canvas). Do NOT navigate and do NOT run scripts: the',
  '  harness owns navigation and every observation.',
  '- claim: the single effect you expect to persist, bound to ONE of the disclosed observables',
  '  (entity), with expectedAfterRelation describing how that observable should move (e.g. increased).',
  '  Set quantified:true only for a universal claim (any/all/every user).',
  '',
  'Propose the smallest walk that submits the front door. The harness — not you — reads the store and',
  'decides the verdict.',
].join('\n');

/**
 * @typedef {Object} WalkStep
 * @property {'find'|'type'|'click'|'clickAt'|'pointer'|'trigger'|'http'} op the drive gesture (browser
 *   ops, the one-op argo 'trigger', or the one-op note-lifecycle 'http' — see ALLOWED_ARGO_OPS/ALLOWED_HTTP_OPS)
 * @property {Record<string, any>} args op-specific, validated arguments
 */

/**
 * The agent-proposed effect claim — the harness (catch.mjs) turns this into the full effect Claim,
 * binding it to the delta + confirm-leg receipts it minted from what it OBSERVED.
 * @typedef {Object} ProposedClaim
 * @property {string} entity one of the harness-enumerated observables (FW-P1-C)
 * @property {{op:string, value?:any}} expectedAfterRelation how the observable should move (frozen relation set)
 * @property {string} scope human-readable scope of the claim
 * @property {boolean} [quantified] universal quantifier — the harness lint can only ADD this, never clear it
 */

/**
 * @typedef {Object} Proposal
 * @property {WalkStep[]} walk
 * @property {ProposedClaim} claim
 */

/**
 * @typedef {(input:{intent:any, introspection:any, observables:string[]}) => Promise<any>} LlmFn
 * The proposer seam: takes the intent + the harness-owned introspection snapshot + the disclosed
 * observable menu, returns the UNTRUSTED raw proposal. The default is a real Anthropic call.
 */

/**
 * Fail loudly, naming the offending part. A throw is an honest could-not-execute (→ CND), never an
 * error the caller should route around and never a scripting surface.
 * @param {string} why
 * @returns {never}
 */
function bad(why) {
  throw new Error(`proposer: ${why}`);
}

/** @param {any} v @param {string} field */
function requireString(v, field) {
  if (typeof v !== 'string' || !v) bad(`${field} must be a non-empty string`);
}
/** @param {any} v @param {string} field */
function requireNumber(v, field) {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${field} must be a finite number`);
}

/**
 * Guard an `http` walk step's path against host-retargeting tricks. The note-lifecycle executor
 * builds its request as `fetchFn(baseUrl + resolvedPath)` (catch.mjs's executeNoteLifecycleWalk):
 * a path carrying userinfo (`@attacker/...`) or an absolute URL (`http://evil`) can re-target that
 * concatenation at a different host entirely, exfiltrating the recipe's operator_env values /
 * front_door.headers to it. A safe path must be a plain relative path (starts with '/') and must
 * not contain '@', '://', or whitespace/control characters. Reused both here (proposal validation
 * — an unsafe path is rejected at the door as an honest CND) and, defense-in-depth, at execution
 * (catch.mjs re-checks the PLACEHOLDER-RESOLVED path, since a captured value could smuggle the
 * same trick in after resolution).
 * @param {string} path
 * @returns {string|null} a reason the path is unsafe, or null when it's fine
 */
export function unsafeHttpPathReason(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return `must start with '/' (a relative path), got ${JSON.stringify(path)}`;
  if (path.includes('@')) return "must not contain '@' (host-retargeting risk)";
  if (path.includes('://')) return "must not contain '://' (absolute-URL retargeting risk)";
  if (/[\s\x00-\x1f]/.test(path)) return 'must not contain whitespace/control characters';
  return null;
}

/**
 * Validate one step's args against its op — reject a wrong-shape argument. Returns a clean,
 * whitelisted args object (only the fields the executor uses; no stray keys carried through).
 * @param {string} op
 * @param {any} args
 * @param {number} i step index (for the error message)
 * @returns {Record<string, any>}
 */
function validateArgs(op, args, i) {
  switch (op) {
    case 'find':
    case 'click':
      requireString(args.selector, `walk[${i}].args.selector`);
      return { selector: args.selector };
    case 'type':
      requireString(args.selector, `walk[${i}].args.selector`);
      requireString(args.text, `walk[${i}].args.text`);
      return { selector: args.selector, text: args.text };
    case 'clickAt':
      requireNumber(args.x, `walk[${i}].args.x`);
      requireNumber(args.y, `walk[${i}].args.y`);
      if (args.shift !== undefined && typeof args.shift !== 'boolean') bad(`walk[${i}].args.shift must be a boolean when present`);
      return { x: args.x, y: args.y, ...(args.shift !== undefined ? { shift: args.shift } : {}) };
    case 'pointer':
      if (!Array.isArray(args.actions) || args.actions.length === 0) bad(`walk[${i}].args.actions must be a non-empty array`);
      if (args.pointerType !== undefined) requireString(args.pointerType, `walk[${i}].args.pointerType`);
      return { actions: args.actions, ...(args.pointerType !== undefined ? { pointerType: args.pointerType } : {}) };
    case 'trigger':
      // The argo drive gesture: run the disclosed workflow. Optional validated string parameters; the
      // run-nonce and the manifest are harness/config-owned, never agent-supplied.
      if (args.parameters !== undefined) {
        if (!args.parameters || typeof args.parameters !== 'object' || Array.isArray(args.parameters)) bad(`walk[${i}].args.parameters must be an object`);
        for (const [k, v] of Object.entries(args.parameters)) requireString(v, `walk[${i}].args.parameters.${k}`);
      }
      return { ...(args.parameters !== undefined ? { parameters: { ...args.parameters } } : {}) };
    case 'http': {
      // The note-lifecycle drive gesture: one REST call against the disclosed surface. `body` (if
      // any) is JSON-shaped (mirrors conjure.mjs's SetupStep); `capture` (if any) is JSONPath-only
      // (name -> a JSONPath string read from the response, the setup/confirm default form).
      requireString(args.method, `walk[${i}].args.method`);
      requireString(args.path, `walk[${i}].args.path`);
      {
        const pathProblem = unsafeHttpPathReason(args.path);
        if (pathProblem) bad(`walk[${i}].args.path ${pathProblem}`);
      }
      if (args.body !== undefined && (!args.body || typeof args.body !== 'object' || Array.isArray(args.body))) {
        bad(`walk[${i}].args.body must be an object when present`);
      }
      if (args.capture !== undefined) {
        if (!args.capture || typeof args.capture !== 'object' || Array.isArray(args.capture)) bad(`walk[${i}].args.capture must be an object when present`);
        for (const [k, v] of Object.entries(args.capture)) requireString(v, `walk[${i}].args.capture.${k}`);
      }
      return {
        method: args.method,
        path: args.path,
        ...(args.body !== undefined ? { body: args.body } : {}),
        ...(args.capture !== undefined ? { capture: { ...args.capture } } : {}),
      };
    }
    default:
      return bad(`walk[${i}].op unsupported '${op}'`); // unreachable: op is already allowlisted
  }
}

/**
 * Validate the proposed claim: `entity` MUST be one of the harness-enumerated observables
 * (FW-P1-C — no free-form entity), the relation op MUST be in the frozen relation set, `scope` a
 * non-empty string, and `quantified` (if present) a boolean. Returns a clean ProposedClaim.
 * @param {any} claim
 * @param {string[]} observables
 * @returns {ProposedClaim}
 */
function validateClaim(claim, observables) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) bad('proposal.claim must be an object');
  const menu = observables || [];
  if (typeof claim.entity !== 'string' || !menu.includes(claim.entity)) {
    bad(
      `proposal.claim.entity must be one of the harness-enumerated observables [${menu.join(', ')}] ` +
        `(got ${JSON.stringify(claim.entity)}) — a free-form entity is rejected (FW-P1-C)`
    );
  }
  const rel = claim.expectedAfterRelation;
  if (!rel || typeof rel !== 'object' || typeof rel.op !== 'string' || !ALLOWED_RELATION_OPS.includes(rel.op)) {
    bad(
      `proposal.claim.expectedAfterRelation.op must be one of ${ALLOWED_RELATION_OPS.join('|')} ` +
        `(got ${JSON.stringify(rel && rel.op)})`
    );
  }
  requireString(claim.scope, 'proposal.claim.scope');
  if (claim.quantified !== undefined && typeof claim.quantified !== 'boolean') bad('proposal.claim.quantified must be a boolean when present');
  return {
    entity: claim.entity,
    expectedAfterRelation: { op: rel.op, ...('value' in rel ? { value: rel.value } : {}) },
    scope: claim.scope,
    ...(claim.quantified !== undefined ? { quantified: claim.quantified } : {}),
  };
}

/**
 * The PURE gate over an untrusted raw proposal. The walk must be a non-empty ordered list of
 * {op, args} whose ops are all in `allowedOps` (find/type/click/clickAt/pointer — execute/navigate
 * excluded, FW-P1-D) with well-shaped args; the claim must bind an in-menu entity (FW-P1-C) and a
 * frozen relation op. ANY violation throws — an honest could-not-execute (→ CND), not a bypass.
 * @param {any} raw the untrusted proposal (an llmFn's tool input)
 * @param {{observables:string[], allowedOps?:readonly string[]}} opts
 * @returns {Proposal}
 */
export function validateProposal(raw, { observables, allowedOps = ALLOWED_WALK_OPS }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('proposal must be an object');
  if (!Array.isArray(raw.walk) || raw.walk.length === 0) bad('proposal.walk must be a non-empty array of steps');
  const opSet = new Set(allowedOps);
  /** @type {WalkStep[]} */
  const walk = raw.walk.map((/** @type {any} */ step, /** @type {number} */ i) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) bad(`walk[${i}] must be an object`);
    if (typeof step.op !== 'string' || !opSet.has(step.op)) {
      bad(
        `walk[${i}].op must be one of ${allowedOps.join('|')} (got ${JSON.stringify(step.op)}) — ` +
          `execute/navigate are excluded: no JS or re-staging escape (FW-P1-D)`
      );
    }
    if (!step.args || typeof step.args !== 'object' || Array.isArray(step.args)) bad(`walk[${i}].args must be an object`);
    return { op: step.op, args: validateArgs(step.op, step.args, i) };
  });
  const claim = validateClaim(raw.claim, observables);
  return { walk, claim };
}

/**
 * The Anthropic tool encoding EXACTLY the walk+claim shape: the op enum (find/type/click/clickAt/
 * pointer), the claim's entity enum (= the disclosed observables, FW-P1-C), and the relation-op enum
 * (the frozen relation set). input_schema is a hint to the model; validateProposal is the real gate.
 * @param {string[]} observables
 * @returns {{name:string, description:string, input_schema:any}}
 */
export function buildProposeTool(observables) {
  return {
    name: PROPOSE_TOOL_NAME,
    description:
      'Propose the user walk on the already-loaded front-door page (find/type/click; clickAt/pointer ' +
      'for a canvas) and the single persisted effect to claim, bound to one disclosed observable.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        walk: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              op: { type: 'string', enum: [...ALLOWED_WALK_OPS] },
              args: { type: 'object' },
            },
            required: ['op', 'args'],
          },
        },
        claim: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entity: { type: 'string', enum: [...observables] },
            expectedAfterRelation: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: [...ALLOWED_RELATION_OPS] },
                value: { description: "REQUIRED when op is 'equals' — the exact value the entity must equal after the walk (e.g. true, 1, \"some-string\"). Unused by increased/decreased/changed/unchanged." },
              },
              required: ['op'],
            },
            scope: { type: 'string' },
            quantified: { type: 'boolean' },
          },
          required: ['entity', 'expectedAfterRelation', 'scope'],
        },
      },
      required: ['walk', 'claim'],
    },
  };
}

/**
 * Extract the UNTRUSTED raw proposal from an Anthropic Messages response body: the first
 * `type:'tool_use'` content block's `.input`. No tool_use block → throw (→ could-not-execute → CND).
 * PURE, so the seam's extraction is unit-tested API-free.
 * @param {any} body a parsed Messages API response
 * @returns {any} the tool_use `.input` (still untrusted; validateProposal gates it)
 */
export function extractProposal(body) {
  const content = body && Array.isArray(body.content) ? body.content : [];
  const toolUse = content.find((/** @type {any} */ b) => b && b.type === 'tool_use' && b.name === PROPOSE_TOOL_NAME) ||
    content.find((/** @type {any} */ b) => b && b.type === 'tool_use');
  if (!toolUse) bad('the model returned no tool_use block — cannot extract a proposal');
  return toolUse.input;
}

/**
 * The DEFAULT seam: a real Anthropic Messages API call over the Node built-in global fetch (NO SDK
 * — deps stay ZERO). Forces the propose_walk tool (tool_choice), reads the tool_use input back as
 * the untrusted raw proposal. Needs ANTHROPIC_API_KEY; without it, throws (inject a mock llmFn for
 * API-free runs). fetchFn is injectable so the request/extraction is exercisable without the network.
 * @param {{intent:any, introspection:any, observables:string[]}} input
 * @param {{fetchFn?:typeof fetch, model?:string, maxTokens?:number}} [opts]
 * @returns {Promise<any>}
 */
export async function defaultLlmFn({ intent, introspection, observables }, opts = {}) {
  const doFetch = opts.fetchFn || /** @type {typeof fetch} */ (fetch);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) bad('ANTHROPIC_API_KEY is not set — the real Sonnet proposer needs it (inject a mock llmFn for API-free runs)');
  const res = await doFetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model || DEFAULT_MODEL,
      max_tokens: opts.maxTokens || DEFAULT_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `${intent}\n\n${JSON.stringify(introspection)}` }],
      tools: [buildProposeTool(observables)],
      tool_choice: { type: 'tool', name: PROPOSE_TOOL_NAME },
    }),
  });
  if (!res.ok) bad(`Anthropic Messages API returned HTTP ${res.status}`);
  return extractProposal(await res.json());
}

// ---------------------------------------------------------------------------
// The claude-CLI seam — a real Sonnet over the LOCAL CLI (subscription OAuth, NO API key)
// ---------------------------------------------------------------------------

/** The CLI model alias — Sonnet is the production driver (the API path pins claude-sonnet-5). */
const DEFAULT_CLI_MODEL = 'sonnet';
/** Every tool DENIED: the nested agent reasons from the prompt alone, never touching fs/network. */
const CLI_DISALLOWED_TOOLS = 'Bash Read Edit Write Glob Grep WebFetch WebSearch Task';
const CLI_TIMEOUT_MS = 120000;
const CLI_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * A claude-CLI exec seam — mirrors the DockerRunner in browserdrive/storetap. Injected in tests so
 * the whole seam runs WITHOUT the CLI or any auth; the default shells to the real `claude` in a
 * NEUTRAL cwd so the nested agent sees only the prompt, never the pb repo (the COLD-proposal property).
 * @typedef {Object} ClaudeRunner
 * @property {(args:string[], cwd:string) => import('node:child_process').SpawnSyncReturns<string>} run
 */

/** @returns {ClaudeRunner} the real `claude` child_process runner (spawnSync, exactly like docker) */
function defaultClaudeRunner() {
  return {
    run: (args, cwd) => spawnSync('claude', args, { cwd, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER }),
  };
}

/** @param {string} [s] @param {number} [n] keep the TAIL of a long CLI error/output */
function tail(s, n = 400) {
  s = s || '';
  return s.length > n ? s.slice(-n) : s;
}

/**
 * Strip an optional ```json … ``` (or bare ```) markdown fence the model may wrap its JSON in; a
 * non-fenced string is returned trimmed. `claude -p` has no forced tool, so the model may fence its reply.
 * @param {string} s
 * @returns {string}
 */
function stripFence(s) {
  const t = (s || '').trim();
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i);
  return m ? m[1].trim() : t;
}

/**
 * Build the CLI prompt: the shared SYSTEM_PROMPT + the intent + the harness introspection snapshot +
 * the disclosed observable menu + an explicit "reply with ONLY the JSON {walk, claim}" instruction
 * that mirrors buildProposeTool's shape (the op enum, entity ∈ observables, the frozen relation-op
 * enum). There is NO forced tool in `claude -p`, so the schema must live in the prompt; the real gate
 * is still validateProposal on the returned raw.
 * @param {{intent:any, introspection:any, observables:string[]}} input
 * @returns {string}
 */
export function buildCliPrompt({ intent, introspection, observables }) {
  const menu = observables || [];
  return [
    SYSTEM_PROMPT,
    '',
    `INTENT: ${intent}`,
    '',
    `HARNESS INTROSPECTION (the already-loaded front-door page, provided by the harness): ${JSON.stringify(introspection)}`,
    '',
    `DISCLOSED OBSERVABLES — the claim.entity MUST be exactly one of: ${menu.join(', ') || '(none)'}`,
    '',
    'This mode has NO tools available: ignore any instruction above to reply via a tool, and instead',
    'reply with ONLY a single JSON object (no prose, no explanation, no markdown fence) of this shape:',
    '{',
    `  "walk": [ { "op": one of ${ALLOWED_WALK_OPS.join('|')}, "args": { ... } }, ... ],`,
    '  "claim": {',
    `    "entity": one of ${menu.join('|') || '(none)'},`,
    `    "expectedAfterRelation": { "op": one of ${ALLOWED_RELATION_OPS.join('|')}, "value": REQUIRED when op is 'equals' (the exact value, e.g. true/1/"some-string") — omit for increased/decreased/changed/unchanged },`,
    '    "scope": a short human-readable scope string,',
    '    "quantified": optional boolean (true only for a universal any/all/every claim)',
    '  }',
    '}',
    'Walk arg shapes: find/click → {"selector":"..."}; type → {"selector":"...","text":"..."}; ' +
      'clickAt → {"x":<number>,"y":<number>,"shift":true? (hold Shift for a multi-select gesture)}; ' +
      'pointer → {"actions":[...],"pointerType":"..."}.',
  ].join('\n');
}

/**
 * A SECOND proposer seam (alongside defaultLlmFn): drive a real Sonnet via the LOCAL `claude` CLI —
 * subscription OAuth, NO ANTHROPIC_API_KEY — by shelling out exactly like pb shells to docker, so
 * deps stay ZERO. Runs headless + structured + cold + model-pinned:
 *   claude -p "<prompt>" --output-format json --model sonnet --disallowedTools "<every tool off>"
 * in a fresh NEUTRAL tmp cwd (the nested agent sees only the prompt, never the recipe/expected
 * answer — the COLD-proposal property M5 needs). Parses the JSON envelope: a spawn failure, a
 * non-zero exit, or is_error:true (e.g. "OAuth session expired and could not be refreshed") → throw =
 * an honest could-not-execute → CND; otherwise the model's `.result` (fence-stripped) is JSON.parse'd
 * to the UNTRUSTED raw proposal — validateProposal in proposeWalkAndClaim is still the gate (this
 * never bypasses it, so a hostile CLI reply degrades to ≠WORKS exactly like the API path).
 * @param {{intent:any, introspection:any, observables:string[]}} input
 * @param {{runner?:ClaudeRunner, model?:string, cwd?:string}} [opts]
 * @returns {Promise<any>} the untrusted raw proposal (validateProposal gates it)
 */
export async function claudeCliLlmFn({ intent, introspection, observables }, opts = {}) {
  const runner = opts.runner || defaultClaudeRunner();
  const model = opts.model || DEFAULT_CLI_MODEL;
  const cwd = opts.cwd || mkdtempSync(join(tmpdir(), 'pb-proposer-'));
  const prompt = buildCliPrompt({ intent, introspection, observables });
  const args = ['-p', prompt, '--output-format', 'json', '--model', model, '--disallowedTools', CLI_DISALLOWED_TOOLS];
  const res = runner.run(args, cwd);
  if (res.error) {
    bad(`could not run the 'claude' CLI (${res.error.message}) — is it on PATH? (set ANTHROPIC_API_KEY or inject a mock llmFn for the non-CLI paths)`);
  }
  /** @type {any} */
  let envelope;
  try {
    envelope = JSON.parse(res.stdout || '');
  } catch {
    bad(`the claude CLI did not return a JSON envelope (exit ${res.status}): ${tail(res.stderr || res.stdout)}`);
  }
  if (res.status !== 0 || envelope.is_error) {
    bad(`the claude CLI could not execute the proposal: ${tail(String(envelope.result || res.stderr || `exit ${res.status}`))}`);
  }
  const text = stripFence(String(envelope.result || ''));
  try {
    return JSON.parse(text);
  } catch {
    return bad(`the model did not return a JSON {walk, claim} object: ${tail(text)}`);
  }
}

/**
 * Propose a validated {walk, claim} for the intent + introspection, or THROW (→ caller treats a
 * throw as an honest could-not-execute → CND). The llmFn seam produces an untrusted raw proposal;
 * validateProposal is the gate. Default llmFn = the real Anthropic call.
 * @param {{intent:any, introspection:any, observables:string[]}} input
 * @param {{llmFn?:LlmFn, allowedOps?:readonly string[]}} [opts] allowedOps selects the walk vocabulary (browser default, or ALLOWED_ARGO_OPS for the argo drive)
 * @returns {Promise<Proposal>}
 */
export async function proposeWalkAndClaim({ intent, introspection, observables }, opts = {}) {
  const llmFn = opts.llmFn || /** @type {LlmFn} */ ((input) => defaultLlmFn(input));
  const raw = await llmFn({ intent, introspection, observables });
  return validateProposal(raw, { observables, allowedOps: opts.allowedOps || ALLOWED_WALK_OPS });
}
