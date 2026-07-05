# Documentation Method: grill-with-docs / domain-modeling / to-prd / to-issues (mattpocock/skills)

Source repo: https://github.com/mattpocock/skills (fetched via raw.githubusercontent.com, main branch, 2026-07-06).

Files fetched (full contents, via GitHub tree API `repos/mattpocock/skills/git/trees/main?recursive=true` + raw fetch):

- https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/grill-with-docs/SKILL.md
- https://raw.githubusercontent.com/mattpocock/skills/main/docs/engineering/grill-with-docs.md (doc-site mirror)
- https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/grilling/SKILL.md (the primitive grill-with-docs is built on — not under `engineering/`, found via full-tree search)
- https://raw.githubusercontent.com/mattpocock/skills/main/docs/productivity/grilling.md
- https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/domain-modeling/SKILL.md
- https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/domain-modeling/ADR-FORMAT.md
- https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/domain-modeling/CONTEXT-FORMAT.md
- https://raw.githubusercontent.com/mattpocock/skills/main/docs/engineering/domain-modeling.md
- https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/to-prd/SKILL.md
- https://raw.githubusercontent.com/mattpocock/skills/main/docs/engineering/to-prd.md
- https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/to-issues/SKILL.md
- https://raw.githubusercontent.com/mattpocock/skills/main/docs/engineering/to-issues.md

`grill-with-docs/SKILL.md` is a 7-line pointer: *"Run a `/grilling` session, using the `/domain-modeling` skill."* — it has no templates/flows directory of its own; the mechanics live in two other skills it composes: `grilling` (the interview primitive, under `skills/productivity/`, not `engineering/`) and `domain-modeling` (the glossary/ADR discipline, under `skills/engineering/`).

---

## 1. The grilling loop (from `grilling/SKILL.md` + doc)

Full prompt body of the skill (this is the entire mechanism — no more, no less):

> Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.
>
> Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.
>
> If a question can be answered by exploring the codebase, explore the codebase instead.
>
> Do not enact the plan until I confirm we have reached a shared understanding.

Mechanics, decomposed:

