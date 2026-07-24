#!/usr/bin/env node
// @ts-check
/**
 * pb — the CLI dispatcher.
 *
 * Wires `pb gate` to the E1 malicious-driver gate, `pb phase1|phase2|phase3` to the three
 * phase runners, and `pb prove <recipeDir>` to the DIFFERENTIAL Catch — the same user walk run
 * at the merge SHA and its parent SHA, proving merge=WORKS ∧ parent≠WORKS (the PR IS why it
 * works). Every command produces harness receipts + claims and calls the pure verdict; exit 0
 * only on WORKS / differential PASS.
 */

import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { conjure, teardownSut } from './conjure.mjs';
import { runGate } from './e1/gate.mjs';
import { runPhase1 } from './phases/phase1.mjs';
import { runPhase2 } from './phases/phase2.mjs';
import { runPhase3 } from './phases/phase3.mjs';
import { listRecipes, pickRandom } from './pool.mjs';
import { loadRecipe } from './recipe.mjs';
import { runCatch } from './catch.mjs';
import { claudeCliLlmFn } from './proposer.mjs';
import { Verdict } from './types.mjs';

function usage() {
  return [
    'pb — proof-of-work for AI change (honesty core, E1)',
    '',
    'Usage: pb <command>',
    '',
    'Commands:',
    '  gate            run the E1 malicious-driver gate (deterministic; exit 0=pass, 1=fail)',
    '  phase1 <dir>    run the repo\'s own test suite → WORKS/DOES_NOT_WORK/CND',
    '  phase2 <dir>    bring up docker-compose + prove the front door serves → READY/CND',
    '  phase3 <dir> [--intent "..."]   HTTP-drive a fixture app + confirm the effect persists',
    '  conjure <recipeDir>|--random [--keep]   bring up a real SUT from a pb-recipe-v1 (--random: pick one from the pool) + mint its code-identity fingerprint',
    '  prove <recipeDir>|--random [--json]   run the differential Catch at the merge SHA and the parent SHA (--random: pick one from the pool) → PASS iff merge=WORKS ∧ parent≠WORKS; --json emits ONE pb-verdict-v1 JSON document on stdout (render-layer only — exit codes unchanged), human-readable rendering moves to stderr',
    '  help            show this help',
    '',
    'Phase commands exit 0 only on WORKS; prove exits 0 only on differential PASS.',
  ].join('\n');
}

/**
 * @param {import('./phases/phase1.mjs').PhaseResult} result
 * @returns {string}
 */
function renderPhase(result) {
  const lines = [`pb ${result.phase} — ${result.verdict.state}`, ''];
  if (result.diagnosis.length) {
    lines.push('  notes:');
    for (const n of result.diagnosis) lines.push(`    - ${n}`);
  }
  lines.push('  reasons:');
  for (const r of result.verdict.reasons) lines.push(`    - ${r}`);
  return lines.join('\n');
}

/**
 * @param {import('./e1/gate.mjs').GateResult} result
 * @returns {string}
 */
