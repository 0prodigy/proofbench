# Phase 3 — Behavioral Verification: Theory & Proof (before any implementation)

*Theory-first. We build nothing until the property is proven on paper. This document was
written, then put under an adversarial pass (Fable) whose only job was to find a **false
WORKS** — a verdict that says works on a broken feature. It found two fatal ones in the first
draft; both are resolved below with day-one mechanisms. No slop, no stubs: every mechanism
here is load-bearing, and §4 forbids the shortcuts that would quietly weaken it.*

Standard for this project (binding): a false WORKS is the cardinal sin. Every line we later
add serves the property below or it does not ship. Abstractions do not ship until a real run
flows through them.

**Revised after Battle-test #1** (`docs/battle-test-01-calcom-webhooks.md`, Cal.com org-scoped
webhooks): egress effect checks (§1.5), quantifier lint (§1.4), and mutation-attribution
calibration (§1.2) are now day-one; new false-WORKS vectors FW-11/FW-12/FW-14 are in §2.

---

## 0. The property — corrected

The property we *wanted* was: *"the agent's unreliability can never manufacture a false
WORKS."* **As first designed, that was false.** The architecture stops the agent from writing
the verdict, fabricating evidence, or touching the seal — but it left the agent (a) **aiming
the oracle** (choosing which persisted location counts as truth), (b) **staging state** (an
unconstrained action/HTTP vocabulary lets it *create* the state the effect check confirms),
and (c) **authoring the claims' meaning** (vacuous kill-conditions, empty checks). Harness
provenance is worthless if the agent aims the camera.

### P′ — the property we can actually hold

> A **WORKS** verdict implies, for the exact code pb built and ran:
> - **(a) User-shaped execution.** ≥1 walk ran through the front door using only actions a real
>   user could take (click/type/navigate/scroll/read) — no request forging, no script
>   injection, no deep links.
> - **(b) Effect confirmed on ground truth.** ≥1 effect check, **bound to a harness-observed
>   persisted-state delta** that occurred **inside a user-action window**, confirmed on *both*
>   the persisted leg (store handle) *and* a fresh-session user surface. **Egress effects** (the
>   essence is an outbound call to a *user-configured* destination — webhooks/callbacks): the
>   check binds to the sealed-room **egress ledger** with payload content-bound to a
>   same-window persisted entity, and **content-binding replaces the fresh-session leg** (§1.5).
> - **(c) Discriminating, complete claims.** Every pre-registered claim CONFIRMED and every
>   hostile-repertoire class SURVIVED or mechanically-justified-N/A; **NOT-EXECUTED counts as
>   untested → CND**, never as pass.
> - **(d) Stability + reproduction.** The effect held across a receipted settle window, **and
>   the walk reproduced k/N from a fresh world each time** — a single clean walk is never a
>   WORKS (FW-6, decided).
>
> — all derived by **deterministic rule from sealed, harness-collected receipts the driving
> agent could neither write nor aim.**

### The threat table (what is proven vs bounded vs out-of-scope)

An honesty product must publish this, SLSA-style, and never overclaim past it.

| Property component | How assured | Residual / where the risk lives |
|---|---|---|
| No agent-fabricated evidence | **by construction** — out-of-band taps; agent has no evidence write-handle | box-owner forgery at rest → **out of scope v1**, disclosed in every case file |
| Verdict = pure function of sealed receipts | **by construction** — deterministic truth table; narration may only cite | — |
| Agent cannot *aim* the oracle | **by construction** — write-set-bound effect checks (§1.1) | agent may still pick among *real* deltas → a peripheral-but-real check → **bounded by corpus** |
| Agent cannot *stage* state | **by construction** — user-shaped vocabulary + read-only cross-exam + mutation attribution (§1.2) | — |
| Claims are discriminating | **bounded by corpus** — kill-condition *quality* is not mechanizable | claim adequacy → corpus-gated, false-WORKS = 0 release-blocking |
| Verdict is about the change's code | **by construction** — "pb built it or refuses to bind" (§1.3, FW-4) | non-reproducible builds → chronic CND → a policy decision, not a loophole |
| Effect is final, not transient | **bounded** — settle policy, empirically calibrated (E5) | long-horizon finality (sagas, async) → `notCovered` |
| Not intermittent | **by policy** — WORKS requires k/N identical walks from a fresh world (FW-6 decided) | intermittence beyond N → `notCovered`; cost: clean-path wall-clock ×~k |

