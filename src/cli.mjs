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

import { resolve, dirname, join } from 'node:path';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { conjure, teardownSut } from './conjure.mjs';
import { runGate } from './e1/gate.mjs';
import { runPhase1 } from './phases/phase1.mjs';
import { runPhase2 } from './phases/phase2.mjs';
import { runPhase3 } from './phases/phase3.mjs';
import { listRecipes, pickRandom } from './pool.mjs';
import { loadRecipe } from './recipe.mjs';
import { runCatch, sealedVerdict } from './catch.mjs';
import { claudeCliLlmFn } from './proposer.mjs';
import { contentAddress, sealBundle } from './evidence.mjs';
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
    '  prove <recipeDir>|--random   run the differential Catch at the merge SHA and the parent SHA (--random: pick one from the pool) → PASS iff merge=WORKS ∧ parent≠WORKS',
    "  prove <recipeDir> --leg <label> [--replay-walk <case.json>] [--out <path>]   run ONE leg of a conjure.mode:'k8s-attach' operator-deploy-swap differential (the deploy is swapped OUT-OF-BAND between legs); persists a sealed case file carrying {leg, differential:false} — a single leg can never pass as a differential — exits on the LEG's own verdict",
    '  differential <merge-case.json> <parent-case.json>   fold two sealed leg cases (from prove --leg) into DIFFERENTIAL: PASS iff merge=WORKS and parent=DOES_NOT_WORK',
    '  help            show this help',
    '',
    'Phase commands exit 0 only on WORKS; prove exits 0 only on differential PASS (a --leg run',
    'instead exits 0 WORKS / 1 DOES_NOT_WORK / 2 COULD_NOT_DETERMINE / 3 internal, on its own verdict);',
    'differential exits 0 only on PASS, 2 on a mismatch, 3 on a seal/validation failure.',
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

// ---------------------------------------------------------------------------
// k8s-attach LEG differential (ENG-17397 class): the merge/parent legs are separated by an
// OUT-OF-BAND deploy swap (the operator redeploys between two SEPARATE `pb prove --leg` CLI
// invocations, not one process), so the differential can't be assembled in a single `prove` run
// the way the from_tree path does. Each leg runs through the EXISTING routed catch path unchanged
// (runCatch's own drive.mode:'note-lifecycle' dispatch — resolveCatchSeams -> runNoteLifecycleCatch);
// this section only labels + persists the result as a durable, replayable case file and folds two
// case files into a verdict. It never mints evidence and never touches verdict.mjs/harness.mjs/
// evidence.mjs — sealBundle/contentAddress/sealedVerdict are REUSED exactly as-is.
// ---------------------------------------------------------------------------

/**
 * The frozen exit-code contract (CLAUDE.md), applied to a single leg's own verdict — never a
 * differential PASS/FAIL (only `pb differential` ever prints that).
 * @param {string} state
 * @returns {number} 0 WORKS / 1 DOES_NOT_WORK / 2 COULD_NOT_DETERMINE / 3 UNVERIFIED (or anything else — internal)
 */
export function exitCodeForVerdict(state) {
  if (state === Verdict.WORKS) return 0;
  if (state === Verdict.DOES_NOT_WORK) return 1;
  if (state === Verdict.COULD_NOT_DETERMINE) return 2;
  return 3;
}

/**
 * Wrap ONE leg's Catch result into a durable, sealed CASE FILE. The frozen agent proposal
 * {walk, claim} is folded in as an EXTRA agent-provenance receipt so it is tamper-evident under a
 * FRESH ed25519 seal over intent+claims+receipts+verdict (evidence.mjs's sealBundle, reused as-is,
 * never re-implemented) — `--replay-walk`/`differential` can then extract it from the SEALED
 * bundle only, never a loose file. `{leg, differential:false}` sit alongside as routing metadata:
 * only `pb differential` (which needs TWO case files) ever prints "DIFFERENTIAL: PASS", so a
 * single leg's case can never pass itself off as one.
 * @param {Object} args
 * @param {{name:string}} args.recipe the loaded recipe (only .name is carried into the case)
 * @param {string} args.recipeDir
 * @param {string} args.leg operator-chosen label (e.g. 'merge' | 'parent')
 * @param {import('./catch.mjs').CatchResult} args.result
 * @returns {any} the pb-catch-case-v1 case file (JSON-serializable)
 */
