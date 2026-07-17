// @ts-check
/**
 * Phase 1 — Intent → Promise via the project's OWN committed test suite.
 *
 * runPhase1 detects the stack (package.json → the repo's own `npm test` script;
 * go.mod → `go test ./...`; pyproject.toml → pytest) and RUNS it in repoDir with
 * node:child_process, in fresh child processes, RUNS times (FW-6: a single green run
 * is never WORKS). It then PRODUCES harness receipts from the real exit codes + test
 * tallies and calls verdict() — it never decides the tri-state itself:
 *   - ran and passed (>=1 test, reproduced k>=2) → effect CONFIRMED   → WORKS
 *   - ran and failed                             → effect FALSIFIED   → DOES_NOT_WORK
 *   - no stack / cannot run / zero tests         → effect NOT_EXECUTED → COULD_NOT_DETERMINE
 * A suite that exits 0 having executed 0 tests is the §1.3 "zero-tests hole": the
 * harness refuses to mint a confirming delta for a run that verified nothing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newBundle } from '../evidence.mjs';
import { mint } from '../harness.mjs';
import { verdict } from '../verdict.mjs';

const RUNS = 2;

/**
 * A child env that cannot inherit a parent node:test runner context — otherwise a
 * spawned `node --test` suite silently skips its own files ("run() is being called
 * recursively") and exits 0 without testing anything.
 * @returns {NodeJS.ProcessEnv}
 */
function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (env.NODE_OPTIONS && /--test\b/.test(env.NODE_OPTIONS)) {
    env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/--test\b/g, '').trim();
  }
  return env;
}

/**
 * @typedef {Object} PhaseResult
 * @property {string} phase
 * @property {import('../types.mjs').VerdictResult} verdict
 * @property {string[]} diagnosis runner-computed deterministic notes (never the tri-state itself)
 * @property {import('../types.mjs').EvidenceBundle} bundle
 */

/**
 * @typedef {Object} Stack
 * @property {'node'|'go'|'python'} kind
 * @property {string} cmd
 * @property {() => import('node:child_process').SpawnSyncReturns<string>} run
 */

/**
 * @param {string} repoDir
 * @returns {{stack: Stack|null, reason?: string}}
 */
function detectStack(repoDir) {
  const pkgPath = join(repoDir, 'package.json');
  if (existsSync(pkgPath)) {
    let pkg = null;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      return { stack: null, reason: 'package.json is present but unparseable' };
    }
    const testScript = pkg && pkg.scripts && pkg.scripts.test;
    if (!testScript) return { stack: null, reason: 'package.json has no "test" script' };
    if (/no test specified/.test(testScript)) {
      return { stack: null, reason: 'package.json test script is the npm placeholder (no real tests)' };
    }
    return {
      stack: {
        kind: 'node',
        cmd: `npm test (${testScript})`,
        run: () => spawnSync('npm', ['test'], { cwd: repoDir, encoding: 'utf8', timeout: 120000, env: cleanEnv() }),
      },
    };
  }
  if (existsSync(join(repoDir, 'go.mod'))) {
    return {
      stack: {
        kind: 'go',
        cmd: 'go test ./...',
        run: () => spawnSync('go', ['test', './...'], { cwd: repoDir, encoding: 'utf8', timeout: 300000, env: cleanEnv() }),
      },
    };
  }
  if (existsSync(join(repoDir, 'pyproject.toml'))) {
    return {
      stack: {
        kind: 'python',
        cmd: 'python3 -m pytest',
        run: () => spawnSync('python3', ['-m', 'pytest', '-q'], { cwd: repoDir, encoding: 'utf8', timeout: 300000, env: cleanEnv() }),
      },
    };
  }
  return { stack: null, reason: 'no supported stack found (looked for package.json, go.mod, pyproject.toml)' };
}

/**
 * Parse the test tally from a run's combined output. testsRan is 0 for a confirmed
 * zero-test run, a positive count (or 1 as a ">=1 ran" sentinel) when tests executed,
 * or null when the count is undeterminable for that runner.
 * @param {'node'|'go'|'python'} kind
 * @param {string} out
 * @param {number|null} exitCode
 * @returns {{testsRan: number|null, failed: number|null}}
 */