- **Mental model**: a "design tree" — every plan branches into decisions, decisions depend on each other. The interview descends the tree one node at a time; an early answer reshapes which questions come next. ([doc](https://raw.githubusercontent.com/mattpocock/skills/main/docs/productivity/grilling.md))
- **Question style**: exactly one question at a time, and wait for the answer before asking the next. A bulk questionnaire is explicitly called "bewildering" and rejected.
- **Every question ships with a recommended answer** — the agent is not a neutral interviewer, it takes a position and lets the user agree/override.
- **Codebase-first**: any question answerable by reading the code is answered by reading the code, not asked.
- **Stop condition**: the interview does not end on a timer or a question budget — it ends when the *user confirms* shared understanding has been reached ("Do not enact the plan until I confirm..."). It's a rare model-invoked *primitive*: other skills (`grill-with-docs`, `improve-codebase-architecture`, `triage`) call into it rather than reimplementing the interview.

`grill-with-docs` is the same loop with side effects: as each question resolves, terms get written into `CONTEXT.md` inline (not batched at session end), and decisions that clear a high bar get written as ADRs — also inline, not batched. ([SKILL](https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/grill-with-docs/SKILL.md), [doc](https://raw.githubusercontent.com/mattpocock/skills/main/docs/engineering/grill-with-docs.md))

"It's working if" checklist from the doc (useful as an acceptance test for anyone implementing this pattern):
- Asks one question at a time and waits, rather than dumping a questionnaire.
- Terms get written to `CONTEXT.md` the moment they resolve, in the project's own words.
- Reaches into the codebase to answer its own questions where it can.
- ADRs stay rare — the user is not asked to rubber-stamp reversible choices.

Chain position: `grill-with-docs → to-prd → to-issues → implement → code-review` — it is explicitly the *opening* step, before anything is written as a spec.

---

## 2. ADR template / format (from `domain-modeling/ADR-FORMAT.md`)

Location and numbering:
- ADRs live in `docs/adr/`, sequentially numbered: `0001-slug.md`, `0002-slug.md`, ...
- The directory is created **lazily** — only when the first ADR is actually needed, not scaffolded up front.
- Numbering rule: scan `docs/adr/` for the highest existing number, increment by one.

Exact template prescribed:

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's the whole template. Quote: *"That's it. An ADR can be a single paragraph. The value is in recording that a decision was made and why — not in filling out sections."*

Optional sections, to be added **only when they add genuine value** (most ADRs won't need them):
- **Status** frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`) — only useful when decisions get revisited.
- **Considered Options** — only when the rejected alternatives are worth remembering.
- **Consequences** — only when non-obvious downstream effects need calling out.

**Gate for writing an ADR at all** — all three must hold simultaneously:
1. **Hard to reverse** — cost of changing your mind later is meaningful.
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — genuine alternatives existed and one was picked for specific reasons.

If any one is missing, skip the ADR — explicitly: "If a decision is easy to reverse, skip it — you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond 'we did the obvious thing.'"

What qualifies (examples given verbatim):
- Architectural shape ("we're using a monorepo", "write model is event-sourced, read model projected into Postgres").
- Integration patterns between contexts ("Ordering and Billing communicate via domain events, not synchronous HTTP").
- Technology choices that carry lock-in (database, message bus, auth provider, deployment target — "just the ones that would take a quarter to swap out").
- Boundary/scope decisions, including explicit no's ("Customer data is owned by the Customer context; other contexts reference it by ID only").
- Deliberate deviations from the obvious path ("manual SQL instead of an ORM because X") — these stop a future engineer from "fixing" something that was deliberate.
- Constraints not visible in the code ("can't use AWS because of compliance requirements", "response times must be under 200ms because of the partner API contract").
- Rejected alternatives when the rejection is non-obvious (e.g., considered GraphQL, picked REST, for subtle reasons — otherwise someone re-proposes GraphQL in six months).

---

## 3. CONTEXT.md / glossary conventions (from `domain-modeling/CONTEXT-FORMAT.md` + `SKILL.md`)

**Purpose**: `CONTEXT.md` is a glossary and *nothing else*. Explicitly, repeatedly stated: "totally devoid of implementation details," not a spec, not a scratchpad, not a repository for implementation decisions.

Exact structure prescribed:

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

Rules:
- **Be opinionated.** When multiple words exist for one concept, pick the best one and list the rejects under `_Avoid_`.
- **Keep definitions tight** — one or two sentences max, define what the thing IS, not what it does.
- **Only project-specific terms.** General programming concepts (timeouts, error types, utility patterns) don't belong even if heavily used. Litmus test: "is this a concept unique to this context, or a general programming concept? Only the former belongs."
- **Group under subheadings** when natural clusters emerge; a flat list is fine for a single cohesive area.

**Single vs. multi-context repos**:
- Single context (most repos): one `CONTEXT.md` at repo root.
- Multi-context: a `CONTEXT-MAP.md` at repo root lists each context, where it lives, and how contexts relate:

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) — receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) — generates invoices and processes payments
- [Fulfillment](./src/fulfillment/CONTEXT.md) — manages warehouse picking and shipping

## Relationships

- **Ordering → Fulfillment**: Ordering emits `OrderPlaced` events; Fulfillment consumes them to start picking
- **Fulfillment → Billing**: Fulfillment emits `ShipmentDispatched` events; Billing consumes them to generate invoices
- **Ordering ↔ Billing**: Shared types for `CustomerId` and `Money`
```

Each context then gets its own `CONTEXT.md` and its own `docs/adr/` (system-wide decisions stay at the repo-root `docs/adr/`; context-specific decisions live under that context's own `docs/adr/`). Resolution rule the skill follows: if `CONTEXT-MAP.md` exists, read it to find contexts; if only a root `CONTEXT.md` exists, treat as single-context; if neither exists, create root `CONTEXT.md` lazily on the first resolved term. When multiple contexts exist and it's unclear which one a topic belongs to, the skill asks rather than guessing.

**When to update**: inline, the moment a term resolves during a session — never batched to the end. Two concrete triggers named in `domain-modeling/SKILL.md`:
- **Conflict with existing glossary** → call it out immediately ("Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?").
- **Vague/overloaded term** → propose a precise canonical term ("You're saying 'account' — do you mean the Customer or the User? Those are different things.").
- **Cross-reference with code**: when a stated behavior contradicts what the code does, surface it explicitly ("Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?").

Everything is created **lazily**: no `CONTEXT.md` or `docs/adr/` scaffolded up front — the first resolved term creates the glossary file, the first qualifying decision creates the ADR directory.

---

## 4. How PRDs are derived (`to-prd/SKILL.md`)

Key framing: `to-prd` does **not** interview — it explicitly says "Do NOT interview the user — just synthesize what you already know," taking the current conversation + codebase understanding as input. It assumes `grill-with-docs`/`grilling` already ran.

Process:
1. Explore the repo if not already done; use the project's glossary vocabulary throughout the PRD and respect any ADRs in the touched area.
2. Sketch the **seams** at which the feature will be tested. Prefer existing seams over new ones, and the *highest* seam possible — "the fewer seams across the codebase, the better - the ideal number is one." Confirm the seams with the user before writing.
3. Write the PRD from a fixed template, then publish to the issue tracker with a `ready-for-agent` triage label.

Exact template:

```md
## Problem Statement
The problem that the user is facing, from the user's perspective.

## Solution
The solution to the problem, from the user's perspective.

## User Stories
A LONG, numbered list of user stories. Each: "1. As an <actor>, I want a <feature>, so that <benefit>"
This list should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions
Modules built/modified, their interfaces, technical clarifications, architectural decisions,
schema changes, API contracts, specific interactions.
Do NOT include specific file paths or code snippets (go stale quickly) — EXCEPT a prototype
snippet that encodes a decision more precisely than prose (state machine, reducer, schema,
type shape); inline that, trimmed to the decision-rich parts, noting it came from a prototype.

## Testing Decisions
What makes a good test (external behavior only, not implementation details), which modules
will be tested, prior art for tests in the codebase.

## Out of Scope
What's deliberately not covered.

## Further Notes
Anything else worth carrying forward.
```

Underlying design principle called out explicitly ("Deep modules"): before writing, look for opportunities where a lot of functionality hides behind a small, stable interface — because a good interface gives tests something durable to target while the implementation underneath changes freely.

Chain position: `grill-with-docs → to-prd → to-issues → implement → code-review`.

---

## 5. How issues are derived (`to-issues/SKILL.md`)

Key framing: breaks an *already-written* plan/spec/PRD into "independently-grabbable issues" using **tracer-bullet vertical slices** — never horizontal (all-of-one-layer) slices.

Process:
1. Gather context — from conversation, or fetch a referenced issue (number/URL/path) including its comments.
2. Explore the codebase if not already done; issue titles/descriptions use the glossary vocabulary and respect ADRs in the touched area. Look for **prefactoring** opportunities first — "make the change easy, then make the easy change."
3. Draft vertical slices: each is a thin end-to-end cut through *every* integration layer (schema, API, UI, tests) — never a horizontal single-layer slice. Rule: "a completed slice is demoable or verifiable on its own." Any prefactoring work is ordered first.
4. Quiz the user on the breakdown: present a numbered list with Title / Blocked-by / User-stories-covered per slice; ask if granularity is right, dependencies correct, anything to merge/split. Iterate to approval.
5. Publish to the issue tracker in dependency order (blockers first, so later "Blocked by" fields can cite real issue IDs), tagging with the ready-for-agent triage label.

Exact issue body template:

```md
## Parent
A reference to the parent issue on the issue tracker (if the source was an existing issue, otherwise omit).

## What to build
A concise description of this vertical slice. Describe end-to-end behavior, not layer-by-layer implementation.
Avoid specific file paths or code snippets (go stale) — except a prototype snippet that encodes a decision
more precisely than prose (state machine, reducer, schema, type shape); inline it, trimmed, noting it's from a prototype.

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by
- A reference to the blocking ticket (if any)
Or "None - can start immediately" if no blockers.
```

Explicit rule: never close or modify any parent issue.

Chain position: sits between `to-prd` (hands it a settled spec + user stories) and `implement` (builds each slice, driving TDD internally, followed by `code-review`).

---

## 6. The full chain, end to end

```
grill-with-docs  →  to-prd  →  to-issues  →  implement  →  code-review
(interview +          (synthesize,           (vertical-slice   (build each      (review against
 write CONTEXT.md      no re-interview,        tickets,         slice,           glossary + ADRs)
 + ADRs inline)         seam-first)             quiz + publish)  TDD-first)
```

Two side artifacts persist across the whole chain and are consulted, not just produced: `CONTEXT.md` (glossary, read by every downstream skill for vocabulary) and `docs/adr/*.md` (decisions, respected by `to-prd`, `to-issues`, and code review as constraints on the touched area).

---

## 7. Concrete proposal for this repo (`/Users/prodigy/prodigy/project`)

Repo state checked directly (2026-07-06): single Go module (`go.mod`), no existing `docs/adr/`, `CONTEXT.md`, or `CONTEXT-MAP.md`. `docs/` currently holds only `docs/quickstart.md` and `docs/research/`. `PLAN.md` already uses a stable, opinionated vocabulary (Readiness manifest, Substrate adapter, Drive verb, Proof ladder, Evidence bundle v2, Attestation, Human gate) — this is exactly the kind of settled-but-unwritten glossary the method targets first.

**Adopt as-is, verbatim, no modification** — the format is intentionally minimal and matches this repo's own stated philosophy ("derive, don't restate," minimal comments, surgical diffs):

### `docs/adr/` — decision log
- Path: `docs/adr/0001-slug.md`, `docs/adr/0002-slug.md`, ... (4-digit zero-padded, sequential, kebab-case slug after the number).
- Create the directory lazily, on the first qualifying decision — do not scaffold it empty in this task.
- Template (copy exactly):
  ```md
  # {Short title of the decision}

  {1-3 sentences: what's the context, what did we decide, and why.}
  ```
  Optional `Status`, `Considered Options`, `Consequences` sections only when they add real value.
- Gate: only write one when a decision is simultaneously hard-to-reverse, surprising-without-context, and a real trade-off. Candidates already implicit in PLAN.md that would each pass the gate: "evidence bundle schema v2 is tri-state, never default-green," "substrate is chosen at runtime, not baked into the manifest," "OSS core / hosted cloud later," "not a sandbox runtime — we run on top of one." These should be extracted into ADR-0001+ as a follow-up task, not invented here.

### `CONTEXT.md` — glossary
- Single file at repo root (`/Users/prodigy/prodigy/project/CONTEXT.md`) — this repo is single-context; no `CONTEXT-MAP.md` needed unless/until the codebase splits into genuinely separate bounded contexts (e.g., if "harness core" and "hosted cloud" later diverge into separate deployables with their own vocab).
- Structure: `# Proofbench` + 1-2 sentence purpose line, then `## Language` with opinionated `**Term**: / _Avoid_:` entries for exactly the terms already coined in PLAN.md and CONTRACTS.md — e.g. `Readiness manifest`, `Substrate`, `Drive verb`, `Proof ladder`, `Evidence bundle`, `Human gate`, `Provenance flag` — each with an `_Avoid_` line capturing the loose synonyms currently floating around ("env config" for manifest, "runner"/"backend" for substrate, "test command" for drive verb, "report" for evidence bundle).
- Do not let it drift into a spec: no YAML schema fragments, no code — those belong in `spec/` (which already exists) or `CONTRACTS.md` (which already exists and currently plays a similar disambiguation role — worth checking for overlap/redundancy before populating `CONTEXT.md`, since this repo already has a hand-rolled `CONTRACTS.md`).
- Populate lazily and inline during the next design session that touches terminology, not as a batch backfill in this task — consistent with the method's "created lazily... first term or decision crystallises" rule and this project's own "derive, don't hardcode" convention.

### Where the grilling loop itself would run
Not a file convention but a process one: the next time a fuzzy PLAN.md area is worked (the open question Akash delegated — "harness vs. agents vs. full product" — is exactly this shape), run a `grilling`-style one-question-at-a-time interview with a recommended answer per question, codebase-checked where possible, stopping only on explicit confirmation — and capture the outcome into `CONTEXT.md` / `docs/adr/` per the templates above, rather than letting the resolution live only in chat history.

---

## ADR-READY RECOMMENDATION

**Decision**: Adopt the mattpocock/skills `domain-modeling` artifacts verbatim — root `CONTEXT.md` (single-context; add `CONTEXT-MAP.md` only if the repo later splits into independent bounded contexts) + `docs/adr/NNNN-slug.md` with the 1-3-sentence template and the three-part gate (hard-to-reverse ∧ surprising-without-context ∧ real-trade-off). Do not adopt `to-prd`/`to-issues` output formats yet (they assume an issue tracker with a `ready-for-agent` triage label that this repo doesn't have configured) — revisit once we pick a tracker.

**Alternatives considered**:
1. **Heavier ADR template (MADR/Nygard-style, with Context/Decision/Consequences/Alternatives as mandatory sections)** — rejected: this repo already has `CONTRACTS.md` and `spec/` doing structured-detail duty; a mandatory multi-section ADR would duplicate that and, per the method's own reasoning, get abandoned or filled with boilerplate once the novelty wears off. The 1-3-sentence default keeps friction near zero, which is the entire point of "lazy creation."
2. **No glossary file at all — keep vocabulary implicit in PLAN.md prose** — rejected: PLAN.md already shows terminology drift risk (e.g., "substrate" vs "adapter" vs "backend" used near-interchangeably across sections); an explicit opinionated `_Avoid_`-list glossary is cheap and directly addresses a defect already visible in the current doc.
3. **Multi-context `CONTEXT-MAP.md` from day one** (anticipating OSS-core vs. hosted-cloud split) — rejected for now: the repo is a single Go module with one `go.mod`; premature multi-context structure violates the method's own "create lazily" rule and this project's "derive, don't hardcode" convention. Revisit if/when hosted-cloud becomes a separate deployable with its own team and vocabulary.

**Consequences**:
- Every future PLAN.md/spec edit that coins or overloads a term should get a `CONTEXT.md` entry in the same PR/commit, not batched — otherwise the glossary rots exactly like an un-visited README.
- ADRs will be rare by design (that's a feature, not a gap) — expect single digits over the next few months; if the count grows past ~10-15 without a corresponding volume of hard architectural forks, the gate is being applied too loosely and should be tightened back up.
- `CONTRACTS.md` and `CONTEXT.md` will have adjacent but distinct jobs (contracts = interface/schema detail, glossary = pure vocabulary) — first population pass should explicitly check for overlap and trim `CONTRACTS.md` of any glossary-shaped content that migrates over, to avoid two sources of truth for the same term.
- No tracker-integration decision is made here — `to-prd`/`to-issues`' issue templates and `ready-for-agent` labeling are documented above for later adoption but are explicitly deferred pending an issue-tracker choice (GitHub Issues vs. Linear vs. Jira), which is a separate open decision.

**Open questions**:
- Does `CONTRACTS.md` get folded into / superseded by `CONTEXT.md` + `spec/`, or do all three coexist with a clear division of labor? (Needs a short grilling pass, not a unilateral call.)
- Which issue tracker will `to-issues`'/`to-prd`'s `ready-for-agent` triage-label convention target — GitHub Issues (native to this OSS repo) or something heavier once hosted-cloud work starts?
- Should the "harness vs. agents vs. full product" open question Akash delegated be the very first `grilling` session run under this new method (dogfooding it immediately), producing the repo's `CONTEXT.md` bootstrap and possibly ADR-0001 in one pass?
