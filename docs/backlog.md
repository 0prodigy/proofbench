# Backlog — Stage 1 (OSS harness wedge)

Scope: Stage 1 of [product-shape-ruling](research/product-shape-ruling.md) = PLAN.md §7 P0–P2 plus the
launch surface. Method: [adr-method](research/adr-method.md) §5 (to-issues) — every issue below is an
independently-grabbable slice, demoable on its own; no blocked-by chains. Sizes: S ≤1d · M ≤3d · L ≤1wk.

## Proven build sequence (2026-07-10 kill-tests)

The 2026-07-10 kill-tests (E1–E4) turned four decisions from theory into locked ADRs and, unlike the
rest of this backlog, impose a **real ordering** — the honesty spine is existential and must land first.
This section reorders the work below; it does not replace it. Items marked **proven-safe-now** already
hold empirically; items marked **blocked-until-fixed** ship a false green today and are gated on the
named ADR.

1. **FIRST — honesty spine R1/R2 (existential).** [ADR-0015](adr/0015-honesty-spine-oracle-outside-write-surface.md).
   **blocked-until-fixed:** E1 manufactured a green live by editing the oracle in the agent's write
   surface (gut-exercise, weaken-predicate, empty-`expect`, self-heal, delete-check) and re-anchoring
   the unsigned sha ledger. Content-hash-pin + sign check definitions by a non-agent principal (R1);
   split generation ≠ execution and cap self-judged runs below L5 (R2); agent evidence non-promoting
   (R3); externally anchor the seal (R6-hardening). Acceptance gate: all five E1 attacks flip
   FAIL→caught. Touches the seal/`manifest.json` path used across issues #16, #24; nothing else on the
   list is trustworthy until this lands.
   - **DONE (2026-07-10 slice):** R1 (`pb pin` → signed `ready.lock`; verify refuses drifted/unsigned/
     vacuous checks), R2 (`selfJudged` flag + proof capped below L5 when signer == executor), R3
     (agent/tool-provenance evidence is non-promoting), and R6 as a **detached** `manifest.sig` that
     `pb evidence validate` verifies (catches an edited/re-anchored sha). Gate met by
     `internal/verify/honesty_test.go::TestHonestySpineE1Acceptance` (all six cases caught).
   - **DEFERRED — R6 external anchor:** the detached signature is self-anchored, so a principal that
     holds the signing key can still re-sign after tampering (and re-pin, which R2 caps as self-judged).
     Closing this needs an **external transparency-log entry** (e.g. Rekor/sigstore) for the lock and
     `manifest.sig`, so a re-sign is publicly detectable. Not built in this slice (see the `ponytail`
     note in `internal/evidence/core.go` `SignManifest`).
2. **Provenance ladder R4 + generate.** [ADR-0016](adr/0016-provenance-ladder-discover-generate.md).
   **blocked-until-fixed:** E2 forged unsigned provenance (label flip; 8-line hand-typed SLSA;
   indistinguishable under `imagetools inspect`). Green only at verified signed attestation (R4);
   ship the build-time **generate** stamp (GitHub `attest-build-provenance` / cosign) for the long tail;
   two-scope attach (cluster-read + registry-read). Extends issue **#16** (proofLevel/provenance in the
   ENG-20190 replay) and issue **#5** (k8s-attach scopes).
3. **Attach: in-cluster SA + authz-preflight.** [ADR-0017](adr/0017-surface-discovery-attach-boundary.md).
   **blocked-until-fixed:** E3 showed a static short-lived token yields a dead watcher and `/livez`
   passed while `get pods` 403'd; `--token`-with-kubeconfig silently masked RBAC via the admin
   client-cert. Attach runs in-cluster (or scheduled re-auth) with an `kubectl auth can-i` preflight,
   reusing the `mic` resolve→switch→liveness spine. Directly reshapes issue **#5** (`k8s-attach`
   substrate) and issue **#21** (re-attach after rollout); relates to **#25** (single-pod scope).
4. **Discovery: k8s-objects + dep-map.** [ADR-0017](adr/0017-surface-discovery-attach-boundary.md).
   **proven-safe-now** for k8s-object surfaces (E3: workloads/Service/EndpointSlice/Ingress/headless
   auto-discovered deploy-agnostically); **blocked-until-fixed** for dependency edges (E3: only env/
   Secret-heuristic edges, code/IP/external invisible) — require a declare-once dep-map or traffic
   capture (eBPF/mesh/OTel), never inference. New surface feeding issues **#15/#16**.
