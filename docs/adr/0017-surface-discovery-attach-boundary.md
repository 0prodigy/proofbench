# Surface discovery + attach boundary

`pb` auto-discovers Kubernetes-**object** surfaces (deploy-method-agnostic), but treats application **dependency edges** as declared-or-captured, never inferred; and attach runs as an **in-cluster ServiceAccount** (or on a scheduled re-auth) gated by an **authorization preflight**, not a liveness probe.

**Empirical evidence (kill-test E3, 2026-07-10, local kind):** k8s-object surfaces are generically auto-discoverable — workloads via `ownerReferences`, `Service → EndpointSlice` (including a canary's two Deployments behind one Service), `Ingress → Service → pods`, and headless services — independent of how they were deployed. Application dependency **edges** are not: `web → api` was only recoverable from a plain env var, `api → db` only via a Secret-read (needing RBAC) plus a host-parse heuristic, and code-level / IP / external edges were entirely invisible. On attach, a static short-lived token produced a **dead watcher** (the minimum viable token was 600s), and a **liveness** check passed while `get pods` returned 403 — liveness is the wrong health signal. A sharp trap surfaced: passing `--token` while a kubeconfig is present silently used the admin **client-cert** and masked the RBAC failure entirely.

**The decision:**

- **Auto-discover k8s-object surfaces.** Workloads, Services/EndpointSlices, Ingress paths, and headless services are discovered generically from the API, not from deploy-tool-specific config.
- **Dependency edges are declared or captured, never inferred.** Require a **declare-once dep-map** in the manifest, or derive edges from **traffic capture** (eBPF / service mesh / OTel). Heuristic edge-inference (env-scrape, Secret host-parse) is not trusted as truth because E3 showed it is both incomplete and RBAC-gated.
- **Attach = in-cluster SA + authz-preflight.** Attach runs on an auto-rotated in-cluster ServiceAccount, or re-authenticates on a schedule; a bare short-lived token is rejected as a dead-watcher hazard. Health is an **authorization preflight** (`kubectl auth can-i` against the exact verbs/resources the run needs), never `/livez`. The `--token`-with-kubeconfig masking trap is detected and refused rather than silently falling back to the client-cert.

This extends ADR-0011's runner-in-cluster pull model with the missing health semantics, and **reuses the `mic` resolve→switch→liveness spine**, adding the authz-preflight step that spine currently lacks.

## Considered Options

- **Infer dependency edges automatically from env/Secrets.** Rejected: E3 proved inference is incomplete (misses code/IP/external edges), is itself RBAC-gated (Secret reads), and would ship confident-but-wrong topology — a false-green shape.
- **Attach with a static short-lived token.** Rejected: the token expires mid-watch (600s floor observed) and leaves a dead watcher; in-cluster SA rotation or scheduled re-auth is the only durable form.
- **Use `/livez` (or SDK liveness) as attach health.** Rejected: liveness passed while `get pods` was 403 — it answers "is the API reachable" not "can I do the work," so the run would proceed blind. Authz-preflight is the correct gate.

## Consequences

- Discovery ships as the deploy-agnostic k8s-object walker; dependency topology becomes a manifest concern (dep-map) or a capture integration, sequenced after the honesty spine and provenance work in `docs/backlog.md`.
- The attach path gains an authz-preflight and an explicit refusal for the `--token`-with-kubeconfig masking case, closing a silent-admin-fallback hole in the current `mic` spine.
- Two-scope attach (cluster-read + registry-read) is shared with ADR-0016's provenance verification, so the in-cluster SA's Role must grant both.
- The single-pod-through-a-forward evidence-scope caveat (backlog #25) and re-attach-after-rollout (backlog #21) sit inside this boundary and are cross-referenced there, not re-decided here.