export function sealLegCase({ recipe, recipeDir, leg, result }) {
  const proposal = result.proposal;
  const receipts = proposal
    ? [
        ...result.bundle.receipts,
        {
          id: 'agent-proposal',
          kind: 'proposal',
          provenance: 'agent',
          data: { walk: proposal.walk, claim: proposal.claim },
          sha256: contentAddress(JSON.stringify({ walk: proposal.walk, claim: proposal.claim })),
        },
      ]
    : result.bundle.receipts;
  const rewrapped = {
    intent: result.bundle.intent,
    actorIdentity: result.bundle.actorIdentity,
    claims: result.bundle.claims,
    receipts,
    reproduce: result.bundle.reproduce,
  };
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    kind: 'pb-catch-case-v1',
    leg,
    differential: false,
    recipe: recipe.name,
    recipeDir,
    sha: result.sha,
    bundle: sealBundle(rewrapped, privateKey),
  };
}

/**
 * Extract the FROZEN {walk, claim} from a sealed leg case's 'agent-proposal' receipt, refusing a
 * tampered or malformed case (never returning a walk to replay from an untrusted artifact). Reuses
 * sealedVerdict (catch.mjs) — the SAME verifySeal path every other verdict in this project goes
 * through — so a mutated receipt/claim/intent surfaces as UNVERIFIED here too.
 * @param {any} caseFile parsed pb-catch-case-v1 JSON
 * @returns {{proposal:import('./proposer.mjs').Proposal}|{error:string}}
 */
export function extractFrozenProposal(caseFile) {
  if (!caseFile || !caseFile.bundle) return { error: 'not a pb case file (missing .bundle)' };
  const v = sealedVerdict(caseFile.bundle);
  if (v.state === Verdict.UNVERIFIED) return { error: `UNVERIFIED: ${v.reasons[0] || 'the sealed case did not verify'}` };
  const rec = (caseFile.bundle.receipts || []).find((/** @type {any} */ r) => r.id === 'agent-proposal');
  if (!rec || !rec.data || !rec.data.walk || !rec.data.claim) {
    return { error: 'sealed case carries no agent-proposal receipt (was it produced by `pb prove --leg`?)' };
  }
  return { proposal: rec.data };
}

/**
 * Stable, key-sorted JSON (mirrors the small pure stableStringify/sortKeys pair every honesty-core
 * module duplicates on purpose — verdict.mjs/evidence.mjs/harness.mjs — so modules stay independent).
 * @param {any} value
 * @returns {string}
 */
function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}
/** @param {any} v @returns {any} */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/**
 * Fold two sealed leg case files into a differential verdict — computes nothing new and mints
 * nothing: it re-derives each leg's verdict FRESH from ITS OWN seal (sealedVerdict, so a tampered
 * case can never contribute a verdict) and enforces the anti-tautology preconditions (same recipe
 * identity, byte-identical frozen {walk, claim} replayed on both legs). PURE (no I/O, no
 * process.exit) so it is unit-testable without a live cluster.
 * @param {Object} args
 * @param {any} args.mergeCase parsed pb-catch-case-v1 JSON (validated here — any shape accepted)
 * @param {any} args.parentCase
 * @param {string} args.mergePath for messages only
 * @param {string} args.parentPath for messages only
 * @returns {{exitCode:number, lines:string[]}}
 */
