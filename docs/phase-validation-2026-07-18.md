# Phase correctness validation vs the 12-PR corpus — 2026-07-18

*Ultracode workflow `wf_070fee88-770`: Fable-5 planned (complex/core/product) → one rubric;
6 Opus auditors (one per contract phase P1–P6) scored all 12 corpus cases; every high/medium
break got 2 adversarial skeptics. 39/49 agents completed; the org spend limit killed the final
`report:synth` + 9 skeptics (both FW-P1-A + both FW-P1-B skeptics among them — covered here by
running the actual code, which is dispositive). This file is the hand-synthesis + independent
verification, done in the main thread against `c4cdf0e`.*

## Headline

**The honesty core has ONE live, demonstrated false-WORKS at HEAD** — a null-delta `equals`
tautology. The E1 gate does not catch it because all 9 malicious drivers use `op:'increased'`
(which requires `after > before`). **So the release claim `false-WORKS = 0` is currently FALSE
for this vector.** The fix is one line in `evalEffect` + one E1 driver to lock it.

Everything else is either (a) a **false-DNW** logic divergence (not release-gate-blocking), (b) a
**core backstop gap** that goes live once the drive/capture side is built, or (c) **latent behind
unbuilt surfaces** and correctly declining to CND today (the honest-CND-by-construction working).

> **STATUS 2026-07-18 (same day):** Finding #1 (FW-P1-A) **FIXED** — `verdict.mjs evalEffect` now
> rejects a null delta *after* the relation check, so a no-op may FALSIFY but never CONFIRM
> ("absence is a catch", §12.8, preserved). Locked by E1 driver `seed-match-null-delta` (gate now
> 10 malicious, PASS) + adversarial `(e)`/`(e-sanity)` tests. `node --test` 32/32, typecheck clean.
> `false-WORKS=0` is honest-green again. Findings #2 (DNW k-gate) and #3 (owner-shadow/M2) are
> **deferred by design** — both are verdict-contract changes, not surgical edits (see roadmap).

## Per-phase verdict (contract soundness vs impl reality)

| Phase | Contract | Impl @ HEAD | Live false-WORKS? |
|---|---|---|---|
| **P1 Intent→Promise** | compiler unbuilt; `verdict()` is the only backstop | backstop has a **LIVE hole** | **YES — FW-P1-A** |
| **P2 Environment/Conjure** | sound | compose-slice only; arbitrary conjure → CND | No (latent behind unbuilt conjure) |
| **P3 Readiness** | sound | **identity-binding UNBUILT, rounds UP** (no CND floor) | No live (real-repo path declines); unsafe default |
| **P4 Drive** | sound | mint-boundary is convention; owner-shadow capture unbuilt; 200 ms window | Latent (P4-1 arch precondition) + core gap |
| **P5 Capture/Seal** | sound | seal works (tamper-evident verified); seal-strip latent | No (latent behind persist surface) |
| **P6 Verdict** | sound | **LIVE: null-delta (=P1) + DNW-not-k-gated**; owner-shadow gap; seal-strip latent | **YES — null-delta** |

5 of 6 **contracts** are sound. The defects are in the **implementation of the trust spine**
(`verdict.mjs` / `gate.mjs`) and in **unbuilt capabilities that round up instead of flooring to CND**.

## LIVE at HEAD (reachable in the built code now)

### 1. FW-P1-A — null-delta `equals` tautology → false-WORKS  ⛔ release-gate-blocking
`verdict.mjs evalEffect` (207–247) never rejects a null delta, and `relationHolds` (148–149)
scores `op:'equals'` as `deepEqual(after, value)` **ignoring `before`**. A harness delta with
`before == after == V` (a seeded row the user action never changed) + `{op:'equals', value:V}` +
a matching fresh-session leg + `k≥2` → **WORKS**. This reopens FW-1 (oracle mislocation) at the
impl layer: §1.1's "admissible only if it binds an entity the harness saw CHANGE" is not enforced
for `equals`/`unchanged`.

**Independently demonstrated** (see repro below): `verdict()` returns `WORKS`, bundle seals +
verifies intact. **Fix (1 line):** in `evalEffect`, before the relation check —
`if (isNullDelta(delta)) return { state: NOT_EXECUTED, detail: '§1.1 write-set-bound requires an observed delta' }`.
Honest paths (phase3/E1) always have `before != after`, so no honest regression. **Then add an
E1 driver** (seed-match / null-delta `equals`) so the gate covers the vector.
Corpus cases: medusa, ghost, cal.com.

