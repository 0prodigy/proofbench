# RECIPE-NOTES — lyric-eng17397-stage-controls

Translation of `~/lyric/.tickets/ENG-17397/appservice/ready.yaml` onto the loader surface
(`src/recipe.mjs`) + the catch-path drive built for it (`src/catch.mjs`
`runNoteLifecycleCatch`), through `docs/lyric-eng17397-recipe-draft.md`. This recipe
**loads clean** through `loadRecipe()` and **resolves end-to-end** through
`resolveCatchSeams()` (see `node --test`, `test/notelifecycle.test.mjs`'s "LYRIC E2E DRY"
cases) — but several field values are recon-pending placeholders, not real values, and the
cluster itself has never been reached (no live run has executed). Do not treat any
`TODO(...)` string below as a value to run against a cluster.

## What the LYRIC DRIVE SLICE built this pass (previously unbuilt, now wired)

- **multi_repo identity through k8s-attach** (`conjure.mjs`): the sealed fingerprint now
  carries `code_identity.repos[]`/`wheels[]` verbatim (a CLAIM, per the versions-disagree
  note above) alongside the DRIVE-TIME observed pod digests (`mintK8sAttachIdentity`) —
  `code_identity.images[].tag` is never itself sealed, only an expectation.
- **`conjure.expected_images` binding**: a digestless entry (this recipe's shape — no
  `git_tag_overwrite` tag was resolved, see item 3 below) now binds by REPO(+TAG) against a
  running pod's own requested image ref, sealing the OBSERVED digest — no longer a
  permanent, un-bindable CND as it was before this pass.
- **`front_door.mode:'rest'` + `drive.mode:'note-lifecycle'`**: wired end-to-end. The
  proposer receives `drive.surface` + `front_door.base_url_template`/`entrypoint` +
  `setup.operator_env` values (harness-run introspection) and proposes a walk of `http`
  ops (method/path/body/capture); the HARNESS executes each step through the k8s-attach
  port-forward (reusing conjure/confirm's own placeholder-resolution + capture shape, never
  a new executor). The walk itself stays agent-proposed — nothing here scripts it.
- **`fresh_world:'new_instance_per_iteration'` enforcement**: each reproduction's captured
  instance id (the discriminating query's own placeholder, here `child_execution_id`) must
  differ from every earlier reproduction's; a repeat is a degenerate replay — excluded from
  both k and kFail, named in the diagnosis, never silently folded into either bucket.
- **Placeholder injection guard** (`mongotap.mjs`): an agent-captured value substituted into
  `store_tap.queries.stage_controls_queued`'s `{child_execution_id}` must be a 24-hex
  ObjectId or a conservative `[A-Za-z0-9_-]{1,64}` token before it enters the mongosh
  `--eval` string — a hostile capture is refused (→ CND naming the step), never interpolated.
- **Drift + confirm wiring**: `mintK8sAttachIdentity` runs before each reproduction's walk;
  `checkK8sAttachDrift` runs after its confirm leg (both throw → CND, never a false
  DOES_NOT_WORK). `confirm[]` is empty here, so the confirm leg is a SECOND independent
  scoped mongo read of the same `{child_execution_id}`-bound query (mirrors the argo-drive
  nonce round-trip) — mongo confirm always goes through the scoped tap, never ambient.

## Recon-pending fields (must be resolved before any live run)

1. **`conjure.kube_context` / `conjure.namespace`** — the ticket's own artifacts disagree:
   `ready.yaml:12-14` says `redcat`/`redcat`; `evidence/20260710-164002/manifest.json`
   pins `akashpathak`/`delta`. Per the draft's decision, these are operator-supplied
   (`PB_K8S_CONTEXT`/`PB_K8S_NAMESPACE`) and must never be baked as a recipe literal.
   The recipe carries `TODO(...)` placeholder strings only so the loader's required-string
   check passes; the real values are resolved at run time.

2. **`code_identity.wheels[].version` for `lyric-runner-py`** — the runner's own package
   version is not declared in `lyric_py_version.py`; the evidence string
   `26.2.4.dev17398` is `selfAttested`/unsealed (agent/tool provenance), not harness
   provenance. Must be read from the built wheel at conjure time.

3. **`code_identity.images[].tag`** (all four: appservice, metadata-service,
   mosaic-function-scenario, mosaic-function-stage-control) — no `git_tag_overwrite`
   dev-build tag string was present in the read artifacts (only a stale digest at an old
   SHA for appservice/metadata-service, and no image ref at all for the two Nuclio
   functions). Per the loader contract, digest is always a DRIVE-TIME re-read and never a
   recipe field — but even the recipe's claimed `tag` is unresolved here. This is now
   inert either way: `mintK8sAttachIdentity` never reads `images[].tag` at all, and
   `conjure.expected_images` binds by REPO(+TAG) against the running pod's own ref (item 4
   below), sealing the OBSERVED digest — the claimed `tag` string is documentation only.