export function judgeDifferential({ mergeCase, parentCase, mergePath, parentPath }) {
  if (!mergeCase || !mergeCase.bundle || !parentCase || !parentCase.bundle) {
    return { exitCode: 3, lines: ['pb differential: a case file is missing .bundle — not a sealed pb-catch-case-v1 artifact.'] };
  }
  const mergeVerdict = sealedVerdict(mergeCase.bundle);
  const parentVerdict = sealedVerdict(parentCase.bundle);
  if (mergeVerdict.state === Verdict.UNVERIFIED || parentVerdict.state === Verdict.UNVERIFIED) {
    const lines = ['pb differential — UNVERIFIED (a sealed case did not verify; tamper-evident, not judged on merit)'];
    if (mergeVerdict.state === Verdict.UNVERIFIED) lines.push(`  merge  (${mergePath}): ${mergeVerdict.reasons[0]}`);
    if (parentVerdict.state === Verdict.UNVERIFIED) lines.push(`  parent (${parentPath}): ${parentVerdict.reasons[0]}`);
    return { exitCode: 3, lines };
  }
  if (mergeCase.recipe !== parentCase.recipe || mergeCase.recipeDir !== parentCase.recipeDir) {
    return {
      exitCode: 2,
      lines: [
        `pb differential: recipe identity mismatch — merge='${mergeCase.recipe}' (${mergeCase.recipeDir}) vs parent='${parentCase.recipe}' (${parentCase.recipeDir}); the two legs must be the SAME recipe.`,
      ],
    };
  }
  const mergeProposal = extractFrozenProposal(mergeCase);
  const parentProposal = extractFrozenProposal(parentCase);
  if ('error' in mergeProposal || 'error' in parentProposal) {
    return { exitCode: 2, lines: [`pb differential: ${('error' in mergeProposal && mergeProposal.error) || ('error' in parentProposal && parentProposal.error)}`] };
  }
  if (stableStringify(mergeProposal.proposal) !== stableStringify(parentProposal.proposal)) {
    return {
      exitCode: 2,
      lines: [
        'pb differential: merge and parent did NOT replay the SAME agent-proposed {walk, claim} — not apples-to-apples (re-run the parent leg with --replay-walk pointing at the merge case).',
      ],
    };
  }
  const pass = mergeVerdict.state === Verdict.WORKS && parentVerdict.state === Verdict.DOES_NOT_WORK;
  const lines = [
    'pb differential — DIFFERENTIAL (the deploy swap IS why it works)',
    `  merge  (${mergeCase.leg || 'merge'}, ${mergePath}): ${mergeVerdict.state}`,
    `  parent (${parentCase.leg || 'parent'}, ${parentPath}): ${parentVerdict.state}`,
    '',
    `  DIFFERENTIAL: ${pass ? 'PASS' : 'FAIL'}  (PASS iff merge=WORKS and parent=DOES_NOT_WORK)`,
  ];
  if (!pass) {
    if (mergeVerdict.state !== Verdict.WORKS) lines.push(`    - merge is ${mergeVerdict.state}, not WORKS.`);
    if (parentVerdict.state !== Verdict.DOES_NOT_WORK) lines.push(`    - parent is ${parentVerdict.state}, not DOES_NOT_WORK.`);
  }
  return { exitCode: pass ? 0 : 2, lines };
}

/**
 * `pb prove <recipeDir> --leg <label> [--replay-walk <path>] [--out <path>]` — ONE leg of a
 * conjure.mode:'k8s-attach' operator-deploy-swap differential (recipes/lyric-eng17397-stage-
 * controls is the first). Runs through the EXISTING routed catch path unchanged (runCatch's own
 * drive.mode:'note-lifecycle' dispatch) — this only labels + persists the result as a case file.
 * `--replay-walk` loads a PRIOR leg's sealed case, seal-verifies it (tamper -> refuse, exit 3), and
 * replays its FROZEN {walk, claim} with NO proposer call — mirroring runCatch's own in-process
 * propose-once-freeze, but across the two SEPARATE CLI invocations the operator's deploy swap
 * requires. Exit code is the leg's OWN verdict (never a differential) — see exitCodeForVerdict.
 * @param {import('./recipe.mjs').Recipe} recipe
 * @param {string} abs
 */