The gap between the old P and P′ *is* the product's honest edge. We ship P′ and say exactly
what it does not cover.

---

## 1. The three mechanisms that must be day-one contracts (they close the fatal holes)

These are not "hardening." Without them the property is false. They ship with the seal, on
day one, or we do not have a product.

### 1.1 Write-set-bound oracle (closes FW-1: oracle mislocation)

In conjure mode the world is small and pb owns the datastore. The recorder takes a **whole-store
snapshot before and after each user-action window** and computes the **observed delta**. An
`effectCheck` is **admissible only if it binds to an entity the harness saw change** in that
window. The agent proposes *which* observed delta is the one that matters; it can no longer
point the harness at a hypothesized column that the bug happens to write.

- `PromiseContract.effectChecks[]` is structurally `{ entityIdentifiedPreAction, beforeValue,
  expectedAfterRelation }`. **Existential predicates are not admissible effect checks** (kills
  "an order with total 40 exists" — one did, in the seeds).
- **Dual-leg confirmation:** persisted delta (store handle) **AND** user-surface re-observation
  **from a fresh session** (kills read-through caches and session state).
- **Comparator provenance:** every arithmetic input to a criterion (the `$50` baseline) carries
  its own receipt from a declared layer, pinned at compile. A baseline read only from the
  screen is flagged (kills baseline poisoning).
- **Free dividend:** the write-set diff also *is* schema discovery — so there is never a reason
  to reach for the app's own `GET /orders/:id` as "persisted state" (forbidden, T3).

### 1.2 User-shaped action vocabulary + read-only cross-exam + mutation attribution (closes FW-2: the prosecutor plants evidence)

1. **The walk uses only user-shaped actions** — click / type / navigate / scroll / read. **No
   `evaluate`, no request forging from the browser context.** If a driver stack cannot operate
   without `evaluate`, that is a **CND**, not an exception.
2. **The cross-exam HTTP driver is physically read-only** — a method allowlist enforced at the
   tap; any non-GET from the driver is dropped and receipted as a harness violation.