4. **`conjure.expected_images`** — only the two known refs (appservice, metadata-service)
   are listed; the two `mosaic-function-*` Nuclio image refs are not in any read artifact
   and are intentionally omitted rather than guessed. Both listed refs are bare (no `@sha256`,
   no `:tag`) — the loader's ref-matching (`expectedImagesBind`, this pass) now binds a
   digestless entry by REPO alone against any running pod's own image ref, sealing whatever
   digest is actually observed; this is no longer the permanent, un-bindable CND it was
   before this pass. The base-coherence preflight (still R3-unbuilt, see below) still cannot
   check the two Nuclio services until a recon task supplies their refs.

5. **`store_tap.queries[*]` placeholders** (`{parent_execution_id}`, `{child_execution_id}`)
   — populated at drive time by the agent-proposed walk (fire → resolve
   `parent.notes[0]` → child id), never baked into the recipe. The walk itself stays
   agent-proposed per the frozen invariant (propose/dispose) — no recipe field scripts it.

## Deliberately NOT added (unbuilt loader surfaces — do not add ahead of the loader)

- **Base-coherence preflight** (F2/F3 defense: `compute-diff` SYNCED check + chart-version
  coherence) — ROADMAP R3 lists this as a still-open checklist item; `src/recipe.mjs`'s
  `k8s-attach` schema has no field for it today, so none is declared here.