5. **Test-selection route-verify guard.** [ADR-0018](adr/0018-test-selection-safety.md).
   **proven-safe-now:** ∅-selection / unmapped-path / data-only ⇒ AMBER coverage-gap, never green (E4).
   **blocked-until-fixed:** tag-only positive selection shipped a false green (ran `/users`, reported
   `/inventory`) — each selected spec must be route-verified (issued HTTP path == changed route) with a
   live route-table drift check; generation stays gated per ADR-0015/ADR-0010. Guards the selection that
   feeds issues **#4** (drivers) and **#16** (replay).

## Harness hardening

### 1. `pb lint` — manifest validation verb · S
`manifest.Load` (`internal/manifest/parse.go`) validates on load, but no standalone verb exists — the
ENG-20190 confirmation flagged it. Add a `lint` case to the `cmd/pb/main.go` dispatch, next to `init`.
- [x] `pb lint [--manifest ready.yaml]` exits 0 on valid, 1 with named errors
- [x] Each `internal/manifest/testdata/invalid_*.yaml` fixture yields a distinct, actionable message
- [x] `rootUsage` documents the verb

### 2. Bundle pairing through `pb verify` · S
`--pairs-with` exists on `pb evidence new` (`evidence.NewOpts.PairsWith`), but `verify.Opts`
(`internal/verify/verify.go`) cannot set it or `Kind`, so `pb verify` can't emit paired before/after runs.
- [x] `pb verify --pairs-with RUNID --kind before|after` populates `pairsWith`/`kind` in manifest.json
- [x] Covered in `verify_test.go`; documented in `rootUsage`

### 3. Run reaper + substrate preflight · M
`internal/substrate/compose.go` leaks resources when a run is killed; docker-mode.md prescribes
label-and-sweep plus a preflight so docker-socket/registry-auth failures surface as known_walls-shaped
errors (trap + cause + recovery, PLAN §4), not bare exec failures.
- [ ] Every resource the compose substrate creates carries a `pb.runId` label
- [ ] `Down` and the next invocation sweep orphans by label
- [ ] Missing docker socket / bad registry auth fail preflight with a named recovery hint

## Drivers

### 4. Driver families; Playwright as first non-exec check driver · L
ADR-0005: every execution concern is a driver family — small frozen interface + `New(kind)` selector,
seeded by `internal/substrate/types.go`. Extract a CheckDriver family from `internal/verify/verify.go`
(exec = current behavior); add `playwright` shelling out to `npx playwright test` (ADR-0007).
- [ ] exec driver preserves current behavior; existing verify tests stay green
- [ ] A check exercising a Playwright spec attaches trace/screenshot artifacts, `provenance: tool`
- [ ] `tool` provenance enum lands in spec/v0 + `pb evidence validate` + hub/report chip (ADR-0013)
- [ ] A driver absent at runtime yields honest `not-run` naming the capability (ADR-0012)

### 5. `k8s-attach` substrate · L
k8s-mode.md §7–8 + ADR-0011: 4th kind in `internal/substrate/k8sattach.go`, frozen interface unchanged.
Shape A only: `Up` resolves `Resource.Via["k8s"]` and asserts liveness; port-forward profiles
(generalize `pf.sh`/`keep-forwards.sh`) + env derivation from live pods (`env.derive.from: k8s-pod`).
- [ ] `pb up --substrate k8s-attach` establishes forwards for declared resources in a granted namespace
- [ ] Env derived from a named pod, never hand-written; nothing org-owned is ever created or deleted
- [ ] `Down` touches only `proofbench.dev/managed=true`-labeled resources

### 6. BuildKit shape-B builder behind the driver interface · M
docker-mode.md + ADR-0007: a Builder step (new `internal/build` package) runs before `Up` — not a
`Substrate` method (CONTRACTS.md stays frozen). Shape A validates/pins a pre-built image by digest;
shape B builds via `docker buildx bake` with cache mounts. Kaniko excluded (archived).
- [ ] Additive `artifact`/`build` manifest fields; `Up/Ready/Seed/Down` signatures untouched
- [ ] Evidence `pins.image` is always the resolved digest, never the input tag, for both shapes
- [ ] Shape-A path rejects an unpinned/annotation-less image with a named error

### 7. `auth` block v1 in ready.yaml · M
ADR-0008 + ADR-0006: basic, API-key, and cookie (Playwright `storageState`) ship in OSS; secrets by
`secretRef` only. Extend `internal/manifest/types.go` + `spec/v0/ready.schema.json`; drive verbs and
checks reference auth identities.
- [ ] `secretRef` schemes `env|file` supported; manifest validation rejects inline plaintext values
- [ ] Stale `storageState` fails a validate-before-reuse probe and forces fresh auth — no silent green
- [ ] A basic-auth and an apikey drive verb work end-to-end on a fixture service

