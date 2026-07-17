#!/usr/bin/env node
// @ts-check
/**
 * pb — the CLI dispatcher.
 *
 * Wires `pb gate` to the E1 malicious-driver gate, and `pb phase1|phase2|phase3` to
 * the three phase runners (each produces harness receipts + claims and calls the pure
 * verdict; exit 0 only on WORKS). `prove` remains an honest placeholder until the full
 * conjure→drive→seal pipeline is stitched.
 */

import { resolve } from 'node:path';
import { runGate } from './e1/gate.mjs';
import { runPhase1 } from './phases/phase1.mjs';
import { runPhase2 } from './phases/phase2.mjs';
import { runPhase3 } from './phases/phase3.mjs';
import { Verdict } from './types.mjs';

const NOT_BUILT_YET = new Set(['prove']);

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
    '  prove           [stage 2] conjure + drive a real feature — not built yet',
    '  help            show this help',
    '',
    'Phase commands exit 0 only on WORKS.',
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

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(usage() + '\n');
    process.exit(cmd === undefined ? 2 : 0);
  }

  if (NOT_BUILT_YET.has(cmd)) {
    process.stdout.write(`pb ${cmd}: not built yet — the conjure/drive pipeline lands in stage 2.\n`);
    process.exit(2);
  }

  process.stderr.write(`pb: unknown command '${cmd}'\n\n${usage()}\n`);
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`pb: ${String((e && e.message) || e)}\n`);
  process.exit(1);
});
