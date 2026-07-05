# k8s-based testing mode, incl. BYOC — architecture research

Date: 2026-07-06. Feeds an ADR. Companion to `PLAN.md` §3.2 (substrate adapters), §4 (`ready.yaml`), §6 (architecture), §12 (prior art). Current code: `internal/substrate/types.go` defines `Substrate{Up,Ready,Seed,Down}` with only `local`/`compose` implemented; this doc scopes the third: `k8s-attach`.

## 0. Recommendation up front

**v1 k8s-mode = a 4th substrate, `k8s-attach`, defaulting to Shape A (org deploys, we attach+test), isolation = namespace + quotas (not kind/k3d, not vcluster), BYOC agent = outbound-only, namespaced-Role-only, evidence-out/kubeconfig-never-in.** Full ADR at §8. Everything below is the research that grounds it.

---

## 1. Two shapes, restated for k8s

From the task brief, unchanged from the docker-mode framing:

- **Shape A — they build+deploy, we test.** The org's own CI/CD or GitOps already puts a running workload in a cluster/namespace. Our agent is granted access to *that* namespace and drives/verifies/captures evidence. No build privilege, no deploy privilege needed.
- **Shape B — we build+deploy+test end-to-end.** Our agent needs to turn source into a running workload itself: build an image, apply manifests/Helm, then drive/verify.

The k8s question this doc answers is: **what does "attach" mean concretely (isolation substrate + RBAC posture), and how far into Shape B do we go in a customer's own cluster in v1.**

---

## 2. Isolation substrate: ephemeral cluster vs virtual cluster vs namespace+quotas

### 2.1 Ephemeral clusters — kind / k3d

kind runs upstream Kubernetes-in-Docker; k3d runs k3s-in-Docker. Both are disposable-by-design: "KIND clusters are disposable, fast, and completely ephemeral — perfect for testing"; kind is described as the CI standard while k3d is lighter for local dev but k3s's API diverges slightly from upstream K8s, which "occasionally cause[s] subtle test failures with upstream K8s configs" ([sanj.dev](https://sanj.dev/post/kind-vs-k3d-vs-k0s/), [ARMO](https://www.armosec.io/blog/best-local-kubernetes-tools/), [dev.to survey](https://dev.to/pendelabhargavasai/the-definitive-guide-to-lightweight-kubernetes-kind-minikube-microk8s-k3s-vcluster-k0s-and-3be1)).

The catch for **BYOC**: running kind/k3d *inside a customer's cluster* means cluster-in-a-cluster — Docker-in-Docker (or sysbox/kata as a safer DinD alternative) as a privileged-adjacent workload inside a cluster we don't own. That's the opposite of the least-privilege pitch this product is selling. It also duplicates a full control plane (etcd + API server) per run, which is slow and resource-heavy compared to reusing the host cluster's own control plane.

Where kind/k3d *is* the right tool: **our own compute** — CI for proofbench itself, the `remote` substrate's default when a BYOC cluster isn't in play, and public fixture-repo demos. Not as the default inside someone else's cluster.

### 2.2 Virtual clusters — vcluster (2026 state + licensing)

