#!/usr/bin/env node
// @ts-check
/**
 * pb — the CLI dispatcher.
 *
 * Stage 1 (this file) wires `pb gate` to the E1 malicious-driver gate. The
 * prove/phase1/phase2/phase3 subcommands are honest placeholders — the conjure/
 * drive pipeline lands in stage 2, and they say so rather than pretending to run.
 */

import { runGate } from './e1/gate.mjs';

const NOT_BUILT_YET = new Set(['prove', 'phase1', 'phase2', 'phase3']);

function usage() {
  return [
    'pb — proof-of-work for AI change (honesty core, E1)',
    '',
    'Usage: pb <command>',
    '',
    'Commands:',
    '  gate      run the E1 malicious-driver gate (deterministic; exit 0=pass, 1=fail)',
    '  prove     [stage 2] conjure + drive a real feature — not built yet',
    '  phase1    [stage 2] intent -> promise — not built yet',
    '  phase2    [stage 2] environment (conjure) — not built yet',
    '  phase3    [stage 2] readiness gate — not built yet',
    '  help      show this help',
  ].join('\n');
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

function main() {
  const cmd = process.argv[2];

  if (cmd === 'gate') {
    const result = runGate();
    process.stdout.write(renderGate(result) + '\n');
    process.exit(result.passed ? 0 : 1);
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

main();
