# Proofbench — Agent Constitution

**Read this first, every session. It is binding. It overrides your instincts.**
Then read `docs/RESUME.md` (state) and `docs/ROADMAP.md` (the only allowed work).

This project burned millions of tokens on four full rewrites in twelve days
(v0 Go → v0.2 multi-repo → ADR-0030 reset → ADR-0031 intent-driven → product-v1).
Every line of code before product-v1 was thrown away. The concepts survived; the code
didn't. The founder cannot afford a fifth rewrite. Your job is to FINISH, not to rethink.

## The product (fixed — do not reinterpret)

When an AI agent says a change is done, pb returns proof — not the agent's word — that a
real user can do the thing: a tri-state verdict (WORKS / DOES NOT WORK / COULD NOT
DETERMINE) the agent cannot fake, bound to the exact code that ran, with sealed replayable
evidence. North star: companies run it in their jira-to-deploy pipeline — agents implement,
pb verifies, humans (later: policy) approve, prod deploys. pb never implements and never
owns the deploy; it is the verification layer between them.

## The eight invariants (frozen — survived every rewrite; touching them is destruction)

1. Tri-state verdict; CND by default; a false WORKS is the cardinal sin (`false-WORKS = 0`
   is release-blocking, forever).
2. Agent proposes, harness disposes. The agent can never write the verdict, mint evidence,
   or touch the seal. Structural, not conventional.
3. Provenance ranks: harness > tool > agent. Only harness-minted receipts can confirm.
4. Sealed, portable, self-verifying evidence artifact (ed25519; tamper → UNVERIFIED).
5. Verdict bound to the exact bytes that ran (SHA/digest fingerprint; unbindable → CND).
6. Verify the persisted effect out-of-band, never the app's own success claim.
7. Substrate is a swappable seam with ONE shipped default; new substrates earn their way
   in via an executed live verdict, never ahead of one.
8. Agent-agnostic via CLI shell-out (claude CLI on subscription is the proven path).

## The seven failure patterns (each one killed an era — hard rules against recurrence)

1. **No breadth before depth.** Never build a seam, provider, org-config, or abstraction
   that no committed recipe exercises END-TO-END LIVE. (v0.2 died with 4,234 LOC of
   unwired seams. orgconfig.mjs is currently unwired — wire it or delete it; add nothing
   like it.)
2. **Vertical slices only.** Every unit of work ends in an EXECUTED verdict on a real
   system with committed evidence, or it isn't done. Paper analysis, theory docs, and
   "blind predictions" do not count as progress.
3. **Never rewrite. Never clean-scratch. Never new-branch-reset.** Evolve additively on
   product-v1. If you believe a rewrite is needed, STOP and write the case in one
   paragraph for the founder — do not act on it.
4. **The input surface is frozen:** `pb-recipe-v1` JSON + agent-proposed walk. No new
   DSL, manifest format, config schema, or promise language. (Four eras, four input
   surfaces, all dead. IC-15: an editable formal artifact is Gherkin through the back
   door.)
5. **No re-hardening the frozen core** (`verdict.mjs`, `harness.mjs`, `evidence.mjs`)
   without an EXECUTED false-WORKS reproduction as a failing driver first. The core is
   honest-green; re-finishing the finished part is how eras stalled.
6. **Claims must match committed evidence.** Nothing goes in README/site that isn't
   backed by an evidence artifact in the repo. No aspirational copy.
7. **Scope court:** work is admissible only if it is on the straight line to the CURRENT
   roadmap gate (`docs/ROADMAP.md`). Everything else gets one line in DEFERRED.md and
   dies for now.

## The adoption bar (binding — founder-approved 2026-07-20)

Honesty is necessary, not sufficient. pb wins only as a DAILY habit in a company's
jira-to-deploy flow, so every gate also reports the four adoption metrics in
`docs/ROADMAP.md` (named-unblock rate, CND rate, verdict wall-clock, time-to-first-
verdict). Two agent rules that follow: (a) a CND that does not name the one action that
unblocks it is a bug with false-WORKS severity; (b) when choosing between hardening an
already-honest path and widening what gets an honest named verdict, widen — coverage
walls (a repo that won't conjure, an unnamed egress failure, a recipe that takes days)
kill adoption faster than any missed hardening.

## Session protocol

- Start: read this file → `docs/RESUME.md` → `docs/ROADMAP.md`. Work ONLY on the current
  gate's checklist. Do not reopen decided questions (decisions are logged in ROADMAP.md).
- Verify: `node --test` green, `node src/cli.mjs gate` PASS, `npm run typecheck` clean —
  before AND after your change. A live-run claim requires the run's evidence committed.
- End: update `docs/RESUME.md` (state) and check off ROADMAP items. Commit each verified
  slice immediately (spend limits kill sessions; a kill must lose nothing).
- Ponytail applies: smallest diff, no speculative structure, generality earned per case.

## Hard "never"s

- Never declare a milestone done without the executed run's evidence committed.
- Never demonstrate on a parallel surface (a mock, a fixture, a hand-rolled script) and
  report it as the product working. If the real surface is unreachable, say CND-style:
  "not proven, blocked on X."
- Never touch the eight invariants, the exit-code contract (0 WORKS / 1 DNW / 2 CND /
  3 internal), or the seal format without founder sign-off in the same session.
- Never add a runtime dependency to pb. The SUT's deps live in its container.