### 8. Peekaboo check-driver spike · S
peekaboo-computer-use.md + ADR-0010: shell out to the `peekaboo` CLI (`--json`) on macOS — never
MCP-wired — mapping screenshot/JSON-sidecar output into `artifacts[]`/`checks[]`, binary version pinned.
- [ ] Prototype replays a `.peekaboo.json` script as a check on a live Mac; artifacts land in a bundle
- [ ] Go/no-go note for v1 inclusion, covering TCC permissions and CI impossibility (ADR-0010)

## GitHub App

### 9. `pb` GitHub Action · M
Run `pb verify` in a workflow (PLAN §2: CI can invoke us); the single static binary (ADR-0012) makes
this a thin composite action pinned to a release.
- [ ] Action installs pinned `pb`, runs verify against the repo's ready.yaml, sets status from verdict
      (builds from source for now; TODO in `action.yml` to switch to a pinned v0 release binary)
- [x] Evidence bundle uploaded as a workflow artifact; `inconclusive` distinguished from `fail`
- [x] Usage snippet in README

### 10. GitHub App posting bundle markdown on PRs · L
The Stage-1 viral surface (product-shape-ruling). `internal/report/markdown.go` already renders bundle
markdown; the App receives a bundle and comments verdict + proof-ladder rung + artifact links (PLAN §7 P3).
- [ ] App comments rendered markdown on the PR for a bundle produced in that repo's CI
- [ ] Comment shows verdict, `proofLevel`, tri-state per check, and provenance flags (ADR-0002)
- [ ] Re-runs update the existing comment instead of stacking new ones

## MCP

### 11. `pb mcp serve` · M
agent-abstraction.md: MCP is the neutral inbound surface (ADR-0009), embedded in the same binary
(ADR-0012). Expose up/ready/seed/down/verify/evidence as tools over the handlers in `cmd/pb/main.go`.
- [ ] `pb mcp serve` speaks stdio MCP; verify tool returns verdict + bundle path
- [ ] Exercised end-to-end from Claude Code against a fixture repo
- [ ] Tool errors carry the same named-recovery shape as CLI errors

## Spec + docs

### 12. Publish spec/v0 + docs site · M
`spec/v0/ready.schema.json` + `evidence-v2.schema.json` exist; PLAN §8 makes the spec the flag.
Publish schemas at stable URLs and stand up a docs site (quickstart, proof ladder, manifest reference).
- [ ] Schemas fetchable at a stable, versioned URL usable in `$schema` headers
- [ ] Docs site builds/deploys; manifest reference generated from the schema, not restated by hand
- [ ] Proof ladder L0–L5 and evidence-v2 documented with a real bundle example

