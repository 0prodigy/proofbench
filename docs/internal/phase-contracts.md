# Phase Contracts & Tool Integration — v1

*The buildable plan below the vision. For each phase: what it **solves**, its **contract**
(the seam — typed input → typed output), the **default tool we ship** plus the **bring-your-own**
alternatives (so it runs on your infra), the **evidence** it produces (proof on WORKS, the
broken moment on DOES NOT WORK), and exactly **where the AI is allowed to be wrong vs where it
is forbidden**. This document is the contract; implementations swap, these seams do not.*

---

## 0. The problem this document solves

A **works / doesn't** verdict built on AI agents is tricky because agents are
non-deterministic and will report success they cannot substantiate. Every design decision
here exists to make the verdict trustworthy *despite* that. Two load-bearing ideas:

### 0.1 Propose vs dispose (the honesty engine)

| The AI agent **proposes** (fallible) | The deterministic harness **disposes** (authoritative) |
|---|---|
| interpretation of the sentence (P1) | executes every action and records ground truth (P4) |
| which user actions to try (P4) | captures evidence out-of-band and seals it (P5) |
| the human-readable narration (P6) | computes the verdict by fixed rules (P6) |

Invariants that hold *by construction*, not by policy:

1. **Oracle outside the write surface.** The component that decides the verdict and the
   component that seals evidence run where the agent cannot write. The agent never sees the
   signing key and never emits a receipt.
2. **CND by default.** Any gap — couldn't bring the system up, couldn't ground the sentence,
   ran out of probe budget, a receipt type is missing — resolves to **COULD NOT DETERMINE**,
   never to WORKS.
3. **Reproduce to convict.** A DOES NOT WORK must reproduce ≥k of N times from a fresh,
   identical world. A single unreproduced failure is reported as *"observed once, could not
   reproduce"* — never a verdict, never silently dropped.

**The asymmetry that makes it safe:** the agent's unreliability can only ever *lose us a
WORKS* (degrading it to CND). It can **never manufacture a false WORKS.** `false-WORKS = 0`
is the one release-blocking metric.

### 0.2 Your infra, one default (the seam model)

- **Seam phases (yours to swap):** Environment (P2), Readiness (P3), Drive (P4). Each is an
  interface with **one default we ship**. You satisfy the contract with your own tool to run
  on your own infrastructure.
- **Trust phases (ours, never swappable):** Capture/Seal (P5), Verdict (P6). These are the
  anchor; a swappable judge is a relocated lie. You *verify* them (offline self-check), you
  do not replace them.
- Intent (P1) is our compiler, but the **model behind it is BYO** (bring your own agent).

---

## 1. The typed artifacts (the contracts between phases)

These are the nouns every phase reads and writes. Freeze these; everything else is
implementation.

- **`PromiseContract`** — `{ sentenceVerbatim, persona, startState, walk[] (only actions a
  real user could take), successCriteria[] (only outcomes a user could observe),
  effectChecks[] (re-observe the outcome from a user surface *after* the action),
  assumptions[] (strict default + the one flag to rerun the other reading), fingerprint
  (frozen at compile time) }`
- **`SystemUnderTest` (SUT)** — `{ services[]{ name, endpoint, codeFingerprint,
  reality: REAL | FAITHFUL | STUBBED }, entrypointURL, dataReadHandles[] (read-only),
  networkPolicy: SEALED, teardownHandle }`
- **`ReadinessReport`** — `{ ready: bool | CND, castList[], fingerprintMatch: bool,
  unmet[] (which check failed, verbatim) }`
- **`Observation`** (streamed) — `{ seq, action (proposed by agent), executedBy: harness,
  request?, response?, screenshot?, dbBefore?, dbAfter?, ts }` — every field captured at a
  harness tap, never handed over by the agent.
- **`EvidenceBundle`** — `{ receipts[]{ hash, type, bytes }, codeFingerprints, networkLedger,
  sealRoot (sha256), selfVerifyBlob }`
- **`Verdict`** — `{ state: WORKS | DOES_NOT_WORK | CND, decisiveMoment, claimScoreboard[],
  notCovered[], reproduce{ n, k }, blame: CHANGE | ENV }` + **`CaseFile`** (one self-contained
  HTML file).