async function proveLeg(recipe, abs) {
  const legIdx = process.argv.indexOf('--leg');
  const leg = legIdx !== -1 ? process.argv[legIdx + 1] : undefined;
  if (!leg || leg.startsWith('--')) {
    process.stderr.write(`pb prove --leg: missing <label>\n\n${usage()}\n`);
    process.exit(2);
  }

  const replayIdx = process.argv.indexOf('--replay-walk');
  /** @type {import('./proposer.mjs').Proposal|undefined} */
  let proposal;
  if (replayIdx !== -1) {
    const replayPath = process.argv[replayIdx + 1];
    if (!replayPath || replayPath.startsWith('--')) {
      process.stderr.write(`pb prove --replay-walk: missing <path>\n\n${usage()}\n`);
      process.exit(2);
    }
    /** @type {any} */
    let loaded;
    try {
      loaded = JSON.parse(readFileSync(resolve(replayPath), 'utf8'));
    } catch (e) {
      process.stdout.write(`pb prove --leg ${leg}: could not read/parse --replay-walk case ${replayPath}: ${String((e && /** @type {any} */ (e).message) || e)}\n`);
      process.exit(3);
    }
    const extracted = extractFrozenProposal(loaded);
    if ('error' in extracted) {
      process.stdout.write(`pb prove --leg ${leg}: ${extracted.error}\n`);
      process.exit(3);
    }
    proposal = extracted.proposal;
  }

  const llmFn = selectLlmFn();
  const intent = recipe.intent;
  const result = await runCatch({ recipeDir: abs, intent, llmFn, proposal });

  const outIdx = process.argv.indexOf('--out');
  const outArg = outIdx !== -1 ? process.argv[outIdx + 1] : undefined;
  const outPath = outArg ? resolve(outArg) : join(dirname(result.receiptPath), `case-${leg}.json`);
  const kase = sealLegCase({ recipe, recipeDir: abs, leg, result });
  writeFileSync(outPath, JSON.stringify(kase, null, 2));

  process.stdout.write(renderCatch(leg.toUpperCase(), result.sha || leg, result) + '\n\n');
  process.stdout.write(`  leg case (leg=${leg}, differential=false): ${outPath}\n`);
  process.exit(exitCodeForVerdict(result.verdict.state));
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
    let dir = process.argv[3];
    if (process.argv.includes('--random')) {
      // Anti-overfit: pick a recipe from the pool each run — pb must not always prove n8n.
      const pool = listRecipes();
      if (pool.length === 0) {
        process.stderr.write('pb prove --random: no loadable recipes in the pool (recipes/)\n');
        process.exit(1);
      }
      const picked = pickRandom(pool);
      process.stdout.write(`randomly picked: ${picked.name} (${picked.dir})\n`);
      dir = picked.dir;
    } else if (!dir || dir.startsWith('--')) {
      process.stderr.write(`pb prove: missing <recipeDir>\n\n${usage()}\n`);
      process.exit(2);
    }
    const abs = resolve(dir);
    const recipe = loadRecipe(abs);

    // --leg is gated on conjure.mode (not merely on flag presence), so a from_tree recipe's path
    // below is byte-identical to before — it never even reaches this branch or parses --leg/
    // --replay-walk/--out. Only a conjure.mode:'k8s-attach' recipe (the operator-deploy-swap
    // class) is run ONE leg at a time; the from_tree differential below stays untouched.
    if (recipe.conjure && recipe.conjure.mode === 'k8s-attach') {
      await proveLeg(recipe, abs);
      return;
    }

    const ci = recipe.code_identity;
    if (ci.mode !== 'from_tree' || !ci.parent_sha) {
      process.stdout.write(
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
    process.stdout.write(renderCatch('MERGE', merge.sha, merge) + '\n\n');
    process.stdout.write(renderCatch('PARENT', parent.sha, parent) + '\n');
    const pass = merge.verdict.state === Verdict.WORKS && parent.verdict.state !== Verdict.WORKS;
    process.stdout.write(renderDifferential(merge, parent, pass) + '\n');
    process.exit(pass ? 0 : 1);
  }

  if (cmd === 'differential') {
    const mergePath = process.argv[3];
    const parentPath = process.argv[4];
    if (!mergePath || !parentPath || mergePath.startsWith('--') || parentPath.startsWith('--')) {
      process.stderr.write(`pb differential: missing <merge-case.json> <parent-case.json>\n\n${usage()}\n`);
      process.exit(2);
    }
    const mergeAbs = resolve(mergePath);
    const parentAbs = resolve(parentPath);
    /** @type {any} */
    let mergeCase;
    /** @type {any} */
    let parentCase;
    try {
      mergeCase = JSON.parse(readFileSync(mergeAbs, 'utf8'));
      parentCase = JSON.parse(readFileSync(parentAbs, 'utf8'));
    } catch (e) {
      process.stdout.write(`pb differential: could not read/parse a case file: ${String((e && /** @type {any} */ (e).message) || e)}\n`);
      process.exit(3);
    }
    const { exitCode, lines } = judgeDifferential({ mergeCase, parentCase, mergePath: mergeAbs, parentPath: parentAbs });
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(exitCode);
  }

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(usage() + '\n');
    process.exit(cmd === undefined ? 2 : 0);
  }

  process.stderr.write(`pb: unknown command '${cmd}'\n\n${usage()}\n`);
  process.exit(2);
}

// Only dispatch when this file is the process entry point — importing sealLegCase/
// extractFrozenProposal/judgeDifferential/exitCodeForVerdict (test/cli.test.mjs) must never also
// trigger the CLI (which would read the test runner's OWN argv and process.exit under it).
// realpathSync resolves a `pb` bin symlink to the same real path Node's loader already used for
// import.meta.url, so this holds for `node src/cli.mjs ...` and an installed `pb` binary alike.
const isDirectlyExecuted = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectlyExecuted) {
  main().catch((e) => {
    process.stderr.write(`pb: ${String((e && e.message) || e)}\n`);
    process.exit(1);
  });
}
