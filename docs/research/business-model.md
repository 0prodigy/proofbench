# Business Model & GTM Architecture — Proofbench

**Date:** 2026-07-06
**Status:** Draft for ADR
**Scope:** Pricing, packaging, OSS/cloud boundary, GTM sequencing for the agent-proof-harness product scoped in `PLAN.md`.

---

## 1. Comparable pricing models (2026 research)

### 1.1 Dev-infra open-core / usage-hybrid

| Company | Meter(s) | Self-host vs cloud | Notes |
|---|---|---|---|
| **PostHog** | Per-product usage: events, session recordings, feature-flag requests, error exceptions, data-warehouse rows — each product priced independently with automatic volume discounts up to ~82% at scale | OSS self-host (MIT, Docker Compose) free; cloud $0–2.5K/mo typical. Self-hosting only economical at 100M+ events/mo given $5–15K/mo infra+ops overhead | Generous product-led free tier (1M events, 5K recordings, etc.) drives adoption; per-product metering (not one blended unit) lets each surface find its own price-to-cost ratio. [posthog.com/pricing](https://posthog.com/pricing), [PostHog pricing teardown](https://dev.to/beton/posthog-pricing-teardown-2026-57oo) |
| **Sentry** | Event volume (errors, transactions/traces, replays, logs) + seats as a secondary axis | OSS self-host available; cloud Developer (free, 5K errors/1 user) → Team $26/mo (50K errors) → Business $80/mo | Explicitly *not* per-seat as primary meter — "pay for what you use instead of adding licenses." [sentry.io/pricing](https://sentry.io/pricing/), [Sentry 2026 pricing](https://sentrypricing.com/) |
| **GitLab** | Per-seat, tiered by feature depth (Free $0 / Premium $29/user/mo / Ultimate $99/user/mo) | CE (MIT) self-host free; EE proprietary/source-available, no relicensing drama — has held this line since 2015 CLA | Classic open-core: OSS core stays untouched, paid tiers are pure feature-gating, not usage. Proven durable (10+ years, no fork). [about.gitlab.com/pricing](https://about.gitlab.com/pricing/), [GitLab licensing](https://docs.gitlab.com/development/licensing/) |
| **Grafana** | Cloud: active users + metrics series/logs/traces ingestion (Pro ~$19/mo + usage, e.g. ~$6.50/1K active series); OSS: free forever | AGPLv3 self-host (2021 relicense from Apache 2.0) free; Enterprise adds RBAC, premium datasource plugins, audit/reporting — feature-gated, not usage-gated | Relicensed to AGPLv3 specifically to block hyperscalers from reselling modified Grafana without contributing back — narrower and less controversial than SSPL/BSL because it only restricts *distributing modifications*, not internal self-hosting. [grafana.com/pricing](https://grafana.com/pricing/), [AGPL relicense rationale](https://techradar.info/is-grafana-fully-open-source-the-truth-behind-the-2026-license/) |
| **Temporal** | "Actions" (state transitions) per million, plus storage; Essentials $100/mo incl. 1M actions, ~$50/M actions beyond, with volume discounts | Self-hosted server free (MIT); Cloud is the monetized surface | Nearly perfect meter-to-value alignment for us: an "action" ≈ one unit of durable work, independent of wall-clock time. [temporal.io/pricing](https://temporal.io/pricing), [Temporal Cloud pricing update](https://temporal.io/blog/temporal-cloud-pricing-update) |
| **n8n** | Per-workflow-*execution* (not per node/step/task) — Starter $24/mo (2.5K executions) → Pro $60/mo (10K) → Business $800/mo (40K, +SSO/versioning) | Self-hosted Community Edition 100% free, unlimited executions (Sustainable Use License — free for internal use, restricted for competing-product resale); Enterprise self-host needs a daily-phone-home license key | The "one execution = one full run regardless of complexity" unit is the direct analogue to our "one verify run regardless of #checks." [n8n.io/pricing](https://n8n.io/pricing/) |

### 1.2 Sandbox/compute infra (raw meter precedent for our PAYG)

| Company | Meter | Rate anchor |
|---|---|---|
| **Modal** | Per-second compute, split CPU/GPU/memory | H100 ≈ $0.0011/sec (~$3.95/hr effective); finest billing granularity in the category — ideal for scale-to-zero bursty jobs. [modal.com/pricing](https://modal.com/pricing) |
| **E2B** | Per-second sandbox compute (vCPU + memory) | $0.0504/vCPU-hr, $0.0162/GiB-hr; Hobby free tier, Pro $150/mo for 24h sessions + 100 concurrent sandboxes. [e2b.dev/pricing](https://e2b.dev/pricing) |
| **Daytona** | Per-second compute + storage | Same per-unit rate as E2B ($0.0504/vCPU-hr) — commoditized at this layer; $200 free credit. [Daytona pricing](https://www.xpay.sh/saas-pricing/daytona-io/) |
| **Browserbase** | "Browser hours" billed per-minute (first minute rounded up) + concurrency + proxy GB | Free (1 hr) → Developer $20/mo (100 hrs) → Startup $99/mo (500 hrs) → Scale (custom); overage $0.10–0.12/browser-hr. [browserbase.com/pricing](https://www.browserbase.com/pricing) |

**Takeaway:** the sandbox/compute layer has fully commoditized to per-second billing at near-identical rates ($0.05/vCPU-hr). We should never try to re-meter raw compute — pass it through near-cost (small margin) and meter *our* value (verification runs, evidence bundles) on top, same as Browserbase doesn't compete on raw CPU-seconds, it sells "browser session" as the unit.

### 1.3 Test-automation / QA-agent vendors (closest functional comparables)

| Company | Model | Rate |
|---|---|---|
| **QA Wolf** | Per *active test* (a maintained user-flow), flat monthly fee, includes creation + maintenance + unlimited parallel runs | ~$40–44/test/mo; median ACV ~$90K/yr; demo-gated, no public pricing. [QA Wolf pricing analysis](https://getautonoma.com/blog/qa-wolf-pricing) |
| **Ranger** | Custom annual contract sized to test-suite scope; includes hosted infra + human review | No public tiers; positions against QA Wolf on cost. [ranger.net](https://www.ranger.net/post/ranger-vs-qa-wolf) |
| **Momentic** | Free tier + quote-based paid (seat-flavored, unconfirmed ~$300/mo entry) | Opaque — no public per-seat or per-test number. [Momentic pricing](https://bug0.com/knowledge-base/momentic-pricing) |

**Takeaway:** the managed-QA-agent category prices on **outcome unit (a maintained test/flow)**, not compute or seats — and hides pricing behind sales calls (high-touch, high-ACV, services-heavy). That's a fundamentally different motion from ours (self-serve OSS → PAYG cloud); we should not copy their opacity, but the "per durable artifact, not per seat" instinct is right and maps to **per verified check / per readiness manifest**, not per test-author-seat.

### 1.4 Per-seat AI coding agents — the pricing model that is actively breaking (critical signal)

| Company | 2026 change | Why |
|---|---|---|
| **GitHub Copilot** | June 1 2026: moved *all* plans to usage-based "AI Credits" (1 credit = $0.01) on top of per-seat base; completions stay free/unmetered, chat/agent/premium-model calls are metered | Seat fee alone couldn't capture cost variance between a linter suggestion and a multi-step agent run. [GitHub Copilot usage-based billing](https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/) |
| **Cursor Bugbot** | Renewals after June 8 2026: dropped the flat $40/seat/mo entirely, moved to pure usage (avg run $1.00–1.50) | A PR-review agent's cost scales with PR size/complexity, not headcount — seat pricing was leaving money on the table on big PRs and overcharging idle seats. [Bugbot pricing change](https://cursor.com/blog/may-2026-bugbot-changes) |
| **Devin (Cognition)** | ACU (Agentic Computing Unit ≈ 15 min of autonomous work) consumption, $2.00–2.25/ACU; **seats are unlimited on every plan** | Explicit framing: "you are buying working time, not access licenses." [Devin pricing](https://devin.ai/pricing/) |
| **Market-wide** | Seat-based pricing among AI-product vendors fell from 21%→15% share in one year; seat-only vendors post ~40% lower gross margins than usage/outcome peers; 43% of 2026 buyers prefer consumption pricing, 27% outcome-based | Structural mismatch: a better agent needs *fewer* seats, so seat pricing pays the vendor to underperform. [AI agent pricing shift](https://www.mindstudio.ai/blog/saas-pricing-ai-agent-era), [outcome pricing 2026](https://particula.tech/blog/ai-agent-pricing-models-per-seat-vs-outcome-based-evaluation) |

**This is the single most important data point for our design.** Our product is structurally an agent-adjacent verification tool — the same misalignment applies: if we charged per human seat, we'd be paid *less* the more autonomous our customers' agent workflows become, which is the opposite of our stated thesis (verification is the bottleneck, agents will run more, not fewer, verification loops). **Meter the machine work (verify runs / evidence bundles / ACU-equivalent), not the humans.**

### 1.5 Compliance-evidence adjacency (models our "compliance exports" cloud feature)

- **Vanta / Drata / Secureframe**: platform subscription $7.5K–20K+/yr (breadth of integrations, frameworks) is *separate* from the actual third-party audit fee ($10K–50K). The lesson for us: **compliance/evidence-ledger tooling is priced as an enterprise annual platform fee, decoupled from any per-unit meter**, because the buyer (security/compliance team) budgets annually and wants predictability, not a variable bill. [Vanta pricing](https://www.vanta.com/pricing), [SOC2 cost breakdown](https://www.thesectorpost.com/compliance/soc2/audit-costs)

### 1.6 Open-core relicensing dramas — what worked vs backfired

| Case | What happened | Outcome | Lesson |
|---|---|---|---|
| **MongoDB → SSPL (2018)** | Copyleft extended to "offering as a service" to stop AWS DocumentDB-style extraction | Debian/RHEL/Fedora dropped MongoDB; AWS built an *API-compatible clean-room* product instead (DocumentDB) — SSPL didn't stop the competitor, it just lost MongoDB the OS-distro channel | A restrictive license doesn't stop a well-capitalized cloud vendor; it stops *packagers and downstream OSS ecosystem*. [MongoDB SSPL history](https://en.wikipedia.org/wiki/Server_Side_Public_License) |
| **Elastic → SSPL/Elastic License (2021) → back to AGPL (2024)** | Same AWS-extraction motive; triggered the AWS-led **OpenSearch** fork (100M+ downloads year 1) | Elastic reversed in 2024, re-added AGPLv3 as an option — but OpenSearch had already won permanent mindshare/market share; trust took 3 years to partially rebuild | Once you relicense, the fork is permanent even if you reverse course; the *community-trust* cost outlives the *legal* fix. [Elastic's return to OSS](https://www.infoq.com/news/2024/09/elastic-open-source-agpl/) |
| **HashiCorp Terraform → BSL (Aug 2023)** | Blocked competing IaC platforms (Spacelift, env0, Scalr) from building on Terraform | Immediate fork (**OpenTofu**), 33K+ GitHub stars in a month, 120+ companies signed the manifesto, Linux Foundation adopted it within weeks, GA in 4 months | The faster and more credible the neutral-foundation fork, the less damage a vendor can do relicensing later — this is now a well-worn, fast playbook the community executes reflexively. [OpenTofu fork timeline](https://opentofu.org/blog/opentofu-announces-fork-of-terraform/) |
| **Redis → SSPL/RSAL (Mar 2024) → AGPL (2025)** | Same motive again | Immediate **Valkey** fork under Linux Foundation, backed by AWS/Google/Oracle within days; 83% of large Redis users had adopted or were testing Valkey within a year; Redis "lost most external contributors"; original creator (antirez) returned and pushed the 2025 reversal to AGPLv3 | Worst-case outcome of the three: reputational damage was severe enough to require bringing back the founder to reverse course, and even the reversal (AGPL) is treated by many enterprise legal teams as "commercially radioactive" | [Redis license saga](https://www.infoq.com/news/2025/05/redis-agpl-license/) |
| **GitLab CE/EE (2015–now)** | Never relicensed the OSS core; kept EE proprietary from day one via CLA | No fork, no backlash, 10+ years stable — proof that **feature-gating from the start** (not usage-restricting *after* adoption) is durable | [GitLab licensing model](https://docs.gitlab.com/development/licensing/) |

**Pattern, unambiguous across 4 cases:** relicensing an *already-permissive* OSS project to extract cloud-vendor value **always** triggers a credible, fast, foundation-backed fork now (community has the OpenTofu/Valkey/OpenSearch playbook memorized), and the reputational damage outlasts any later reversal. The only durable model is **GitLab's**: pick the open/proprietary boundary once, at OSS launch, and never move it. This is a hard constraint on our own OSS strategy (§3).

---

## 2. Design for us

### 2.1 The PAYG meter

**Recommendation: meter the *verify run*, with evidence-bundle byte storage as a secondary metered axis in cloud, and pass through agent/LLM tokens near-cost.**

Reject the alternatives:

- **Reject "agent tokens passthrough + margin" as the primary meter.** We don't control token consumption (the customer's chosen agent — Claude, Cursor, Devin — burns its own tokens against its own API key or subscription in most BYOA setups); metering something we don't control and can't optimize is a broken incentive (mirrors the seat-pricing mismatch in §1.4 — we'd be paid more when the *customer's* agent is wasteful, not when our verification is good). Where we *do* run agent calls on the customer's behalf (e.g., the optional computer-use exploratory round, or an agent-proposed-fix path), pass those tokens through at near-cost + a small visible margin (10–20%, Modal/E2B-style transparency), billed as a **separate line item**, never blended into the core meter.
- **Reject "evidence runs" as a distinct unit from "verify runs."** In our own architecture (PLAN §5–6) a verify run *produces* the evidence bundle — they're the same event. Don't invent two meters for one action; n8n's lesson (§1.1) is that collapsing to the smallest number of legible units wins trust.

**Primary meter: 1 "verify run" = one invocation of `pb verify` (or CI/MCP equivalent) that executes the manifest's checks against a substrate and produces one evidence bundle**, independent of:
- how many `checks[]` it evaluates (like n8n: one execution regardless of node count)
- how long it runs (like Temporal actions, not wall-clock)
- which substrate it targets (local runs are usually free-tier/self-host anyway; compose/k8s-attach/remote are the paid-tier moments)

This is the one unit a founder, a platform-eng buyer, and a compliance buyer can *all* read off an invoice and map to "how much did we verify this month," which is the same legibility property that makes Temporal's "action" and n8n's "execution" durable meters.

Secondary/cloud-only meters (bundle to avoid seat-style creep, but disclose):
- **Evidence retention** (GB-months of bundle storage beyond a free retention window) — like Grafana Cloud's ingestion tiering, decoupled from the primary meter so a customer that runs a lot of *free/local* verification isn't punished, only paid cloud retention.
- **BYOC-attach connector minutes** (managed credential-brokered k8s-attach sessions) — Browserbase-style "session" unit, our BYOC analogue.
- **Pass-through agent tokens** (when our agent runs on the customer's behalf) at cost+15%.

Free forever: **local + compose verify runs, self-hosted, unlimited** — no meter at all below the cloud line, matching PostHog/Temporal/n8n's "self-host is genuinely free, cloud is where billing starts" pattern, not GitLab's "free tier is capped at 5 users" pattern (that cap fits seat-native products; it does not fit a CLI tool devs run hundreds of times a day locally — capping *that* kills the PLG loop we're relying on for adoption).

### 2.2 Subscription tiers

| Tier | Price anchor | What's in it | Comparable |
|---|---|---|---|
| **OSS / Free (self-host)** | $0 | Full CLI+engine+MCP, all substrates (local/compose/k8s-attach/remote), unlimited verify runs, local hub, spec/v0 schemas, community manifest registry | PostHog OSS, Temporal self-hosted, n8n Community |
| **Team Cloud** | $0 base + usage; ballpark **$0.50–$2 per verify run** beyond a monthly included allotment (e.g., 500 free runs/mo), plus a flat **$20–29/active-repo/mo** platform fee once a team wants the hosted hub/PR-publisher (not per human seat) | Hosted evidence hub (retained/searchable/RBAC'd), PR/Jira/Slack publishers, before/after diff view, GitHub App install | Pricing shape mirrors Temporal Essentials ($100 base + $50/M actions) and Sentry Team ($26 base + event overage); per-*active-repo* (not per-seat) fee mirrors PostHog's per-project-not-per-user instinct and dodges the per-seat trap in §1.4 |
| **Enterprise (BYOC + SSO + compliance)** | Custom, anchored around **$25K–$60K/yr** entry (Grafana Enterprise floor is $25K/yr; Vanta/Drata compliance-platform floor is $7.5K–20K/yr — we sit between, since we combine infra-attach + compliance) | Managed credential-brokered k8s-attach connectors, SSO/SAML, signed DSSE attestations, compliance exports (SOC2/ISO change-management mapping), readiness-score analytics, fleet supervision, dedicated support, uptime SLA | Grafana Enterprise, Vanta Enterprise |

Notes on the tier boundary:
- **No feature is removed from OSS to build the paid tiers** — the paid tiers are 100% *new cloud-only capability* (hosted ledger, managed connectors, compliance exports), never a crippled version of the CLI. This is deliberate: it's the GitLab shape (feature-gate from day one, never later) crossed with PostHog's "self-host is really free" — and it is the only shape that survives the relicensing-drama pattern in §1.6, because there is never anything to "take back" from the OSS half. We are pre-committing, at launch, to never later restrict something the OSS core already does — which forecloses ever needing a BSL/SSPL move.
- Team Cloud's per-active-repo platform fee (not per-seat) is chosen specifically because our buyer's success (agents doing more autonomous work) should *increase* our revenue via verify-run volume, not decrease it via seat contraction — directly countering the §1.4 mismatch.

### 2.3 OSS vs cloud-only boundary (confirms PLAN §9, sharpens the rationale)

| Stays OSS (Apache-2.0) | Cloud-only |
|---|---|
| `ready.yaml`/`workspace.yaml` spec + JSON Schemas | Hosted evidence **ledger** (org-wide retained/searchable/RBAC'd) |
| Engine, substrate adapters (local/compose/k8s-attach/remote) | **Compliance exports** (SOC2/ISO mapping, signed attestation verification UI) |
| Capture/evidence-bundle writer (`pb evidence`), bundle schema v2 | **Fleet supervision** (Crabfleet-style multi-repo/multi-agent oversight, merge-gating policies) |
| Local hub (single-machine, read-only) | **Credential broker** (audited, managed BYOC cluster connectors — customers shouldn't have to hand us raw kubeconfigs) |
| CLI + embedded MCP server | **Readiness scores & analytics** (cross-org SetupBench-style scoring, flaky-verification detection, trend dashboards) |
| Vendor compile targets (Copilot/Cursor/OpenHands configs) | PR/Jira/Slack **publishers as a hosted service** (self-hosters can still build/run their own publisher scripts against the open bundle format — we're not gating the format, only the managed integration) |

Every cloud-only item is either (a) inherently a *hosted, multi-tenant, ongoing-operations* capability that doesn't make sense as a local artifact (ledger, fleet supervision, credential broker), or (b) a compliance/analytics capability that only has value at accumulated scale (readiness scores need cross-run history). None of them is "the same CLI feature, but paywalled" — that distinction is what keeps this open-core boundary GitLab-shaped rather than Redis-shaped.

### 2.4 GTM wedge sequencing

1. **OSS CLI, local-first** (`pb up/seed/verify/evidence`) — Show HN launch anchored on a SetupBench-style headline stat (PLAN P3 already scopes this). Zero-config auto-detect removes the Earthly-style cold-start tax. No sign-up, no network call required to get value — matching how n8n Community and Temporal self-hosted earn trust before any monetized surface exists.
2. **GitHub App: PR proof comment** — free, install-in-60-seconds, posts verdict + proof-ladder rung + evidence-bundle link on PRs (mirrors Codecov's / Snyk's / Bugbot's PR-check distribution motion, which is proven as a discovery channel — Codecov and Snyk both gate the *report view* behind a paid seat, but keep the *check itself* free, which is the right split for us too: free status check, paid hosted report/ledger). This is also the natural moment to introduce the "agent-proposed fix" surface later.
3. **Cloud (Team tier)** — once a team has >1 repo wired and wants retained history/RBAC/before-after diffing, convert on the per-active-repo + verify-run-overage meter from §2.2. This is the PostHog/Sentry-style "free tier funnels to usage tier" motion, not a hard paywall.
4. **Enterprise (BYOC/SSO/compliance)** — inbound from platform/security teams once the evidence ledger has enough history to be worth compliance-mapping; sales-assisted, annual, Vanta/Grafana-Enterprise-shaped.

This order is deliberately identical to the PLAN.md roadmap (P0–P3) — the GTM sequence and the engineering roadmap are the same sequence, which is itself a point in favor: we are not building monetization as a bolt-on later, each roadmap milestone *is* the next GTM step.

---

## 3. ADR-ready recommendation

**Decision:** Open-core, Apache-2.0 CLI/engine/spec (never relicensed — pre-committed boundary), with a usage-metered cloud product on top. Primary meter is the **verify run** (not agent tokens, not seats, not "evidence runs" as a separate unit). Three tiers: **OSS self-host (free, unlimited)** → **Team Cloud (per-active-repo platform fee + verify-run overage, ~$20–29/repo/mo + $0.50–2/run beyond an included allotment)** → **Enterprise BYOC (custom, $25K+/yr floor, SSO/compliance/credential-broker/fleet)**. GTM sequence: OSS CLI → free GitHub App PR-proof comment → Team Cloud conversion → Enterprise inbound — matching the existing PLAN.md P0–P3 roadmap 1:1.

**Alternatives considered:**
1. **Per-seat SaaS (GitLab/Copilot-classic shape).** Rejected as primary meter: §1.4 shows this is the pricing model actively breaking industry-wide for agent-adjacent tools in 2026 (seat pricing pays the vendor to underperform as agents get more autonomous — the opposite of our thesis that agents will run *more* verification, not fewer). Kept only as a *description* of Enterprise contract structure (named users for RBAC), never as the revenue meter.
2. **Agent-token passthrough + margin as the primary meter.** Rejected as primary: we don't control most of the token spend (customer's own agent/API key in BYOA setups), so it's not a lever we can improve, and blending it with our own value-add erodes trust the way "hidden AI credit" line items are already drawing criticism in Copilot's June 2026 rollout. Kept as a *secondary, transparently separate* line item only for the narrow case where our agent runs on the customer's behalf (computer-use exploratory round).
3. **Aggressive open-core with usage-restrictive self-host license (SSPL/BSL-style), to capture hyperscaler resale value.** Rejected outright: §1.6 shows a 100% failure rate across MongoDB/Elastic/HashiCorp/Redis — every case triggered an immediate, credible, foundation-backed fork, and reputational cost outlived even a later reversal. Given we are pre-launch with zero installed base, there is no hyperscaler-extraction problem yet to defend against, and the downside (killing OSS trust before we have any) dominates any theoretical upside.

**Consequences:**
- We forgo near-term revenue from gating any CLI feature — the cloud product must earn its price entirely on hosted-operations value (ledger, compliance, fleet, credential broker), which requires those four cloud-only pillars (PLAN §9) to actually be worth $20–60K/yr, not just "the same tool with a login screen." This raises the bar on cloud-hub UX/analytics investment (§9 items 1–3) relative to engine investment.
- Per-active-repo + verify-run-overage billing is harder to forecast for customers than flat per-seat (usage bills have this reputation regardless of category) — mitigate with PostHog-style spend caps/alerts per repo from day one of Team Cloud, not as a v2 feature.
- Committing to "never relicense, never restrict OSS" as a permanent constraint forecloses a MongoDB/Elastic-style late-stage monetization lever if a hyperscaler ever resells our hosted-hub-equivalent — accepted, because §1.6 shows that lever destroys more value than it captures even when "successfully" executed.
- The GTM wedge (free GitHub App PR comment) creates support/abuse surface (public repos, potential spam) before there's a paid relationship — needs a lightweight rate-limit/abuse policy at P3, not deferred to cloud launch.

**Open questions (flagged for Akash, not resolved here):**
1. Exact included-allotment size for Team Cloud's free verify-run tier (500/mo is a placeholder anchored loosely to Temporal's 1M-actions-for-$100 and n8n's 2.5K-executions-for-$24 — needs our own COGS model per verify run, which depends on substrate mix — local/compose runs cost us near-zero, k8s-attach/remote runs carry real compute pass-through).
2. Whether the "agent-proposed fix" feature (PLAN, implied but not yet spec'd) becomes a distinct metered action (Bugbot-style, ~$1–1.50/run) or is bundled into the verify-run meter — decide once that feature is actually scoped.
3. Whether Enterprise BYOC pricing should itself split into a platform fee (us) + pass-through cloud infra (customer's own account, direct-billed) the way true BYOC vendors do (§1.4's BYOC section) — likely yes, but needs confirmation once the credential-broker architecture (PLAN §9.4) is designed, since it determines whether we ever touch the compute bill at all.
4. Whether the still-unresolved "harness vs agents vs full product" framing (explicitly delegated by Akash) changes this pricing architecture — this ADR assumes **harness + thin agent surface**, matching PLAN's non-goals (§2: "not an agent"); if the product pivots toward *owning* more of the agent loop (e.g., our own fix-proposal agent becomes primary, not optional), the meter shifts from "verify run" toward something ACU/Devin-shaped, and this ADR should be revisited.

---

## Sources

- PostHog pricing: https://posthog.com/pricing ; https://dev.to/beton/posthog-pricing-teardown-2026-57oo
- Sentry pricing: https://sentry.io/pricing/ ; https://sentrypricing.com/
- GitLab pricing & licensing: https://about.gitlab.com/pricing/ ; https://docs.gitlab.com/development/licensing/
- Grafana pricing & AGPL relicense: https://grafana.com/pricing/ ; https://techradar.info/is-grafana-fully-open-source-the-truth-behind-the-2026-license/
- Temporal Cloud pricing: https://temporal.io/pricing ; https://temporal.io/blog/temporal-cloud-pricing-update
- n8n pricing: https://n8n.io/pricing/
- Modal pricing: https://modal.com/pricing
- E2B pricing: https://e2b.dev/pricing
- Daytona pricing: https://www.xpay.sh/saas-pricing/daytona-io/
- Browserbase pricing: https://www.browserbase.com/pricing
- QA Wolf pricing: https://getautonoma.com/blog/qa-wolf-pricing ; https://www.qawolf.com/blog/qa-wolf-is-reinventing-qa-pricing
- Ranger: https://www.ranger.net/post/ranger-vs-qa-wolf
- Momentic pricing: https://bug0.com/knowledge-base/momentic-pricing
- GitHub Copilot usage-based billing: https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/
- Cursor Bugbot pricing change: https://cursor.com/blog/may-2026-bugbot-changes
- Devin/Cognition ACU pricing: https://devin.ai/pricing/
- AI agent per-seat vs usage/outcome pricing shift 2026: https://www.mindstudio.ai/blog/saas-pricing-ai-agent-era ; https://particula.tech/blog/ai-agent-pricing-models-per-seat-vs-outcome-based-evaluation
- Vanta / Drata / SOC2 compliance pricing: https://www.vanta.com/pricing ; https://www.thesectorpost.com/compliance/soc2/audit-costs
- BYOC pricing model: https://northflank.com/blog/bring-your-own-cloud-byoc-future-of-enterprise-saas-deployment
- Codecov / Snyk PR-check pricing: https://about.codecov.io/pricing/ ; https://snyk.io/plans/
- MongoDB SSPL history: https://en.wikipedia.org/wiki/Server_Side_Public_License
- Elastic relicense + 2024 return to AGPL: https://www.infoq.com/news/2024/09/elastic-open-source-agpl/
- HashiCorp BSL + OpenTofu fork: https://opentofu.org/blog/opentofu-announces-fork-of-terraform/ ; https://spacelift.io/blog/terraform-license-change
- Redis SSPL/AGPL saga + Valkey fork: https://www.infoq.com/news/2025/05/redis-agpl-license/
- crabbox / OpenClaw economics: https://github.com/openclaw/crabbox ; https://sfailabs.com/guides/openclaw-pricing