---

## 2. Phase 1 — Intent → Promise

**Solves.** Turn one plain sentence into a checkable, user-shaped contract *without the human
authoring anything beyond the sentence.* The moment a human must edit a formal artifact, the
product has lost (the Cucumber/Gherkin grave).

**Contract.** `in: { sentence, SUT-handle }` → `out: PromiseContract (frozen + fingerprinted)`
**or** `CND(uncheckable: quotes the blocking words, offers 1–2 checkable rewrites)`.

**Default we ship.** Our compiler: an LLM (Claude) *proposes* groundings for every noun/verb;
each grounding is checked against the **running system** (a promised surface that grounds to
nothing is a catch, not an invention). Silence-is-consent echo of the interpretation; strict
default for anything the sentence leaves unsaid, printed in an `Assumed:` ledger with the flag
to rerun the other reading.

**Bring-your-own.** Your own model/agent behind the compiler interface; or supply a
`PromiseContract` directly (later).

**Evidence.** WORKS-path: the compiled interpretation as prose + the `Assumed` ledger + each
step traced to specific words of the sentence. CND-path: the exact ungradeable words + the
rewrites that *would* be checkable.

**AI allowed / forbidden.** *Allowed:* propose the interpretation and groundings. *Forbidden:*
ground to any surface it did not observe in the system. The interpretation is frozen +
fingerprinted so replay re-runs the exact promise, never a fresh guess.

---

## 3. Phase 2 — Environment (the BYO-infra heart)

**Solves.** Bring the *whole* multi-service system to life the way it really runs — the thing
agents botch most (SetupBench) and the thing that makes black-box verification possible at all.

**Contract.** `in: { repo|artifact, target codeFingerprint }` → `out: SystemUnderTest`
**or** `CND(couldn't bring up: first causal error, which service, last log lines)`.

**Two modes behind the one contract** — this is how "your infra" and "disposable production"
coexist (see Contradiction C1):