function renderGate(result) {
  const nameW = Math.max('DRIVER'.length, ...result.rows.map((r) => r.name.length));
  const verW = Math.max('VERDICT'.length, ...result.rows.map((r) => r.verdict.length));
  const lines = [
    'pb gate — E1 malicious-driver honesty gate',
    '',
    `  ${'DRIVER'.padEnd(nameW)}  ${'VERDICT'.padEnd(verW)}  OK`,
    `  ${'-'.repeat(nameW)}  ${'-'.repeat(verW)}  ----`,
  ];
  for (const r of result.rows) {
    lines.push(`  ${r.name.padEnd(nameW)}  ${r.verdict.padEnd(verW)}  ${r.ok ? 'ok' : 'FAIL'}`);
  }
  const malicious = result.rows.length - 1;
  lines.push('');
  lines.push(`  ${malicious} malicious driver(s) held (not WORKS); honest driver is WORKS.`);
  lines.push(`  GATE: ${result.passed ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

/**
 * GET the resolved front door as the bring-up + world proof (200 text/html serving the form).
 * @param {string} url
 * @returns {Promise<{status:number|null, contentType:string, bytes:number, hasForm:boolean, error?:string}>}
 */
async function proveFrontDoor(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    const body = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      bytes: body.length,
      hasForm: /<form\b/i.test(body),
    };
  } catch (e) {
    return { status: null, contentType: '', bytes: 0, hasForm: false, error: String((e && /** @type {any} */ (e).message) || e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {import('./conjure.mjs').SutHandle} handle
 * @param {{status:number|null, contentType:string, bytes:number, hasForm:boolean, error?:string}} proof
 * @param {boolean} keep
 * @returns {string}
 */
function renderConjure(handle, proof, keep) {
  const fp = handle.receipts.find((r) => r.kind === 'fingerprint');
  const d = (fp && fp.data) || {};
  const ready = handle.receipts.find((r) => r.kind === 'attempt');
  const lines = [`pb conjure — ${handle.recipe.name}`, '', '  fingerprint (harness):', `    mode:          ${d.mode}`];
  if (d.sha) lines.push(`    sha:           ${d.sha}`);
  if (d.image_digest) lines.push(`    image_digest:  ${d.image_digest}`);
  if (d.version_label) lines.push(`    version_label: ${d.version_label}`);
  lines.push(`    image:         ${d.image_ref_or_tag}`);
  lines.push(`    container:     ${handle.containerName}`);
  lines.push(`  ready:           ${ready ? `${ready.data.request} → ${ready.data.status}` : 'n/a'}`);
  lines.push(`  front door:      ${handle.frontDoorUrl}`);
  if (proof.status === 200 && proof.hasForm) {
    lines.push(`  SUT up:          GET front door → 200 ${proof.contentType.split(';')[0]} (form served, ${proof.bytes} bytes)`);
  } else {
    const seen = proof.status === null ? `no-response${proof.error ? ` (${proof.error})` : ''}` : `${proof.status} ${proof.contentType}`.trim();
    lines.push(`  SUT up:          GET front door → ${seen} (form ${proof.hasForm ? 'served' : 'NOT served'})`);
  }
  if (keep) lines.push(`  kept:            container ${handle.containerName} left up (tear down: docker rm -f ${handle.containerName})`);
  return lines.join('\n');
}

/**
 * Render one leg of the differential Catch (a full Catch verdict at one SHA) with its notes + reasons.
 * @param {string} label 'MERGE' | 'PARENT'
 * @param {string} sha the SHA actually built
 * @param {import('./catch.mjs').CatchResult} result
 * @returns {string}
 */
function renderCatch(label, sha, result) {
  const lines = [`pb prove — ${label} ${sha.slice(0, 12)} → ${result.verdict.state}`, ''];
  if (result.receiptPath) lines.push(`  sealed receipt:  ${result.receiptPath}`);
  if (result.diagnosis.length) {
    lines.push('  notes:');
    for (const n of result.diagnosis) lines.push(`    - ${n}`);
  }
  lines.push('  reasons:');
  for (const r of result.verdict.reasons) lines.push(`    - ${r}`);
  return lines.join('\n');
}

/**
 * Render the DIFFERENTIAL result: PASS iff merge=WORKS ∧ parent≠WORKS (the anti-tautology — the
 * PR IS why it works). A non-pass names WHY: merge didn't verify, or the parent worked too (the
 * target did not discriminate — a real finding, not a forced fit).
 * @param {import('./catch.mjs').CatchResult} merge
 * @param {import('./catch.mjs').CatchResult} parent
 * @param {boolean} pass
 * @returns {string}
 */
function renderDifferential(merge, parent, pass) {
  const lines = [
    '',
    'pb prove — DIFFERENTIAL (the PR IS why it works)',
    `  merge  ${merge.sha.slice(0, 12)}: ${merge.verdict.state}`,
    `  parent ${parent.sha.slice(0, 12)}: ${parent.verdict.state}`,
    '',
    `  DIFFERENTIAL: ${pass ? 'PASS' : 'FAIL'}  (PASS iff merge=WORKS ∧ parent≠WORKS)`,
  ];
  if (!pass) {
    if (merge.verdict.state !== Verdict.WORKS) {
      lines.push(`    - merge is ${merge.verdict.state}, not WORKS — the feature did not verify at the PR SHA (see the MERGE notes above).`);
    }
    if (parent.verdict.state === Verdict.WORKS) {
      lines.push('    - parent is WORKS too — the target did NOT discriminate (the change is not why it works; report it and pick another corpus PR).');
    }
  }
  return lines.join('\n');
}

/**
 * One leg (merge | parent) of the `pb prove --json` document.
 * @typedef {Object} VerdictJsonLeg
 * @property {string} sha
 * @property {string} verdict
 * @property {string|null} reason
 * @property {string|null} case_file
 */

/**
 * Assemble the ONE JSON document `pb prove --json` emits on stdout — pure, render-layer only:
 * every field is derived from the two CatchResults and the SAME pass/exit-code the human-readable
 * path (renderCatch/renderDifferential) already computes, never a re-decision of the tri-state.
 * `verdict` mirrors renderDifferential's own PASS/FAIL line (line ~171) rather than inventing a
 * new non-discriminating-parent state; each leg's own failing state is still visible verbatim
 * under `legs.<leg>.verdict`. `reason` joins verdict.reasons (VerdictResult carries a string[], not
 * a single string) — empty only when the verdict recorded none. `case_file` is the sealed receipt
 * persistCatchReceipt wrote for that leg (catch.mjs, always populated by runCatch today; null'd
 * defensively for a future/foreign CatchResult that omits it).
 * @param {Object} args
 * @param {string} args.recipeName
 * @param {import('./catch.mjs').CatchResult} args.merge
 * @param {import('./catch.mjs').CatchResult} args.parent
 * @param {boolean} args.pass
 * @param {number} args.exitCode
 * @returns {{schema:string, recipe:string, verdict:'PASS'|'FAIL', exit_code:number, legs:{merge:VerdictJsonLeg, parent:VerdictJsonLeg}, differential:{pass:boolean}}}
 */
export function buildVerdictJson({ recipeName, merge, parent, pass, exitCode }) {
  /**
   * @param {import('./catch.mjs').CatchResult} result
   * @returns {VerdictJsonLeg}
   */
  const leg = (result) => ({
    sha: result.sha,
    verdict: result.verdict.state,
    reason: result.verdict.reasons.length ? result.verdict.reasons.join(' ') : null,
    case_file: result.receiptPath || null,
  });
  return {
    schema: 'pb-verdict-v1',
    recipe: recipeName,
    verdict: pass ? 'PASS' : 'FAIL',
    exit_code: exitCode,
    legs: { merge: leg(merge), parent: leg(parent) },
    differential: { pass },
  };
}

/**
 * Select the proposer backend WITHOUT adding a config key: PB_PROPOSER forces it
 * (`claude-cli` | `api`); otherwise auto — use the local `claude` CLI (subscription OAuth, no key)
 * UNLESS ANTHROPIC_API_KEY is set, in which case use the Anthropic API path. Returns the LlmFn seam
 * to thread into runCatch, or undefined to let runCatch fall back to its default (defaultLlmFn = API).
 * @returns {import('./proposer.mjs').LlmFn|undefined}
 */
function selectLlmFn() {
  const pick = process.env.PB_PROPOSER || (process.env.ANTHROPIC_API_KEY ? 'api' : 'claude-cli');
  return pick === 'claude-cli' ? (input) => claudeCliLlmFn(input) : undefined;
}

async function main() {
  const cmd = process.argv[2];

  if (cmd === 'gate') {
    const result = runGate();
    process.stdout.write(renderGate(result) + '\n');
    process.exit(result.passed ? 0 : 1);
  }

  if (cmd === 'phase1' || cmd === 'phase2' || cmd === 'phase3') {
    const dir = process.argv[3];
    if (!dir || dir.startsWith('--')) {
      process.stderr.write(`pb ${cmd}: missing <dir>\n\n${usage()}\n`);
      process.exit(2);
    }
    const abs = resolve(dir);
    let result;
    if (cmd === 'phase1') {
      result = await runPhase1(abs);
    } else if (cmd === 'phase2') {
      result = await runPhase2(abs);
    } else {
      const idx = process.argv.indexOf('--intent');
      const intent = idx !== -1 ? process.argv[idx + 1] : undefined;
      result = await runPhase3({ appDir: abs, intent });
    }
    process.stdout.write(renderPhase(result) + '\n');
    process.exit(result.verdict.state === Verdict.WORKS ? 0 : 1);
  }

  if (cmd === 'conjure') {
    const keep = process.argv.includes('--keep');
    let dir = process.argv[3];
    if (process.argv.includes('--random')) {
      // Anti-overfit: pick a recipe from the pool each run — pb must not always test n8n.
      const pool = listRecipes();
      if (pool.length === 0) {
        process.stderr.write('pb conjure --random: no loadable recipes in the pool (recipes/)\n');
        process.exit(1);
      }
      const picked = pickRandom(pool);
      process.stdout.write(`randomly picked: ${picked.name} (${picked.dir})\n`);
      dir = picked.dir;
    } else if (!dir || dir.startsWith('--')) {
      process.stderr.write(`pb conjure: missing <recipeDir>\n\n${usage()}\n`);
      process.exit(2);
    }
    const abs = resolve(dir);
    /** @type {import('./conjure.mjs').SutHandle|null} */
    let handle = null;
    let code = 0;
    try {
      handle = await conjure(abs);
      const proof = await proveFrontDoor(handle.frontDoorUrl);
      process.stdout.write(renderConjure(handle, proof, keep) + '\n');
    } catch (e) {
      // Honest failure: a bring-up/setup error is CND, never evidence against the change.
      process.stdout.write(`CND (could not conjure): ${String((e && /** @type {any} */ (e).message) || e)} — this is not evidence against your change\n`);
      code = 1;
    } finally {
      if (handle && !keep) await teardownSut(handle);
    }
    process.exit(code);
  }

  if (cmd === 'prove') {
    // --json is render-layer only (schema pb-verdict-v1): it moves the human-readable rendering
    // to stderr and prints exactly one JSON document to stdout; the exit-code contract is untouched.
    const json = process.argv.includes('--json');
    const humanOut = json ? process.stderr : process.stdout;
    let dir = process.argv[3];
    if (process.argv.includes('--random')) {
      // Anti-overfit: pick a recipe from the pool each run — pb must not always prove n8n.
      const pool = listRecipes();
      if (pool.length === 0) {
        process.stderr.write('pb prove --random: no loadable recipes in the pool (recipes/)\n');
        process.exit(1);
      }
      const picked = pickRandom(pool);
      humanOut.write(`randomly picked: ${picked.name} (${picked.dir})\n`);
      dir = picked.dir;
    } else if (!dir || dir.startsWith('--')) {
      process.stderr.write(`pb prove: missing <recipeDir>\n\n${usage()}\n`);
      process.exit(2);
    }
    const abs = resolve(dir);
    const recipe = loadRecipe(abs);

    const ci = recipe.code_identity;
    if (ci.mode !== 'from_tree' || !ci.parent_sha) {
      humanOut.write(
        'pb prove: the differential Catch needs a from_tree code_identity with a parent_sha (the disclosed baseline); ' +
          'this recipe has none, so the anti-tautology (merge=WORKS ∧ parent≠WORKS) cannot be proven.\n'
      );
      process.exit(2);
    }
    // The SAME agent-proposed walk at BOTH SHAs: propose+freeze ONCE at the merge leg, then replay
    // that identical {walk, claim} at the single parent (baseline). The differential stays
    // apples-to-apples (only the built SHA differs) and LLM non-determinism is irrelevant.
    const llmFn = selectLlmFn();
    const intent = recipe.intent;
    const merge = await runCatch({ recipeDir: abs, buildSha: ci.sha, llmFn, intent });
    const parent = await runCatch({ recipeDir: abs, buildSha: ci.parent_sha, proposal: merge.proposal || undefined, llmFn, intent });
    humanOut.write(renderCatch('MERGE', merge.sha, merge) + '\n\n');
    humanOut.write(renderCatch('PARENT', parent.sha, parent) + '\n');
    const pass = merge.verdict.state === Verdict.WORKS && parent.verdict.state !== Verdict.WORKS;
    humanOut.write(renderDifferential(merge, parent, pass) + '\n');
    const exitCode = pass ? 0 : 1;
    if (json) {
      process.stdout.write(JSON.stringify(buildVerdictJson({ recipeName: recipe.name, merge, parent, pass, exitCode })) + '\n');
    }
    process.exit(exitCode);
  }

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(usage() + '\n');
    process.exit(cmd === undefined ? 2 : 0);
  }

  process.stderr.write(`pb: unknown command '${cmd}'\n\n${usage()}\n`);
  process.exit(2);
}

// Only dispatch when this file is the process entry point — importing this module for any other
// reason must never also trigger the CLI (which would read the importer's OWN argv and
// process.exit under it). realpathSync resolves a `pb` bin symlink to the same real path Node's
// loader already used for import.meta.url, so this holds for `node src/cli.mjs ...` and an
// installed `pb` binary alike.
const isDirectlyExecuted = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectlyExecuted) {
  main().catch((e) => {
    process.stderr.write(`pb: ${String((e && e.message) || e)}\n`);
    process.exit(1);
  });
}