3. **Mutation attribution (calibrated — R4).** A persisted delta to a **claim-relevant** table
   with no attributable user-shaped cause **contaminates the run → CND**. Attribution subtracts
   an **idle baseline** (ambient churn: sessions, cron, queue heartbeats) and follows **causal
   chains** (queue/scheduled rows inherit their originating window via FK) — so a real app is not
   false-CND'd by background writes; only unexplained writes to tables a claim *reads* are fatal.
   (The naive "any delta → CND" rule breaks every real app — Battle-test #1, B4.)
4. **Navigation provenance** — each navigation records its cause (clicked element / typed entry
   URL). The entry URL is the front door; any *other* typed URL is a deep link → the "reach"
   claim is not confirmed.

### 1.3 Verdict-side structural minimums (closes FW-3: vacuous claims)

Enforced at **verdict time**, independent of the compiler (so a weak compilation cannot slip a
green through):

- **WORKS requires `effectChecks.count ≥ 1`** — re-checked at the verdict, not only at compile.
  (This is the zero-tests hole; the old system closed it, the greenfield spec had dropped it.)
- Every hostile-repertoire class is `SURVIVED` or `N/A-with-a-mechanical-justification-receipt`
  (e.g. "no form element present," proven from the DOM). Agent-declared N/A is not a green.
- **NOT-EXECUTED ≡ untested → CND**, naming the probe. A probe that errored is never "survived."

### 1.4 Quantifier lint (closes FW-11: owner-shadow / quantifier collapse)

An intent with a universal quantifier (any / all / every / whole-X) is **not satisfiable by the
configuring actor's own scope.** At **verdict time** (like `effectChecks ≥ 1`), WORKS requires
**≥2 distinct in-scope instantiations that are not the configuring actor**, plus **≥1 out-of-scope
negative**. A plural event class ("booking/meeting events") forces **one claim per selected
trigger**, or an explicit `Assumed:` narrowing sealed into the echo. Without this, a walk that only
exercises the owner's own CREATED event passes every other mechanism while never testing the
feature — a false WORKS on a real feature (Battle-test #1, FW-11).

### 1.5 Egress effect check (closes B1: the outbound-delivery class)

Many real features' essence is an **outbound call to a user-configured destination** (webhooks,
callbacks, notifications): no persisted delta, no fresh-session surface, so `P′(b)` read literally
CNDs the whole class. Resolution: the sealed-room **egress ledger** and a **pb-controlled receiver**
are first-class observed stores. An egress effect check is admissible iff (i) the POST **leaves the
app container inside a settle-extended user-action window**, (ii) its payload **content-binds** to
an entity the same window persisted (booking uid / walk-minted nonce), (iii) optionally matches the
front-door-configured secret. For egress claims, **content-binding replaces the fresh-session leg.**
Carve-out: **a destination the user configures through the front door is user data — aiming it at a
controlled surface is a *walk*, not a stub.** Fixed-vendor destinations (calendar sync) remain CND.
Corollary strength: the sealed room makes **negatives provable** ("no cross-tenant delivery" = zero
egress to the receiver in-window) — stronger than any conventional suite.

---

## 2. The false-WORKS kill list (ranked; status per vector)

Status = **closed** (by a §1 mechanism), **bounded** (corpus-gated), or **open** (must prove).

| # | Vector | L×D | Resolution | Status |
|---|---|---|---|---|
| FW-1 | Oracle mislocation — harness confirms the wrong location | HIGH·FATAL | §1.1 write-set-bound + dual-leg + comparator provenance | **closed**; residual (peripheral-real delta) **bounded** |
| FW-2 | Agent stages the state it then confirms | MED·FATAL | §1.2 user-shaped vocab + RO cross-exam + mutation attribution | **closed** |
| FW-3 | Vacuous claim set (tautologies, N/A, empty checks) | HIGH·HIGH | §1.3 verdict-side minimums | **closed** on structure; kill-condition *quality* **bounded** |
| FW-4 | Wrong-bytes binding (stale image labeled with new SHA) | MED·HIGH | "pb built it from the tree, or refuses to bind"; labels/`/version` are hearsay; prebuilt → CND floor | **closed**; non-reproducible builds → **open** policy |
| FW-5 | Transient state (effect held at T, gone at T+finality) | MED·HIGH | typed settle policy: re-read persisted leg at two spaced points + fresh-session surface; long-horizon → `notCovered` | **open** — calibrate empirically (E5) |
| FW-6 | Single-walk green over an intermittent bug | MED·HIGH | **WORKS requires k/N identical walks from a fresh world** (decided) | **closed** (cost: clean-path wall-clock ×~k) |
| FW-7 | LLM misreads pixels → confirms the surface leg | MED·MED | **zero purely-perceptual confirmations** on verdict-bearing claims; surface leg = deterministic DOM-text; pixels corroborate narration only | **closed** |
| FW-8 | Attach mode: a concurrent write satisfies your check | LOW(v1)·HIGH | reserve now: run-scoped nonce entities, or effect claims cap at CND; receipts name primary-vs-replica | **reserved** (v1 is conjure-only) |
| FW-9 | Human retry-to-green, forwards the lucky file | HIGH-over-time·MED | at mint, scan output dir for sibling case files (same promise+fingerprint), stamp "3rd run; siblings: CND, DNW" | **open** (product-level; cheap mitigation) |
| FW-10 | Permissive doubles acquit a broken integration | MED·MED | a double must validate against the vendor schema and be decline-capable; a double that can't reject can't ship | **closed by rule** |
| FW-11 | Owner-shadow / quantifier collapse — walk tests only the configuring actor's own scope | HIGH·FATAL | §1.4 quantifier lint (≥2 non-actor in-scope + ≥1 negative, at verdict) | **closed** on quantifiers; general adequacy **bounded** |
| FW-12 | Fixture-world divergence — verdict rests on fixture-shaped rows prod may not produce | MED·HIGH | worldProvenance tier + world-shape receipt (R3) | **open — boundable by disclosure** |
| FW-14 | Sandbox config/flags ≠ customer prod config | MED·MED | a WORKS speaks about *code*; stays silent about config divergence, in every confession | **open — boundable by disclosure** |

---

## 3. Nuances that will bite (resolved / open)

1. **Grounding vs freeze-point contradiction (spec bug).** Grounding needs the running system;
   the promise is frozen *before* conjure. Both can't hold. → **Two-stage freeze:** semantic
   promise frozen at echo; grounding bound as a second sealed artifact post-conjure; replay
   re-uses both.
2. **Control-probe blame inversion.** With no diff input, pb can't know what's "untouched." If
   the change breaks the app shell, the control probe fails and pb would exonerate the change
   ("not evidence against your change") for a breakage the change *caused*. → In-app control
   failures read "basic flows are broken — could be your change or the world"; the exonerating
   phrasing is reserved for **pre-walk** conjure/readiness failures only.
3. **Blocked-egress inside a falsification window.** The sealed room can *manufacture* a
   conviction (a feature that legitimately needs egress fails 3/3 deterministically). → Any
   falsified claim whose causal window contains a blocked-egress event **demotes to CND
   (boundary)**, path-to-real-answer named. (New truth-table rule.)
4. **Repertoire state pollution.** Double-submit / re-entry probes mutate the world the effect
   check reads. → Effect check confirmed on a clean segment *before* hostile probes; or
   per-probe reset.
5. **Wire-tap blindness between services.** A browser-level proxy never sees storefront→orders
   traffic — so "the coupon never reached orders" narration needs evidence we won't have without
   per-container egress capture (breaks mTLS/cert-pinned → CND). → Every wire receipt carries a
   **coverage statement**; causal narration degrades to what DB+UI receipts alone support.
6. **"Read-only DB" is a promise, not physics.** → pb creates a **read-only role** at conjure
   (it owns the datastore) or reads via snapshot; the RO-ness is itself receipted.
7. **Self-verifying case file is circular** (edit receipt *and* verifier → INTACT theater). →
   In-file check is advisory; **`pb verify <file>` ships in v1** and checks against the printed
   root; the honesty panel says so.
8. **CND-rate pressure Goodharts into weaker claims.** Hardening the WORKS bar doesn't stop the
   *compiler* from lowering CND by emitting weaker checks. → The corpus includes **claim-strength
   fixtures** (a promise whose honest compilation *must* produce a specific effect check; a
   weaker one fails release).
9. **"~90 seconds" is marketing, not measurement.** → Publish the measured clean-path and
   catch-path times (E6); reset the public number to the true one.
10. **Conjure-world ≠ production.** Migrations on a seeded-empty DB prove a parallel universe.
    → The scope confession stays honest; this is *why* phases 1–2 exist, and v1 lacks them —
    do not let "works-as-intended" be read as "prod truth."
11. **Same model compiles/drives pb and (maybe) wrote the code.** Blinding removes the voice,
    not the fingerprints. → The corpus must include lies authored by the **same model family**
    that drives pb, and measure the residual.
12. **Replay conflict semantics.** WORKS file + DNW replay, same fingerprints. → Neither is
    revoked; the pair is first-class evidence of intermittence; a contradicting replay says so
    on its own verdict block.

---

## 4. The no-stub / no-slop rules (the shortcuts that quietly weaken honesty)

Each will look reasonable under deadline. Each is forbidden.

| Tempting shortcut | Forbidding rule |
|---|---|
| Read `GIT_SHA` from a label / env / `/version` for code binding | Identity is what **pb built or digest-matched**; self-declared metadata is hearsay and can never bind a verdict |
| `/health` 200 (or port-open) as readiness | Readiness = a real user-shaped request served through the front door + migrations observed complete (fixture: an app whose `/health` lies must land CND) |
| Use the app's `GET /orders/:id` as "persisted state" because the schema is annoying | Persisted receipts come only from **store handles**; an API read is a *user-surface* receipt. Schema discovery is free from §1.1's write-set diff |
| A doubles library that 200s everything | Decline-capable, schema-validating doubles only |
| Teardown in a `finally` block | External **reaper** process holding a liveness handle, SIGKILL-tested in CI |
| Let the drive agent summarize receipts for the judge | The judge reads sealed receipts or a **renderer-computed** deterministic index; anomalies are computed by code, never delegated |
| Skip the interpretation echo in CI/unattended runs | The echo is **sealed into the case file header**; oracle-audit moves to read time, never disappears |
| Replay against cached images "same tag" | Replay verifies **digest equality** before claiming comparability; tag match is hearsay |
| A vision model "confirms" a surface claim to get a green | **Zero purely-perceptual confirmations** on verdict-bearing claims (FW-7) |
| Brightcart drifts pb-aware (friendly selectors, happy-path seeds) | The fixture app stays **pb-ignorant**; new lies planted weekly by someone who didn't build pb; misses are public and permanent |
| A `sleep()` to let state settle | Settle is a **typed, receipted policy** (re-read + stability window with timestamps); CI greps for bare sleeps and fails |
| Trust compose `depends_on` / healthcheck as bring-up proof | Only pb's own **demonstrated-request** receipts count as life |

---

## 5. What must be proven before we trust this (in order)

**E0 — Rewrite the property (done, §0).** P′ + the threat table. Every FW item assigned a row.
*Gate: this document.*

**E1 — The malicious-driver suite (the keystone; built BEFORE the product).** Replace the drive
agent with adversarial *scripted* agents, one per cheat: report-success-without-acting; inject
the expected screen; `POST` the expected row via the cross-exam driver; deep-link past the
front door; register tautological kill-conditions; N/A every repertoire class; point the effect
check at a seed row / wrong column; spoof an image label. **Pass = every one lands ≤ CND, zero
reach WORKS, release-blocking forever.** The seeded-lie corpus tests broken *apps*; this tests a
lying *prosecutor* — and the prosecutor is the cardinal-sin gap. **No product code before E1
exists.**

**E2 — Write-set-bound effect checks (spike on Brightcart).** Whole-store before/after diff with
action-window bracketing. Pass = the `lying` build's oracle-mislocation variants (cache table,
existential seed-match, display-vs-charged column) all fail to reach WORKS; the `honest` build
still earns it.