- **CONJURE (default we ship = docker-compose from the repo's own topology).** Fresh,
  hermetic, disposable; deadman's-switch teardown; sealed network. Strongest honesty tier.
- **ATTACH (BYO, on your infra).** Point at your running cluster/staging via request-level
  isolation (Signadot) or a virtual cluster (vcluster); ephemeral overlay; read-only where
  possible. Weaker teardown/isolation → the case file **discloses the reduced honesty tier.**

**Bring-your-own.** Signadot, vcluster, raw k8s, your compose, your staging endpoint.

**Evidence.** The **cast list** — each service `REAL | FAITHFUL | STUBBED` with its running
fingerprint — plus the sealed-network ledger and a bring-up proof (each service answered a real
request). On failure: the first causal error + *"this is not evidence against your change."*

**AI allowed / forbidden.** Nothing fallible decides here: *"up"* is a demonstrated fact
(a real request answered), never an agent claim. An agent may help *author* a compose/attach
recipe, but the recipe is then run mechanically and proven.

---

## 4. Phase 3 — Readiness gate

**Solves.** Confirm the environment is *truly the feature's world* before judging: every
service healthy, every built package/artifact version resolvable, and the code actually
running is the code under test. (This is the earlier "all services deployed & healthy, all
built pkg versions accessible" phase.)

**Contract.** `in: { SUT, expectedVersions/fingerprints }` → `out: ReadinessReport(READY,
castList, fingerprintMatch)` **or** `CND(env not the feature's world: the exact unmet check)`.

**Default we ship.** Our prober: hit health endpoints, resolve each built package version from
its registry, verify running-vs-expected fingerprints. **Bring-your-own.** Your readiness
probes, a Testkube job, your existing health checks.

**Skippable with attestation.** A human may attest *"already deployed & healthy."* Recorded as
a **human-attested skip with identity** (provenance) — **never silently assumed.** The final
verdict always carries the chain: what was machine-proven vs human-attested vs skipped.

**Evidence.** Readiness receipts (each health signal, each version resolved, the fingerprint
match). On fail: the exact unmet check + *"not evidence against your change."*

---

## 5. Phase 4 — Drive (the skeptical user)

**Solves.** Exercise the feature end-to-end across UI and API like a hostile first user,
probing to **disconfirm** — not to flatter the change.

**Contract.** `in: { PromiseContract, SUT }` → `out: Observation stream + per-claim results`.
Claims are pre-registered with kill conditions (the scoreboard starts all-UNTESTED); a control
probe on an untouched flow guards against blaming the change for a broken environment.

**Default we ship.** Playwright / browser-use for the UI + an HTTP driver for the API.
**Bring-your-own.** Skyvern or Stagehand (vision drivers), your existing Playwright/Cypress
suite, or **Keploy** — replay *real recorded production traffic* as the walk (production
behaviour as the test; see Product Note in §10).

**Evidence.** Every action + response + screenshot + data-before/after, captured at the
harness taps (browser, wire, read-only DB) — **not handed over by the agent** — chained in
capture order. On DOES NOT WORK: the **decisive moment** (e.g. *screen says $40, the order row
says $50*) with the receipts side by side.

**AI allowed / forbidden.** *Allowed:* propose the next action; decide when it has probed
enough (bounded by budget → CND if it runs out). *Forbidden:* report outcomes (the harness
observes them); see the raw seal. Catches trigger reproduce-N from a fresh identical world.

---

## 6. Phase 5 — Capture & Seal 🔒 (ours, not swappable)

**Solves.** Make evidence tamper-evident, bound to the exact code that ran, and physically out
of the agent's reach.

**Contract.** `in: Observation stream (captured out-of-band during P4)` → `out: EvidenceBundle
(content-addressed receipts, code fingerprints, network ledger, seal root, offline
self-verify blob)`.

**Default & only.** Our capture at the taps + content-addressed sealing. Separation of powers:
the walker (P4) cannot write here.

**Honest tamper tier (the BYO-infra caveat, stated up front).** On *your own* infra or local,
evidence is tamper-**evident** — a third party detects any edit, and the case file
self-verifies offline — but the **box owner can forge it at rest** (the key and the run live
on a machine they control). True tamper-**resistance** requires a future **neutral-runner
tier**. The honesty panel in every case file says exactly this. We ship the honest tier and
name its ceiling; we do not claim more. *(This is the same gap the earlier honesty analysis
found; it is carried forward, not hidden.)*

**Evidence.** The seal root printed to the terminal; the case file's `INTACT / TAMPERED`
one-click self-check.

---

## 7. Phase 6 — Verdict 🔒 (ours, not swappable)

**Solves.** Turn sealed evidence into a tri-state judgment a human believes in 30 seconds —
proof on WORKS, the broken thing on DOES NOT WORK.

**Contract.** `in: { EvidenceBundle, PromiseContract }` → `out: Verdict + CaseFile`.

**Default & only.** **Deterministic rules over the sealed receipts** compute the state (truth
table below). The LLM writes only the *narration* and may **cite sealed receipts and nothing
else** — uncited sentences are flagged; an unresolved citation degrades the render.

**The verdict truth table** (computed, not judged):

| Condition (over sealed receipts) | State |
|---|---|
| any pre-registered claim FALSIFIED and it reproduced ≥k/N | **DOES NOT WORK** (blame: CHANGE) |
| all claims CONFIRMED incl. every effect check, hostile repertoire survived | **WORKS** |
| bring-up / readiness / control probe failed | **CND** (blame: ENV) |
| promise ungradeable, budget expired, or any required receipt type missing | **CND** |
| failure observed once, did not reproduce | **CND** ("observed once, could not reproduce") |

**Evidence.** WORKS → the receipts proving each claim + an explicit *"what this does not
cover."* DOES NOT WORK → the decisive moment, what is broken, and a repro bundle an agent can
consume. CND → the blocking reason + the smallest unblocking action. This is the *"when it
works show evidence; when not, show what's broken"* requirement, realized.

---

## 8. Phase 7 — Ledger (deferred v1, contract defined)

**Solves.** Verdicts as a durable, queryable record so trust compounds; freshness/decay
("when is yesterday's WORKS invalidated?").

**v1: cut** (guardrail). But every `CaseFile` carries a machine-readable verdict block + a
touched-surface manifest, so the ledger is later a **pure fold** over case files — no rework.
**Bring-your-own:** your store (S3/Postgres). **Default (later):** local dir → hosted.

---

## 9. Composability — skippable entry with attestation

The user enters at any phase. Skipping a phase is satisfied one of two ways:

1. an **upstream machine artifact** (e.g. P3 produced a `READY`), or
2. a **human attestation** (*"already reviewed / already deployed"*).

**Non-negotiable:** a skipped phase is recorded as *skipped-by-human-attestation, with the
attester's identity* — never silently assumed. Entry matrix falls out for free:

- *"already reviewed & deployed — just drive it"* → enter P4; P1–P3 stamped human-attested.
- *"confirm deployment, then drive"* → enter P3 → P4.
- *"full run"* → P1 → … → P6.

---

## 10. Contradictions & resolutions (the honest part — you asked me to flag these)

- **C1 — "run on my infra" vs "conjure a disposable production."** Real tension: conjure-fresh
  is hermetic and honest but isn't *your* running system; attaching to your infra is real but
  not disposable and risks mutating your environment. **Resolution:** P2's two modes behind one
  contract — CONJURE (default) and ATTACH (BYO, read-only / request-isolated), with the case
  file **disclosing the honesty tier** so an attach-mode WORKS is never dressed up as a
  hermetic one.
- **C2 — "unfakeable evidence" vs "runs on your own box."** On infra you control, evidence is
  tamper-*evident*, not tamper-*resistant* — the box owner can forge at rest. **Resolution:**
  ship the honest local tier, state the ceiling in every case file, and reserve tamper-
  *resistance* for a future neutral-runner. Do not claim more than the tier provides.
- **C3 — "the skeptical user is an AI" vs "AI verdicts can't be trusted."** **Resolution:**
  §0.1 — the AI only proposes actions; the harness records ground truth and the verdict is
  deterministic; catches must reproduce. The AI's failure mode is *under-exploration* → CND
  (honest), never a fabricated pass.
- **C4 — "don't dig on tools" vs "integrate a tool per phase."** Not a real conflict: tool
  *selection* is done (this doc uses it); the work is the *integration behind the contract*,
  which is what §§2–8 specify.

---

## 11. What v1 cuts (the guardrail)

No dashboard. No CI/PR bot (exit codes + case file only). No ledger/history/freshness (P7).
No multi-stack matrix — one conjure shape (compose-topology web system); everything else
declines honestly with CND. No plugins, no config surface, no auth. No multi-sentence promises
or ticket ingestion. No editable promise artifact (that is Gherkin returning). No real-vendor
graduation, recorded doubles, or production-data twins. No signatures/transparency-log/TEE
(local tamper-evidence + replay is v1's honest tier, and it says so). No numeric confidence.

**The tri-state verdict is the scope valve:** anything v1 cannot verify is answered with an
honest *"couldn't determine, because X"* — which turns every temptation to widen scope into a
shipped, truthful feature instead of a delay.

---

## 12. v1 acceptance (done = all pass, on our own demo corpus "Brightcart")

1. Catches the planted lie (coupon shown in browser, never persisted) → DOES NOT WORK, decisive
   moment names the price mismatch, receipt shows screen-vs-DB side by side.
2. The receipt is replayable from the case file and reproduces the failure for an agent.
3. Does **not** false-green the honest sibling build (WORKS, scoped + confessional).
4. Never rounds up: delete one receipt type → the honest build demotes to CND.
5. Blame lands: kill a dependency → CND (ENV), *"not evidence against your change."*
6. The seal holds: edit one byte of a receipt → self-verify flips to TAMPERED.
7. A one-off is not a conviction: a 1-in-3 intermittent → reported with its rate, not dropped.
8. Absence is a catch: promise a feature that doesn't exist → DOES NOT WORK, *"here's what IS
   on the page."*
9. `false-WORKS = 0` across the corpus is **release-blocking**; the confusion matrix is
   published in-repo (be our own first customer).
