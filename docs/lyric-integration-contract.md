# pb × Lyric integration contract — DRAFT (2026-07-21, from live recon of infra-config, mic, decision-engine)

**Delivery model (founder-set):** pb ships a control surface; the Lyric team integrates
ONCE against it; thereafter every PR/ticket is verified on autopilot. First substrate =
a **dedicated BYOC lyriclet** driven through the decision-engine (DE) REST API — chosen
because whole-infra deployment control gives pb the properties its honesty model needs
on real infra: fresh worlds, code-identity pinning, out-of-band reads, teardown/recreate.

Recon ground truth: DE is a thin control plane proxying the Deployment Controller (DC);
all lyriclet lifecycle ops (`/api/v1/provisioning/*`: create/destroy/stop/start/retry/
schedule/kubeconfig), single-service pin+deploy (`POST /clusters/:id/deploy-service`,
always force-rollout), runtime state (`GET /clusters/:id/services`), and a read-only
desired-vs-live diff (`POST /releases/:id/compute-diff`) are ALL headless over HTTP
(HMAC orchestrator token or 15-min gh-exchange DE-JWT). mic contributes kubeconfig/
context handling only — no token mint, no port-forward/exec CLI verbs; pb calls kubectl
directly with the DE-issued kubeconfig (as ready.yaml and lyric-mongo.sh already do).

## 1. What pb ships (the control surface — maps onto ROADMAP R3, reshaped)

- `conjure.mode:"lyriclet"` — DE-driven: wake-or-create the pb lyriclet → `deploy-service`
  at the infra-config `config_ref` whose compiled values carry the exact image tag +
  dev-wheel pins → poll provisioning/services until ready → `post-setup/trigger` seed.
  (Reshapes R3's `k8s-attach`: pb OWNS the world instead of attaching to a shared one;
  attach-to-shared becomes a later variant.)
- **Code identity:** DE is tag-level only (git ref → tag; no digest anywhere in DE —
  grep-confirmed). pb binds identity by (a) unique-tag discipline (existing
  `git_tag_overwrite` dev-build convention) and (b) reading the running pod `imageID`
  digest out-of-band via kubeconfig at DRIVE time and sealing THAT. Multi-repo rollup
  per the ENG-17397 draft (repos[]+wheels[]+images[]).
- **Store tap `engine:"mongo"`:** `kubectl exec mongodb-0 -c mongod -- mongosh` (the
  proven lyric-mongo.sh shape, 3-secret credential fallback) over the DE kubeconfig —
  harness provenance, never through the app.
- **Fresh world, two grains:**
  - whole-lyriclet recreate (strongest; provision is async + minutes-to-tens-of-minutes,
    measure empirically) — reserved for catches/nightly;
  - long-lived pb lyriclet + app-level fresh unit (new scenario/note per iteration) +
    `deploy-service` force-rollout — the daily grain. DE has no sub-cluster fresh-world
    primitive; the app-level unit is pb-recipe/lyric-qa layered.
- **Base-coherence preflight + drift sentinel (F2/F3 defense):** assert
  `compute-diff → SYNCED` and chart-version coherence (`/charts/resolve`,
  `clusters/:id/services.chart_version`) BEFORE the verdict window, re-check AFTER —
  any un-caused `SyncStatus` flip voids the verdict (CND naming the drift). Also
  `DELETE /provisioning/:id/schedule` so auto-hibernation can't stop the world mid-run.
- **Recipe-schema extensions** implied by ready.yaml but missing from R3's bullet list:
  operator-env setup object (G5), REST front door (G6), note-lifecycle drive sub-fields
  (G7) — add to R3 at kickoff.
- **Verdict output:** frozen exit codes 0/1/2/3 + the signed verdict document (R2
  `--json`) consumed as a GitHub required status check. pb never deploys.

## 2. The one-time Lyric-team integration (checklist)

1. Provision a dedicated pb lyriclet: distinct `customer`/`cluster_id` enabled for ZERO
   fleet services (so `*`/`notprod` scheduled releases can never land on it), no
   hibernation schedule during runs, TTL policy as cost backstop.
2. Issue pb its credential (founder decision #4 below) + the lyriclet kubeconfig, with
   RBAC for: port-forward svc/appservice + datastores, exec pod/mongodb-0, pod read for
   digest (`jsonpath .status.containerStatuses[].imageID`).
3. State (and if needed disable) the reconcile posture on that lyriclet — is ArgoCD
   auto-sync/self-heal ON? Lives DC/agent-side; DE cannot answer it. pb needs the
   guarantee "this world does not change unless pb changes it," or at minimum the diff
   sentinel treats any flip as verdict-voiding.
4. Answer drive auth (A5): do `POST /executions` / `PATCH …/stages` need a bearer/`From`
   on this cluster? If yes, hand pb a headless mint path (neither mic nor de-api.sh has
   one today).
5. Author the first recipe: translate the existing ENG-17397 `ready.yaml` via the
   committed draft (`docs/lyric-eng17397-recipe-draft.md`) + a standing proof
   scenario/sequence/note with a ≥3-stage action.
6. Wire CI: one pb job at the chosen trigger point (service-repo PR check | image-
   promotion between docker_publish and deployment.yml | infra-config tag-move gate)
   + a required status check with branch protection.

## 3. Autopilot (steady state)

Per-PR: merge-leg only (`--merge-only`, R2), explicitly labeled non-differential, inside
the review-attention window. Nightly/catch: full differential on the pool. Consumption:
WORKS → tag/release eligible to promote (human/policy ratifies); DNW → block + repro
bundle; CND → block + the named unblocking action. Ordering: R-gates hold — no R3
surface ships before G1 closes; the first live lyriclet verdict closes G3.

## 4. Founder / Lyric-team decisions (consolidated, deduped)

1. **Reconcile posture** on the pb lyriclet (ArgoCD self-heal on/off) — top honesty risk.
2. **Fresh-world grain + wall-clock budget** for k≥2 (whole-lyriclet vs app-level reset).
3. **Identity bar:** tag-level acceptable or digest required (recommend: unique-tag
   discipline + drive-time digest seal — costs nothing extra).
4. **pb credential:** HMAC orchestrator token (headless, effectively NON-EXPIRING,
   fleet-wide-powerful — validate-token never checks timestamp age) vs 15-min DE-JWT
   (one-time browser link + refresh). Recommend asking DE team for a scoped pb principal
   rather than the raw orchestrator secret.
5. **Drive-endpoint auth path (A5)** — top technical unknown.
6. **Gate location** in the pipeline + who owns the required check.
7. **Ratify the two defaulted decisions:** D1 new-note-per-iteration reproduce model;
   D2 drive surface = appservice REST + mongo tap (ui end-user leg deferred).
8. **RBAC posture** for the mongo exec tap (standing exec vs read-only DB user).
9. **Cost guardrails:** short `ttl_hours` on create + DC TTL-reap as leak backstop.

## 5. Nice-to-have DE additions (Lyric-team backlog, pb works around all of them today)

digest field on cluster-services · readable "reconcile on/off" flag · sub-cluster
fresh-world primitive (ephemeral tenant/namespace reset) · provision-ready webhook
(today pb polls `progress_percent`).