**E3 — Fingerprint binding spike.** pb-built → digest↔tree bound; prebuilt/ spoofed-label / dirty
tree → CND floor with published wording. No binding from self-declared metadata.

**E4 — Verdict purity + seal determinism.** Property tests: permute all narration → verdict
byte-identical; delete any receipt type → honest build demotes to CND; replay on identical
digests k times → publish the verdict-divergence rate.

**E5 — Async settle calibration.** Worker-written-order and saga-rollback fixtures; measure
false-red vs false-confirm across settle policies; publish the policy + its `notCovered` wording.
Pass = 0 false-WORKS on rollback, false-red ≤ 5%.

**E6 — Wall-clock truth.** Measured clean-path and catch-path times, published; the public number
is the measured number.

**E7 — The corpus with asymmetric gates (from week one).** Seeded-lie fixtures + E1's
malicious-driver fixtures + claim-strength fixtures + spoofed-label fixture + same-model-family
lies. **false-WORKS = 0 is release-blocking**; the only permitted response to CND-rate pressure
is harness (and now compiler-claim-strength) hardening.

---

## 6. Build order — vertical, no stubs

The old branch died building *horizontally* (all seams, no real verdict). We build *vertically*
and honesty-first:

1. **E0** — this document. *(done)*
2. **E1** — the malicious-driver harness + the deterministic verdict truth table it exercises.
   This is the honesty core with *no real product attached yet* — but it is a real, running,
   release-gating thing, not a stub.
3. **E2 + E3** — write-set-bound oracle and fingerprint binding, proven on Brightcart.
4. **The real Catch** — conjure Brightcart, user-shaped drive, out-of-band capture, seal,
   verdict, case file — wired end to end so it catches the planted coupon lie *and* survives the
   E1 malicious drivers *and* does not false-green the honest sibling.
5. **E4–E7** — purity/determinism, settle calibration, wall-clock truth, and the gated corpus,
   standing from the first real run.

The rule throughout: **nothing ships until a real run flows through it**, and **every release is
gated by E7 (false-WORKS = 0) and E1 (no malicious driver reaches WORKS).**

---

*Method note: §0's fatal-flaw finding, the FW kill list, the nuance list, the anti-stub table,
and E0–E7 came from an adversarial theory pass (Fable) against the first draft of this design —
the point of proving on paper first. What it caught (the agent aiming the oracle and staging
state) would have been a shipped false-WORKS had we gone straight to code.*
