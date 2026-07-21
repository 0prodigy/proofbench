# RECIPE-NOTES — lyric-eng17397-stage-controls

Translation of `~/lyric/.tickets/ENG-17397/appservice/ready.yaml` onto the new loader
surface (`src/recipe.mjs`), through `docs/lyric-eng17397-recipe-draft.md`. This recipe
**loads clean** through `loadRecipe()` (see `node --test`), but several field values are
recon-pending placeholders, not real values — a parallel recon task is resolving them.
Do not treat any `TODO(...)` string below as a value to run against a cluster.

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
   recipe field — but even the recipe's claimed `tag` is unresolved here.

4. **`conjure.expected_images`** — only the two known refs (appservice, metadata-service)
   are listed; the two `mosaic-function-*` Nuclio image refs are not in any read artifact
   and are intentionally omitted rather than guessed. The base-coherence preflight (once
   built, R3) cannot check those two services until a recon task supplies their refs.

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
