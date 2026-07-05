# Build on out-of-box OSS: the v1 dependency stack

We build ON great out-of-box OSS instead of hand-rolling execution layers
(locked founder decision, 2026-07-06). Each dependency slots in as a driver
per ADR-0005.

- **Playwright + playwright-mcp** (Apache-2.0) — browser checks (L4/L5) and the
  agent's cloud/CI exploratory round; already load-bearing in `ready.yaml`.
- **Peekaboo** (MIT) — local macOS computer-use, shelled out as a CLI, not
  MCP-wired, per upstream's own guidance.
- **BuildKit rootless** (Apache-2.0, via `docker buildx`) — shape-B builds; covers
  the no-privileged-daemon case. kaniko excluded — archived by Google, Jan 2025.
- **compose semantics** — the baseline substrate; `docker compose` natively
  resolves both `image:` (pull) and `build:` stanzas, so no new substrate kind.
- **kind / vcluster** (Apache-2.0) — local throwaway and namespace-isolated k8s
  test environments (kind at v1, vcluster at P2/BYOC).
- **Claude Agent SDK** (proprietary ToS) — the embedded agent, isolated in an
  optional adapter outside the Apache-2.0 core.
- **Stagehand (Browserbase) — neither adopted nor rejected (2026-07-06)**: gets a
  spike inside the `pb explore` prototype; amend this ADR if it beats plain
  Playwright codegen at producing durable specs.
- **Dagger — explicitly NOT now**: its engine is mid-rewrite (Project Theseus)
  and it needs a second daemon, against the single-static-binary constraint.
  Revisit trigger: the engine rewrite ships stable AND P2+ agent-surface work
  begins — whichever is later.
