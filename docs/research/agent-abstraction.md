# Agent Abstraction — Multi-Agent/Harness Support (Claude-First)

**Status:** ADR-ready draft. **Date:** 2026-07-06. **Feeds:** ADR set for Proofbench product scope (see `/Users/prodigy/prodigy/project/PLAN.md`).

**Question this answers:** how does Proofbench embed an agent runtime to power three internal roles — **explorer** (one computer-use exploratory test round per new feature), **builder** (build+deploy for integration-shape-B customers), **fixer** (propose fixes as diffs/PRs) — and how does that relate to the already-planned MCP server (§6/§8 of PLAN.md) that lets *external* agents drive `pb`?

---

## 0. TL;DR decision

Two separate integration points, don't conflate them:

1. **MCP server (`pb mcp`, already planned)** — the *inbound* surface. Any external agent (Claude Code, Cursor, Codex CLI, OpenHands, a customer's own harness) drives `pb up/seed/verify/evidence` as tools. This is protocol-level and already provider-neutral by construction (MCP is the standard — [modelcontextprotocol.io](https://github.com/modelcontextprotocol/servers)). No new decision needed here.
2. **Embedded agent runtime (this doc's real subject)** — the *outbound* surface for our own cloud product's autonomous roles (explorer/builder/fixer). This needs a real decision.

**Decision: standardize the embedded runtime on the Claude Agent SDK v1 behind one narrow internal Go interface (`AgentRuntime`), ship Claude-only through the roadmap's P0–P3, and add OpenHands as the second adapter only when a real customer or licensing need forces it (BYO-model requirement, or an Anthropic ToS/cost wall).** Do not build a four-way abstraction speculatively — one implementation plus one interface, not four implementations. Rationale and consequences in §7.

---

## 1. The four candidate engines

All four are **CLI-first products with an embeddable library bolted on**, not libraries with a CLI bolted on. That shapes everything downstream: none has a first-class Go SDK (`pb` is Go, per PLAN.md §6), so *every* one of them is embedded the same way — spawn a subprocess (or call a local HTTP/SSE server) and speak its structured-output protocol, not link a library in-process. This flattens the "one interface vs many" question somewhat: the interface boundary is a process boundary either way.

### 1.1 Claude Agent SDK

- **What:** Python + TypeScript library exposing "the same tools, agent loop, and context management that power Claude Code," programmable via `query()`. Renamed from Claude Code SDK in Sept 2025. ([code.claude.com/docs/en/agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview))
- **Subagents:** `AgentDefinition` objects invoked via the `Agent` tool; each runs in its own fresh conversation, only the final message returns to the parent, and every subagent message carries `parent_tool_use_id` for tracing. ([code.claude.com/docs/en/agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview), [code.claude.com/docs/en/agent-sdk/subagents](https://code.claude.com/docs/en/agent-sdk/subagents))
- **MCP:** first-class client — `mcp_servers` option connects any MCP server (Anthropic's own quickstart example connects the **Playwright MCP server** for browser automation — directly reusable for our explorer role). ([code.claude.com/docs/en/agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview))
- **Hooks:** `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit` — callbacks that validate/log/block/transform. `PreToolUse` can deny a tool call outright before it executes. ([code.claude.com/docs/en/agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview))
- **Structured output:** pass a JSON Schema via `output_format`/`outputFormat`; SDK returns validated `structured_output` on the result message. Supports `$ref`, `enum`, `const`, nested objects; Zod/Pydantic for type-safe definitions. ([code.claude.com/docs/en/agent-sdk/structured-outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs))
- **Sandboxing:** built-in sandbox mode isolates Bash execution with configurable network/filesystem allow-lists (domains, blocked write paths, Unix-socket control). ([agent-safehouse.dev/docs/agent-investigations/claude-code](http://www.agent-safehouse.dev/docs/agent-investigations/claude-code))
- **Sessions:** JSONL-persisted to `~/.claude/projects/`, resumable/forkable via `resume`. ([code.claude.com/docs/en/agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview))
- **Managed Agents (hosted alternative, beta):** a separate REST product — Anthropic runs the agent loop *and* the sandbox; you send events, get SSE back. Supports both an Anthropic-managed cloud sandbox and a **self-hosted sandbox on your own infra** (relevant for BYOC). Explicitly **beta**, and **not eligible for Zero Data Retention or HIPAA BAA** today because sessions are stateful and server-persisted. ([platform.claude.com/docs/en/managed-agents/overview](https://platform.claude.com/docs/en/managed-agents/overview))
- **Licensing/cost:** governed by Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms); billed as ordinary API tokens (Sonnet 5: introductory $2/$10 per M input/output tokens through 2026-08-31, standard $3/$15 after — [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing), [edenai.co](https://www.edenai.co/post/claude-sonnet-5-pricing-benchmarks-api-access)). **Agent SDK requires an API key — Claude Pro/Max subscription OAuth tokens are explicitly not permitted for SDK use** (Feb 2026 policy) — engineers' existing Claude Code seats do not offset our product's Agent SDK spend. ([HN thread on ToS enforcement](https://news.ycombinator.com/item?id=44763110), corroborated by [VentureBeat](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses))
- **Branding constraint:** may say "Claude Agent" / "Powered by Claude," may **not** say "Claude Code" or mimic its branding — irrelevant to function, relevant to our marketing copy. ([code.claude.com/docs/en/agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview))

### 1.2 OpenAI Codex SDK / CLI

- **What:** Codex CLI is Apache-2.0, open-source, written in Rust ([github.com/openai/codex](https://github.com/openai/codex)). Codex SDK (TypeScript `@openai/codex-sdk`, Python `openai-codex`) is a thin programmatic wrapper: `thread.run(prompt)`, resumable by thread ID, designed explicitly for "CI/CD pipeline" control and building "your own agent that engages with Codex." ([developers.openai.com/codex/sdk](https://developers.openai.com/codex/sdk))
- **Sandboxing:** OS-native, not container-based — macOS Seatbelt, Linux/WSL2 `bubblewrap` (user-namespace isolation, unprivileged), Windows native Sandbox. Three modes: `read-only`, `workspace-write` (default), `danger-full-access`; approval policies (`untrusted`/`on-request`/`never`) gate escapes. This is meaningfully **weaker isolation than a container/microVM** for genuinely untrusted repo code — it constrains the *agent's own* commands, not a hostile payload the agent might execute on your behalf. ([developers.openai.com/codex/concepts/sandboxing](https://developers.openai.com/codex/concepts/sandboxing))
- **MCP:** Codex can run *as* an MCP server (stdio) for another orchestrator to drive, and separately can consume MCP servers as tools. ([developers.openai.com/codex/guides/agents-sdk](https://developers.openai.com/codex/guides/agents-sdk))
- **Structured output:** supported via an output-schema file (`--output-schema-file`) or per-turn `outputSchema` in the TS SDK; parses into typed results. ([hexdocs.pm/codex_sdk structured-output](https://hexdocs.pm/codex_sdk/0.2.0/structured-output.html), [github.com/openai/codex sdk/typescript/README.md](https://github.com/openai/codex/blob/main/sdk/typescript/README.md))
- **Subagents:** no first-class subagent primitive comparable to Claude's `AgentDefinition`; multi-agent patterns are DIY via multiple threads/orchestrator code on top.
- **Licensing/cost:** billed per OpenAI API pricing (GPT-5.2-Codex: $1.75/$14.00 per M input/output tokens — [pricepertoken.com](https://pricepertoken.com/pricing-page/model/openai-gpt-5.2-codex)). OpenAI's usage policy bars using API output "to develop AI models that compete with OpenAI's products" — same shape of restriction as Anthropic's, not a differentiator. ([openai.com/policies/usage-policies](https://openai.com/policies/usage-policies/))

### 1.3 OpenHands Software Agent SDK

- **What:** Python + REST SDK from All Hands AI, **MIT-licensed**, explicitly **model-agnostic** — "can work with any LLM... Claude and OpenAI, as well as open source LLMs like Qwen and Devstral." Runs locally or via a production Agent Server in Docker/Kubernetes. ([docs.openhands.dev/sdk](https://docs.openhands.dev/sdk), [github.com/OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk))
- **Subagents:** real primitive — `DelegateTool` (fine-grained spawn/assign/collect) and `TaskToolSet` (single blocking call: spawn, run, cleanup). Current implementation is blocking/parallel, not async — a documented, honest limitation, not marketing gloss. ([docs.openhands.dev/sdk/guides/agent-delegation](https://docs.openhands.dev/sdk/guides/agent-delegation), [arXiv:2511.03690](https://arxiv.org/html/2511.03690v1))
- **Tools:** Bash, file edit, browser, MCP integration built in. Includes a **security analyzer for agent actions** and lifecycle control (pause/resume/history-restore). ([arXiv:2511.03690](https://arxiv.org/html/2511.03690v1))
- **Licensing/cost:** MIT license, zero platform fee — cost is purely whatever LLM you point it at, including self-hosted open models (the only one of the four with a true zero-marginal-license-cost path).
- **Gap:** no first-class hooks-equivalent or JSON-Schema structured-output primitive documented as cleanly as Claude's (per its own docs; not confirmed absent, just not surfaced).

### 1.4 Gemini CLI

- **What:** Google's open-source terminal agent, **Apache-2.0**. ([github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli))
- **Embeddable core:** `@google/gemini-cli-core` npm package is deliberately published *unbundled* (unlike the CLI binary itself) specifically so it can be used as a library in other Node projects — the one candidate here with an explicit "yes, embed this" packaging signal distinct from Codex/Claude's "library that happens to also be a CLI" framing. ([geminicli.com/docs/npm](https://geminicli.com/docs/npm/), [npmjs.com/@google/gemini-cli-core](https://www.npmjs.com/package/@google/gemini-cli-core))
- **MCP:** supported, plus environment-variable sanitization when spawning MCP server subprocesses (redacts host secrets from the child env) — a sandboxing-adjacent detail worth stealing regardless of which engine we pick. ([WebSearch summary of Gemini CLI MCP docs, geminicli.com/docs/tools/mcp-server](https://geminicli.com/docs/tools/mcp-server.html))
- **Sandboxing:** folder-level "Trusted Folders" execution-policy model, not container/microVM isolation.
- **Subagents/hooks/structured output:** SDK & Custom Skills shipped v0.30.0 (Feb 2026) with dynamic system instructions and `SessionContext`, but no subagent-delegation or hooks primitive matching Claude's maturity found in current docs.
- **Cost:** Gemini 3.1 Pro $2/$12 per M tokens (≤200K context, doubles above); Gemini 3.5 Flash $1.50/$9.00; Flash-Lite $0.25/$1.50 — the cheapest tier of any engine here, relevant if we ever need a low-cost bulk-triage pass. ([felloai.com/gemini-pricing](https://felloai.com/gemini-pricing/), search-aggregated pricing)

### 1.5 Side-by-side

| | Claude Agent SDK | Codex SDK/CLI | OpenHands SDK | Gemini CLI |
|---|---|---|---|---|
| License (the tool itself) | Commercial ToS (SDK is free to use, governed by Anthropic ToS) | Apache-2.0 (CLI); SDK wraps it | **MIT** | Apache-2.0 |
| Model lock-in | Claude only | OpenAI only | **Any LLM (BYO)** | Gemini only |
| Subagents | Native (`AgentDefinition`, parent/child tracing) | DIY | Native (`DelegateTool`/`TaskToolSet`, blocking) | Not yet mature |
| Hooks (block/transform mid-loop) | Native, 6+ lifecycle points | Approval policies only | Security analyzer (coarser) | Not surfaced |
| Structured output | Native JSON Schema, Zod/Pydantic | Native via schema file | Not surfaced | Not surfaced |
| MCP client + server | Both | Both | Client (+ built-in tools) | Client |
| Sandboxing | Bash-scoped net/fs allow-list | OS-native (Seatbelt/bubblewrap) | Delegates to Docker/k8s Agent Server | Folder-trust model |
| Hosted/managed option | Managed Agents (beta, self-hosted-sandbox option) | None found | Agent Server (self-run in Docker/k8s) | None |
| Go-embeddable | No (Py/TS) | No (Py/TS; Rust core) | No (Python) | No (Node) |
| $/M tok (in/out, mid-2026) | $2–3 / $10–15 (Sonnet 5) | $1.75 / $14 (GPT-5.2-Codex) | whatever model you pick | $0.25–2 / $1.5–12 |

---

## 2. Mapping to our three roles

| Role | Needs | Best-fit signal |
|---|---|---|
| **Explorer** (one computer-use round: Peekaboo locally, Playwright in cloud) | MCP client to drive Peekaboo/Playwright as tools; bounded single round; structured findings output feeding the "propose durable automation" decision | Claude Agent SDK's own quickstart literally demonstrates connecting the **Playwright MCP server** ([code.claude.com/docs/en/agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview)) — zero-adapter fit for the cloud half; Peekaboo itself already ships as an MCP server "for Codex, Claude Code, and Cursor" ([github.com/openclaw/Peekaboo](https://github.com/openclaw/Peekaboo)) — zero-adapter fit for the local half. |
| **Builder** (build+deploy, integration-shape-B) | Long-running Bash/session persistence; **hooks to enforce PLAN §3.7's human gates** (block a deploy tool call until a named gate is pre-authorized); subagents to parallelize a multi-service build | `PreToolUse` hooks are a direct implementation of the manifest's `gates:` list — deny the tool call, surface `reason` from `ready.yaml`, exactly the "pre-authorization protocol" PLAN.md already calls for (§7 roadmap item 7). No other engine has an equivalently native block-with-reason primitive. |
| **Fixer** (propose diffs/PRs) | Edit/Write/Bash(git) scoped to a branch, never `main`; structured PR-description output; never wider write scope than "open a PR" | `allowed_tools` scoping + `output_format` (PR title/body/diff schema) covers this without new plumbing; the SDK's own permission model (`acceptEdits` etc.) is the enforcement point for "never push to main." |

The recursive point worth naming explicitly: **this is the same pattern this very session's orchestrator uses** — a main thread routing to `implementer`/`debugger`/`reviewer`/`validator` subagents via Claude Code's own subagent mechanism. Explorer/builder/fixer is that pattern one layer down, inside our product instead of inside our own dev workflow. We'd be dogfooding the exact primitive we depend on.

---

## 3. Sandboxing untrusted repo code — reuse the substrate layer, don't build a new one

Builder and fixer both execute **arbitrary customer repo code** (install scripts, build tooling, test suites) — this is the "run untrusted code" problem, and it is a different problem from "constrain what the agent's own shell can do":

- **Agent-level sandboxing** (Claude SDK's net/fs allow-list, Codex's Seatbelt/bubblewrap, Gemini's trusted-folders) constrains *the agent*, assuming the code it runs is not actively hostile. Fine for the agent's own reasoning missteps; **not sufficient alone** for a customer's real `npm install`/`make build` on an untrusted or compromised repo.
- **Real isolation for untrusted code execution** is the microVM/gVisor layer: Firecracker microVMs are called "the de facto standard for executing untrusted LLM-generated code," ~50% of Fortune 500 AI-agent workloads reportedly use them, ~125ms boot, <5MiB overhead ([northflank.com/blog/how-to-sandbox-ai-agents](https://northflank.com/blog/how-to-sandbox-ai-agents)); gVisor intercepts syscalls in userspace (10–30% I/O overhead, faster cold-start) as a lighter middle ground.
- **We already planned this layer and should not duplicate it.** PLAN.md §3.2/§6 already defines a `remote` substrate adapter delegating to E2B/Daytona-class providers, explicitly scoped as "not a sandbox/runtime... we run on them via providers" (§2). E2B and Daytona both bill ~$0.05/vCPU-hr, per-second ([e2b.dev/pricing](https://e2b.dev/pricing), aggregated in [northflank.com/blog/ai-sandbox-pricing](https://northflank.com/blog/ai-sandbox-pricing)) — cheap enough that builder/fixer runs against untrusted repos should simply **execute inside the `remote` substrate**, not a bespoke agent-sandbox subsystem.
- For BYOC/enterprise customers who need the code to never leave their VPC, Claude's Managed Agents "self-hosted sandbox" option is the one hosted-agent primitive that matches our `k8s-attach` substrate's data-residency posture — worth revisiting once Managed Agents exits beta (currently **not ZDR/HIPAA-eligible**, so not viable for the compliance-product wedge in PLAN §9.2 today). ([platform.claude.com/docs/en/managed-agents/overview](https://platform.claude.com/docs/en/managed-agents/overview))

**Conclusion: sandboxing untrusted repo code is a substrate-adapter concern we already scoped, not a new agent-runtime concern.** The agent runtime picks *which* substrate to run builder/fixer commands against (same `local`/`compose`/`k8s-attach`/`remote` selection every other `pb` command uses); it does not need its own isolation model.

---

## 4. Licensing and commercial-terms risk

Both major-vendor SDKs carry the **same-shaped restriction**: no using the API/output to build a competing model, and (Anthropic specifically) no funneling subscription-tier access to third parties — Agent SDK usage must be metered API keys, not Pro/Max OAuth tokens ([HN #44763110](https://news.ycombinator.com/item?id=44763110), [VentureBeat](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses)). **Neither restriction blocks our use case** — we are not training a competing model, and our product bills its own metered usage of the vendor's API on the customer's behalf (standard SaaS-on-API pattern), not reselling raw subscription seats. This should still get a one-time legal read before GA pricing is finalized, specifically on the "resell/redistribute access" boundary once we have a pay-as-you-go tier that is *effectively* metered Claude access with a markup.

- Claude Agent SDK: Commercial Terms of Service, no automation-specific restriction beyond the above. ([anthropic.com/legal/commercial-terms](https://www.anthropic.com/legal/commercial-terms))
- Codex SDK: Apache-2.0 CLI + OpenAI Usage Policies (same anti-competing-model clause). ([openai.com/policies/usage-policies](https://openai.com/policies/usage-policies/))
- OpenHands SDK: MIT — cleanest license, zero platform-level restriction, because All Hands AI isn't the model vendor; risk moves entirely to whichever LLM backend the customer BYOs.
- Gemini CLI: Apache-2.0 for the tool; Gemini API has its own usage terms (not fetched in depth here — low priority since Gemini is not the near-term pick).

---

## 5. Cost model implications for pricing our product

- Explorer round (bounded, single pass) is naturally cheap regardless of engine — good candidate to run even on our free/OSS tier.
- Builder/fixer are long-running, tool-call-heavy loops — this is where token spend concentrates, and where the **subscription-tier-token exclusion matters most**: we cannot amortize a customer's own Claude subscription into our COGS; every builder/fixer run is metered API spend we must price into subscription or PAYG tiers.
- OpenHands' BYO-model flexibility is the only path to a *customer-supplied-model* pricing tier (customer brings their own OpenAI/Gemini/self-hosted key, we charge for orchestration+evidence only, zero model COGS to us) — worth keeping as an explicit future tier rather than building it day one.

---

## 6. The abstraction question, answered directly

Three options were on the table:

**(A) One interface, adapters for all four from day one.** Rejected — no real second consumer exists yet (YAGNI; mirrors PLAN §11's Earthly-death lesson: "spec cold-start... integration work + new syntax" kills specs nobody asked for). Building four adapters to satisfy a hypothetical future customer preference is speculative generality before we have one customer with that preference.

**(B) Standardize on Claude Agent SDK v1 as the only implementation, no interface at all — call it directly everywhere.** Rejected — cheap now, expensive later: OpenHands' BYO-model tier (§5) and the possibility of an OpenAI-shop customer wanting Codex are real enough that hardcoding SDK calls throughout the builder/fixer/explorer code paths would make the eventual second adapter a rewrite instead of an addition.

**(C, chosen) One narrow internal interface (`AgentRuntime`), Claude Agent SDK as the only adapter through P0–P3.** The interface is deliberately small — shaped by what Claude's SDK actually needs to expose, not by surveying all four APIs for a lowest-common-denominator:

```go
// internal/agent/runtime.go — sketch, not final
type AgentRuntime interface {
    // Run executes one bounded agent task (explorer round, builder step, fixer pass)
    // against a target substrate, streaming normalized events.
    Run(ctx context.Context, task AgentTask) (<-chan AgentEvent, error)
}

type AgentTask struct {
    Role         string            // "explorer" | "builder" | "fixer"
    Prompt       string
    AllowedTools []string
    MCPServers   map[string]MCPServerConfig  // e.g. peekaboo, playwright
    OutputSchema json.RawMessage             // structured findings/PR-description
    Gates        []Gate                      // from ready.yaml — enforced via PreToolUse-equivalent
    Substrate    string            // local | compose | k8s-attach | remote — where tool calls execute
}

type AgentEvent struct {
    Kind        string // tool_call | tool_result | message | structured_output | done
    Provenance  string // "agent" — feeds evidence bundle v2's provenance flag directly
    Payload     json.RawMessage
}
```

Because none of the four engines has a Go SDK, every adapter is a subprocess/HTTP-SSE bridge regardless — the interface cost of adding OpenHands or Codex later is "write one more bridge," not "redesign the abstraction." This is the same shape as the substrate-adapter pattern already in PLAN.md §6, so it's an idiom this codebase already has, not a new one.

**Trigger conditions to add adapter #2** (don't build ahead of these): a paying customer requires BYO-model (→ OpenHands adapter), or Anthropic ToS/pricing changes make Claude-only untenable for a segment (→ Codex or Gemini adapter as hedge), or the OSS community explicitly asks for engine choice on the embedded-runtime side (distinct from MCP-server interop, which is already engine-agnostic today).

---

## 7. ADR-ready recommendation

**Decision:** Ship the embedded cloud-product agent runtime as a single internal `AgentRuntime` Go interface with exactly one adapter — **Claude Agent SDK v1** — through roadmap phases P0–P3. Keep the MCP server (`pb mcp`) as the separate, already-provider-neutral inbound integration point; it requires no engine decision because MCP itself is the abstraction. Route all builder/fixer/explorer tool execution through the existing substrate-adapter layer (`local`/`compose`/`k8s-attach`/`remote`) for isolation — do not build a bespoke agent sandbox. Explorer role reuses Claude's demonstrated Playwright-MCP and Peekaboo-MCP patterns directly, per the task's fixed local/cloud split.

**Alternatives considered:**
1. *Four adapters from day one* — rejected as speculative generality with no second real consumer; violates the spec-cold-start lesson already codified in PLAN.md §11.
2. *No interface, hardcode Claude SDK calls* — rejected because a real second-adapter trigger (BYO-model pricing tier, §5) is plausible enough within the product's own roadmap to warrant one seam now, at near-zero cost since every engine is subprocess-embedded anyway.
3. *OpenHands as the base instead of Claude* — rejected for the *initial* adapter despite the MIT license and model-agnosticism being attractive, because the task's explicit framing is "Claude-first," Claude's hooks/structured-output/subagent primitives are the most mature fit for our specific gate-enforcement and structured-findings needs (§2), and OpenHands remains available as adapter #2 exactly when the BYO-model tier is built.

**Consequences:**
- We take on single-vendor dependency risk (Anthropic pricing/ToS changes) for the embedded runtime specifically — mitigated by the interface seam, not eliminated.
- Every builder/fixer run is metered Anthropic API spend with no subscription-tier offset — must be priced into subscription/PAYG tiers explicitly (§5).
- Sandboxing untrusted customer code is deliberately *not* solved inside the agent runtime — a bug here is a substrate-adapter bug, not an agent-runtime bug; keeps the two concerns cleanly separated but means substrate `remote` (E2B/Daytona) hardening becomes a harder dependency for builder/fixer GA than it is for plain `pb verify`.
- Managed Agents (Anthropic's hosted alternative) is explicitly not chosen for now — beta, no ZDR/HIPAA — revisit before the compliance-product wedge (PLAN §9.2) ships.

**Open questions (not resolved here, need founder/legal input):**
1. At what PAYG markup over metered Claude API cost does "reselling access" become a Commercial-Terms concern worth a direct legal read (§4)? Not urgent pre-launch, but should be resolved before public pricing goes live.
2. Does the OpenHands BYO-model tier (§5) belong in the launch pricing model (P3, per PLAN roadmap) or is it a P4+ enterprise-only add-on? This is a product-scoping call, not an engineering one.
3. Should the `AgentRuntime` interface live in the OSS `proofbench` repo (making engine choice a community-visible extension point, consistent with the "spec as the flag" OSS strategy in PLAN §8) or stay closed-source inside the cloud product? Leaning closed for now since it's cloud-product-specific, not spec-level, but worth a deliberate call before P3.