function parseTally(kind, out, exitCode) {
  if (kind === 'node') {
    const t = out.match(/(?:#|ℹ)\s*tests\s+(\d+)/);
    const f = out.match(/(?:#|ℹ)\s*fail\s+(\d+)/);
    return { testsRan: t ? Number(t[1]) : null, failed: f ? Number(f[1]) : null };
  }
  if (kind === 'python') {
    if (/no tests ran/i.test(out) || exitCode === 5) return { testsRan: 0, failed: null };
    const c = out.match(/collected\s+(\d+)\s+item/i);
    const f = out.match(/(\d+)\s+failed/i);
    return { testsRan: c ? Number(c[1]) : null, failed: f ? Number(f[1]) : null };
  }
  // go
  const ran = /(^|\n)(ok|FAIL|PASS)\b/.test(out) || /---\s+(FAIL|PASS)/.test(out);
  const onlyNoFiles = /no test files/.test(out) && !ran;
  return { testsRan: onlyNoFiles ? 0 : ran ? 1 : null, failed: /\bFAIL\b/.test(out) ? 1 : null };
}

/** @param {string} s @param {number} [n] */
function tail(s, n = 1500) {
  s = s || '';
  return s.length > n ? s.slice(-n) : s;
}

/**
 * @param {import('../types.mjs').EvidenceBundle} bundle
 * @param {string[]} diagnosis
 * @returns {PhaseResult}
 */
function finalize(bundle, diagnosis) {
  return { phase: 'phase1', verdict: verdict(bundle), diagnosis, bundle };
}

/**
 * Run phase 1 against a repo.
 * @param {string} repoDir
 * @returns {Promise<PhaseResult>}
 */
export async function runPhase1(repoDir) {
  /** @type {string[]} */
  const diagnosis = [];
  const { stack, reason } = detectStack(repoDir);
  if (!stack) {
    diagnosis.push(`phase1: cannot run — ${reason}.`);
    return finalize(
      newBundle({ intent: `Run the committed test suite in ${repoDir}.`, actorIdentity: 'ci', claims: [], receipts: [], reproduce: { k: 0, n: 0 } }),
      diagnosis
    );
  }

  const cmd = stack.cmd;
  const intent = `The committed test suite passes in ${repoDir} (${cmd}).`;

  /** @type {Array<{exitCode:number|null, testsRan:number|null, failed:number|null, out:string}>} */
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const r = stack.run();
    if (r.error && /** @type {any} */ (r.error).code === 'ENOENT') {
      diagnosis.push(`phase1: cannot run — the ${stack.kind} toolchain is not available (${cmd}).`);
      return finalize(
        newBundle({ intent, actorIdentity: 'ci', claims: [], receipts: [], reproduce: { k: 0, n: 0 } }),
        diagnosis
      );
    }
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const { testsRan, failed } = parseTally(stack.kind, out, r.status);
    runs.push({ exitCode: r.status, testsRan, failed, out });
  }

  const first = runs[0];
  const cannotComplete = first.exitCode === null;
  const zeroTests = first.testsRan === 0;

  // Cannot complete (timeout/signal) or zero tests => the run verified nothing =>
  // record the runs as ATTEMPTs so the effect claim is NOT_EXECUTED => CND.
  if (cannotComplete || zeroTests) {
    diagnosis.push(
      cannotComplete
        ? `phase1: the suite did not complete (timeout/signal) on ${cmd} — nothing was verified.`
        : `phase1: ${cmd} ran but executed 0 tests — nothing was verified (§1.3 zero-tests hole); refusing to mint a confirming result.`
    );
    const receipts = runs.map((r, idx) =>
      mint({
        id: `run-${idx + 1}`,
        kind: 'attempt',
        provenance: 'harness',
        identity: 'ci',
        data: { cmd, exitCode: r.exitCode, testsRan: r.testsRan, tail: tail(r.out) },
      })
    );
    const claims = [
      {
        id: 'suite-passes',
        kind: 'effect',
        scope: cmd,
        effectCheck: {
          entity: 'test-suite',
          expectedAfterRelation: { op: 'equals', value: 0 },
          deltaReceiptId: 'run-1',
          confirmLegReceiptId: 'run-2',
        },
        receiptIds: ['run-1', 'run-2'],
      },
    ];
    return finalize(newBundle({ intent, actorIdentity: 'ci', claims, receipts, reproduce: { k: 0, n: RUNS } }), diagnosis);
  }

  // A real run: delta = run 1 (persisted leg), confirm leg = run 2 (a fresh process
  // re-observation). reproduce.k = runs that genuinely passed (exit 0, no failures).
  const k = runs.filter((r) => r.exitCode === 0 && (r.failed == null || r.failed === 0) && r.testsRan !== 0).length;
  const receipts = [
    {
      id: 'run-1',
      kind: 'delta',
      provenance: 'harness',
      identity: 'ci',
      sourcePR: false,
      data: { entity: 'test-suite', cmd, before: 'not-run', after: first.exitCode, testsRan: first.testsRan, failed: first.failed, tail: tail(first.out) },
    },
    {
      id: 'run-2',
      kind: 'fresh-session',
      provenance: 'harness',
      identity: 'ci',
      // `observed` content-binds this fresh re-observation to run-1's persisted `after` (§1.1).
      data: { entity: 'test-suite', cmd, observed: runs[1].exitCode, exitCode: runs[1].exitCode, testsRan: runs[1].testsRan, failed: runs[1].failed },
    },
  ].map(mint);
  const claims = [
    {
      id: 'suite-passes',
      kind: 'effect',
      scope: cmd,
      effectCheck: {
        entity: 'test-suite',
        expectedAfterRelation: { op: 'equals', value: 0 },
        deltaReceiptId: 'run-1',
        confirmLegReceiptId: 'run-2',
      },
      receiptIds: ['run-1', 'run-2'],
    },
  ];
  if (first.exitCode === 0) {
    diagnosis.push(`phase1: ${cmd} passed (${first.testsRan ?? '?'} test(s)); reproduced k=${k}/${RUNS}.`);
  } else {
    diagnosis.push(`phase1: ${cmd} failed (exit ${first.exitCode}${first.failed ? `, ${first.failed} failing` : ''}).`);
  }
  return finalize(newBundle({ intent, actorIdentity: 'ci', claims, receipts, reproduce: { k, n: RUNS } }), diagnosis);
}
