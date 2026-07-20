# Proof-of-Work for AI Change — working name TBD

> When an AI agent says a feature is done, get **proof, not its word**, that a real user
> can actually do the thing — across every service it touches — as a verdict the agent
> **cannot fake**, with evidence you can **replay**.

**Status:** built and green on branch `product-v1` — honesty core frozen, one live
differential Catch executed (n8n #7130). What is proven vs pending is tracked in
`docs/ROADMAP.md`; agents read `CLAUDE.md` first. Prior code and ADRs live on `main` /
`ENG-17397-proofbench-k8s-attach` and are historical only.

---

## What it is

A CLI you run at the moment of maximum doubt. One plain sentence in. The product brings
your whole (multi-service) system to life, drives it like a hostile first user, and returns
one of three verdicts — **WORKS · DOES NOT WORK · COULD NOT DETERMINE** — bound to the exact
code that ran, as one self-contained HTML **case file** where every claim has a replayable
receipt. On WORKS it shows the evidence; on DOES NOT WORK it shows the broken moment.

## Why a works/doesn't verdict on top of AI agents is hard — and how we make it trustworthy

Agents are non-deterministic and will claim success they can't substantiate. The one
principle that makes the verdict trustworthy:

**The AI agent only ever _proposes_; a deterministic harness _disposes_.**

- The **agent** proposes (fallible, revisable): the interpretation of the sentence, the user
  actions to try, the human-readable narration.
- The **harness** disposes (authoritative): it executes the actions, records ground truth
  *out of the agent's reach*, seals the evidence, and computes the verdict by fixed rules.
- The agent is structurally unable to (a) write the verdict, (b) fabricate the evidence, or
  (c) touch the seal.
- Uncertainty is **COULD NOT DETERMINE by default** — never rounded up to green. A failure
  must **reproduce** to become a conviction; a one-off is reported as "observed once, could
  not reproduce," never dropped, never a verdict.

**The asymmetry is the whole game:** the agent's unreliability can only ever *cost us a
WORKS* (it degrades to COULD NOT DETERMINE) — it can **never manufacture a false WORKS.**

## It runs on your infra (one default per phase)

Phases split into two kinds:

- **Seam phases — yours to swap:** *Environment*, *Readiness*, *Drive*. Each is an interface
  with **one default we ship**; plug your own tool that satisfies the contract to run on your
  own infrastructure.
- **Trust phases — ours, not swappable:** *Capture/Seal* and *Verdict*. These are the honesty
  anchor. If they were swappable the product would merely relocate the lie. You can *verify*
  them (the case file self-verifies offline); you cannot replace them.

## The pipeline

| # | Phase | Contract (in → out) | Default we ship | Bring-your-own |
|---|---|---|---|---|
| 1 | **Intent → Promise** | sentence + system → frozen `PromiseContract` | our compiler (Claude) | your model/agent |
| 2 | **Environment** | repo + fingerprint → live `SystemUnderTest` | docker-compose (conjure) | Signadot / vcluster / your staging (attach) |
| 3 | **Readiness** | SUT + expected versions → `READY` / CND | our health+version prober | your probes / Testkube |
| 4 | **Drive (skeptical user)** | promise + SUT → `Observation` stream | Playwright / browser-use + HTTP | Skyvern / Stagehand / Keploy (traffic replay) |
| 5 | **Capture & Seal** 🔒 | observations → sealed `EvidenceBundle` | **ours only** | — |
| 6 | **Verdict** 🔒 | evidence + promise → `Verdict` + case file | **ours only** | — |
| 7 | **Ledger** | case files → queryable record | *deferred v1* (local files) | your store |

Full detail: **[docs/phase-contracts.md](docs/phase-contracts.md)**. Product vision &
build contract: **[docs/product-plan.md](docs/product-plan.md)**.

## v1 scope (the guardrail against "start but never deliver")

v1 verifies **one flow shape brilliantly** — a signed-in user performs a state-changing
action through a web front door, across ≥2 services and a real datastore, and the promised
effect must actually hold in the data. Everything off that straight line is cut (see the
cut list in the phase-contracts doc). The magic moment is **"The Catch."**
