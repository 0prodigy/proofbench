// @ts-check
/**
 * The SIGNAL REAPER — reap live SUT state (containers / compose graphs / temp checkouts) when pb is
 * INTERRUPTED, not just when it exits cleanly.
 *
 * conjure() leaves a real SUT up on success and teardownSut() reaps it in the caller's `finally` —
 * but a `finally` only runs on normal completion or a thrown error. A Ctrl-C (SIGINT) or an
 * orchestrator kill (SIGTERM) terminates the process WITHOUT unwinding that `finally`, so the SUT
 * container / compose graph / temp clone dir LEAKS (RESUME.md: bitten twice). This module closes that
 * gap: conjure REGISTERS a best-effort reap when it brings a SUT up and DE-REGISTERS it on normal
 * teardown; a one-time SIGINT/SIGTERM handler runs every still-registered reap, then exits with the
 * conventional signal code (128 + signo: 130 for SIGINT, 143 for SIGTERM).
 *
 * Double-reap-safe: the handler DRAINS the registry once, and normal teardown de-registers before it
 * reaps, so a reap runs at most once per SUT — and conjure's own reaps (docker rm -f / compose down
 * -v / rmSync) are themselves no-ops when the target is already gone, so even a double call is inert.
 * The happy path is unchanged: with no signal, the `finally` teardown runs exactly as before and the
 * de-register makes the registered reap dead weight the handler never touches.
 *
 * ponytail — the ceiling: SIGKILL (kill -9) and a hard power loss CANNOT be caught by any process, so
 * this is best-effort, not a guarantee. The robust upgrade is a Ryuk-style reaper sidecar (a container
 * that watches pb's session and reaps the labelled SUT if pb dies) — the pattern Testcontainers uses;
 * adopt it if best-effort signal reaping proves insufficient.
 *
 * Zero runtime deps: a module-level Set + process signal handlers.
 */

/**
 * A best-effort cleanup to run on interrupt.
 * @typedef {() => (void | Promise<void>)} Reap
 */

/** The signals we reap on, mapped to their conventional exit code (128 + signal number). */
const SIGNAL_EXIT = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

/** @type {Set<Reap>} the live reaps — added on bring-up, removed on normal teardown. */
const active = new Set();

/** Guards the ONE-TIME signal-handler install (so importing the reaper attaches nothing on its own). */
let installed = false;

/**
 * Register a best-effort reap and lazily install the signal handlers. Returns the SAME function so the
 * caller can de-register the exact reference on normal teardown.
 * @param {Reap} reap
 * @returns {Reap}
 */
export function registerReap(reap) {
  active.add(reap);
  installSignalReaper();
  return reap;
}

/**
 * De-register a reap the normal teardown has already run, so the signal handler never re-runs it. A
 * no-op if it was already drained by the handler (or never registered).
 * @param {Reap} reap
 */
export function deregisterReap(reap) {
  active.delete(reap);
}

/**
 * Run every registered reap once, best-effort — a throw in one never blocks the rest — DRAINING the
 * registry so nothing is reaped twice. This is exactly what the SIGINT/SIGTERM handler calls; it is
 * exported so the reaper LOGIC is unit-tested without sending a real OS signal or needing docker.
 * @returns {Promise<void>}
 */
export async function runAllReaps() {
  const reaps = Array.from(active);
  active.clear();
  for (const reap of reaps) {
    try {
      await reap();
    } catch {
      /* best-effort: a failed reap must never block the others or the exit */
    }
  }
}

/**
 * Install the ONE-TIME SIGINT/SIGTERM handlers that drain the registry then exit 130/143. Idempotent
 * (guarded), and safe to call from every registerReap. Kept off module top-level so a bare import of
 * the reaper never attaches a handler until a SUT is actually registered.
 */
export function installSignalReaper() {
  if (installed) return;
  installed = true;
  for (const sig of /** @type {(keyof typeof SIGNAL_EXIT)[]} */ (Object.keys(SIGNAL_EXIT))) {
    process.on(sig, () => {
      // Reap what is still live, then exit with the conventional 128 + signo code. The reaps are
      // synchronous under the hood (docker via spawnSync), so this settles before the process exits.
      runAllReaps().finally(() => process.exit(SIGNAL_EXIT[sig]));
    });
  }
}