### 13. Compile targets — `pb emit` · M
PLAN §6/§7 P3, the adoption feature: generate `copilot-setup-steps.yml`, `.cursor/environment.json`,
and an AGENTS.md section from ready.yaml (derive, don't restate).
- [ ] `pb emit <target>` produces valid config for ≥2 vendor targets from a fixture manifest
- [ ] Generated files are marked as derived and regeneration is idempotent

## Dogfood

### 14. Lyric cutover: `evidence.sh` → `pb evidence` · M
P0 exit (PLAN §7): Lyric skills call `pb evidence` with zero behavior loss; the 7 real ENG-20190
bundles are the fixtures (PLAN §14.3). Retire `_dashboard/dashboard.py` contending for :8787 (§13.5).
- [ ] Lyric skills use `pb evidence` for new/run/assert/seal/verdict
- [ ] Existing ENG-20190 bundles pass `pb evidence validate`
- [ ] One hub on :8787

### 15. ready.yaml for three Lyric services · M
P1 dogfood exit: manifests for dataservice, metadata-service, triggerservice derived from
`per-repo-setup.md`/`port-forward-deps.md` (PLAN §13.6); doubles as framework fixtures.
- [ ] Three committed manifests pass manifest validation
- [ ] `pb up/ready/seed` green on local or compose for at least one service
- [ ] Drift found vs the hand-written docs is recorded

### 16. ENG-20190 full replay via the framework · L
The P2 acceptance test the founder named (PLAN §7; Stage-1 advance gate, ADR-0001): replay an
ENG-20190-class verification entirely through pb against `delta-akash`/`redcat`, runtime-selected.
- [ ] `pb verify --substrate k8s-attach` produces a paired before/after bundle at proofLevel L4
- [ ] Verdict grounded in machine `checks[]`; run pinned (SHAs/digests); gated steps honest `not-run`
- [ ] No step falls back to `evidence.sh` or hand-run kubectl

### 17. `pb explore` prototype behind a flag · L
Stage-1 scope (product-shape-ruling): prototyped behind a flag on Lyric tickets. Claude Agent SDK via
the `AgentRuntime` process-boundary adapter outside the Apache-2.0 core (ADR-0009); one exploratory
round whose only durable output is committed automation (ADR-0010, ADR-0002). Includes a
Stagehand-vs-Playwright-codegen spike for durable-spec generation (ADR-0007 note).
- [x] `pb explore` runs only behind an experimental flag; core builds without the SDK adapter
- [ ] Output is a proposed `checks[]` diff + spec files — never a verdict; agent artifacts flagged
      (the `checks[]` proposal diff lands via `agentruntime.Explore`; spec-file generation is unbuilt)
- [ ] Exercised once on a real Lyric ticket; survival of generated checks recorded (kill-metric input)

## Launch

### 18. SetupBench headline benchmark · M
PLAN §1/§7 P3: "agents with readiness manifests: X% → Y% setup success" on SetupBench/EnvBench-class
tasks (arXiv 2507.09063) — both our eval harness and our pitch.
- [ ] Reproducible run comparing agent setup success with vs without ready.yaml on ≥10 tasks
- [ ] Method + numbers published in docs; the delta quotable in one sentence

### 19. Public fixture repo · M
PLAN §7 P3: fork of a well-known microservices demo with committed manifests — the demo target for the
Action, App, and MCP issues, and the first entry of the community manifest registry (PLAN §8).
- [ ] Public repo with a ready.yaml per service; `pb verify` green in its CI
- [ ] Linked from README and docs quickstart

### 20. Show HN launch checklist · S
PLAN §10 + §14: clear the name (trademark/domain/npm/PyPI/GitHub), README with one-liner + proof
ladder + 60-second demo GIF (PR comment with an evidence bundle), post with the benchmark headline.
- [ ] Name cleared per §10 avoid-list; repo public under the final name, Apache-2.0 (ADR-0003)
- [ ] Flip repo public at `github.com/0prodigy/proofbench` after availability checks (PLAN §10)
- [ ] README + demo GIF done; HN post drafted with the SetupBench numbers from issue 18

## Field feedback (2026-07-10 e2e)

Source: two-company + redcat end-to-end runs on 2026-07-10 — issues 21–25 below were all confirmed live,
not theorized.

### 21. Forward liveness + re-attach after rollout · M
k8s-attach (`internal/substrate/k8sattach.go`) pins a port-forward to the pod(s) live at `pb up` time;
a rollout during the run leaves the tunnel silently dead (docs/quickstart.md "redeploy caveat" — today
the only recovery is `pb down && pb up`). Detect and self-heal instead of forcing a manual cycle.
- [ ] `pb ready`/`pb verify` detect a dead forward (closed local port or broken pipe) and name it, not a
      bare dial-refused error
- [ ] `k8sAttach` reopens a stale forward automatically (or with a `--reattach` flag) without a full
      `down`/`up` cycle
- [ ] A rollout mid-run is covered by a substrate test that kills the forwarded pod and asserts recovery

### 22. Value capture/chaining in the expect grammar · M
`internal/evidence/assert.go`'s grammar has no way to capture a value produced by one drive verb (e.g.
an id) for use in a later predicate; customers shell-wrap today (write to a file, grep it back out).
- [ ] A capture syntax (e.g. `capture(<name>) <- jsonpath(...)`) records a named value on the bundle
- [ ] A later predicate can reference a captured name in place of a literal
- [ ] Documented in spec/v0/ready.schema.json's `expect` description alongside the existing predicates

### 23. `pb drive <verb>` for smoke-driving entrypoints · S
Manifests declare `drive[]` verbs, but there's no standalone way to fire one outside `pb verify` — new
users onboarding a manifest have no fast way to smoke-test a single drive verb by hand.
- [ ] `pb drive <verb> [--manifest ready.yaml]` runs one named drive verb and prints its output
- [ ] Honest error when the verb name isn't declared, listing the known verbs
- [ ] `rootUsage` documents the verb

### 24. Check artifacts written to cwd should land in the sealed bundle automatically · S
Drive verbs and checks commonly redirect output into a cwd-relative file (e.g. `> execution.json`,
per the ENG-17397 fixture's `read-execution`); today `pb evidence add`/claim is a separate manual step,
so it's easy to seal a bundle missing the file a predicate just read.
- [ ] A check whose `exercise` or `expect` references a cwd-relative path auto-claims that file into the
      bundle's `artifacts[]` before sealing
- [ ] `pb verify` sealing fails loudly (not silently) if a referenced path can't be found to claim

### 25. Replica-aware attach note · S
`k8s-attach` forwards `svc/<name>` (`internal/substrate/k8sattach.go` `forwardTargets`), which reaches
exactly one pod behind the service; on a multi-replica deployment, evidence captured through the forward
reflects that one pod only, not the fleet.
- [ ] docs/quickstart.md's k8s-attach section calls out single-pod evidence scope explicitly
- [ ] Multi-forward (one tunnel per replica) considered and either scoped as a follow-up issue or ruled
      out with a named reason
