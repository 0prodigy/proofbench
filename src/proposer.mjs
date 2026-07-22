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

/** The claim-shape prompt section — SHARED verbatim across every drive mode's system prompt. */
const CLAIM_PROMPT_LINES = [
  '- claim: the single effect you expect to persist, bound to ONE of the disclosed observables',
  '  (entity), with expectedAfterRelation describing how that observable should move (e.g. increased).',
  '  Set quantified:true only for a universal claim (any/all/every user).',
];

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
  ...CLAIM_PROMPT_LINES,
  '',
  'Propose the smallest walk that submits the front door. The harness — not you — reads the store and',
  'decides the verdict.',
].join('\n');

/**
 * @typedef {Object} OpPromptDoc
 * @property {readonly string[]} intro replaces the browser intro paragraph (still ends in the propose_walk-tool clause)
 * @property {readonly string[]} walk the `- walk:` section documenting the op's EXACT validateArgs shape
 * @property {string} argShapes the compact "Walk arg shapes" recap line for the CLI prompt
 */

/**
 * Per-op prompt docs for the NON-BROWSER one-op drive vocabularies (keyed by op; the browser default
 * keeps SYSTEM_PROMPT verbatim). This map closes the MODE-BLINDNESS bug: validateProposal restricts
 * the walk vocabulary per drive mode (allowedOps), but the prompt used to instruct the browser
 * gestures unconditionally — the model obeyed, proposed `find`, and every note-lifecycle run was a
 * guaranteed could-not-execute. Each `walk` section mirrors validateArgs's shape for its op exactly
 * (the prompt must teach the SAME vocabulary the gate enforces).
 * @type {Record<string, OpPromptDoc>}
 */
const OP_PROMPT_DOCS = {
  http: {
    intro: [
      'You propose how a real API client would drive a service\'s harness-disclosed REST surface (the',
      'introspection carries the front door: base_url_template, entrypoint, and the operator_env echo) to',
      'exercise ONE feature, plus the single persisted effect that proves it worked. Reply ONLY via the',
      'propose_walk tool.',
    ],
    walk: [
      '- walk: the ordered REST calls. Every step MUST be {"op":"http","args":{...}} — no browser gestures,',
      '  no scripts. args: `method` (required, e.g. "GET"/"POST") and `path` (required; a RELATIVE path',
      '  starting with \'/\' — never an absolute URL, \'@\', \'://\', or whitespace; the harness owns the host).',
      '  Optional `body`: a JSON object (never an array or a bare string). Optional `capture`: an object of',
      '  name -> a \'$.a.b[0].c\' JSONPath string read from the step\'s JSON response. A {name} placeholder in',
      '  a later step\'s path or body string is substituted from the operator_env values and earlier captures',
      '  (an unresolved placeholder fails the step).',
    ],
    argShapes:
      'Walk arg shapes: http → {"method":"...","path":"/...","body":{...} optional,"capture":{"name":"$.json.path"} optional}.',
  },
  trigger: {
    intro: [
      'You propose how a real user would run a service\'s harness-disclosed Argo workflow (the manifest is',
      'disclosed config, like a front-door URL) to exercise ONE feature, plus the single persisted effect',
      'that proves it worked. Reply ONLY via the propose_walk tool.',
    ],
    walk: [
      '- walk: the ordered trigger gestures. Every step MUST be {"op":"trigger","args":{...}} — the harness',
      '  owns the run-nonce and the manifest. args: optional `parameters`, an object of name -> STRING',
      '  workflow parameters (nothing else).',
    ],
    argShapes: 'Walk arg shapes: trigger → {"parameters":{"name":"value", ...} optional} (every value a string).',
  },
};

/** The closing prompt lines shared by every non-browser mode (the browser closing names the front door). */
const NON_BROWSER_CLOSING_LINES = [
  'Propose the smallest walk that exercises the disclosed surface end-to-end. The harness — not you —',
  'reads the store and decides the verdict.',
];