- **Operator-ratify gating** for the mutating drive verbs (`fire-default`, `fire-override`,
  `drive-stage-machine`, `drive-illegal-transition`, per `ready.yaml`'s `gates:` block) —
  ROADMAP R3 "operator-ratify mode" is unbuilt; no recipe field exists for it yet. The
  actual live run must get same-turn human confirmation before any mutating step
  regardless (CLAUDE.md Risk & autonomy), independent of whether the loader ever grows a
  declarative gate field.
- **`front_door.headers`** (the drive-endpoint auth question, `docs/lyric-integration-
  contract.md` §4 decision 5/A5: does `POST /executions` / `PATCH …/stages` need a
  bearer/`From` header on this cluster?) — the loader/catch.mjs SUPPORT this today
  (`front_door.headers: {"<name>": "{OPERATOR_ENV_VAR}"}`, resolved + sent on every
  note-lifecycle request, sourced strictly from `setup.operator_env` — never a literal
  secret baked into the recipe), but it is NOT declared here because the answer is still
  unresolved. Once the Lyric team answers it: add the header name here (e.g.
  `"headers": {"From": "{PB_LYRIC_FROM}"}`) and add `PB_LYRIC_FROM` (or whatever the real
  header's operator-supplied value is named) to `setup.operator_env` — no loader/catch.mjs
  change needed.

## Values used as-is (not recon-pending — proven/committed sources)

- `store_tap.credential_secrets` ordered fallback (`mongodb-password`,
  `mongodb-credentials`, `mongodb-lyric-lyric`) — the proven order from
  `~/.claude/skills/lyric-qa/scripts/lyric-mongo.sh`.
- `store_tap.pod`/`container`/`db` (`mongodb-0`/`mongod`/`lyric`) — same script + `ready.yaml`.
- `code_identity.repos[].sha` and the four non-`lyric-runner-py` `wheels[].version` values —
  the ticket-worktree-coherent values from `docs/lyric-eng17397-recipe-draft.md`'s
  versions-disagree table (NOT the stale main-worktree values).
- `conjure.services[]` name/port pairs — `ready.yaml`'s `resources.*.via.k8s` block.
- `setup.operator_env` names and `front_door.entrypoint` query-string shape —
  `ready.yaml`'s drive verbs + `known_walls` (a body-only POST 500s).

## Exact remaining runtime requirements for the live run

Everything the loader/catch-path code needs is built and unit-proven cluster-free
(`test/notelifecycle.test.mjs`). A real live run still needs, supplied by the operator:

1. **`conjure.kube_context`/`conjure.namespace`** — edit these two recipe fields (or a copy
   of the recipe) to the real, resolved values; nothing reads `PB_K8S_CONTEXT`/
   `PB_K8S_NAMESPACE` from the environment to fill them in automatically today.
2. **`setup.operator_env`'s actual values** (`PB_SCENARIO_ID`, `PB_SEQUENCE_ID`,
   `PB_SEQ_NOTE_ID`, `PB_DEFAULT_ACTION`, `PB_OVERRIDE_ACTION`, `PB_EXPECTED_IMAGE`) — set as
   real process environment variables before the run; a value left unset surfaces as an
   honest could-not-execute naming the unresolved placeholder, never a fabricated default.
3. **`conjure.expected_images`** — the two Nuclio refs (mosaic-function-scenario,
   mosaic-function-stage-control) are still not in any read artifact; add them once a recon
   task supplies the refs, or the base-coherence preflight (still unbuilt) will only ever
   cover appservice/metadata-service.
4. **Header config (`front_door.headers`)** — leave unset unless/until the Lyric team
   confirms `POST /executions`/`PATCH …/stages` need a bearer/`From` header on this cluster
   (see "Deliberately NOT added" above); if they do, add the header + its operator_env name
   here, no code change needed.

**Honest gap — `node src/cli.mjs prove` itself does not reach this recipe yet.** `pb prove`
(`src/cli.mjs`) is a two-SHA DIFFERENTIAL runner: it hard-requires
`code_identity.mode === 'from_tree'` with a `parent_sha` and exits 2 (CND) BEFORE ever
calling `conjure()` otherwise — verified live this pass (`node src/cli.mjs prove
recipes/lyric-eng17397-stage-controls` prints exactly that message and exits 2, touching no
kubectl/cluster at all). `code_identity.mode:'multi_repo'` has no from_tree SHA and no
declared differential-baseline shape (a BYOC attach has no "build the parent commit"
analogue — the differential, per the ROADMAP's Lyric-dogfood bullet, would need TWO
deployed cluster states, a shape nothing in R3 has designed yet). This is a PRE-EXISTING,
separate limitation of the CLI's `prove` command — not touched this pass (out of the LYRIC
DRIVE SLICE's numbered scope, and inventing a new non-differential prove mode ahead of an
executed live verdict is exactly the "no seam without a committed recipe exercising it
end-to-end live" pattern CLAUDE.md forbids). `runCatch()` itself (the layer `cli.mjs prove`
calls into) DOES reach a real `conjure()` k8s-attach attempt for this recipe today —
proven by `test/notelifecycle.test.mjs`'s "LYRIC E2E DRY" cases, which show the ONLY
failure mode reaching a real cluster call is a genuine attach/connect error, never a
"not implemented" throw. Closing the CLI-level gap (a single-snapshot or two-cluster
prove mode for `multi_repo`) is next-session work, scoped to ROADMAP R3's "Lyric dogfood"
checklist item, not this slice.
