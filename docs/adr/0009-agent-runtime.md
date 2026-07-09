# Agent runtime: Claude Agent SDK first, behind a process-boundary adapter outside the core

The embedded agent roles (explorer, builder, fixer) run on the Claude Agent SDK first — its hooks, subagents, and structured-output primitives are the most mature fit for gate enforcement and structured findings. The SDK is governed by Anthropic's proprietary commercial ToS, and no candidate engine (Claude, Codex, OpenHands, Gemini) ships a Go SDK, so the runtime sits behind a single narrow process-boundary adapter (`AgentRuntime`) that lives outside the Apache-2.0 core: the core stays license-clean, and since every candidate embeds as a subprocess/HTTP bridge anyway, the adapter is multi-agent-ready by construction — a second engine is one more bridge, not a redesign. The MCP server (`pb mcp`) is the separate, provider-neutral inbound surface for third-party agents driving pb; it needs no engine decision because MCP itself is the abstraction.

## Considered Options

- Adapters for all four candidate engines from day one — rejected: speculative generality with no second real consumer (the spec-cold-start lesson, PLAN §11).
- Hardcoded Claude SDK calls with no seam — rejected: a BYO-model tier (OpenHands, MIT) is plausible within the roadmap, and the seam is near-free since every engine is subprocess-embedded regardless.

## Consequences

Single-vendor exposure to Anthropic pricing/ToS for the embedded runtime, mitigated (not eliminated) by the adapter seam. Agent SDK use requires metered API keys (subscription OAuth tokens are disallowed), so every explorer/builder/fixer run is API spend that must be priced into PAYG/subscription tiers.

**Amended 2026-07-10 by ADR-0014:** the first shipped adapter is headless Claude Code CLI shell-out inheriting customer auth (subscription included); the Agent SDK consequence above applies only to SDK-linked runtimes.
