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
 * llmFn is the seam (mirrors openBrowserFn/tapStoreFn/fetchFn in catch.mjs): the default calls the
 * real Anthropic Messages API over the Node built-in global fetch — NO SDK, so pb's runtime deps
 * stay ZERO. Tests inject a mock/adversarial llmFn, so the whole validate→assemble→verdict path is
 * proven API-free (the stronger honesty test: a hostile proposal degrades to ≠WORKS).
 */

/**
 * The walk op vocabulary the browser-drive executor maps to (browserdrive.mjs's
 * find/type/click/clickAt/pointer) MINUS `execute` and `navigate`. Excluding those two shuts the
 * JS/staging escape (FW-P1-D): a proposal can never run arbitrary page JS nor re-navigate/re-stage
 * the world — the harness owns navigation and every out-of-band read.
 * @type {readonly string[]}
 */
export const ALLOWED_WALK_OPS = Object.freeze(['find', 'type', 'click', 'clickAt', 'pointer']);

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
  '  element handle. Do NOT navigate and do NOT run scripts: the harness owns navigation and every',
  '  observation.',
  '- claim: the single effect you expect to persist, bound to ONE of the disclosed observables',
  '  (entity), with expectedAfterRelation describing how that observable should move (e.g. increased).',
  '  Set quantified:true only for a universal claim (any/all/every user).',
  '',
  'Propose the smallest walk that submits the front door. The harness — not you — reads the store and',
  'decides the verdict.',
].join('\n');

/**
 * @typedef {Object} WalkStep
 * @property {'find'|'type'|'click'|'clickAt'|'pointer'} op the browser-drive gesture
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
      return { x: args.x, y: args.y };
    case 'pointer':
      if (!Array.isArray(args.actions) || args.actions.length === 0) bad(`walk[${i}].args.actions must be a non-empty array`);
      if (args.pointerType !== undefined) requireString(args.pointerType, `walk[${i}].args.pointerType`);
      return { actions: args.actions, ...(args.pointerType !== undefined ? { pointerType: args.pointerType } : {}) };
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
              properties: { op: { type: 'string', enum: [...ALLOWED_RELATION_OPS] }, value: {} },
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

/**
 * Propose a validated {walk, claim} for the intent + introspection, or THROW (→ caller treats a
 * throw as an honest could-not-execute → CND). The llmFn seam produces an untrusted raw proposal;
 * validateProposal is the gate. Default llmFn = the real Anthropic call.
 * @param {{intent:any, introspection:any, observables:string[]}} input
 * @param {{llmFn?:LlmFn}} [opts]
 * @returns {Promise<Proposal>}
 */
export async function proposeWalkAndClaim({ intent, introspection, observables }, opts = {}) {
  const llmFn = opts.llmFn || /** @type {LlmFn} */ ((input) => defaultLlmFn(input));
  const raw = await llmFn({ intent, introspection, observables });
  return validateProposal(raw, { observables });
}