vcluster runs a **separate API server + control plane inside a namespace** of the host cluster and syncs resources down to real pods on real host nodes — "cheaper than creating separate full-blown clusters," "each tenant gets their own API server, their own set of CRDs, and their own admission configuration," while the CNI/CSI/host OS stay shared ([GitHub](https://github.com/loft-sh/vcluster), [CNCF blog, 2025-09](https://www.cncf.io/blog/2025/09/23/solving-kubernetes-multi-tenancy-challenges-with-vcluster/)). This is materially lighter-privilege than DinD: the vcluster syncer is "just" an operator that needs namespaced RBAC to create pods/services/etc in its own namespace — a normal "run a controller in a namespace" ask, not a privileged-pod ask.

**Licensing (verified directly from the repo and docs, no controversy found):**
- Core vcluster is **Apache-2.0**, confirmed at [github.com/loft-sh/vcluster/blob/main/LICENSE](https://github.com/loft-sh/vcluster/blob/main/LICENSE).
- vCluster **Free** tier sits between OSS and Enterprise — adds embedded etcd, Private Nodes, custom resource syncing, sleep-adjacent conveniences — but **requires connecting to the vCluster Platform for license validation** even though no credit card is needed ([OSS vs Free docs](https://www.vcluster.com/docs/vcluster/introduction/oss-vs-free)).
- Paid **Enterprise** tiers (Dev/Prod/Scale) add sleep mode, external DB backing, SSO, audit logging, FIPS, air-gap ([pricing](https://www.vcluster.com/pricing), [vCluster Pro launch](https://www.vcluster.com/blog/introducing-vcluster-pro)).
- Company rebranded Loft Labs → **vCluster Labs** in 2026, signaling this is now their whole business, not a side project ([rebrand post](https://www.vcluster.com/blog/loftlabs-is-now-vcluster-labs)).
- No relicensing scandal found (checked explicitly) — the OSS core has stayed Apache-2.0; the monetization lever is the *Platform* (phone-home license service) gating Free/Enterprise features, not a source-license change on OSS itself.

**Real limitations, not just marketing:** host cluster CNI/CSI/webhooks are still shared across virtual clusters unless explicitly reconfigured — "a misbehaving admission webhook affects every namespace" at the host level even though each vcluster gets isolated CRDs/RBAC; cluster-scoped CRD sync has known sharp edges (vcluster ships a dedicated fix, "a solution to the problem of cluster-wide CRDs") ([vcluster ClusterMAX criteria](https://www.vcluster.com/clustermax), [CRD blog](https://www.vcluster.com/blog/solution-clusterwide-crds), [multi-tenancy best-practices](https://www.vcluster.com/blog/best-practices-for-achieving-isolation-in-kubernetes-multi-tenant-environments)).

vcluster-per-PR is an established 2026 pattern specifically recommended when "changes touch operators, CRDs, or cluster config," with the tradeoff being "some control-plane overhead" ([Northflank 2026 preview-env comparison](https://northflank.com/blog/kubernetes-preview-environments-comparison), [vcluster's own CI/CD ephemeral-env post](https://www.vcluster.com/blog/ephemeral-kubernetes-environments-on-ci-cd-systems-with-vcluster)).

### 2.3 Namespaces + quotas

Plain namespace isolation, hardened with `ResourceQuota` (caps total namespace consumption) + `LimitRange` (caps a single pod so it can't eat the whole quota) + default-deny `NetworkPolicy` (blocks unauthorized cross-tenant traffic) + Pod Security Standards. This is explicitly framed as "soft multi-tenancy" vs. vcluster's "hard multi-tenancy," with the guidance to size quotas at 2–3× P95 consumption, not minimum usage ([namespace isolation best-practices 2026](https://dasroot.net/posts/2026/03/kubernetes-multi-tenancy-namespace-isolation-best-practices/), [Northflank multi-tenancy guide](https://northflank.com/blog/kubernetes-multi-tenancy)).

Weakness vs. vcluster: shared API server, shared CRDs/admission webhooks, no separate RBAC control plane — a bad webhook or a CRD-version collision on the host cluster can bleed into our namespace. Strength: **zero extra components**, works on literally any cluster the org already has, and matches what most BYOC orgs will actually be willing to grant on day one — a namespace, not a virtual-cluster-installing permission.

### 2.4 Comparison

| | Ephemeral cluster (kind/k3d) | Virtual cluster (vcluster) | Namespace + quotas |
|---|---|---|---|
| Privilege needed in customer cluster | High (DinD/privileged-adjacent) | Medium (namespaced operator) | Low (namespaced Role only) |
| Extra components to install | None (self-contained, but *is* the extra thing) | vcluster syncer + its own control plane | None |
| Isolation strength | Full (new cluster) | Strong (own API server/CRDs/RBAC) | Weak-medium (shared control plane) |
| Good for CRD/operator-under-test | Yes | Yes | No |
| Cost/speed per run | Slow, heavy (new etcd+apiserver) | Medium | Fast, cheap |
| Licensing risk | None (OSS) | None for core; Free/Enterprise phone home | None |
| Fit for BYOC v1 default | Poor (privilege ask too big) | Good v1.1 upgrade path | **Best v1 default** |
| Fit for our own compute (`remote` substrate) | **Good** | Good | Fine |

---

## 3. Runner-in-cluster patterns for BYOC (RBAC posture, "evidence out, no kubeconfig in")

Five prior-art architectures converge on the *same* pattern, which validates the PLAN's design intent directly:

- **GitLab Runner, Kubernetes executor** — a persistent Manager pod watches for jobs and creates per-job Worker pods; the recommended RBAC is a namespaced `Role` with exactly `create/get/list/watch/delete` on pods, `pods/attach` + `pods/exec` for interaction, `pods/log` for output, and `create/delete/get/update` on secrets *it creates itself* — nothing broader. Node-selector labels further shrink blast radius. Kaniko is even name-checked in GitLab's own docs as the way to build images "without privileged access" ([GitLab Runner k8s executor docs](https://docs.gitlab.com/runner/executors/kubernetes/), [walkthrough](https://oneuptime.com/blog/post/2026-01-27-gitlab-ci-runners-kubernetes/view)).
- **GitLab Agent for Kubernetes (agentk/KAS)** — the cluster-side `agentk` opens a **bidirectional gRPC tunnel it initiates outbound** to GitLab's KAS; this "eliminates the need to store raw Kubeconfig credentials in CI/CD variables" and removes any requirement to punch inbound firewall holes ([architecture doc](https://gitlab.com/gitlab-org/cluster-integration/gitlab-agent/-/blob/master/doc/architecture.md), [getting started](https://docs.gitlab.com/user/clusters/agent/)). This is the single strongest piece of prior art for "kubeconfig never leaves the cluster."
- **Argo CD Agent** — hub-and-spoke; "the agent runs inside each managed cluster and establishes a secure outbound connection back to the ArgoCD control plane," secured with mTLS between principal (hub) and spoke agents; explicitly pitched as air-gap-ready because of the pull direction ([argocd-agent repo](https://github.com/argoproj-labs/argocd-agent), [Red Hat architecture overview](https://docs.redhat.com/en/documentation/red_hat_openshift_gitops/1.19/html/argo_cd_agent_architecture/argocd-agent-architecture)).
- **Buildkite Agent Stack for Kubernetes** — a controller watches Buildkite's Agent **REST API** (single, tightly-scoped agent token) and creates Jobs/Pods locally; marketing line doubles as a security claim: "Buildkite never needs access to your source code, secrets, or internal systems" ([Agent Stack overview](https://buildkite.com/docs/agent/self-hosted/agent-stack-k8s), [securing the stack](https://buildkite.com/docs/agent/self-hosted/agent-stack-k8s/securing-the-stack), [scale post](https://buildkite.com/resources/blog/kubernetes-with-buildkite-faster-simpler-and-ready-for-scale/)).
- **GitHub Actions Runner Controller (ARC)** — ships with least-privilege RBAC by default, and the strongest recommended hardening is `watchSingleNamespace` to stop the controller watching cluster-wide, plus namespace isolation as "a native isolation boundary you control" when running multiple runner scale-sets ([ARC repo](https://github.com/actions/actions-runner-controller), [securing ARC](https://some-natalie.dev/blog/securing-ghactions-with-arc/), [StepSecurity series](https://www.stepsecurity.io/blog/github-actions-runner-controller-blog-series)).

**Synthesis — the pattern to copy:** an agent Deployment lives inside the target namespace, uses a namespaced `ServiceAccount` + `Role` (never `ClusterRole`), and **dials out** to a control plane rather than accepting inbound connections; the org never hands over a kubeconfig, and the control plane never needs kube-API network reachability into the customer's cluster at all — only the bundle needs to leave.

**Kubernetes-native primitive that hardens this further — bound service account tokens.** Since 1.22, `TokenRequest`-issued tokens are **time-bound, audience-bound, and object-bound** (tied to the pod's lifetime); recommendation is to use audience-scoped tokens and `automountServiceAccountToken: false` everywhere except the one pod that needs API access, "ensur[ing] the service account permissions follow the principle of least privilege" ([k8s docs](https://kubernetes.io/docs/concepts/security/service-accounts/), [KEP-1205](https://github.com/kubernetes/enhancements/blob/master/keps/sig-auth/1205-bound-service-account-tokens/README.md), [Datadog Security Labs on TokenRequest attack surface](https://securitylabs.datadoghq.com/articles/kubernetes-tokenrequest-api/)).

### 3.1 Our BYOC RBAC posture (recommendation)

- Agent ships as an **org-applied** Helm chart/manifest (they read it, they `helm install` it — trust via transparency, not a `curl | bash`).
- `ServiceAccount` + namespaced `Role`, scoped to exactly the namespace(s) named in `workspace.yaml`'s context. Verbs: `get/list/watch` pods+services, `pods/log`, `pods/exec` (for drive verbs and exec-style readiness probes), `create/delete` only on resources the agent itself labels `proofbench.dev/managed=true`. No `secrets:get` on secrets it didn't create. No `ClusterRole`, ever, in v1.
- **Outbound-only.** Agent dials our control plane (hosted mode) or nothing (pure self-hosted OSS: evidence is written locally / to a bucket the org owns and published via their own PR/Jira integration). No inbound port, no ingress, no exposed service.
- Bound, audience-scoped SA tokens (`TokenRequest` API) for any in-cluster calls the agent makes on the org's behalf — never a long-lived static token, and never the org's kubeconfig.
- Default-deny egress `NetworkPolicy` on the agent's own pod, opened only to: the k8s API server, the evidence sink the org configures, and (if hosted mode) our control plane endpoint. This closes "agent becomes an exfil path" as a risk class.
- **Teardown discipline:** the agent only ever deletes what it created and labeled itself (Shape A: nothing the org owns is ever touched by `Down`).

This is the concrete shape of PLAN's "evidence out, no kubeconfig in" line — every piece above is independently attested by a different vendor's own security documentation, not invented for this doc.

---

## 4. Build + deploy in-cluster

### 4.1 Image build

**Kaniko is dead.** Google archived it (reporting puts this ~Jan–Jun 2025) and GitLab has announced a full migration off it; a live CNCF project (Strimzi) has an open proposal titled "use Buildah instead of Kaniko" citing exactly this ([BuildKit-replaces-Kaniko writeup](https://www.nabilnoh.com/posts/buildkit-kaniko-replacement/), [Strimzi proposal](https://github.com/strimzi/proposals/blob/main/114-use-buildah-instead-of-kaniko.md), [Buildah vs Kaniko 2026](https://lucaberton.com/blog/buildah-vs-kaniko-2026/)). Do not build proofbench's in-cluster build story on Kaniko even though it's the tool most existing BYOC docs still reference.

Successors:
- **BuildKit (rootless)** — the Docker/Buildx default since Engine 23.0+, "up to 3× faster," better caching, better multi-arch. Rootless mode avoids `privileged: true` but still needs either a compatible seccomp profile or kernel user-namespace support to be *fully* rootless-rootless; CERN's own 2025 writeup on rootless container builds on k8s is the sharpest treatment of the remaining sharp edges ([CERN blog](https://kubernetes.web.cern.ch/blog/2025/06/19/rootless-container-builds-on-kubernetes/), [migration writeup](https://hervekhg.medium.com/migrating-from-kaniko-to-buildkit-for-docker-builds-on-kubernetes-eks-1-33-4af5aee4b447)).
- **Buildah** — more flexible/scriptable, "well-supported, widely used" as the direct Kaniko replacement where teams want more than pure-Dockerfile builds ([Buildah vs Kaniko 2026](https://lucaberton.com/blog/buildah-vs-kaniko-2026/)).
- Language-native no-Dockerfile builders (`ko` for Go, Jib for Java, Cloud Native Buildpacks generally) are viable narrower alternatives, cited alongside BuildKit/Buildah as the "7 ways to replace Kaniko" ([codecentric roundup](https://www.codecentric.de/en/knowledge-hub/blog/7-ways-to-replace-kaniko-in-your-container-image-builds)).

**Recommendation:** if/when proofbench builds images in-cluster, use **BuildKit rootless**, not Kaniko — but see §4.2, the sharper call is to avoid needing this at all in v1 BYOC.

### 4.2 Deploy — push vs. pull, and why it matters more than the build tool

Flux and Argo CD are both fundamentally pull-based: "an agent inside the cluster watch[es] Git, fetch[es] changes, and appl[ies] them — credentials never leave the cluster boundary" ([oneuptime Flux-vs-Argo](https://oneuptime.com/blog/post/2026-03-13-flux-cd-vs-argocd-helm-support/view), [helm-operator-vs-flux-vs-argo](https://www.golinuxcloud.com/helm-operator-vs-flux-vs-argo/)). The architectural difference that matters for us isn't Flux-vs-Argo, it's **pull-model-vs-push-model as a security boundary**, same lesson as §3.

**Recommendation:** for Shape B inside a BYOC cluster, prefer **"we render, their GitOps applies"** — deposit rendered manifests/Helm values where the org's own Flux `Kustomization`/`HelmRelease` or Argo CD `Application` already watches, rather than our agent running `helm upgrade --install`/`kubectl apply` directly. This means we inherit the org's *existing* deploy security boundary instead of becoming a second, independent deployer with write-everything privilege. Where an org runs no GitOps at all, our agent may apply directly — but scoped to the same `Role`-restricted, `proofbench.dev/managed=true`-labeled resources as §3, nothing broader.

---

## 5. Preview-env orchestration

2026 landscape converges on four shapes, and none of them owns a repo-resident cross-service manifest — which is exactly proofbench's differentiation, not a gap to close by building a fifth orchestrator:

- **Full-clone-per-PR** (Okteto-style): a full namespace/stack copy per PR — simplest mental model, cost scales linearly with service count.
- **Virtual-cluster-per-PR** (vcluster): strongest isolation, "ideal when changes touch operators, CRDs, or cluster config," some control-plane overhead.
- **Request-level delta** (Signadot): only changed services deployed, unchanged services served from the shared baseline — cheapest per-preview, highest engineering complexity to build yourself.
- **Native GitOps trigger** (Argo CD `ApplicationSet` `PullRequest` generator): the controller detects the PR and deploys into a new namespace automatically — no separate product needed if the org already runs Argo CD.

(Sources: [Northflank 2026 comparison](https://northflank.com/blog/kubernetes-preview-environments-comparison), [Signadot preview-envs guide](https://www.signadot.com/articles/comprehensive-guide-to-preview-environments/), [Bunnyshell preview envs](https://www.bunnyshell.com/kubernetes-preview-environments/), industry-survey claim that "67% of enterprise organizations plan to invest in Ephemeral Environments... during 2026" per the same Northflank piece.)

**Recommendation:** don't build a 5th preview-env product. When the org already runs GitOps, **emit** an `ApplicationSet`/`Kustomization` from our `workspace.yaml` graph (their controller does the rest — consistent with §4.2). When they don't, fall back to plain namespace-per-run applied by our own scoped agent. Reserve vcluster-per-run specifically for the CRD/cluster-scoped case flagged in §2 — one extra technology serving two jobs (isolation *and* preview-env duty) beats bolting on a fourth tool.

---

## 6. mirrord / Signadot — delta-testing as a later mode

Both let you test against a **live** cluster's real dependencies without deploying a full copy — the PLAN already names this as a P2+ "later mode," and the research confirms that's the right sequencing, not premature deferral:

- **mirrord** (MetalBear) — syscall interception makes a local/CI process behave as if it were a pod in the cluster; default mode *mirrors* (duplicates) traffic rather than intercepting, which is safer against a shared environment. Core CLI is **MIT-licensed and free**; a "mirrord for CI" mode explicitly targets running integration/e2e tests against a shared cluster without a dedicated env; MetalBear has *already* productized "mirrord for AI agents" (Claude Code, Cursor, Codex CLI, Gemini CLI) — a direct competitive signal worth tracking ([GitHub](https://github.com/metalbear-co/mirrord), [AI agents page](https://metalbear.com/mirrord/ai-agents/), [FAQ/pricing](https://metalbear.com/mirrord/docs/faq/general), [The New Stack coverage](https://thenewstack.io/metalbears-mirrord-gives-ai-agents-a-staging-environment-to-test-their-code/)). Paid tier ($40/seat/mo) adds the Operator for concurrent multi-user use, queue-splitting, DB branching, RBAC.
- **Signadot** — commercial-only (no OSS core found); request-level routing via its own "devmesh" or a service mesh (Istio/Linkerd); "Sandboxes" are a lightweight delta, not a full clone; also explicitly positions as "Fast Ephemeral Environments for Coding Agents" — same competitive signal as mirrord ([pricing](https://www.signadot.com/pricing/), [mirrord comparison](https://www.signadot.com/comparison/mirrord/), [sandboxes-at-scale](https://www.signadot.com/blog/creating-sandboxes-in-kubernetes-at-scale/)).

**Recommendation:** mirrord's OSS CLI is the natural first integration — pure "Allies, not clones" per PLAN §8 — as an *alternate substrate for the drive/verify phase only* (run our checks as a mirrord-connected process against live deps) rather than reimplementing traffic-borrowing. Signadot, being closed and control-plane-centric, is an interop/evidence-emit target at most, not a dependency — building on it would relitigate PLAN §2's "not a remote-runner control plane" non-goal by proxy.

---

## 7. Mapping onto the substrate interface

Current interface (frozen per `CONTRACTS.md`, and correctly so — it doesn't need to change):

```go
// internal/substrate/types.go
type Substrate interface {
    Up(r *manifest.Ready) error
    Ready(r *manifest.Ready) error
    Seed(r *manifest.Ready) error
    Down(r *manifest.Ready) error
}
```

Add a third kind, `KindK8sAttach = "k8s-attach"`, implemented in a new `internal/substrate/k8sattach.go` (same file-per-kind layout as `local.go`/`compose.go`), no interface change required:

- **`Up`** — Shape A: no-op / assert-only — resolve each `Resource.Via["k8s"]` locator (already sketched in PLAN §4, e.g. `via: { k8s: svc/orders-db }`) to a live Service/Pod and fail fast if absent; never create anything the org didn't already deploy. Shape B: render manifests from a new `run.k8s` block (sibling to the existing `LocalRun`) and either apply them via the agent's own scoped `Role` (no-GitOps case) or write them to the path the org's Flux/Argo watches (GitOps handoff, §4.2).
- **`Ready`** — reuse `manifest.Probe` (HTTP/TCP/Exec) unchanged — it's already modeled on "k8s probe vocabulary" per PLAN §4's own comment — just execute the Exec case as an in-cluster `pods/exec` call instead of a local subprocess.
- **`Seed`** — same `SeedStep` list, each step becomes a short-lived Job (the GitLab-Runner manager/worker-pod pattern from §3), agent watches to completion and streams logs into the evidence bundle.
- **`Down`** — Shape A: no-op except for anything labeled `proofbench.dev/managed=true`; Shape B ephemeral: delete the namespace (or vcluster, if that isolation tier was chosen).

Manifest-schema deltas needed (small, additive, doesn't touch frozen `types.go` shapes beyond new optional fields):
1. `RunSpec.K8s` block mirroring `LocalRun` (chart/manifest ref, target namespace/context, apply-mode: `direct|gitops-handoff`).
2. An `isolation:` selector (`namespace|vcluster`) — `namespace` default per §8.
3. `Workspace.Contexts` (already a `map[string]string` today) grows into a small struct: cluster ref + `mode: attach|vcluster` + the Role/ServiceAccount name the org has bound for us.

None of this requires touching the `Substrate` interface itself or `cmd/pb/main.go` — confirms the interface was already scoped with this substrate in mind (PLAN names `k8s-attach` explicitly in §3.2 and §6's architecture diagram).

---

## 8. ADR — v1 k8s-mode architecture + BYOC security posture

**Status:** proposed, ready for founder sign-off.

**Decision.** Ship k8s-mode as a 4th `Substrate` implementation, `k8s-attach`, same frozen `Substrate` interface (§7). Default behavior is **Shape A** (org's own CI/CD or GitOps deploys; our agent attaches to a namespace they grant and drives/verifies/captures evidence — no build, no deploy privilege). Isolation substrate default is **namespace + `ResourceQuota`/`LimitRange` + default-deny `NetworkPolicy`** (§2.4) — not kind/k3d-in-cluster, not vcluster, for v1. BYOC agent posture (§3): org-applied Helm chart, namespaced `ServiceAccount`+`Role` only (never `ClusterRole`), **outbound-only** connection, bound/audience-scoped SA tokens, default-deny egress, teardown restricted to `proofbench.dev/managed=true`-labeled resources — i.e. **evidence out, kubeconfig never in**. **Shape B ships v1 against our own compute** (kind/k3d as the `remote`/CI-fixture substrate), *not* yet inside customer BYOC clusters; extending Shape B into BYOC is deferred (§8, consequences) until BuildKit-rootless in-cluster build (§4.1) and GitOps-handoff apply (§4.2) are proven. vcluster is the named **v1.1 upgrade path** for isolation, opt-in per org/feature (CRD/operator-under-test, or many concurrent preview envs) — pure OSS core only, no Platform phone-home dependency baked into the critical path. mirrord's OSS CLI is the first delta-testing integration (P2+, per PLAN); Signadot is interop-only.

**Alternatives considered:**
1. **kind/k3d-in-cluster as the default BYOC isolation.** Rejected — requires a privileged-adjacent DinD workload inside a cluster we don't own, directly contradicting the least-privilege BYOC pitch, and duplicates a full control plane (etcd+API server) per run for no isolation benefit over vcluster.
2. **vcluster-by-default for all BYOC attach.** Rejected for v1 — a real extra moving part (syncer, its own control-plane storage, Free-tier Platform license check) to require on day one when the more common ask is "just give me a namespace." Promote to default only once real usage shows the CRD/operator case is common, not speculatively.
3. **Shape B (we build+deploy) as the BYOC default from day one.** Rejected for v1 — asks a brand-new OSS tool for image-build *and* apply privilege inside a production-adjacent cluster before the RBAC/evidence story has any field mileage. Trust is sequenced: prove "attach and produce honest evidence" first, earn "build and deploy for you" second.

**Consequences.** v1 ships fast — namespace+quota needs zero new infra beyond what every k8s cluster already has, and the BYOC RBAC story ("we need almost no privilege in your cluster") is credible and demoable immediately, which is the whole competitive point vs. Devin/Cursor (Cursor's cloud agents explicitly have **no BYOC option at all**, per [Qovery's enterprise-limitations analysis](https://www.qovery.com/blog/cursor-cloud-agents-enterprise-limitations) and [Cursor's own self-hosted-agents post](https://cursor.com/blog/self-hosted-cloud-agents) — this is real whitespace). Cost of deferral: the more ambitious long-term story (we build+deploy+test *inside your production-adjacent cluster*) is not in v1 and must be messaged as "coming," not implied as already-shipped.

**Open questions (explicitly delegated, not resolved here):**
- Standing Deployment agent (always-on, like agentk/ArgoCD-agent) vs. per-run ephemeral Job triggered by the org's own CI (lower standing privilege/footprint, but re-pays cold start every run)?
- Do we need our own KAS/Buildkite-API-style relay for hosted mode in v1, or is "agent writes evidence locally, org's own CI/script pushes the bundle to us" sufficient for OSS launch (no always-on relay to operate)?
- `ready.yaml`/`workspace.yaml` schema deltas from §7 (`run.k8s`, `isolation:`, richer `contexts`) — land now while `internal/manifest/types.go` is still young, or hold for the P2 milestone as scoped in `PLAN.md`?
- Default-deny `NetworkPolicy` needs a CNI that actually enforces it — not guaranteed on every BYOC cluster (e.g. some default cloud-VPC-CNI configs are permissive). Detect-and-warn, or hard-require a compatible CNI as a stated prerequisite?
- Is "OSS vcluster only, no Platform dependency" a permanent constraint for us, or just a v1 one — some Free-tier vcluster features (embedded etcd, sleep mode) are genuinely useful cost levers later?

---

## Appendix — sources by topic

- vcluster: [pricing](https://www.vcluster.com/pricing) · [GitHub](https://github.com/loft-sh/vcluster) · [LICENSE](https://github.com/loft-sh/vcluster/blob/main/LICENSE) · [OSS vs Free](https://www.vcluster.com/docs/vcluster/introduction/oss-vs-free) · [Pro launch](https://www.vcluster.com/blog/introducing-vcluster-pro) · [rebrand](https://www.vcluster.com/blog/loftlabs-is-now-vcluster-labs) · [CNCF blog](https://www.cncf.io/blog/2025/09/23/solving-kubernetes-multi-tenancy-challenges-with-vcluster/) · [ClusterMAX criteria](https://www.vcluster.com/clustermax) · [cluster-wide CRDs fix](https://www.vcluster.com/blog/solution-clusterwide-crds) · [isolation best practices](https://www.vcluster.com/blog/best-practices-for-achieving-isolation-in-kubernetes-multi-tenant-environments) · [ephemeral CI/CD envs](https://www.vcluster.com/blog/ephemeral-kubernetes-environments-on-ci-cd-systems-with-vcluster)
- kind/k3d: [sanj.dev comparison](https://sanj.dev/post/kind-vs-k3d-vs-k0s/) · [ARMO](https://www.armosec.io/blog/best-local-kubernetes-tools/) · [lightweight-k8s survey](https://dev.to/pendelabhargavasai/the-definitive-guide-to-lightweight-kubernetes-kind-minikube-microk8s-k3s-vcluster-k0s-and-3be1)
- Runner-in-cluster patterns: [GitLab Runner k8s executor](https://docs.gitlab.com/runner/executors/kubernetes/) · [GitLab agentk architecture](https://gitlab.com/gitlab-org/cluster-integration/gitlab-agent/-/blob/master/doc/architecture.md) · [GitLab agent getting started](https://docs.gitlab.com/user/clusters/agent/) · [Argo CD Agent](https://github.com/argoproj-labs/argocd-agent) · [Argo CD Agent arch (Red Hat)](https://docs.redhat.com/en/documentation/red_hat_openshift_gitops/1.19/html/argo_cd_agent_architecture/argocd-agent-architecture) · [Buildkite Agent Stack for k8s](https://buildkite.com/docs/agent/self-hosted/agent-stack-k8s) · [securing the stack](https://buildkite.com/docs/agent/self-hosted/agent-stack-k8s/securing-the-stack) · [Buildkite k8s scale post](https://buildkite.com/resources/blog/kubernetes-with-buildkite-faster-simpler-and-ready-for-scale/) · [GitHub ARC](https://github.com/actions/actions-runner-controller) · [securing ARC](https://some-natalie.dev/blog/securing-ghactions-with-arc/) · [StepSecurity ARC series](https://www.stepsecurity.io/blog/github-actions-runner-controller-blog-series)
- Bound SA tokens: [k8s service accounts docs](https://kubernetes.io/docs/concepts/security/service-accounts/) · [KEP-1205](https://github.com/kubernetes/enhancements/blob/master/keps/sig-auth/1205-bound-service-account-tokens/README.md) · [Datadog TokenRequest security](https://securitylabs.datadoghq.com/articles/kubernetes-tokenrequest-api/)
- In-cluster build: [Kaniko-to-BuildKit](https://www.nabilnoh.com/posts/buildkit-kaniko-replacement/) · [Strimzi Buildah proposal](https://github.com/strimzi/proposals/blob/main/114-use-buildah-instead-of-kaniko.md) · [Buildah vs Kaniko 2026](https://lucaberton.com/blog/buildah-vs-kaniko-2026/) · [migration writeup](https://hervekhg.medium.com/migrating-from-kaniko-to-buildkit-for-docker-builds-on-kubernetes-eks-1-33-4af5aee4b447) · [CERN rootless builds](https://kubernetes.web.cern.ch/blog/2025/06/19/rootless-container-builds-on-kubernetes/) · [7 ways to replace Kaniko](https://www.codecentric.de/en/knowledge-hub/blog/7-ways-to-replace-kaniko-in-your-container-image-builds)
- Deploy pull-vs-push: [Flux vs Argo helm support](https://oneuptime.com/blog/post/2026-03-13-flux-cd-vs-argocd-helm-support/view) · [helm-operator vs Flux vs Argo](https://www.golinuxcloud.com/helm-operator-vs-flux-vs-argo/)
- Multi-tenancy quotas: [namespace isolation best practices 2026](https://dasroot.net/posts/2026/03/kubernetes-multi-tenancy-namespace-isolation-best-practices/) · [Northflank multi-tenancy guide](https://northflank.com/blog/kubernetes-multi-tenancy)
- Preview environments: [Northflank 2026 comparison](https://northflank.com/blog/kubernetes-preview-environments-comparison) · [Signadot preview-envs guide](https://www.signadot.com/articles/comprehensive-guide-to-preview-environments/) · [Bunnyshell preview envs](https://www.bunnyshell.com/kubernetes-preview-environments/)
- Delta-testing: [mirrord GitHub](https://github.com/metalbear-co/mirrord) · [mirrord for AI agents](https://metalbear.com/mirrord/ai-agents/) · [mirrord FAQ/pricing](https://metalbear.com/mirrord/docs/faq/general) · [The New Stack on mirrord+agents](https://thenewstack.io/metalbears-mirrord-gives-ai-agents-a-staging-environment-to-test-their-code/) · [Signadot pricing](https://www.signadot.com/pricing/) · [Signadot vs mirrord](https://www.signadot.com/comparison/mirrord/) · [Signadot sandboxes at scale](https://www.signadot.com/blog/creating-sandboxes-in-kubernetes-at-scale/)
- Competitive BYOC signal: [Cursor cloud agents enterprise limitations (no BYOC)](https://www.qovery.com/blog/cursor-cloud-agents-enterprise-limitations) · [Cursor self-hosted cloud agents](https://cursor.com/blog/self-hosted-cloud-agents)
- Ephemeral-cluster economics: [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing) · [EKS pricing guide](https://www.cloudzero.com/blog/eks-pricing/)