### 2. P6-B1 — DOES_NOT_WORK is not k-gated → false-DNW  (high, not release-blocking)
`verdict.mjs` rule 2 (413–418) returns `DOES_NOT_WORK` on **any** FALSIFIED claim with no
`reproduce.k` check — but theory §0.1 rule 3 requires a conviction to reproduce ≥k/N ("a single
unreproduced failure is never a verdict"). `verdict()` greening a single-walk FALSIFIED as DNW is
a divergence → blames the change for a flake (the near-peer trust-killer). CONFIRMED by 2 skeptics.
**Fix:** gate DNW on `k≥2` in `verdict()`, or explicitly document that reproduction is the
phase-runner's precondition and `verdict()` is post-reproduction (design call).

### 3. Owner-shadow on non-quantified effects (FW-P1-B = P4-2 = P6-B3)  (high, core backstop gap)
The identity-distinctness guard (`distinctInstantiations`) fires **only** for `c.quantified`
claims (rule 5, `verdict.mjs:397`); `evalEffect`/`evalNegative` never compare `receipt.identity`
to `actorIdentity`. A non-quantified effect proven only under the configuring actor (the n8n
"Test Step" trap; cal.com attendee re-proved as host) CONFIRMS → WORKS. Demonstrated in the same
repro (`identity:'owner' === actorIdentity`, `quantified:false`, still WORKS); CONFIRMED by a
surviving skeptic. Latent end-to-end (needs P1 quantification + real capture), but the backstop
is missing. **Fix needs care** (don't over-rotate genuinely single-user features): add an
`AUTH_CONTEXT` receipt kind and require an independent-session receipt on the actor leg; floor to
CND when the only front door is a same-session affordance. Land before any executed n8n/cal.com WORKS.

## Latent (real, but gated behind unbuilt surfaces — honest CND today)

- **Seal-stripping (P5-1 / P6-B4).** `gate.mjs:22` verifies the seal only `if (bundle.seal)`; a
  seal-less bundle is judged on contents. `verdict()` trusts provenance **strings**, not the
  non-enumerable `MINTED` brand (lost on serialize); `newBundle` re-floors only on construction.
  → a future load/verify/ledger surface would trust forged `harness` strings. **Fix before any
  persist surface:** missing OR invalid seal → `UNVERIFIED`; re-run `newBundle` on every load path.
- **Mint-boundary is convention (P4-1).** `mint()` is an unrestricted export imported by 5
  in-process modules; the propose/dispose property holds only because no agent-authored code runs
  in-process today. **Fix before the in-process Sonnet driver:** isolate the proposer (separate
  process / capability token) + an E1 test asserting `mint()` is unreachable from the proposer.
- **P3 code-identity binding (P3-1).** No fingerprint/version code exists; `phase2` mints
  READY/WORKS from liveness alone with no CND floor. Real-repo path declines today (`prove`
  `NOT_BUILT`), so not live — but the unbuilt default rounds UP. **Fix before real-repo
  composition:** require a harness-minted fingerprint receipt before READY/WORKS, else
  CND(identity-unbound).
- **Settle-window transient (P4-3).** `SETTLE_WINDOW_MS = 200` fixed wall-clock; an effect that
  rolls back after 200 ms samples as stable (FW-5). Bind the window close to a receipted finality
  event; floor async finality to CND until built.
- **Egress content-binding underspecified (P5-2).** §1.5 as written is false-WORKS-reachable on
  ghost (pre-existing config row) / novu (sender-overridable host) / rudder (operator singleton).
  Fix the three rules before shipping the egress ledger.
- **P2 trivial-component cast masking (P2-B1) + off-manifest topology (P2-B6).** Need the
  known-stub-component registry + conjure topology discovery before behavioral conjure of
  arbitrary repos; both decline to CND today.
- **P2 teardown reaper (P2-B2).** `finally`-only teardown is bypassed on SIGKILL (resource leak,
  not a verdict defect). CONFIRMED but no false verdict is emitted.

## Corpus readiness

The 12 cases remain **blind paper predictions**, not executed runs — arbitrary-repo conjure (P2)
and real capture (P4) are unbuilt, so every case either declines to CND or runs only on the
`shop-v1` fixture. Moving the in-scope class (cal.com, documenso, ghost, n8n — web front-door,
compose-conjurable) to *executed* requires, in order: FW-P1-A fix (#1), owner-shadow guard (#3),
then the real conjure+drive slice (the RESUME "NEXT" item).

## Minimal-fix roadmap (surgical, no scope creep)

1. **FW-P1-A** null-delta reject (1 line) + E1 seed-match driver + re-run gate. — *unblocks the release gate.*
2. **P6-B1** k-gate DOES_NOT_WORK (or document the boundary). — *closes the false-DNW.*
3. **Owner-shadow** `AUTH_CONTEXT` receipt + non-quantified guard. — *before any executed WORKS.*
4. **Seal-stripping** missing-seal → UNVERIFIED + re-floor on load. — *before ledger/verify surface.*
5. **Mint-boundary** proposer isolation + E1 unreachability test. — *before in-process Sonnet driver.*
6. **P3 identity binding** fingerprint receipt or CND-floor. — *before real-repo composition.*
7. Deferred/disclosure-bounded: P2 stub-registry, egress binding, settle→finality-event, teardown reaper.

## Repro (independent, run against `c4cdf0e`)

`scratchpad/verify-fw-p1-a.mjs` → `VERDICT STATE: WORKS`, `sealed & verifies intact? true`,
`FALSE-WORKS DEMONSTRATED? YES`. Mirrors the honest build path (`mint()` → `newBundle()` →
`verdict()`) with a null delta + `op:'equals'`.
