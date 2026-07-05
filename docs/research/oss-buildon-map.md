# Build-ON Map: OSS Dependency Survey for Proofbench

**Date:** 2026-07-06
**Scope:** For every candidate — what we'd use it for, license (AGPL/BUSL flagged), embed vs shell-out vs MCP, integration effort (S/M/L), and a verdict. Closes with an honest fork-vs-build check and an ADR-ready v1 dependency-stack recommendation.

**Ground rule for license risk:** we are building a **commercial product** (OSS core + hosted cloud, subscription + PAYG). Two license shapes are flagged as risk, not blockers:
- **AGPL-3.0 (network copyleft):** safe to *use unmodified, self-hosted by the customer*; unsafe to *embed/modify and redistribute* as part of our product or to *offer as a modified network service* without open-sourcing our modifications.
- **BUSL / source-available "Community" licenses:** safe to *read for design ideas*; unsafe to *depend on the restricted paths* in a product we intend to monetize on terms the licensor didn't pre-clear.

Apache-2.0 / MIT / CC-BY-4.0 carry no such risk and are called out only when the finding is “clean.”

---

## 1. Summary table

| Candidate | Use for us | License | Risk flag | Integration | Effort | Verdict |
|---|---|---|---|---|---|---|
| [Playwright](https://github.com/microsoft/playwright) + [playwright-mcp](https://github.com/microsoft/playwright-mcp) | UI drive/checks (L5 proof rung); agent's exploratory round in cloud/CI | Apache-2.0 | none | shell-out (test runner) + MCP (agent exploration) | S | **Adopt v1** |
| [Peekaboo](https://github.com/openclaw/Peekaboo) | Local computer-use exploratory round (macOS) | MIT | none (macOS-only platform limit) | shell-out / MCP | S | **Adopt v1** (optional, Mac hosts only) |
| [Stagehand](https://github.com/browserbase/stagehand) | AI-explore-once → cache into durable Playwright steps — the literal "self-evolving test" mechanism | MIT | none | shell-out (Node) | M | **Adopt v1** |
| [browser-use](https://github.com/browser-use/browser-use) | Alt. agentic browser loop | MIT | none | shell-out | M | Defer — overlaps Stagehand/playwright-mcp |
| [Skyvern](https://github.com/skyvern-ai/skyvern) | Alt. vision-first browser agent | **AGPL-3.0** | **yes** | N/A | — | **Avoid embedding**; hosted API only if ever needed |
| [Magnitude](https://github.com/magnitudedev/browser-agent) | Alt. vision-first agent w/ built-in visual-assertion runner | Apache-2.0 | none | shell-out | M | Watch-list |
| [testcontainers-go](https://github.com/testcontainers/testcontainers-go) | Ephemeral dep containers for `compose` substrate + pb's own test suite | MIT | none | **embed** (Go lib) | S–M | **Adopt v1** |
| [kind](https://github.com/kubernetes-sigs/kind) | Local throwaway k8s substrate; CI fixture cluster for our own `k8s-attach` adapter tests | Apache-2.0 | none | embed (Go lib) or shell-out | S | **Adopt v1** |
| [vcluster](https://github.com/loft-sh/vcluster) | Namespace-isolated virtual clusters for BYOC attach at scale | Apache-2.0 core; Free/Enterprise tiers gated behind Platform license | flag: OSS core only | shell-out (CLI) | M | Later (P2/cloud) |
| [mirrord](https://github.com/metalbear-co/mirrord) | `k8s-attach` substrate — real env vars/DNS/traffic without hand-rolled port-forward faking (already named in PLAN roadmap P2); ships a documented ["for AI Agents" mode](https://metalbear.com/mirrord/ai/) | MIT (OSS); Teams/Enterprise paid | none for OSS core | shell-out (CLI) | M | **Adopt P2** |
| [Dagger](https://github.com/dagger/dagger) | Container-based build/run engine, same pipeline local/CI/cloud | Apache-2.0 | none | embed (Go module) or shell-out | **L** (architecture bet) | **Spike in P1**, don't commit yet |
| [container-use](https://github.com/dagger/container-use) | Git-branch-per-agent dev sandboxes | Apache-2.0 | none | MCP / shell-out | S | Watch-list (agent-workspace problem, not ours) |
| [BuildKit](https://github.com/moby/buildkit) | Low-level image build engine (Dagger's foundation) | Apache-2.0 | none | embed (Go) | M | Later, via Dagger not direct |
| [kaniko](https://github.com/GoogleContainerTools/kaniko) | Build images inside a k8s pod without a privileged daemon — BYOC-safe build | Apache-2.0 | none | shell-out (pod exec) | M | Later ("shape B" builds) |
| [Cloud Native Buildpacks](https://github.com/buildpacks) | Auto-build a runnable image for repos with no Dockerfile — mirrors our "zero-config day one" philosophy at the image layer | Apache-2.0 (CNCF) | none | shell-out (`pack` CLI) | M | Later ("shape B" fallback builder) |
| [OpenHands](https://github.com/OpenHands/OpenHands) | N/A as embedded runtime (we are "not an agent," PLAN §2) | MIT | none | compile-target only | S | Compile target only, not a dependency |
| [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python) | Reference agent driver ("multi-agent... starting with Claude") | **Proprietary** — Anthropic Commercial ToS | **yes — not OSS** | separate optional adapter package | S | **Adopt v1**, isolated from Apache-2.0 core |
| [MCP SDKs](https://github.com/modelcontextprotocol/go-sdk) (official Go SDK, Google-maintained) | `pb mcp` embedded server | MIT (existing) | none | embed (Go module) | S | **Adopt v1** |
| [Temporal](https://github.com/temporalio/temporal) | Cloud control-plane run orchestration, human-gate wait-states | MIT | none | embed/shell (server + Go SDK) | L (cloud only) | Later, **cloud tier only** |
| [NATS/JetStream](https://nats.io/) | Cloud control-plane event bus (evidence-bundle events, fleet supervision) | Apache-2.0 | none | embed (single Go binary) | M (cloud only) | Later, **cloud tier only** |
| [OpenTelemetry](https://opentelemetry.io/) | Instrument pb + runs; neutral export | Apache-2.0 | none | embed (Go SDK) | S | **Adopt v1** |
| [Grafana/Loki/Tempo](https://grafana.com/licensing/) | Optional user-owned dashboard target for OTel export | **AGPLv3** (relicensed [2021](https://grafana.com/blog/2021/04/20/grafana-loki-tempo-relicensing-to-agplv3/)) | **yes** | never bundle/modify; user's own instance only | — | Point users at their own instance; never ship a modified copy |
| [sigstore](https://github.com/sigstore) | Signing/verification for evidence-bundle attestations | Apache-2.0 (OpenSSF-mandated) | none | embed (Go libs) | M (P4) | Adopt at P4, reserve schema field now |
| [in-toto](https://github.com/in-toto) | Attestation envelope format (DSSE) | Apache-2.0 | none | embed (Go libs) | M (P4) | Adopt at P4 |
| [devcontainers spec](https://github.com/devcontainers/spec) | One of the "derive, don't restate" sources for `ready.yaml` | CC-BY-4.0 (spec) / MIT (CLI) | none | read/parse only | S | Already in design (PLAN §4) |

---

## 2. Browser / UI automation & computer-use

### Playwright + playwright-mcp — **adopt v1**
- Playwright itself: Apache-2.0, Microsoft. [github.com/microsoft/playwright](https://github.com/microsoft/playwright)
- `playwright-mcp`: Apache-2.0, 33.5k stars, actively maintained (v0.0.76 as of June 2026), `npx @playwright/mcp@latest`, no API key, no hosted tier. ([GitHub](https://github.com/microsoft/playwright-mcp), [morphllm.com](https://www.morphllm.com/playwright-mcp))
- **Role:** this is the backbone L4/L5 "checks" runner named in the `ready.yaml` sketch (`exercise: playwright tests/e2e/order.spec.ts`) — already load-bearing in the PLAN's own spec. `playwright-mcp` is also the tool the **agent** reaches for during the one-shot cloud/CI exploratory round (per the founder's constraint: "Playwright in cloud").
- **Integration:** shell-out to the Playwright CLI/test runner for durable checks (pb captures stdout/exit code/trace/screenshot as artifacts — this already matches evidence bundle v2's `artifacts[]` shape); the agent uses `playwright-mcp` directly as an MCP server, not something pb embeds.
- **Effort:** S — it's a well-documented, zero-config npx tool; our job is just wiring capture around it.

### Peekaboo — **adopt v1, macOS-only**
- MIT license, part of the OpenClaw org. macOS CLI + optional MCP server for screenshots/computer-use, with a natural-language agent chaining see/click/type/scroll/hotkey/menu/window/app/dock/space. ([GitHub](https://github.com/openclaw/Peekaboo), [peekaboo.sh](https://peekaboo.sh/))
- **Role:** this is the exact tool the founder named for the **local** exploratory round ("Peekaboo by OpenClaw locally").
- **Integration:** shell-out/MCP. **Flag:** macOS-only — the local exploratory round is a Mac-only capability at launch; document this platform gap rather than letting it surprise a Linux/Windows user.
- **Effort:** S.

### Stagehand — **adopt v1** (the mechanism match)
- MIT, Browserbase. "Drop-in Playwright enhancement... action caching cuts token costs." ([GitHub](https://github.com/browserbase/stagehand), [skyvern.com comparison](https://www.skyvern.com/blog/browser-use-vs-stagehand-which-is-better/))
- **Why this one specifically:** the founder's requirement is "one manual-style exploratory round via computer use... then BUILDS AND SHIPS durable automation" — that is *literally* Stagehand's architecture: an LLM-driven `act()`/`observe()` call the first time, cached into a deterministic replay step after. No other candidate in this list has that built-in cache-to-durable conversion; browser-use and Skyvern are agentic loops with no equivalent caching primitive, and Magnitude's "vision-first, agent is the product" framing is oriented at the agent doing the work every time, not authoring something durable for pb to own afterward.
- **Integration:** shell-out (Node/TS process); pb captures the cached step definitions as generated Playwright-compatible artifacts that then become `checks[]` entries.
- **Effort:** M — it's a real dependency (Node runtime, LLM key wiring), not a zero-config CLI.

### browser-use — **defer**
- MIT, Python, 89.1% WebVoyager SOTA claim, largest community. ([GitHub](https://github.com/browser-use/browser-use), [comparison thread](https://dev.to/stevengonsalvez/browser-tools-for-ai-agents-part-2-the-framework-wars-browser-use-stagehand-skyvern-4gn))
- License is clean, but it duplicates what `playwright-mcp` (agent exploration) + Stagehand (cache-to-durable) already cover; adding a third agentic-browser dependency in v1 is unjustified surface area. Revisit if Stagehand/playwright-mcp prove insufficient for a specific exploratory pattern.

### Skyvern — **avoid embedding (AGPL-3.0)**
- "All of the core logic powering Skyvern is available in this open source repository licensed under the AGPL-3.0 License." Self-hostable via Docker/K8s. ([GitHub](https://github.com/skyvern-ai/skyvern), [skyvern.com](https://www.skyvern.com/developers))
- **Risk:** AGPL-3.0 is the sharpest network-copyleft license in this whole survey. Embedding or modifying Skyvern inside our commercial product (self-hosted OR cloud) would obligate us to release our modifications. Vision-first DOM-unreliable-site handling is a real capability gap vs. Playwright/Stagehand, but not worth the license exposure for v1. If ever needed, use Skyvern's hosted Cloud API as an external call, never their AGPL core as a dependency.

### Magnitude — **watch-list**
- Apache-2.0, TypeScript, vision-first, ships a built-in test runner with visual assertions. ([GitHub](https://github.com/magnitudedev/browser-agent))
- Clean license, real overlap with our "durable automation" goal (it *has* a test-runner mode, not just an agent loop) — re-evaluate if Stagehand's caching model turns out to be too Playwright-coupled for vision-heavy UIs.

---

## 3. Container / cluster / dev-loop substrates

### testcontainers-go — **adopt v1**
- MIT. ([LICENSE](https://github.com/testcontainers/testcontainers-go/blob/main/LICENSE), [pkg.go.dev](https://pkg.go.dev/github.com/testcontainers/testcontainers-go), 1,755 known importers)
- **Role:** natural Go-native embed for spinning up ephemeral dependency containers (Postgres/Kafka/etc.) both (a) as the underlying engine for the `compose` substrate instead of hand-rolling `docker compose` invocation, and (b) for **pb's own test suite** (testing readiness-manifest execution against real fixtures, not mocks).
- **Integration:** embed — it's a Go library, and pb is a Go binary; this is a first-class fit, not a shell-out.
- **Effort:** S–M.

### kind — **adopt v1**
- Apache-2.0, `kubernetes-sigs` (official SIG). ([kind.sigs.k8s.io](https://kind.sigs.k8s.io/), [GitHub](https://github.com/kubernetes-sigs/kind))
- **Role:** the cheapest possible way to offer a real local `k8s` substrate option (not just `local`/`compose`) and to build CI fixtures for our own `k8s-attach` adapter tests without needing a live BYOC cluster in CI.
- **Integration:** kind is designed as both a CLI and a Go library (`sigs.k8s.io/kind`) — embed is viable.
- **Effort:** S.

### vcluster — **later (P2/cloud)**
- Apache-2.0 **core**; free tier and enterprise tiers require connecting to the vCluster Platform for license validation. ([GitHub](https://github.com/loft-sh/vcluster), [OSS vs Free tier docs](https://www.vcluster.com/docs/vcluster/introduction/oss-vs-free))
- **Role:** gives every `k8s-attach` run its own namespace-scoped virtual cluster instead of sharing the customer's raw namespace directly — reduces blast radius for the destructive-step "gates" concept, and is a plausible building block for the §9 "Managed BYOC connectors" cloud tier.
- **Flag:** stick strictly to the Apache-2.0 OSS-core feature set; several attractive features (embedded etcd, Private Nodes, sleep mode) sit behind the Free/Enterprise tiers gated by Loft's own license server — don't casually depend on those in the OSS core.
- **Effort:** M. Not urgent for v1 (P0/P1 don't need cluster-of-clusters isolation yet).

### mirrord — **adopt P2** (already the roadmap's own idea)
- MIT for the OSS core; Teams/Enterprise (control-plane operator, traffic filtering, queue splitting, CI support) is paid. ([GitHub](https://github.com/metalbear-co/mirrord), [FAQ](https://metalbear.com/mirrord/docs/faq/general))
- **Role:** PLAN.md P2 already names "optional mirrord mode" for the `k8s-attach` substrate. mirrord runs the user's local process *as if* it were a pod in the cluster — real env vars, DNS, network, traffic — which directly replaces our own hand-rolled `pod-env-to-local.sh`-style env derivation with a maintained, purpose-built tool. mirrord even ships a **documented "mirrord for AI Agents" mode** ([metalbear.com/mirrord/ai](https://metalbear.com/mirrord/ai/)) — someone else has already productized almost exactly our BYOC-attach use case.
- **Integration:** shell-out to the mirrord CLI from the `k8s-attach` adapter.
- **Effort:** M — real dependency, but replaces planned bespoke code rather than adding net-new scope.

---

## 4. Build / image-construction (for integration "shape B": we build + deploy + test)

*Correction 2026-07-06: superseded by docker-mode.md on build tooling — BuildKit direct (buildx) is the shape-B choice; kaniko is excluded (archived Jan 2025); Dagger deferred.*

### Dagger — **spike in P1, don't commit in v1**
- Apache-2.0. "Automation engine to build, test and ship any codebase. Runs locally, in CI, or directly in the cloud." SDKs in 8 languages, wraps BuildKit underneath. ([GitHub](https://github.com/dagger/dagger), [dagger.io](https://dagger.io/))
- **Why this is the one genuine architecture-level bet in the whole survey:** Dagger's pitch — "same pipeline, local/CI/cloud" — is *word-for-word* our own substrate-polymorphism pillar (PLAN §3.2). If Dagger's execution model is a good fit, it could replace a meaningful slice of our planned P1/P2 substrate-adapter code (the `up`/`seed`/`drive` container execution layer) rather than us hand-rolling it. That is exactly the kind of decision that deserves a dedicated, time-boxed spike with a real Lyric service as the test case — not a call made inside a research doc.
- **Recommendation:** ship v0/v1 with the substrate adapters we've already hand-rolled in `bin/pb` (proven against ENG-20190); run a P1 spike — "rebuild the `compose` substrate on Dagger, time-box one week, compare LOC and behavior" — and only refactor onto Dagger if the spike is clearly positive. Don't block ship on it either way.
- **Effort:** L if adopted (it changes what our engine *is*), but effort to *spike* is S.

### container-use — **watch-list**
- Apache-2.0, from the Dagger org. Gives each coding agent its own container + git branch (`container-use/<env_name>`) so multiple agents can work on the same repo without conflicts. ([GitHub](https://github.com/dagger/container-use))
- This solves the *agent's own workspace isolation* problem (Devin/OpenHands/Claude Code's sandbox), not our readiness/evidence problem. Relevant only if/when we let multiple agents run `pb verify` concurrently against the same repo and need to avoid them clobbering each other's runs — worth revisiting then, not core to v1.

### BuildKit — **later, via Dagger, not direct**
- Apache-2.0, `moby/buildkit`. ([LICENSE](https://github.com/moby/buildkit/blob/master/LICENSE))
- It's the low-level engine Dagger is built on; if we adopt Dagger we get BuildKit for free. Embedding BuildKit directly (bypassing Dagger) only makes sense if the Dagger spike is negative but we still need daemonless image builds — treat as the fallback-fallback.

### kaniko — **later ("shape B" builds inside customer k8s)**
- Apache-2.0, Google. Builds container images inside a Kubernetes pod without a privileged Docker daemon. ([GitHub](https://github.com/GoogleContainerTools/kaniko), [kaniko.org](https://kaniko.org/))
- **Role:** the one candidate here purpose-built for the "our agent handles build + deploy + test end-to-end" shape *inside a customer's BYOC cluster*, where we won't have privileged daemon access. Relevant the moment shape-B customers show up on k8s; not needed for shape-A (user/other-agent builds, we only test) launch scope.
- **Integration:** shell-out (deploy a kaniko pod, exec, retrieve result).

### Cloud Native Buildpacks — **later (fallback builder, no-Dockerfile case)**
- Apache-2.0, CNCF (joined Oct 2018). ([buildpacks.io](https://buildpacks.io/), [buildpacks org](https://github.com/buildpacks))
- **Role:** mirrors our own "zero-config day one" philosophy (PLAN §4) at the container-build layer — auto-detect language/framework and produce a runnable image when the target repo has no Dockerfile at all. Pairs naturally with kaniko/Dagger as the actual execution substrate.

---

## 5. Agent harness & protocol layer

### OpenHands — **compile-target only, not a dependency**
- MIT. 78.5k stars, ~500 contributors, $18.8M Series A (All-Hands-AI). ([GitHub](https://github.com/OpenHands/OpenHands))
- We are explicitly "not an agent" (PLAN §2) — OpenHands *is* an agent (does the coding). The only place it belongs in our architecture is as one more **vendor compile target** alongside Codex/Cursor/Copilot (`.openhands/setup.sh`, already sketched in the PLAN architecture diagram) — generated *output* of `ready.yaml`, never a runtime dependency of `pb` itself.

### Claude Agent SDK — **adopt v1, isolated adapter**
- **Not open source.** "Use of the Claude Agent SDK is governed by Anthropic's Commercial Terms of Service... except to the extent a specific component is covered by a different license." ([anthropics/claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview))
- **Role:** the founder's own scoping names Claude Agent SDK as the first multi-agent driver.
- **License architecture implication:** because the SDK carries Anthropic's proprietary commercial terms, it must live in a **separate optional adapter package** (e.g. `adapters/claude/`), never inside the Apache-2.0 `spec/`/`engine/`/`cli/` core — same pattern OSS projects use for any vendor-specific plugin (Terraform providers, etc.). This also future-proofs "multi-agent... starting with Claude" — OpenAI/other drivers slot into siblings of the same adapter interface.
- **2026 cost-model flag:** as of the mid-2026 policy reversal, programmatic/SDK usage is billed from a separate, non-rollover **Agent SDK credits** pool at API rates — it is *not* subsidized by a chat subscription anymore. Anyone running `pb` with the Claude driver at scale needs to budget real API spend, not assume a Claude Pro/Max seat covers it. ([VentureBeat](https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch), [The New Stack](https://thenewstack.io/anthropic-agent-sdk-confusion/))

### MCP SDKs (official Go SDK) — **adopt v1**
- MIT for the existing TypeScript/Python/C#/Java SDKs; the **official Go SDK** (`modelcontextprotocol/go-sdk`) is maintained in collaboration with Google. ([GitHub](https://github.com/modelcontextprotocol/go-sdk))
- **Role:** directly implements the architecture diagram's `pb mcp` embedded server. Because pb is a Go binary and an *official*, Google-co-maintained Go SDK exists, this is a clean, low-effort embed — no need to shell out to a Node/Python MCP process.
- **Effort:** S.

---

## 6. Cloud control-plane infrastructure (Temporal / NATS) — cloud tier only

### Temporal — **later, cloud tier only**
- MIT. Self-host free; Temporal Cloud is the managed option. 2,000+ companies (Snap, Box, Stripe) in production as of May 2026. ([GitHub](https://github.com/temporalio/temporal), [temporal.io](https://temporal.io/))
- **Role:** matches the PLAN's own §9 "cloud hosting as moat" pillar — multi-step verify-run orchestration, retries, and the "gates" concept (human-in-the-loop wait-states) map cleanly onto Temporal signals/queries.
- **Architecture boundary:** deliberately **do not** pull Temporal into the OSS local CLI — `pb` is meant to be a single static binary with zero runtime deps (PLAN §6 "Implementation choices"); requiring a Temporal cluster to run `pb verify` on a laptop would violate that promise. Keep it strictly behind the hosted control plane.
- **Effort:** L (cloud infra to stand up and operate).

### NATS/JetStream — **later, cloud tier only**
- Apache-2.0. CNCF-hosted; 2025 relicensing scare was resolved in the community's favor (stays Apache-2.0, trademarks to the Linux Foundation). ([CNCF blog](https://www.cncf.io/blog/2025/05/01/protecting-nats-and-the-integrity-of-open-source-cncfs-commitment-to-the-community/), [nats.io](https://nats.io/))
- **Role:** candidate event bus for the hosted evidence hub / Crabfleet-style fleet supervision (streaming bundle events across runs/orgs).
- **Note:** it's a genuinely lightweight single Go binary, so unlike Temporal it *could* be embedded even locally without breaking the zero-dependency promise — but there's no local use case that needs it yet (a file-based event log is sufficient for a single-machine run). Keep it scoped to cloud until a concrete local need appears.
- **Effort:** M (cloud infra).

---

## 7. Observability

### OpenTelemetry — **adopt v1**
- Apache-2.0, CNCF. "No license fees or paid plans for using the SDKs, specification, or Collector." ([opentelemetry.io](https://opentelemetry.io/), [Collector LICENSE](https://github.com/open-telemetry/opentelemetry-collector/blob/main/LICENSE))
- **Role:** instrument `pb` itself (run engine, substrate adapters, capture) and export traces/metrics in a vendor-neutral format users can pipe into whatever they already run.
- **Effort:** S.

### Grafana / Loki / Tempo — **flag AGPLv3, never bundle**
- Relicensed from Apache-2.0 to **AGPLv3** in April 2021; plugins/agents/certain libraries remain Apache. ([Grafana Labs blog](https://grafana.com/blog/2021/04/20/grafana-loki-tempo-relicensing-to-agplv3/), [licensing page](https://grafana.com/licensing/))
- **Risk in plain terms:** using Grafana *unmodified*, self-hosted by the customer, pointed at data we export via OTel, is fine. Shipping a *modified* copy inside our product (self-hosted or cloud) triggers AGPL's network-copyleft obligation to publish our modifications. **Recommendation: never bundle or fork Grafana/Loki/Tempo.** Emit OTel; let the customer wire it into their own Grafana/Datadog/Honeycomb/whatever. For our own hosted-hub analytics backend, pick anything Apache/MIT (or Lyric's own ClickHouse, which the founder's org already runs).

---

## 8. Supply-chain attestation

### sigstore — **adopt at P4, reserve schema now**
- Apache-2.0 is a **hard requirement**: "All sigstore projects MUST be licensed under Apache-2.0" per OpenSSF charter. ([sigstore/community LICENSING.md](https://github.com/sigstore/community/blob/main/LICENSING.md))
- **Role:** directly implements PLAN §3.6 "Attestations (later)" — keyless signing (Fulcio), transparency log (Rekor), verification (Cosign) over the evidence bundle.
- **Effort:** M, scheduled at P4 per the roadmap; the evidence schema should already carry the placeholder field it needs (v2 schema sketch in PLAN §5 doesn't yet, worth a 1-line addition — see Open Questions).

### in-toto — **adopt at P4**
- Apache-2.0. Cosign has built-in support for in-toto attestations (DSSE envelope format). ([sigstore docs](https://docs.sigstore.dev/cosign/verifying/attestation/))
- **Role:** the envelope format for wrapping the evidence bundle manifest before signing with sigstore — these two are used together, not alternatives.

---

## 9. Fork-as-chassis: honest check

The question: is there an existing OSS project close enough to Proofbench that we should **fork it as our chassis** instead of continuing to build `bin/pb` from scratch? Four real candidates, all rejected, for different reasons:

| Candidate | Why it looked tempting | Why we reject it as chassis |
|---|---|---|
| [**crabbox**](https://github.com/openclaw/crabbox) | Closest architectural sibling: single static Go binary, "capsule/replay" UX, remote-runner control plane, MIT license, actively developed (updated Jul 5 2026 per its own release history). | PLAN §2 already scopes this correctly: crabbox "ships bytes to a box" and "explicitly refuses to own environment semantics" — that refusal is precisely the gap we exist to fill. Forking it means inheriting a codebase optimized for remote-provider plumbing (Azure/Apple Container leases, etc.) we don't need yet, at the cost of ripping out as much as we'd keep. **Interoperate, don't fork** — PR a bundle-emitter into crabbox (as PLAN already plans), consume it as a `remote` substrate provider. |
| [**OpenHands**](https://github.com/OpenHands/OpenHands) | MIT, mature (78k stars), self-hostable, "bring your own agent" story overlaps ours. | It's an *agent* (the thing that writes code), not a *verification harness*. We are explicitly "not an agent" (PLAN §2). Forking it buys us an LLM-loop/sandboxing codebase we'd have to first gut before it does anything we need. |
| [**Ona core** (ex-Gitpod)](https://github.com/gitpod-io/gitpod) | Closest *conceptual* prior art per PLAN §12 (`automations.yaml` services start/ready + seed tasks + `dependsOn` — literally the closest readiness-manifest precedent that exists). | Two independent disqualifiers: (1) **AGPL-3.0** core — the worst license shape to inherit for a company planning a hosted SaaS tier, since any modification we ship over a network must be released; (2) Ona was **acquired by OpenAI** in mid-2026 ([andrew.ooo](https://andrew.ooo/answers/openai-acquires-ona-gitpod-codex-explained-june-2026/)) — forking a now-OpenAI-owned codebase as a product chassis is a strategic own-goal (trademark exposure, a competitor's codebase as our foundation). **Read `automations.yaml` for design ideas only** (already happening — it's in PLAN §12); do not fork the code. |
| [**Testkube**](https://github.com/kubeshop/testkube) | Closest *domain* sibling: k8s-native test orchestration, has an "Execution Viewer" that rhymes with our evidence hub. | Dual-licensed MIT core + a custom **Testkube Community License** for some agent features ([licensing FAQ](https://docs.testkube.io/articles/testkube-licensing-FAQ)) — exactly the source-of-truth complexity we'd inherit for zero benefit. More fundamentally, its architecture assumes **Kubernetes CRDs/operator as the substrate**, which contradicts our explicit local/compose/k8s substrate-polymorphism requirement — adopting it would anchor us to k8s-only when half our stated integration shapes are pure local/compose. |

**Conclusion: no fork.** Continue building `bin/pb` bespoke. The one place a "build vs. fork" decision is genuinely still open is **Dagger-as-engine** (§4 above) — but that's "depend on it as a library," not "fork its repo," and it's explicitly scoped as a P1 spike, not a v1 decision.

---

## 10. ADR-ready recommendation: v1 dependency stack

**Decision:** ship v1 as a small, Apache-2.0-clean **Go core** (`spec/`, `engine/`, `cli/`, `mcp/`, `hub/`) that embeds a short list of permissively-licensed Go-native libraries, shells out to a short list of well-known CLIs for anything not Go-native, and keeps every non-Apache/MIT dependency (Claude Agent SDK, any future AGPL tool) in a clearly separated, optional adapter boundary — never in the licensed-Apache-2.0 core.

**v1 core additions (beyond what `bin/pb` already has):**
1. **testcontainers-go** (MIT, embed) — power the `compose` substrate + our own test fixtures.
2. **kind** (Apache-2.0, embed/shell) — offer a real local-k8s substrate option; CI fixtures for `k8s-attach` adapter tests.
3. **Playwright** (Apache-2.0, shell-out) + **playwright-mcp** (Apache-2.0, MCP, agent-side) — the L4/L5 UI check runner and the cloud/CI exploratory round.
4. **Peekaboo** (MIT, shell-out/MCP, macOS-only) — the local exploratory round.
5. **Stagehand** (MIT, shell-out) — the explore-once-cache-to-durable mechanism that makes "self-evolving test system" literally true rather than aspirational.
6. **Official MCP Go SDK** (MIT, embed) — `pb mcp`.
7. **OpenTelemetry Go SDK** (Apache-2.0, embed) — instrumentation, neutral export.
8. **Claude Agent SDK** (proprietary ToS) — isolated in `adapters/claude/`, outside the Apache-2.0 core boundary.

**P2 additions (already on the PLAN roadmap, now vendor-confirmed):**
9. **mirrord** (MIT, shell-out) — replaces hand-rolled `k8s-attach` env-derivation scripts; there's a pre-built "for AI Agents" mode.

**P4 additions (attestation, already scoped in PLAN §3.6):**
10. **sigstore + in-toto** (Apache-2.0, embed) — DSSE-signed evidence bundles.

**Deliberately deferred / not in v1:**
- **Dagger** — spike first (P1), could delete planned adapter code but is an architecture-level bet that shouldn't be made inside this research doc.
- **vcluster, Temporal, NATS, BuildKit/kaniko/buildpacks** — all real, all clean-licensed, all belong to either the cloud control plane or the "shape B" build path, neither of which is v1's critical path (v1's dogfood target per PLAN §7 is `local`/`compose` substrates against 2–3 Lyric services).
- **browser-use, Magnitude** — clean license, functional overlap with tools already chosen; watch-list.
- **Skyvern** (AGPL-3.0), **Grafana/Loki/Tempo unmodified-bundling** (AGPLv3), **Ona/Gitpod core** (AGPL-3.0 + OpenAI-owned) — explicitly avoided; safe *only* as external/user-hosted services, never embedded or forked.

**Alternatives considered:**
1. **Fork crabbox and extend it with environment-semantics + evidence** instead of building `pb` further. Rejected — see §9; PLAN's own non-goal ("interop target, not competitor") is correct, and the codebase's center of gravity (remote-provider plumbing) isn't ours.
2. **Adopt Dagger as the v1 execution engine immediately** rather than spiking it. Rejected for v1 — it's the right kind of bet to make with evidence (a real spike against a Lyric service) rather than from a research pass; the existing hand-rolled adapters are already proven against ENG-20190 and shouldn't be thrown away pre-emptively.
3. **Use browser-use as the primary AI-browser layer** (it has the highest published WebVoyager score and largest community) instead of Stagehand. Rejected — the founder's requirement is specifically "explore once, then ship durable automation," which Stagehand's caching model satisfies structurally and browser-use's agentic-loop model does not; benchmark leadership on autonomous task completion isn't the axis that matters here.

**Consequences:**
- The OSS core stays a single static Go binary with no forced runtime dependency beyond what the user's own `ready.yaml` substrate needs (compose/kind/mirrord CLIs are invoked, not bundled) — preserves the "runs in arbitrary repos and sandboxes with zero runtime deps" promise (PLAN §6).
- The Claude Agent SDK's proprietary terms are contained to one adapter, which both protects the Apache-2.0 core's OSS credibility and sets up the multi-agent story (OpenAI/other drivers as sibling adapters) without a rewrite.
- AGPL exposure (Skyvern, Grafana stack, Ona core) is fully avoided in the product itself; any AGPL tool that shows up later must go through the same "external service only" test applied here.
- Deferring the Dagger decision means some P1/P2 substrate-adapter work might later be thrown away if the spike is positive — an accepted, bounded cost of not making an unverified architecture bet now.

**Open questions for the founder / next research pass:**
1. Should the evidence bundle v2 schema (PLAN §5) get its `sigstore`/`in-toto` placeholder field added now (cheap, forward-compatible) even though P4 is the adoption target?
2. Is a one-week Dagger spike (rebuild the `compose` substrate on it, compare LOC/behavior against the existing `bin/pb` adapter) worth scheduling inside P1, or should it wait until after the P1 dogfood exit criterion (2–3 Lyric service manifests) is met?
3. Do we want a documented stance on Windows/Linux parity for the "exploratory round" pillar now that Peekaboo is confirmed macOS-only — is Playwright/playwright-mcp the cross-platform fallback everywhere except Mac, or is there a real gap to fill?
4. For the hosted cloud tier's message bus, is NATS's 2025 licensing scare (Synadia explored reclaiming it under a non-open license before CNCF/community pushback restored Apache-2.0) a reason to treat it as lower-confidence long-term than Temporal, or was that fully resolved?