/**
 * The per-op docs when EVERY allowed op is a non-browser one (http/trigger), else null → the caller
 * keeps the browser text byte-identical to today's.
 * @param {readonly string[]} allowedOps
 * @returns {OpPromptDoc[]|null}
 */
function nonBrowserOpDocs(allowedOps) {
  if (!allowedOps || allowedOps.length === 0) return null;
  /** @type {OpPromptDoc[]} */
  const docs = [];
  for (const op of allowedOps) {
    const d = OP_PROMPT_DOCS[op];
    if (!d) return null;
    docs.push(d);
  }
  return docs;
}

/**
 * The mode-aware system prompt: the browser default is SYSTEM_PROMPT unchanged; a non-browser
 * vocabulary (ALLOWED_HTTP_OPS / ALLOWED_ARGO_OPS) swaps the intro + walk-vocabulary sections while
 * the claim-shape section stays identical.
 * @param {readonly string[]} allowedOps
 * @returns {string}
 */
function systemPromptFor(allowedOps) {
  const docs = nonBrowserOpDocs(allowedOps);
  if (!docs) return SYSTEM_PROMPT;
  return [
    ...docs[0].intro,
    '',
    ...docs.flatMap((d) => [...d.walk]),
    ...CLAIM_PROMPT_LINES,
    '',
    ...NON_BROWSER_CLOSING_LINES,
  ].join('\n');
}

/**
 * The walk-shape contract the harness disclosed THROUGH the introspection (catch.mjs's
 * note-lifecycle drive sets `required_capture` = the discriminating query's {placeholder}): the
 * harness splits the walk as resolveSteps = walk.slice(0,-1) / terminalStep = walk.slice(-1) and
 * scopes its store reads by the captured id, so a walk that never captures it — or has only one
 * step — is a guaranteed could-not-execute. Emitted on BOTH prompt paths (CLI + API system prompt)
 * only when the disclosure is present; without it the prompt is unchanged.
 * @param {any} introspection
 * @returns {string[]}
 */
function requiredCaptureContractLines(introspection) {
  const name = introspection && typeof introspection.required_capture === 'string' && introspection.required_capture;
  if (!name) return [];
  return [
    '',
    'This drive\'s walk needs AT LEAST 2 steps. Every step before the LAST is the resolve phase (setup +',
    `resolving the fresh instance) and MUST populate a capture named exactly "${name}" — the harness scopes`,
    'its store reads by that captured id (the introspection\'s `serves`, when present, describes how the',
    'entrypoint\'s response resolves to it). The LAST step must be the single terminal state-changing call',
    'the claim is about: the harness observes the store between the resolve phase and that final step, and',
    'again after it. Every {name} placeholder used in a step\'s path or body MUST be an operator_env name',
    'disclosed in the introspection or a `capture` name declared by an EARLIER step — a made-up placeholder',
    'is refused before execution.',
  ];
}

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
 * @typedef {(input:{intent:any, introspection:any, observables:string[], allowedOps?:readonly string[]}) => Promise<any>} LlmFn
 * The proposer seam: takes the intent + the harness-owned introspection snapshot + the disclosed
 * observable menu + the drive mode's walk vocabulary (allowedOps — the SAME list validateProposal
 * enforces, so prompt and gate can never disagree), returns the UNTRUSTED raw proposal. The default
 * is a real Anthropic call.
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
 * Collect every `{name}` placeholder in a string — or in an object's/array's string leaves — into
 * `out`. The SAME replacement grammar as conjure.mjs's resolvePlaceholders (any non-'}' run), so the
 * static resolvability check below simulates exactly what the executor will try to resolve.
 * @param {any} node
 * @param {Set<string>} out
 * @returns {Set<string>}
 */
