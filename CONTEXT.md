# Proofbench

The system of record for agent proof: a vendor-neutral spec and harness that AI coding agents use to prove their changes work — functionally, end-to-end — on any company's setup.

## Language

**Harness**: The deterministic core of `pb` that brings services up, replays checks, captures evidence, and alone anchors verdicts — "agent proposes, harness proves."
_Avoid_: engine (unqualified), evidence engine, verifier

**Readiness manifest**: The per-repo declarative spec (`ready.yaml`) of how a service becomes runnable and testable: dependencies, seed, readiness, drive verbs, checks, gates, known walls.
_Avoid_: ready.yaml (the filename, not the concept), env config, setup spec, blueprint

**Onboarding**: Generating a repo's readiness manifest, via auto-detect on first run; there is no separate setup flow.
_Avoid_: setup wizard, installation, integration flow

**Substrate**: Where a service runs for a given verification — local, compose, k8s-attach, or remote — selected at run time, never baked into the manifest.
_Avoid_: backend, runtime, environment, sandbox

**Driver family**: A pluggable group of execution concerns behind one small frozen Go interface: substrates, check drivers, build strategies, auth providers.
_Avoid_: adapter, plugin, provider (unqualified)

**Drive verb**: A declared, real product entrypoint used to exercise the service — never a look-alike script or ad-hoc curl.
_Avoid_: test command, smoke script, action

**Check**: A declared validation surface in the readiness manifest — an exercise plus machine-evaluated predicates — whose result is tri-state: pass, fail, or not-run, never default-green.
_Avoid_: test (unqualified), assertion, validation step

**Gate**: A declared human-approval requirement before a destructive or irreversible step; an unapproved gate records the blocked check as not-run and the verdict as inconclusive, never a fake pass.
_Avoid_: approval step, checkpoint, pause point

**Known wall**: A declared failure trap in the manifest — symptom, cause, recovery — consulted before spending time debugging.
_Avoid_: gotcha, trap, troubleshooting note

**Evidence bundle**: The portable, tamper-evident output directory of one verification run: an evidence manifest plus captured artifacts.
_Avoid_: bundle (unqualified), report, proof pack, merge-readiness pack

**Evidence manifest**: The machine-checkable `manifest.json` inside an evidence bundle: claim, phase, pins, checks, artifacts, verdict.
_Avoid_: manifest (unqualified — collides with readiness manifest), bundle metadata

**Verdict**: The single outcome of a run — pass, fail, or inconclusive — set last, anchored only by harness-collected evidence.
_Avoid_: result, status, grade

**Proof ladder**: The L0–L5 scale of verification depth every run must name, from L0 static-valid to L5 end-to-end observed; the rung reached is the run's proof level.
_Avoid_: confidence level, maturity score, "done"

**Provenance**: The per-artifact flag naming who captured it — harness (auto-collected) or agent (supplied); only harness provenance can anchor a verdict.
_Avoid_: source, origin, author

**Pairing**: Explicit before/after linkage of two evidence bundles by runId (`kind` + `pairsWith`), never inferred from naming conventions.
_Avoid_: run linking, before/after convention

**Seal**: The verdict-time step that registers every remaining captured file into the evidence manifest with its hash, so nothing goes unrecorded.
_Avoid_: finalize, lock, close-out

**Attestation**: A DSSE/in-toto-style signed envelope over an evidence bundle — the supply-chain idiom applied to functional verification.
_Avoid_: signature, certificate, notarization

**Shape A / Shape B**: The two integration shapes on the same `pb` verbs — Shape A: the user or CI builds, Proofbench proves; Shape B: the embedded agent builds, deploys, and proves.
_Avoid_: mode A/B, product line, stage 1/stage 2 (those are business stages)

**Exploratory round**: The single agent-driven computer-use or browser session a feature gets; nothing the agent merely observed in it counts as proof.
_Avoid_: exploration session, discovery pass

**Durable automation**: The only lasting output of an exploratory round — committed `checks[]` entries and Playwright specs — replayed deterministically by the harness thereafter.
_Avoid_: generated tests, agent tests, exploration output

**Verified run**: The billing meter: one verdict-bearing invocation that executes a manifest's checks and produces an evidence bundle, regardless of check count, duration, or substrate.
_Avoid_: credit, ACU, seat, execution

**Hub**: The local, read-only renderer and index over evidence bundles.
_Avoid_: dashboard, viewer, UI

**Ledger**: The hosted, retained, org-wide store of evidence bundles — the core of the paid product.
_Avoid_: hosted hub, cloud hub, evidence database

**Runner**: The BYOC component an org installs inside its own cluster; it pulls work outbound and pushes evidence bundles out — cluster credentials never leave the cluster.
_Avoid_: worker, cluster agent, connector
