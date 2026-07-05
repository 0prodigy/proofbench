# Docker-based testing mode — architecture research & ADR input

Status: research for ADR · Date: 2026-07-06 · Scope: Proofbench `docker` testing mode, both integration shapes (A: pull a pre-built image; B: build from source), mapped onto the existing `internal/substrate` interface.

Related: [`PLAN.md`](../../PLAN.md) §3–6 (substrate adapters, evidence bundle, architecture), [`CONTRACTS.md`](../../CONTRACTS.md) (frozen `Substrate` interface), [`internal/substrate/types.go`](../../internal/substrate/types.go), [`internal/substrate/compose.go`](../../internal/substrate/compose.go).

---

## TL;DR — the recommendation

**Do not add a new `Substrate` kind for docker-mode.** The existing `compose` substrate already covers shape A (pull) and simple shape B (build) for free, because `docker compose up` already resolves `image:` (pull) and `build:` (BuildKit) stanzas natively. What's missing is everything *around* `Up`: an artifact-handoff contract for shape A, a build-agent for advanced shape B, a reaper so unattended runs don't leak resources, and a preflight that fails honestly instead of surfacing a confusing docker-socket error.

1. **Shape A contract:** OCI image pinned **by digest**, required `org.opencontainers.image.*` annotations for provenance, registry auth via the existing three CI-standard mechanisms (static `config.json` login, cloud credential helper, or short-lived bearer token) — no new proofbench-invented auth scheme.
2. **Shape B build agent, v1: BuildKit via `docker buildx bake`.** Buildpacks as an **opt-in** zero-Dockerfile path for the auto-detect generator. **Kaniko excluded** — archived by Google Container Tools Jan 2025 ([a-listware.com](https://a-listware.com/blog/buildkit-alternatives), [nabilnoh.com](https://www.nabilnoh.com/posts/buildkit-kaniko-replacement/)). **Dagger deferred past v1** — mid-migration off BuildKit internals, adds a second runtime dependency; revisit at P2+.
3. **New orthogonal concern, not a `Substrate` method:** a `Builder` step that runs *before* `Up`, producing/pinning an image reference. Keeps `Up/Ready/Seed/Down` frozen per `CONTRACTS.md`.
4. **Reaper:** adopt testcontainers' Ryuk pattern — label every resource `pb.runId=<id>`, sweep by label on `Down` and on next invocation, so a killed agent process doesn't leak containers.
5. **Isolation requirement, not our job to provide:** docker-mode needs nested-docker capability (Sysbox/Kata-class or Docker Sandboxes-class microVM). We add a preflight check and a named `known_walls` entry — we don't ship a sandbox (per `PLAN.md` §2, "not a sandbox/runtime").

Full ADR-ready block at the bottom.

---

## Part 0 — grounding in the existing substrate interface

```go
// internal/substrate/types.go
type Substrate interface {
    Up(r *manifest.Ready) error
    Ready(r *manifest.Ready) error
    Seed(r *manifest.Ready) error
    Down(r *manifest.Ready) error
}
```

`compose.go` already:
- shells to `docker compose -f <file> up -d --wait`, falling back to plain `up -d` + its own `Ready` poll on older compose without `--wait`;
- treats `sources.compose` (default `docker-compose.yml`) as the derived source of truth — no restated dependency graph;
- has a `checkCompose()` preflight (docker on PATH → compose plugin present → daemon reachable) that degrades to a typed `ComposeUnavailable` error instead of a bare exec failure.

This is the right shape to extend, not replace. Everything below is designed to slot into `checkCompose`-style preflights, `sources.compose`-style derivation, and a **new pre-`Up` phase** rather than touching the frozen interface.

---

## Part 1 — Shape A: user/CI built the image, we pull and test

### 1.1 The artifact handoff contract

Three questions define the contract: *what identifies the artifact*, *what metadata rides with it*, *how do we authenticate to fetch it*. All three have existing open standards — proofbench should consume them, not invent a fourth.

**Identity: pin by digest, not tag.** A mutable tag (`:latest`, `:prod`) breaks the "pins make the run reproducible" property `PLAN.md` §5 already commits to (`"pins": { "image": "dataservice:redcat@sha256:..." }`). The contract: `ready.yaml`'s artifact reference MUST resolve to a digest before it's written into an evidence bundle's `pins.image`, even if the human-authored manifest names a tag.

**Metadata: OCI annotations, not a side-channel file.** The OCI Image Spec reserves the `org.opencontainers.image.*` annotation namespace for exactly this handoff ([github.com/opencontainers/image-spec](https://github.com/opencontainers/image-spec/blob/main/annotations.md), [specs.opencontainers.org](https://specs.opencontainers.org/image-spec/annotations/)). Relevant keys already standardized:

| Key | Use for proofbench |
|---|---|
| `org.opencontainers.image.source` | repo URL → cross-check against the `ready.yaml`'s own repo, catches "wrong image" mistakes |
| `org.opencontainers.image.revision` | commit SHA → becomes `pins.repo` in the evidence bundle for free |
| `org.opencontainers.image.created` | build timestamp → staleness checks ("this image predates the PR") |
| `org.opencontainers.image.base.digest` / `.base.name` | base-image provenance, feeds supply-chain checks later |

Docker's own build metadata docs confirm annotations (image-spec) vs labels (docker-specific, container/runtime scoped) are distinct but commonly mirrored 1:1 by build tooling ([docs.docker.com/build/metadata/annotations](https://docs.docker.com/build/metadata/annotations/), [snyk.io](https://snyk.io/blog/how-and-when-to-use-docker-labels-oci-container-annotations/)). **Decision: require `source` + `revision` at minimum; treat a pulled image missing them as a named, honest `not-run` reason ("image lacks provenance annotations"), never a silent pass** — this is the same anti-fabrication posture as the evidence bundle's provenance flags in `PLAN.md` §5.

**Proposed `ready.yaml` addition** (additive, doesn't touch the frozen `Substrate` interface — only `manifest.Ready`'s schema):

```yaml
artifact:                                # shape A: someone else already built this
  image: ghcr.io/acme/orders-api          # tag is a hint; resolved to digest at pull time
  require_labels: [source, revision]      # org.opencontainers.image.<key>, fail-fast if absent
  registry:
    auth: env:GHCR_TOKEN                  # or: credential-helper | workload-identity (see 1.2)
```

This composes with the existing `compose` substrate unchanged: the generated/derived compose file's service gets `image: ${ARTIFACT_IMAGE}` and compose's native `image:` pull path does the rest — no new substrate code needed for the happy path.

### 1.2 Registry authentication — three patterns, not a fourth

The OCI Distribution Spec's bearer-token flow is the actual mechanism underneath all "docker login"-shaped auth: on a `401`, the registry returns `WWW-Authenticate: Bearer realm=...,service=...,scope=repository:<name>:pull`; the client fetches a token from `realm` and retries with `Authorization: Bearer <token>` ([distribution.github.io](https://distribution.github.io/distribution/spec/auth/token/), [docs.docker.com/reference/api/registry/auth](https://docs.docker.com/reference/api/registry/auth/)). Proofbench never needs to implement this directly — it needs to make sure whichever of the three standard mechanisms is configured actually works before `Up`:

1. **Static `~/.docker/config.json` login** (`docker login` once, credentials cached) — simplest, fine for local dev and long-lived CI credentials ([toddysm.com](https://toddysm.com/2024/01/30/authenticating-with-oci-registries-docker-hub-implementation/)).
2. **Cloud credential helper** (`docker-credential-gcr`, `docker-credential-ecr-login`) — refreshes short-lived cloud tokens automatically; the documented pattern for GAR/ECR in CI ([docs.cloud.google.com/artifact-registry/docs/docker/authentication](https://docs.cloud.google.com/artifact-registry/docs/docker/authentication), ECR helper via [oneuptime.com](https://oneuptime.com/blog/post/2026-02-17-how-to-authenticate-docker-with-google-artifact-registry-using-gcloud-credential-helpers/view)).
3. **Workload identity / short-lived access token** — recommended over long-lived keys for CI-to-cloud-registry auth ("use Workload Identity Federation if your provider supports it, access tokens otherwise") ([docs.cloud.google.com](https://docs.cloud.google.com/artifact-registry/docs/docker/authentication)).

**Contract:** `artifact.registry.auth` names *which* of the three is in play (`config` | `credential-helper:<name>` | `env:<VAR>`) so the preflight can check the right thing (config.json has an entry vs. the helper binary is on PATH vs. the env var is set) and fail with a named reason — this becomes a `known_walls` entry identical in shape to the one `PLAN.md` §4 already sketches (`"401 from artifact registry" / cause: token expiry / recover: gcloud auth print-access-token | docker login ...`). No proofbench-specific secret store; the whole point is deriving from what the host already has configured.

### 1.3 What testcontainers gets right that we should steal

Testcontainers is the closest prior art for "stand up a container, wait until it's actually ready, tear it down even if the test process dies badly" — precisely `Up`/`Ready`/`Down`.

**Ryuk, the reaper.** Ryuk is a sidecar container that tracks every resource (container/network/volume) it's told about via session-scoped labels (`org.testcontainers.<lang>.sessionId`) and deletes them the moment its controlling TCP connection drops — including on abnormal termination ([deepwiki.com/testcontainers-go](https://deepwiki.com/testcontainers/testcontainers-go/2.5-resource-cleanup), [deepwiki.com/testcontainers-python](https://deepwiki.com/testcontainers/testcontainers-python/3.8-ryuk-and-resource-cleanup)). It's a singleton per process — one Ryuk regardless of how many containers are spun up ([golang.testcontainers.org/features/garbage_collector](https://golang.testcontainers.org/features/garbage_collector/)).

**Why this matters more for us than for a test framework:** proofbench runs are agent-invoked and frequently unattended (`PLAN.md`'s whole premise). An agent process that gets killed mid-`verify` — timeout, OOM, orchestrator cancel — must not leave orphaned containers on a shared BYOC node or a CI runner. `compose.go` today only cleans up on an explicit `pb down`; there's no crash path.

**Recommendation for v1 (lighter than a Ryuk sidecar, same guarantee):** label every container/network/volume proofbench creates with `pb.runId=<runId>` (mirrors the compose substrate's existing use of compose project/service labels) and:
- sweep by label on `Down` (already implicit in `docker compose down` for the project's own resources);
- sweep by label **on the next `pb` invocation** in the same repo, before `Up` — "did the previous run's label still have live resources with no corresponding lock/pidfile? clean them first."
- skip a real Ryuk-style sidecar container in v1 — it's a second image pull and a second daemon dependency, against the "Go single static binary, zero runtime deps" implementation choice (`PLAN.md` §6). Flag as an open question below: a sidecar reaper is strictly more crash-proof (survives `kill -9` of the host process, not just the next invocation) and may be worth it once proofbench runs on shared/ephemeral CI nodes where "the next invocation" might never happen.

**Wait strategies.** Testcontainers' documented practice: never `sleep()`, always a deterministic wait strategy — HTTP response, log line, listening port, or exec/healthcheck — and compose these when one signal isn't enough ([testcontainers.com/getting-started](https://testcontainers.com/getting-started/)). `manifest.Ready.Run.Ready` already encodes `http`/`tcp`/`exec` probes (`PLAN.md` §4). **Gap: no log-line probe.** That's a common testcontainers wait strategy for services with no separate health endpoint (e.g., "database system is ready to accept connections" in a Postgres log). Worth adding a fourth probe kind (`log: "pattern"`) to `run.ready` — small, additive, matches the k8s-probe-vocabulary heritage already claimed.

**Reuse (opt-in, dev-only).** Testcontainers' experimental reuse feature keeps a container running across test runs when its config hash matches, enabled via `TESTCONTAINERS_REUSE_ENABLE=true` or `~/.testcontainers.properties`; explicitly **not suited for CI** ([java.testcontainers.org/features/reuse](https://java.testcontainers.org/features/reuse/), [rieckpil.de](https://rieckpil.de/reuse-containers-with-testcontainers-for-fast-integration-tests/)). Directly portable: a `pb up --reuse` flag for local dev loops (skip container startup on repeated `pb verify` iterations against an unchanged manifest), hard-disabled whenever `pb` detects a CI/agent environment (no TTY, `CI=true`) — same asymmetry testcontainers already learned the hard way.

### 1.4 Compose provider services — a resource locator we don't need yet, but should track

Docker Compose's `provider` service type delegates a service's lifecycle to a plugin/binary instead of a container Compose manages directly — `type: <plugin-name>` (a `docker-<name>` CLI plugin or a binary on PATH), the plugin provisions the capability and returns access info as env vars injected into dependents ([docs.docker.com/compose/how-tos/provider-services](https://docs.docker.com/compose/how-tos/provider-services/)). The flagship instance today is `type: model` (Docker Model Runner — an OpenAI-API-compatible local LLM inference engine built into Docker Desktop on top of llama.cpp), requiring Compose ≥2.38 for the model sub-type specifically ([docs.docker.com/ai/model-runner](https://docs.docker.com/ai/model-runner/), [geshan.com.np](https://geshan.com.np/blog/2026/01/docker-model-runner-docker-compose/)); the exact minimum version for the *general* provider mechanism wasn't pinned down by any fetched source — verify at implementation time.

**Why this matters to proofbench specifically, beyond "another resource type":** `PLAN.md`'s `resources:` block already anticipates typed, substrate-resolved dependencies (`db: { type: postgres, via: { compose: postgres, k8s: svc/orders-db } }`). Provider services are a third `via` locator (`via: { provider: { type: postgres, options: {...} } }`) for platform-managed capabilities compose itself doesn't run as a container — relevant for cloud-managed DBs in local dev, and directly relevant to an eventual **LLM-judge check type** in the evidence engine's `checks[]` (an in-repo, no-API-key local model via `type: model` to score a fuzzy assertion) — a capability nothing else in the prior-art list (Ona, Score, Skaffold verify) offers. **Recommendation: don't build this in v1** — flag it as a spec sketch for the `resources.*.via` locator, revisit alongside P2's BYOC/`k8s-attach` work where the "third locator" pattern (compose / k8s / provider) becomes load-bearing anyway.

---

## Part 2 — Shape B: our build agent builds from source

### 2.1 The field, ranked

| Tool | 2026 status | Verdict for proofbench |
|---|---|---|
| **BuildKit** (via `docker buildx` / `buildx bake`) | Docker's standard builder; rootless mode ships as a direct, unprivileged replacement for kaniko; ~3x faster than legacy build, native multi-arch, advanced cache backends ([a-listware.com](https://a-listware.com/blog/buildkit-alternatives), [github.com/moby/buildkit](https://github.com/moby/buildkit)) | **Default build agent, v1.** |
| **Kaniko** | **Officially archived by Google Container Tools, Jan 2025**; a Chainguard fork is the only maintained line ([a-listware.com](https://a-listware.com/blog/buildkit-alternatives), [nabilnoh.com](https://www.nabilnoh.com/posts/buildkit-kaniko-replacement/)) | **Excluded.** No reason to build v1 on a tool already in managed decline when BuildKit's own rootless mode covers the same "no privileged daemon in K8s" need it was chosen for historically. |
| **Cloud Native Buildpacks** (`pack` CLI / `lifecycle`) | CNCF spec; detect→build→export phases auto-select buildpacks by inspecting the source tree (no Dockerfile) ([buildpacks.io/docs/for-platform-operators/concepts/lifecycle](https://buildpacks.io/docs/for-platform-operators/concepts/lifecycle/), [buildpacks.io/docs/for-platform-operators/concepts/lifecycle/detect](https://buildpacks.io/docs/for-platform-operators/concepts/lifecycle/detect/)); deterministic/reproducible by design ([medium.com/@michael.vittrup.larsen](https://medium.com/@michael.vittrup.larsen/dockerfiles-vs-cloud-native-buildpacks-8acf8149dea1)) | **Opt-in, not default.** Trades explicit control for zero-config — exactly the tradeoff `pb init`'s auto-detect generator already exists to manage for repos with no Dockerfile at all. |
| **Dagger** | Mid-rewrite: replacing BuildKit's solver with a native engine and e-graph-based caching ("Project Theseus"), after over a year of lifting operations out of BuildKit through a transitional facade ([dagger.io/changelog](https://dagger.io/changelog/), [deepwiki.com/dagger/dagger](https://deepwiki.com/dagger/dagger/3-engine-and-execution)); `Container` is a first-class value passed through pipelines, not a registry string ([docs.dagger.io/getting-started/types/container](https://docs.dagger.io/getting-started/types/container/)); ships a native `LLM` primitive with tool-use over Dagger Functions, containerized and sandboxed ([dagger.io/blog/llm](https://dagger.io/blog/llm/), [docs.dagger.io/features/llm](https://docs.dagger.io/features/llm/)) | **Deferred past v1**, revisit P2+ (see 2.3). |

Skaffold — the closest existing "declared build+deploy+verify" tool and explicitly named in `PLAN.md`'s prior-art list for its `verify` heritage — still supports Kaniko and Buildpacks as builder types alongside a plain Docker CLI/BuildKit path, but its own docs flag Kaniko's maintenance status and steer users toward BuildKit ([skaffold.dev/docs/builders/builder-types/docker](https://skaffold.dev/docs/builders/builder-types/docker/), [codecentric.de kaniko-replacement roundup](https://www.codecentric.de/en/knowledge-hub/blog/7-ways-to-replace-kaniko-in-your-container-image-builds)) — independent confirmation that the field has already converged on BuildKit as default, buildpacks as alternate, kaniko as legacy.

### 2.2 Caching — the part that actually determines whether shape B is usable in an agent loop

An agent re-running `pb verify` in a loop (edit → verify → edit → verify) is exactly the repeated-build workload BuildKit's caching was built for:

- **Cache mounts** (`--mount=type=cache,target=/root/.npm`) persist a directory across builds at the *host* level, independent of layer caching — so even a `--no-cache` build still reuses `~/.npm`/`pip`/`apt`/Go-module caches ([oneuptime.com cache-mounts](https://oneuptime.com/blog/post/2026-01-16-docker-buildkit-cache-secrets/view), [stackharbor.com](https://stackharbor.com/en/knowledge-base/docker-buildkit-cache-mounts/)). This is the single highest-leverage caching primitive for the "agent iterates in a loop" scenario.
- **External cache export/import** (`--cache-to`/`--cache-from`) supports `registry`, `local`, `gha`, `s3`, `azblob` backends ([docs.docker.com/build/cache/backends](https://docs.docker.com/build/cache/backends/), [crazymax.dev/buildkit/usage/cache](https://crazymax.dev/buildkit/usage/cache/)) — the mechanism for CI/ephemeral-runner cache continuity where local disk doesn't persist between runs: `docker buildx build --cache-from type=registry,ref=<repo>:cache --cache-to type=registry,ref=<repo>:cache,mode=max`.
- **`docker buildx bake`** — declarative multi-target builds (HCL/JSON, or built directly from a compose file) with a **matrix** strategy to fan a single target into variants ([docs.docker.com/guides/bake](https://docs.docker.com/guides/bake/), [docs.docker.com/build/bake/matrices](https://docs.docker.com/build/bake/matrices/)). This is the mechanism for multi-service manifests (`workspace.yaml`'s org-level graph) — one `bake` invocation building every service a `ready.yaml` graph names, sharing the buildx builder/cache across all of them instead of N separate `docker build` invocations.

Dagger's counter-pitch is a *cache-key architecture* rather than a cache *backend* choice: an e-graph tracks operation equivalence so cache hits are computed structurally rather than by content-addressed layer digests alone ([dagger.io/changelog](https://dagger.io/changelog/)). This is a genuinely more powerful caching model — but it's still being built (see 2.3), so it's a reason to *watch* Dagger, not adopt it for v1.

### 2.3 Why Dagger specifically is deferred, not rejected

Dagger deserves a longer note because two things about it line up unusually well with proofbench's own thesis:

- Its `Container` type treats a container's *state* as a first-class pipeline value, not a registry reference ([docs.dagger.io/getting-started/types/container](https://docs.dagger.io/getting-started/types/container/)) — conceptually close to proofbench's own "evidence bundle inputs/outputs as typed, pinned values" framing.
- Its native `LLM` primitive runs an agent's tool calls inside the same containerized, sandboxed runtime it uses for builds, with full visibility into every tool call and resulting state change ([dagger.io/blog/llm](https://dagger.io/blog/llm/), [docs.dagger.io/cookbook/agents](https://docs.dagger.io/cookbook/agents/)) — exactly the "one exploratory computer-use round, then build durable automation" loop the founder scoped, if we ever want it engine-native instead of orchestrated by our own CLI.

But for a *v1 build agent* specifically:
1. **Engine churn.** Dagger is mid-way through replacing BuildKit's own solver with a native engine (`Project Theseus`) — betting v1's build path on an engine that's still being rebuilt underneath is the wrong order of operations ([dagger.io/changelog](https://dagger.io/changelog/)).
2. **Runtime dependency.** Embedding the Go SDK still means shipping/running the Dagger Engine as a separate containerized runtime alongside our own binary ([docs.dagger.io/getting-started/api/sdk](https://docs.dagger.io/getting-started/api/sdk/)) — directly against the "Go single static binary… zero runtime deps" choice in `PLAN.md` §6 that BuildKit-via-buildx (already a docker-CLI-plugin, no separate daemon to manage) doesn't violate.
3. **No unique capability we need *now*.** Everything shape B v1 needs (build from Dockerfile, cache, multi-target) is already solved by `buildx bake`. Dagger's edge (e-graph caching, LLM-native environments) is a P2+/P3 story once we're building the agent-surface layer (`PLAN.md` §7 P3) — that's the natural revisit point.

### 2.4 Isolation for the build step itself

A build-from-source step running *inside* an agent's own sandbox is a nested-virtualization problem: the sandbox needs to let its guest run `docker build` (or `buildx`) without that becoming a full container-escape surface.

- **Sysbox** — an OSS `runc`-compatible runtime giving containers user-namespace isolation plus virtualized `procfs`/`sysfs`, letting them run `systemd`, Docker, K8s, and **buildx** as workloads, "just like VMs" ([github.com/nestybox/sysbox](https://github.com/nestybox/sysbox)). Used by Daytona for its harder-isolation tier.
- **Kata Containers** — an OCI-compatible runtime that puts each container in its own microVM ([katacontainers.io](https://katacontainers.io/blog/kata-containers-agent-sandbox-integration/), [agent-sandbox.sigs.k8s.io](https://agent-sandbox.sigs.k8s.io/docs/use-cases/examples/kata-containers/)).
- **Docker Sandboxes (`sbx`)** — Docker's own coding-agent sandbox: each agent runs in a dedicated microVM with the project workspace mounted in, explicitly designed to let the agent "spin up their own Docker containers" inside without touching the host ([docker.com/products/docker-sandboxes](https://www.docker.com/products/docker-sandboxes/), [docker.com blog](https://www.docker.com/blog/docker-sandboxes-a-new-approach-for-coding-agent-safety/)). **Proprietary** — binary distribution only, `docker/sbx-releases` on GitHub is releases/issues, not source ([github.com/docker/sbx-releases](https://github.com/docker/sbx-releases)); outbound traffic is proxied and allow-list enforced via a host-side proxy at `gateway.docker.internal:3128`.
- The general 2026 pattern across all of these: **VM provides the isolation boundary, container provides the packaging/DX** — the agent/build tool sees a normal Docker socket; the security boundary is one layer down ([emirb.github.io microvm-2026](https://emirb.github.io/blog/microvm-2026/), [manveerc.substack.com](https://manveerc.substack.com/p/ai-agent-sandboxing-guide)).

**This is explicitly not ours to build** — `PLAN.md` §2 already rules out being a sandbox/runtime; we "run on" providers. The actionable conclusion for docker-mode: **declare nested-docker as a substrate capability requirement**, and add a preflight (same shape as `checkCompose()`) that checks for it explicitly rather than letting `docker buildx build` fail deep inside a build step with an opaque error. A sandbox that only offers gVisor-class syscall interception without nested-docker support (some serverless/E2B-style sandboxes cap this) simply cannot run docker-mode — that has to be a named, upfront `not-run` reason, not a confusing failure three steps in.

---

## Part 3 — proposed shape on `internal/substrate`

**No change to the frozen `Substrate` interface or `KindLocal`/`KindCompose`.** The additions are two new, orthogonal pieces that sit *before* `Up` is called:

```go
// internal/build (new package, not internal/substrate — orthogonal concern)
package build

// Builder produces (or resolves) the image references a manifest's compose
// source needs, before Up is called. Shape A (artifact.image already set)
// is the trivial Builder that just resolves a digest and checks required
// labels. Shape B invokes the configured build agent.
type Builder interface {
    // Build resolves every service's image reference, writing a compose
    // override file (image: <resolved-ref>) that Up's existing compose
    // invocation picks up unchanged — Up never needs to know which shape
    // produced the reference.
    Build(r *manifest.Ready) (map[string]string, error) // service -> resolved image ref (by digest)
}
```

Manifest additions (additive to `manifest.Ready`, not touching `Substrate`):

```yaml
artifact:                          # shape A — someone else built it
  image: ghcr.io/acme/orders-api
  require_labels: [source, revision]
  registry: { auth: env:GHCR_TOKEN }

build:                             # shape B — we build it
  agent: buildkit                  # buildkit (default) | buildpacks
  context: .
  dockerfile: Dockerfile
  cache: { to: "registry,ref=ghcr.io/acme/orders-api:cache,mode=max", from: "registry,ref=ghcr.io/acme/orders-api:cache" }
```

Orchestration order (`pb up`): resolve `Builder` (either shape) → write resolved image refs into a `docker-compose.override.yml` → hand off to the **existing, unmodified** `composeSubstrate.Up`. The compose substrate's `checkCompose()` preflight gains one more check for docker-mode specifically: nested-docker capability (per Part 2.4) and, when `build.agent: buildkit`, that `docker buildx version` succeeds — same typed-error-not-bare-exec-failure pattern already used for the daemon-reachability check.

This keeps `CONTRACTS.md`'s frozen surface exactly frozen and adds a single new package boundary (`internal/build`) that owns exactly one thing: producing an image reference `Up` can consume.

---

## ADR-ready recommendation

**Decision:** v1 docker-mode = the **existing `compose` substrate, unmodified**, preceded by a new `internal/build.Builder` step that resolves an image reference for both integration shapes. Shape A validates/pins a pre-built OCI image (digest pin + required `org.opencontainers.image.{source,revision}` annotations + one of three standard registry-auth mechanisms). Shape B builds via **BuildKit through `docker buildx bake`** (cache mounts for iterative agent loops, registry cache export for CI), with **Cloud Native Buildpacks as an opt-in path** for the zero-Dockerfile auto-detect generator. **Kaniko is excluded** (archived upstream). **Dagger is deferred** to P2+.

**Alternatives considered:**
1. **Dagger as the universal build+run engine** (replacing the compose substrate too). Rejected for v1 — its own engine is mid-rewrite (Project Theseus, replacing BuildKit's solver), it requires running a separate Engine daemon (against the "single static Go binary, zero runtime deps" implementation choice), and it offers no capability shape B v1 strictly needs. Its container-as-value model and native LLM primitive are a strong fit for P2/P3's agent-surface work — revisit then, not now.
2. **Kaniko** for unprivileged/K8s-native builds. Rejected — officially archived by Google Container Tools (Jan 2025); BuildKit's own rootless mode already covers the "no privileged daemon" need kaniko was chosen for historically, without adopting a tool in managed decline.
3. **Buildpacks as the default** builder. Rejected as default — loses the explicit, Dockerfile-first control our own dogfood repos already use and that "derive, don't restate" implies; kept as an **opt-in** for repos with no Dockerfile, generated by `pb init`'s auto-detect path, same "value on first run, no rewrite tax" logic already applied to manifest generation.
4. **A new `docker` `Substrate` kind, separate from `compose`.** Rejected — `docker compose` already natively resolves both `image:` (pull) and `build:` (BuildKit) service stanzas; a distinct kind would duplicate `Up`/`Ready`/`Down` logic that already exists and works, and would violate `CONTRACTS.md`'s frozen-interface intent for no functional gain.

**Consequences:**
- `Substrate` interface (`Up`/`Ready`/`Down`/`Seed`) stays frozen, unchanged, exactly as `CONTRACTS.md` requires; the new work lives in a new `internal/build` package plus additive `manifest.Ready` fields (`artifact`, `build`).
- Evidence bundle `pins.image` (already in the v2 schema) must be populated with the **resolved digest**, never the input tag, for both shapes — no schema change, just a population-time discipline.
- A reaper (testcontainers/Ryuk-style label-and-sweep, not a sidecar container in v1) must land alongside the compose substrate's `Down` to prevent orphaned resources from unattended/killed agent runs — this is a gap in the current `compose.go`, independent of docker-mode, that docker-mode makes newly load-bearing.
- Registry-auth and nested-docker-capability failures must surface as named `known_walls`-shaped errors (matching `PLAN.md` §4's trap+cause+recovery pattern), not bare exec failures three layers down.
- Sandboxes/providers lacking nested-docker support (gVisor-only isolation, some serverless sandbox tiers) cannot run docker-mode at all; this must be a declared substrate capability checked in preflight, not discovered mid-build.

**Open questions:**
- Exact minimum Docker Compose version for **general** provider-services support (the `model` sub-type's ≥2.38 requirement is documented; the general provider mechanism's floor wasn't pinned down by any source fetched) — verify against the actual compose binary version proofbench targets before relying on it.
- Whether `resources.*.via.provider` (Compose provider services as a third resource locator, alongside `compose`/`k8s`) belongs in v1's `ready.yaml` schema or should wait for P2's `k8s-attach` work, where the "third locator" pattern becomes load-bearing anyway. Leaning: **defer**, spec-sketch only.
- Whether the reaper should be a real Ryuk-style sidecar (survives `kill -9` of the `pb` process itself, at the cost of one more image dependency) versus the lighter label-sweep-on-next-invocation proposed above (survives graceful failure and CI-runner restarts, not a hard kill mid-run). Matters more once proofbench runs unattended on shared BYOC/CI infrastructure — worth revisiting before P2's BYOC exit criteria.
- Whether `build.agent` selection belongs as a repo-committed `ready.yaml` field at all, versus being purely inferred by `pb init`'s auto-detect (Dockerfile present → buildkit; no Dockerfile → buildpacks) — consistent with "derive, don't restate," the field may not need to exist except as an override escape hatch.