function collectPlaceholders(node, out) {
  if (typeof node === 'string') {
    for (const m of node.matchAll(/\{([^}]+)\}/g)) out.add(m[1]);
  } else if (Array.isArray(node)) {
    for (const x of node) collectPlaceholders(x, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectPlaceholders(v, out);
  }
  return out;
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
 *
 * `placeholderNames` (when provided — the names resolvable at run time: operator_env + any
 * harness-seeded names) additionally simulates placeholder resolvability IN STEP ORDER: every
 * `{name}` in a step's path/body must be in that set or declared by an EARLIER step's capture (a
 * step's own capture cannot feed its own path), and each step's capture names join the set after
 * it. Catches a made-up placeholder (the fifth live CND: `{stageName}` copy-pasted from the serves
 * prose) at PROPOSAL time instead of wasting a cluster round-trip to die at resolvePlaceholders.
 * Absent → behavior unchanged.
 * @param {any} raw the untrusted proposal (an llmFn's tool input)
 * @param {{observables:string[], allowedOps?:readonly string[], placeholderNames?:readonly string[]}} opts
 * @returns {Proposal}
 */
export function validateProposal(raw, { observables, allowedOps = ALLOWED_WALK_OPS, placeholderNames }) {
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
  if (placeholderNames) {
    const available = new Set(placeholderNames);
    walk.forEach((step, i) => {
      const used = collectPlaceholders(step.args.body, collectPlaceholders(step.args.path, new Set()));
      for (const name of used) {
        if (!available.has(name)) {
          bad(
            `walk[${i}] uses the placeholder {${name}} which nothing resolves at run time — not an ` +
              `operator_env/harness-seeded name and not an EARLIER step's capture ` +
              `(names available at this step: ${[...available].sort().join(', ') || '(none)'})`
          );
        }
      }
      if (step.args.capture) for (const name of Object.keys(step.args.capture)) available.add(name);
    });
  }
  const claim = validateClaim(raw.claim, observables);
  return { walk, claim };
}

/**
 * The Anthropic tool encoding EXACTLY the walk+claim shape: the op enum (= the drive mode's
 * allowedOps; browser default find/type/click/clickAt/pointer), the claim's entity enum (= the
 * disclosed observables, FW-P1-C), and the relation-op enum (the frozen relation set). input_schema
 * is a hint to the model; validateProposal is the real gate.
 * @param {string[]} observables
 * @param {readonly string[]} [allowedOps] the drive mode's walk vocabulary (browser default)
 * @returns {{name:string, description:string, input_schema:any}}
 */
export function buildProposeTool(observables, allowedOps = ALLOWED_WALK_OPS) {
  return {
    name: PROPOSE_TOOL_NAME,
    description: nonBrowserOpDocs(allowedOps)
      ? `Propose the walk (ops: ${allowedOps.join('/')}) against the harness-disclosed surface and the ` +
        'single persisted effect to claim, bound to one disclosed observable.'
      : 'Propose the user walk on the already-loaded front-door page (find/type/click; clickAt/pointer ' +
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
              op: { type: 'string', enum: [...allowedOps] },
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
 * @param {{intent:any, introspection:any, observables:string[], allowedOps?:readonly string[]}} input
 * @param {{fetchFn?:typeof fetch, model?:string, maxTokens?:number}} [opts]
 * @returns {Promise<any>}
 */
export async function defaultLlmFn({ intent, introspection, observables, allowedOps = ALLOWED_WALK_OPS }, opts = {}) {
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
      system: [systemPromptFor(allowedOps), ...requiredCaptureContractLines(introspection)].join('\n'),
      messages: [{ role: 'user', content: `${intent}\n\n${JSON.stringify(introspection)}` }],
      tools: [buildProposeTool(observables, allowedOps)],
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
 * Build the CLI prompt: the (mode-aware) system prompt + the intent + the harness introspection
 * snapshot + the disclosed observable menu + an explicit "reply with ONLY the JSON {walk, claim}"
 * instruction that mirrors buildProposeTool's shape (the op enum = allowedOps, entity ∈ observables,
 * the frozen relation-op enum). There is NO forced tool in `claude -p`, so the schema must live in
 * the prompt; the real gate is still validateProposal on the returned raw.
 * @param {{intent:any, introspection:any, observables:string[], allowedOps?:readonly string[]}} input
 * @returns {string}
 */
export function buildCliPrompt({ intent, introspection, observables, allowedOps = ALLOWED_WALK_OPS }) {
  const menu = observables || [];
  const docs = nonBrowserOpDocs(allowedOps);
  return [
    systemPromptFor(allowedOps),
    ...requiredCaptureContractLines(introspection),
    '',
    `INTENT: ${intent}`,
    '',
    `HARNESS INTROSPECTION (${docs ? 'the disclosed drive surface' : 'the already-loaded front-door page'}, provided by the harness): ${JSON.stringify(introspection)}`,
    '',
    `DISCLOSED OBSERVABLES — the claim.entity MUST be exactly one of: ${menu.join(', ') || '(none)'}`,
    '',
    'This mode has NO tools available: ignore any instruction above to reply via a tool, and instead',
    'reply with ONLY a single JSON object (no prose, no explanation, no markdown fence) of this shape:',
    '{',
    `  "walk": [ { "op": one of ${allowedOps.join('|')}, "args": { ... } }, ... ],`,
    '  "claim": {',
    `    "entity": one of ${menu.join('|') || '(none)'},`,
    `    "expectedAfterRelation": { "op": one of ${ALLOWED_RELATION_OPS.join('|')}, "value": REQUIRED when op is 'equals' (the exact value, e.g. true/1/"some-string") — omit for increased/decreased/changed/unchanged },`,
    '    "scope": a short human-readable scope string,',
    '    "quantified": optional boolean (true only for a universal any/all/every claim)',
    '  }',
    '}',
    docs
      ? docs.map((d) => d.argShapes).join(' ')
      : 'Walk arg shapes: find/click → {"selector":"..."}; type → {"selector":"...","text":"..."}; ' +
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
 * @param {{intent:any, introspection:any, observables:string[], allowedOps?:readonly string[]}} input
 * @param {{runner?:ClaudeRunner, model?:string, cwd?:string}} [opts]
 * @returns {Promise<any>} the untrusted raw proposal (validateProposal gates it)
 */
export async function claudeCliLlmFn({ intent, introspection, observables, allowedOps = ALLOWED_WALK_OPS }, opts = {}) {
  const runner = opts.runner || defaultClaudeRunner();
  const model = opts.model || DEFAULT_CLI_MODEL;
  const cwd = opts.cwd || mkdtempSync(join(tmpdir(), 'pb-proposer-'));
  const prompt = buildCliPrompt({ intent, introspection, observables, allowedOps });
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
 * validateProposal is the gate. Default llmFn = the real Anthropic call. allowedOps is threaded INTO
 * the llmFn input so the prompt teaches the same vocabulary the validator enforces (mode-blindness
 * — a browser prompt on an http-only drive — made every note-lifecycle proposal a guaranteed CND).
 * @param {{intent:any, introspection:any, observables:string[]}} input
 * @param {{llmFn?:LlmFn, allowedOps?:readonly string[], placeholderNames?:readonly string[]}} [opts] allowedOps selects the walk vocabulary (browser default, or ALLOWED_ARGO_OPS/ALLOWED_HTTP_OPS for the argo/note-lifecycle drives); placeholderNames enables the static resolvability check (see validateProposal)
 * @returns {Promise<Proposal>}
 */
export async function proposeWalkAndClaim({ intent, introspection, observables }, opts = {}) {
  const allowedOps = opts.allowedOps || ALLOWED_WALK_OPS;
  const llmFn = opts.llmFn || /** @type {LlmFn} */ ((input) => defaultLlmFn(input));
  const raw = await llmFn({ intent, introspection, observables, allowedOps });
  return validateProposal(raw, { observables, allowedOps, placeholderNames: opts.placeholderNames });
}
