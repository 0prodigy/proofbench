# RESUME — read this first to continue with zero loss

*Living checkpoint. Update it at the end of every working session. Git is the durable
checkpoint (every milestone is committed); this doc is the human/agent handoff on top of it.*

**Last updated:** 2026-07-21 · **Branch:** `product-v1` · **Tip:** run `git log --oneline -1`.

---

## SESSION 2026-07-21 (e) — LYRIC LYRICLET TRACK: R3-subset harness BUILT + reviewed; live run gated on two founder actions

**Founder decisions this session (logged in ROADMAP):** G1 build closed → `git push origin
product-v1 v0.2.1` EXECUTED (repo now public on 0prodigy/proofbench); `npm publish` of
proofbench@0.2.1 still PENDING founder `npm login` (ENEEDAUTH). Lyric lyriclet dogfood
(R3 subset, `docs/lyric-integration-contract.md` `45b7c61`) pulled AHEAD of G2; waking
`akashpathak` authorized + done.

**BUILT + committed this pass (all green: 275/275 tests, gate PASS 14 held, typecheck
clean, frozen core diff-empty, zero deps):**
- `a1fa8eb` loader growth: multi_repo identity, k8s-attach conjure, mongo tap engine,
  new_instance_per_iteration, operator_env setup, front_door rest, note-lifecycle surface.
- `44c6c36` mongo exec tap as HARNESS provenance (src/mongotap.mjs) · `4b99093` k8s-attach
  bring-up + mint preconditions (drive-time digest sealing, drift sentinel) · `6b0f8e4`
  review fix: every kubectl call scoped --context/-n (wrong-world vector closed).
- `3578104` recipes/lyric-eng17397-stage-controls (+RECIPE-NOTES.md recon-pending values).
- `55517f2` drive slice: multi_repo through attach, ref-matching expected_images,
  runNoteLifecycleCatch (agent-proposed http walk, TOOL attempts, mongo ground truth),
  fresh-instance enforcement, mongosh/kubectl injection guards, drift bracketing.
- `b1d7e87` CLI: `pb prove --leg <l> [--replay-walk <merge-case>] [--out]` (propose-once-
  freeze ACROSS runs) + `pb differential <merge> <parent>` folding two sealed legs.
- `6e15bb4` false-WORKS review advisories closed: differential refuses PASS on identical
  drive-time digest sets (no deploy swap = no causal claim), leg labels sealed
  (case-routing receipt), http path guard (SSRF/userinfo shapes), bind-ladder doc.
**Reviews:** constitution lens PASS (1 blocking → fixed 6b0f8e4); dedicated false-WORKS
lens PASS — "no constructible false-WORKS, live-run-ready" (its 4 advisories → 6e15bb4).

**CLUSTER STATE (akashpathak, ctx akashpathak, ns delta — LEFT AWAKE):** running
ENG-20190 appservice (`akashpathak-69c1188d`) + MDS 2 commits behind ticket tip (missing
the @AuthValidation commit). Recon FACTS: drive auth = port-forward + `From:` header
(reads verified 200); mongo tap live via secret `mongodb-lyric-lyric`; NO argocd
self-heal, DE agent applies only issued deploys → drift sentinel sufficient; runner wheel
pin `26.3.2.dev20190` SUFFICES (carries A&C surface + mds-sdk 2.0.4.dev17399 — verified,
no repin). Appservice leg images BUILT + SHA-verified: merge `akashpathak-e1c87a34`
(=`0aaff3b1e`, sha256:e43ba5fb…) · parent `akashpathak-40b14842` (=`d9b4642`=staging tip,
sha256:24e13da5…). Note: publish workflow also moved `appservice:latest` (harmless, pins
are explicit).

**RESUME ORDER — the live differential (everything pb-side is DONE):**
1. FOUNDER-GATED: build the two MDS images (classifier blocks `gh workflow run` for
   agents): `gh workflow run single_promote.yml -R lyric-tech/release-manager --ref main
   -f repository=metadata-service -f from-tag=ENG-17397-action-and-controls -f
   to-tag=akashpathak-<rand8>` and the same with
   `from-tag=eng-0001-updating-python-to-3.10`.
2. Fill RECIPE-NOTES.md recon-pending values (kube_context=akashpathak, namespace=delta,
   operator_env ids, expected_images repo+tag per leg), export operator_env.
3. Deploy MERGE builds (appservice `akashpathak-e1c87a34` + MDS merge tag via mic byoc
   pin/deploy + nuclio fn redeploy) → `node src/cli.mjs prove
   recipes/lyric-eng17397-stage-controls --leg merge --out merge-case.json`.
4. Deploy PARENT builds → `… --leg parent --replay-walk merge-case.json --out
   parent-case.json` → `node src/cli.mjs differential merge-case.json parent-case.json`
   (PASS requires distinct drive-time digests). Commit sealed cases + site/cases pair.
5. FOUNDER-GATED: `npm login` → `npm publish` (proofbench@0.2.1, tag v0.2.1 on ffa1bc8).
6. Close-out: tick earned R3 boxes (mongo tap, k8s-attach, multi-repo identity,
   fresh-world enforcement — preflight partial via drift sentinel; operator-ratify still
   unbuilt), update lyric-integration-contract with recon answers, then G2.

---

## SESSION 2026-07-21 (d) — G1 CLOSED: documenso #3031 SECOND ENGINE EXECUTED LIVE

**Governance unchanged.** This pass finished G1's last build item. **G1 is now fully done**
except the two founder-HELD commands (`npm publish`, `git push`) — see RESUME ORDER below.
Next session moves to **G2** (see ROADMAP.md R2).

**DONE this pass (all committed, tree green throughout — verified before AND after every
commit: `node --test` 186→189/189 as tests were added, `node src/cli.mjs gate` PASS [14
malicious drivers held, honest=WORKS], `npm run typecheck` clean; `docker ps -a` empty
after every attempt, no orphans left at any point):**

- `f4f1e56` **port-3010 fix, live-verified via a smoke script first:** the port-3010
  fix banked from the prior session (host port 3000 is hijacked by an unrelated
  `kubectl port-forward`, PID 12248 — never killed) plus a SECOND, previously-
  undiscovered bug the smoke test surfaced: `.env.example` also pins
  `NEXT_PRIVATE_INTERNAL_WEBAPP_URL` to `localhost:3000` — the `LocalJobProvider`'s
  self-loopback POST that actually dispatches the signup-confirmation-email job. With
  `PORT=3010` that self-POST connection-refused and was silently swallowed
  (`submitJobToEndpoint .catch(() => null)`), so inbucket never received the
  verification mail. Fixed by also pinning
  `NEXT_PRIVATE_INTERNAL_WEBAPP_URL=http://localhost:3010` in the compose overlay.
  `conjure()` smoke passed end-to-end (signup → exec team-lookup → inbucket token
  capture → verify-email → multipart envelope-create → front-door URL minted, cookies
  captured, clean teardown) BEFORE this was committed, per the task's ordering.
- **Three diagnose-fix cycles against genuine live infra bugs**, each committed
  separately with its own live re-run:
  - `822e4f9` **attempt #1 was a truthful non-discriminating negative**
    (merge=WORKS ∧ parent=WORKS — reported honestly, not forced). Root-caused from the
    sealed receipts: headless chrome's default window was small, so documenso's Konva
    canvas rendered at ~124x175px, too little room for 3 non-overlapping field
    placements (every clickAt after the first landed on the already-placed field's own
    Rect); the proposed walk also `find`-but-never-`click`ed the Remove button. Fixed
    additively: `browserdrive.mjs` now boots headless chrome with
    `--window-size=1600,1200` (a general fix, not documenso-specific); the recipe's
    `intent` was sharpened (spread placements, name the Remove button's `title`
    attribute, spell out find-then-click). Test updated.
  - `531a8f8` **attempt #2 was an honest CND** (both legs
    `COULD_NOT_DETERMINE`) — chromedriver 400'd every `clickAt` with `'x' must be an
    int`: the agent computes canvas coordinates from `getBoundingClientRect()`, which
    is legitimately float-valued. Fixed: `clickAt` now `Math.round()`s x/y before
    building the W3C Actions payload (both the shift and non-shift branch), and records
    the ACTUAL rounded ints driven, not the raw proposal. New regression test.
  - `5f8af83` **attempt #3 was an honest CND again** (both legs
    `COULD_NOT_DETERMINE`) — chromedriver 500'd `move target out of bounds`.
    Root-caused with a standalone repro script (conjure + open browser + introspect +
    propose, stepping the walk op-by-op): documenso's canvas rect reports height 1130
    at y=172 (bottom edge ~1302), but the real visible viewport is only
    `innerHeight`=1061 — the canvas is taller than the window, and the agent (seeing
    only the raw rect) computed an on-canvas but off-screen click. Fixed: `catch.mjs`'s
    `INTROSPECT_JS` now also reports the window's own `viewport` `{width,height}`
    alongside fields/buttons/canvases; `introspect()`'s return type widens to match
    (bare-array test fakes still accepted, viewport defaults to `{width:0,height:0}`);
    `proposer.mjs`'s shared `SYSTEM_PROMPT` states the clamp requirement explicitly.
    Two new tests (widened shape + back-compat).
  - None of the three fixes touched the frozen core (`verdict.mjs`/`harness.mjs`/
    `evidence.mjs`) — all live in `browserdrive.mjs`/`catch.mjs`/`proposer.mjs`/the
    recipe, exactly per the task's constraint.
- `c926321` **attempt #4 — DIFFERENTIAL: PASS, sealed and committed.**
  `node src/cli.mjs prove recipes/documenso-envelope-fields-pr3031` →
  merge `97835b8dbb2c`=**WORKS** (k=2, fresh worlds, `Field.rows` 0→1, fresh confirm
  agrees) ∧ parent `977d07330b97`=**DOES_NOT_WORK** (kFail=2/2 falsified: the SAME
  frozen agent-proposed walk replayed verbatim persisted `Field.rows` 0→**2**, not the
  claimed 1 — without the shift-click multiselect handler, the parent's click *replaces*
  rather than *extends* the selection, so the toolbar's Remove only drops the
  last-clicked field, leaving 2 instead of 1). Seals independently RE-VERIFIED via the
  `sealedVerdict` code path (not by eye, via a standalone script): both receipts
  re-read from disk reproduce the CLI's exact verdict, and a tampered copy of each
  correctly degrades to `UNVERIFIED`. `site/cases/documenso-envelope-fields-pr3031.
  {merge,parent}.json` are byte-identical copies of the sealed run-dir receipts.
- **Per-leg wall-clock (adoption metric, warm image cache — both SHAs already built in
  earlier attempts this pass):** merge leg (k=2 reproductions + one cold-Sonnet
  `claude -p` proposer call, frozen thereafter) ≤ 2m48s (bounded above by the gap
  between the preceding commit and the merge receipt's mtime, which also includes a
  few seconds of session overhead); parent leg (k=2 reproductions, the SAME frozen
  walk replayed, NO proposer call) = 2m07s (receipt mtimes 15:12:43 → 15:14:50). Total
  differential (both legs) ≈ 4m55s warm. A genuinely cold run (fresh docker image
  build for both SHAs) was NOT separately timed this pass — the honest gap: no
  first-cold-build wall-clock number exists yet for this recipe.
- **docs+site truth pass** (this commit, see `git log --oneline -1`): `site/index.html`'s
  `#stacks` matrix — the Postgres+canvas row flips `CAPABILITY PROVEN` → `SUPPORTED`
  with a link to the sealed case files (and the "Agent-proposed browser walk" row's
  evidence list gains the documenso case as a 4th proof); `docs/ROADMAP.md`'s "Second
  engine EXECUTED" box ticked with commit refs; this RESUME block.

**Left exactly as found (documented, not lost):** the Lyric/argo store-tap `throws`
(R3, cluster-gated, unchanged); `pb prove --random` (the full-pool gate) was NOT run
this pass — a bonus per the task brief, not required to close this box.

**RESUME ORDER (next session) — do these in order:**
1. **Two HELD founder commands** (neither run this session, both require explicit
   founder confirmation per the task constraints):
   - `npm publish` (from `/Users/prodigy/prodigy/project`, publishes `proofbench@0.2.0`
     — tag `v0.2.0` exists on `f7dd9a9`, which now PREDATES this session's harness
     commits; re-tag/rebump before the real publish).
   - `git push origin product-v1` and `git push origin v0.2.0` — `product-v1` has
     never been pushed; today `origin`'s `main` is the stale pre-rewrite OSS line.
2. **G1 is fully closed** (second engine executed, distribution staged, getting-started
   done, launch page done) — once (1) lands, move to **G2**: machine `--json` verdict,
   GitHub Action, `pb init`, dogfood, sealed-room minimum, CI intent source,
   `--merge-only` CI mode, concurrent-run isolation. See ROADMAP.md R2.
3. Minor gaps surfaced but out of scope for this pass (future slice, not blocking):
   the live claude-CLI proposer has no retry on a single malformed proposal (costs a
   CND, not a false-WORKS — noted in the "READ THIS BLOCK FIRST" session block below);
   the exit-code doc/constitution reconciliation gap (`docs/getting-started.md` note);
   binding the #7130 parent's specific CND cause into the sealed reason string itself.

**Post-hoc independent review of `f4f1e56..4949afe` (the commits after the session's
review panel): PASS — ship, zero blocking.** Frozen core diff empty, zero new deps, both
seals re-verified with a genuine tamper probe, differential confirmed non-tautological
(identical intent on the parent leg produced DNW). Advisories banked:
- **Intent-sharpening ratchet (watch item, IC-15):** the documenso recipe's `intent` now
  embeds near-procedural language (button `title`, "click it, not just find it"). Still
  agent-proposed walk + harness-tap truth, but ration intent edits — fix live failures
  in the HARNESS generically (as 822e4f9/5f8af83 did), or intents become de facto scripts.
- `catch.mjs:496` legacy bare-array introspection defaults viewport to 0×0, which with
  the clamp rule would forbid every clickAt if that path ever met a live proposal.
- A future NON-differential run of the documenso recipe is weaker than it looks: merge's
  0→1 alone can't distinguish "placed 3, removed 2" from "placed 1"; the discrimination
  lives in the parent leg.
Version was then bumped to **0.2.1 with tag `v0.2.1` on the final tip** (the old
`v0.2.0`@`f7dd9a9` predates the honesty fix + harness slice — do NOT publish it), so the
held commands are now: `npm publish` + `git push origin product-v1 v0.2.1`.

---

## SESSION 2026-07-21 (c) — G1-tail close-out: distribution staged, docs+matrix landed, one honesty fix, engine still BLOCKED

**Governance unchanged.** Current gate: **G1 tail** — only the second-engine differential
and the actual `npm publish`/`git push` remain open; everything else in G1 is done.

**DONE this pass (all committed, tree green throughout — verified before AND after:
`node --test` 186/186, `node src/cli.mjs gate` PASS [14 malicious drivers held, honest=WORKS],
`npm run typecheck` clean; `docker ps -a` shows zero containers):**

- `f7dd9a9` **pb: G1 distribution — publishable package.json** (files whitelist
  `["src/","LICENSE","README.md"]`, `engines>=20`), a zero-dep `scripts/version-check.mjs`
  prepack gate (refuses to pack/publish unless HEAD is tagged `v<package.json version>`
  exactly), version bumped to **0.2.0** (the local `v0.1.0` tag already points at an
  unrelated pre-rewrite Go-binary commit, so it was not reused), annotated tag `v0.2.0`
  cut on `f7dd9a9`. Cold-verified from an empty temp dir: `npm pack` → 24 files (no
  `recipes/`, `site/`, `test/`, `docs/`, `corpus/` leakage) → fresh `npm install` of the
  tarball → `node_modules` contains ONLY `proofbench` → `npx pb gate` → **GATE: PASS**,
  exit 0. `npm publish --dry-run` completed cleanly (log in scratchpad, not committed).
  **Real `npm publish` was NOT run — HELD for the founder** (see RESUME ORDER below).
  Caveat surfaced by review: the packable artifact is pinned to `v0.2.0`=`f7dd9a9`, which
  **predates** this session's harness commits (`375964f`/`366cbc8`) — the next publish
  needs a version bump + retag once those land in a shippable state.
- `a4d8df2` **docs: G1 getting-started guide** — `docs/getting-started.md`, the
  recipe-authoring guide from a stranger's first hour to a sealed verdict, every
  `pb-recipe-v1` field traced to `src/recipe.mjs`, verdict/exit-code semantics traced to
  `src/verdict.mjs`/`src/cli.mjs`, honest-CND declines named with their ROADMAP unblock.
  Gap surfaced, not fixed: CLAUDE.md's stated exit-code contract (0/1/2/3 mapped to
  WORKS/DNW/CND/internal) is NOT what `src/cli.mjs` implements today (DNW and CND both
  collapse to exit 1); flagged as a doc/constitution reconciliation item, out of scope
  for a docs-only change. Also stale: the doc's `git clone` fallback (line 48) points at
  `origin`'s `main`, which is the old pre-rewrite OSS line — `product-v1` has never been
  pushed, so that command fetches the wrong code until the founder-gated push happens.
- `375964f` **harness: shift-click drive primitive, widened introspection, settle
  debounce, multipart/exec/headers/origin setup+confirm steps** — new `browserdrive.mjs`
  capability (W3C dual-input-source shift+click) plus `catch.mjs`/`conjure.mjs` setup/
  confirm steps needed for the documenso multiselect walk (multipart POST, exec-capture,
  header/origin overrides). Unit-tested against a fake WebDriver router; **no real
  Chromium has executed the shift-click primitive yet** — that's still the smoke-test gap.
- `366cbc8` **recipe: documenso #3031 upgraded to the discriminating shift-click
  multiselect differential** — `parent_sha` added and verified against the real tree at
  both SHAs (the field-group shift-click handler is the ONLY changed code, closing the
  prior non-discriminating-walk gap), plus the genuine HTTP/exec setup dance (signup,
  exec-capture team lookup, inbucket token capture, verify-email, multipart envelope-create).
- `3ea6987` **site: G1 launch-page supported-stacks matrix** — `#stacks` section on
  `site/index.html` + `.stacks-table`/`.stacks-group-head`/`.stacks-note` CSS, two
  tables (5 supported rows incl. Postgres+canvas marked `CAPABILITY PROVEN` not
  `SUPPORTED` since the documenso differential hasn't executed; 4 honest-CND rows each
  naming an unblock), every cell linked to a committed recipe/case/doc file.
- `2995786` **fix: confirm leg no longer inherits a setup capture named `observed`** —
  a review-surfaced false-WORKS vector: `runConfirmLeg` seeded its `captures` map from
  `setupCaptures` and gated only on `'observed' in captures`, so a setup step that
  happened to capture anything named `observed` (e.g. a pre-walk id) could satisfy the
  fresh-re-observation gate even when confirm[] itself never re-captured anything,
  promoting a stale value to WORKS via `confirmAgrees`. Fixed with a one-line
  `delete captures.observed` after the setupCaptures spread, so `observed` can only be
  set by confirm[]'s own capture in that run. New regression test in
  `test/catch.test.mjs` reproduces the exact shape and asserts `verdict.state !== WORKS`.
  No frozen-core file touched (lives in `catch.mjs`'s non-frozen confirm-leg logic).
- Reviewer pass across the full G1-tail diff: no other false-WORKS vectors found; several
  non-blocking robustness/CND-misattribution notes filed below and in ROADMAP-adjacent
  advisories (multipart-without-body silently drops files; exec-capture on zero rows
  captures `''` instead of failing loudly; confirm-leg `origin`/`headers` placeholder
  errors aren't wrapped like `path`/`body` so they misattribute to a generic
  "could not execute" CND instead of naming the placeholder; recipe.mjs accepts an
  `exec` step inside `confirm[]` at load time even though `catch.mjs` rejects it only at
  runtime). None are false-WORKS; none block G1 close-out; left for a future slice.
- ROADMAP: ticked the two stale G0 boxes ("Wire-or-delete" → `ffacf74`, "Constitution +
  roadmap committed" → `d107bed`) and added one-line BLOCKED/STAGED status to the two
  open G1 boxes ("Second engine EXECUTED", "Distribution") — neither ticked, since
  neither is earned yet (no live differential leg; no real registry publish).

**Adoption metrics this session (from the independent verify pass):**
- **CND rate:** 1/6 committed case legs = 16.7% (all 3 differentials PASS; the sole CND
  is #7130's parent, the feature-absent leg — expected for an additive PR).
- **Named-unblock rate:** holds for the committed cases with one flagged gap — the
  sole CND case (`n8n-form-trigger-pr7130.parent.json`) carries an EMPTY `receipts:[]`
  (walk never executed) so its verdict-reason prose names the missing cause generically;
  the specific "Node not found: formTrigger" detail lives only in
  `docs/differential-validity-2026-07-18.md` / the site, not the sealed artifact itself.
  Pre-existing, not introduced this session — borderline against the 100% bar, worth a
  future slice to bind the specific cause into the sealed reason string.
- **Verdict wall-clock:** no completed verdict runs this session (both documenso conjure
  smoke attempts failed on infra before reaching a drive leg), so no new wall-clock
  numbers exist. Cold documenso compose bring-up (first attempt, mostly-cached image
  layers): ~5-6 min to first ready-check failure. Warm-cache second attempt: ~30-40s to
  fail (postgres/inbucket healthy fast; ready-check hit the wrong port immediately).
- **Time-to-first-verdict:** `docs/getting-started.md` states the G1 under-an-hour bar
  and derives the recipe format from `src/recipe.mjs`; it is a guide, not a freshly
  measured timing — no new fresh-repo clock was run this session.

**Left exactly as found, uncommitted (documented, not lost):**
`recipes/documenso-envelope-fields-pr3031/{recipe.json,compose.override.mem.yml}` still
carry the local port-3010 fix diff described in the (b) block below — same state,
unchanged this pass. This is the ONE thing standing between "harness capability +
recipe committed" and "second engine EXECUTED."

**RESUME ORDER (next session) — do these in order:**
1. **Two HELD founder commands** (neither run this session, both require explicit
   founder confirmation per the task constraints):
   - `npm publish` (from `/Users/prodigy/prodigy/project`, publishes `proofbench@0.2.0`
     — tag `v0.2.0` already exists on `f7dd9a9`; re-tag/rebump first if any src change
     has landed since).
   - `git push origin product-v1` and `git push origin v0.2.0` (refspecs
     `refs/heads/product-v1` and `refs/tags/v0.2.0`) — `product-v1` has never been
     pushed; today `origin`'s `main` is the stale pre-rewrite OSS line.
2. **Second engine EXECUTED (the last open G1 item):** commit the port-3010 fix
   (`recipe.json`/`compose.override.mem.yml`, `published_port`/`container_port` 3010,
   `PORT=3010` honored by `apps/remix/server/main.js`), re-run the `conjure()` bring-up
   smoke test end to end (signup → exec team-lookup → inbucket capture → verify-email
   → multipart envelope-create), THEN attempt the actual merge-vs-parent differential
   via `node src/cli.mjs prove recipes/documenso-envelope-fields-pr3031`.
3. Once both land: G1 is fully closed — move to **G2** (machine `--json` verdict,
   GitHub Action, `pb init`, dogfood, sealed-room minimum, CI intent source,
   `--merge-only` CI mode, concurrent-run isolation). See ROADMAP.md R2.

---

## SESSION 2026-07-21 (b) — launch-page stacks matrix landed; documenso differential still BLOCKED

**Done this pass:** the last G1 launch-page piece — `#stacks` section on `site/index.html`
(nav links added header+footer), plus `.stacks-table`/`.stacks-group-head`/`.stacks-note`
CSS in `site/assets/site.css`. Two tables: **Supported** (compose/single-container conjure;
sqlite tap, 3 executed differentials; form + session-auth front doors; agent-proposed
browser walk; Postgres tap + canvas drive + multipart/exec setup — this last one marked
`CAPABILITY PROVEN` not `SUPPORTED`, with an explicit prose note that the documenso
differential itself has not been attempted) and **Declines to honest CND** (k8s/helm → R3,
serverless/managed, mobile/native, no-Dockerfile — each names its unblock). Every cell
links to a committed recipe/case/doc file (relative paths, since `product-v1` isn't pushed
to `origin` yet — only `main`, the old pre-rewrite OSS line, exists on the remote; an
absolute `github.com/.../blob/main/...` link would silently point at stale code). README has
no "stacks" section, so nothing to mirror there. `docs/ROADMAP.md`'s "Launch page rebuild"
checkbox is now checked off. Verified before/after: 185/185 tests, `pb gate` PASS, typecheck
clean — this was a site-only (HTML/CSS) change, `src/` untouched.

**Left exactly as found, NOT committed (out of scope for this pass, do not lose track of
it):** `recipes/documenso-envelope-fields-pr3031/recipe.json` and
`compose.override.mem.yml` carry an uncommitted local diff — the port-3010 fix for the
conjure port-mapping gap described in the engine-track note below. The matrix's honest
wording (`CAPABILITY PROVEN`, no executed differential) is written to stay true whether or
not that diff ever lands, so do not treat "the matrix says CAPABILITY PROVEN" as license to
quietly commit the port fix and call the row done — a real differential still needs the
smoke test re-run + a full `pb prove` merge-vs-parent leg pair, live.

**Engine-track state (context carried over, unchanged by this pass):** the postgres/canvas
harness capability (browserdrive shift-click, widened introspection, settle debounce,
multipart/exec/headers/origin setup+confirm steps) is implemented, tested, and committed
clean. The documenso #3031 recipe was rewritten into a real discriminating differential
(`parent_sha` added, verified against the actual tree at both SHAs — the field-group
shift-click handler is the only changed code — plus the full HTTP/exec setup dance) and
committed (`366cbc8`). Two live smoke-test attempts of `conjure()` both failed on
infrastructure, not recipe logic: (1) this sandbox's host port 3000 is intercepted by an
unrelated Gitea instance ahead of Docker's own container; (2) after moving to
`published_port` 3010, `conjure.mjs`'s compose-mode bring-up never actually parameterizes
the real Docker port publish from recipe fields — it comes from the checked-out
`compose.yml`'s own `3000:3000`, so the ready-check polled a dead port. The fix
(`compose.override.mem.yml` sets `PORT=3010` + an additional `3010:3010` mapping;
recipe.json's `container_port`/`published_port` both 3010) is written but uncommitted and
NOT yet re-verified live. Docker confirmed clean (no orphaned containers) after both
attempts. **Next action:** commit the port fix, re-run the smoke test end to end
(bring-up + full setup dance), then attempt the actual merge-vs-parent differential.

---

## SESSION 2026-07-21 — READ THIS BLOCK FIRST (2026-07-20's interrupted resume order is now ALL DONE)

**Governance unchanged:** repo-root `CLAUDE.md` + `docs/ROADMAP.md` stay binding. Current gate:
**G1 tail only** (second engine, npm distribution, getting-started doc, launch-page stacks matrix)
— G0 is now fully closed.

**DONE this session (all committed, tree green throughout: 182/182 tests + gate PASS + typecheck
clean):**
- Finished R1 slice A + landed slice B directly on `product-v1` (not merged from the banked
  branches below — those turned out stale, rebuilt clean instead): `04e8d21` slice A typecheck fix
  · `18f579f` generic effect binding + generic confirm leg in `catch.mjs` (recipe-declared
  `store_tap.observables`, engine-shaped delta relations, browserdrive cookie-inject wired into
  `runCatch`) · `01a9f24` migrate n8n #7130/#9157 + linkding recipes to the slice-B contract.
- Linkding gap-closing fixes to make the recipe actually run live (form+CSRF capture instead of
  JSON-only POSTs, confirm-leg type coercion, quantifier-lint guidance, pagination-aware JSONPath):
  `bcc9dbe`..`6f4b0b3`.
- **R1 proof case EXECUTED LIVE** (`4d9fd37`): `pb prove recipes/linkding-default-mark-shared-pr1170`
  → merge `6c874aff`=WORKS (k=2, fresh worlds) ∧ parent `723b843c`=DOES_NOT_WORK (kFail=2/2,
  falsified) — the first non-n8n differential Catch (Django/sqlite stack), closing R1's proof-case
  bar. Sealed receipts committed under `site/cases/`.
- **Re-gate n8n #7130 + #9157 post-migration** (`faeee96`): both differentials re-run on the new
  generic path. #7130 matched the committed verdicts on the first run (merge=WORKS ∧
  parent=CND). #9157 did NOT match on its first run — both legs came back CND (the live
  claude-CLI proposer returned a malformed/mismatched walk on one leg; `catch.mjs`'s
  propose-once-freeze calls the seam exactly once per leg with no retry, so a single bad
  proposal collapses the whole leg to CND). Confirmed this was proposer flakiness, not a
  migration regression, by reading `catch.mjs`/`proposer.mjs` (the migration commits never
  touched `validateArgs`/`validateClaim`) then re-running the SAME differential with zero code
  changes: merge=WORKS ∧ parent=DOES_NOT_WORK (kFail=2/2), matching the previously committed
  evidence exactly. Fresh sealed receipts committed either way (`faeee96`'s message discloses
  the retry). **Known gap surfaced, not yet fixed:** the live claude-CLI proposer path has no
  retry on a malformed single proposal — a future slice should either retry-once-per-leg or
  widen `validateProposal`'s tolerance, since today one bad LLM reply costs a CND instead of a
  WORKS/DNW (an adoption-metric hit: CND rate, not a false-WORKS).
- **Site + README truth pass** (`caca762`): hero + certificate lead with the #9157 catch, not a
  green PASS; three real case blocks (#9157 catch, #1170 second catch, #7130 earned-green/CND) each
  linked to committed `site/cases/*.json`; README verdicts traced to committed evidence.
- **ROADMAP checked off:** R0 "Execute n8n #9157" (this one was actually executed live back in the
  *prior* session's `655c794` — the checkbox had simply never been ticked, a pre-existing instance
  of the same drift this pass is fixing), "README truth pass", "Site truth pass"; R1 "Conjure/recipe
  surface (slice A)", "Generic effect binding", "Generic confirm leg". G0 is now fully checked off.

**Stale WIP banked from the 2026-07-20 interrupt — superseded, no action needed:**
- Branch `r1-slice-a` (tip `04e8d21`) — fully merged, ancestor of `product-v1` HEAD. Its real finish
  landed as fresh commits directly on `product-v1`.
- Branch `worktree-agent-aabff673d6f3ed387` (tip `928b5f4`, broken mid-refactor slice B) — **NOT**
  merged, abandoned as planned; slice B was rebuilt clean on `product-v1` (`18f579f`) rather than
  untangled. Safe to delete whenever convenient.
- Branch `wip-site-truth-pass` — fully merged, ancestor of HEAD; the real site pass landed as
  `caca762` instead.
- `git stash@{0}` referenced by the 2026-07-20 block — no longer relevant; superseded by the above.

**RESUME ORDER (next session) — items (1)-(5) from 2026-07-20 below are ALL DONE, and so is the
launch-page matrix (see the 2026-07-21 (b) block above). What's left is G1's tail:** (1) second
engine EXECUTED — documenso #3031 now has a real discriminating recipe + harness capability
committed (`366cbc8`/`375964f`), but the live differential is BLOCKED on an uncommitted conjure
port fix, not yet re-verified (see 2026-07-21 (b) block); (2) npm distribution (publish as
`proofbench`, drop `private:true`, version from git tag, `npx proofbench gate` cold); (3)
getting-started doc — DONE, see `docs/getting-started.md`. Then move to G2.

---

## SESSION 2026-07-20 — spend-limit interrupt (superseded — see 2026-07-21 block above)

**Governance:** repo-root `CLAUDE.md` (agent constitution) and `docs/ROADMAP.md` (R0–R4 gates)
are now BINDING and committed (`d107bed`). Work ONLY the current gate. Do not pivot, do not
redesign, do not touch the frozen core. Current gate: **finish G0 remainder, then G1 (R1)**.

**DONE this session (all committed, main tree green 163/0 + gate PASS + typecheck clean):**
- `d107bed` constitution + roadmap + README truth fix · `ffacf74` R0 mechanical (package renamed
  **proofbench** (npm-free, bin `pb`), `private:true` dropped, Apache-2.0 LICENSE, DEFERRED.md,
  dead-code deleted: orgconfig.mjs + lyric/manifest-adapter.mjs — resurrect from `6c1754d` at R3).
- `655c794` **G0 KEY ITEM: the FIRST parent=DOES_NOT_WORK catch EXECUTED LIVE** — n8n #9157:
  merge `6c63cd97`=WORKS (k=2, fresh-REST confirm) ∧ parent `91e59120`=DOES_NOT_WORK (same walk
  ran, no execution row, FALSIFIED kFail=2/2, NOT CND). Sealed receipts committed at
  `site/cases/n8n-respondwebhook-formtrigger-pr9157.{merge,parent}.json`. **CORRECTION to the
  2026-07-18 note below:** the n8n-1.38 build blocker was NEVER a sqlite3 native-rebuild quirk —
  root cause = the runtime stage's `pnpm rebuild` runs from /home/node with no packageManager
  pin, so `corepack@latest` resolves pnpm 11.x which refuses Node 18; fix = 3rd build_overlay
  line `corepack install -g pnpm@8.14.3` (the tree's own pin). Also: the V1 formTrigger serves
  at `$parameter["path"]/n8n-form`, NOT the node webhookId — workflow.json sets path=UUID.
- `2320b05` ROADMAP R1 empirically grounded + `24f60a7` **linkding #1170 recipe = the R1 proof
  case** (cold-Sonnet trial, src/ frozen): blockers hit for real = no `docker build --target`
  (fatal), JSON-only setup steps (Django CSRF 403 — needs form encoding + HTML token capture),
  setup cookies never reach the browser drive, placeholder hard-required in front_door. Full
  ranked list in ROADMAP R1.

**INTERRUPTED by the org monthly spend limit (3 agents killed mid-flight) — WIP banked:**
- Branch `r1-slice-a` @ `18de342` — R1 slice A (conjure/recipe: --target, form/html-capture
  setup, cookie handle contract, optional placeholder, confirm schema). State: 173/173 tests
  passed at interrupt; remaining = typecheck fixes in test/recipe.test.mjs (possibly-undefined
  guards at lines ~183-197) + final commit polish. NEARLY DONE.
- Branch `worktree-agent-aabff673d6f3ed387` @ `928b5f4` — R1 slice B (generic effect binding).
  State: browserdrive cookie-inject done; **catch.mjs is MID-REFACTOR AND BROKEN** (dangling
  EFFECT_ENTITY/SETTLE refs). Early WIP — consider restarting slice B from the brief in
  ROADMAP R1 rather than untangling, reusing its browserdrive.mjs part.
- `git stash@{0}` on product-v1 — partial site truth pass (site/index.html mid-edit; branch
  `wip-site-truth-pass` marks the base). R0 site+README truth pass NOT done.
- Worktree checkouts were removed (they polluted `node --test` globbing); the branches hold
  everything. NOTE: never leave a broken worktree under .claude/worktrees/ — `node --test`
  sweeps it.

**2026-07-20 PRODUCT AUDIT (founder-requested, post-interrupt):** fundamentals confirmed
right — NO rewrite, ever. Gaps are coverage/cost/onboarding, all additive: ROADMAP gained
a binding **Adoption metrics** block (named-unblock rate 100%, CND rate, verdict
wall-clock, time-to-first-verdict), five new R2 items (sealed-room minimum, CI intent
source = PR title/body, `--merge-only` CI mode, concurrent-run isolation, plus `pb init`
already there), adoption blockers B1–B7 in the issue register, and CLAUDE.md gained "The
adoption bar." Gate order R0→R4 UNCHANGED; resume order below UNCHANGED.

**RESUME ORDER (next session):** (1) finish slice A on `r1-slice-a` (typecheck) → merge to
product-v1; (2) redo/finish slice B against the merged slice-A contract (handle.cookies =
[{name,value}]; confirm[] schema = setup[] schema) → merge; (3) migrate BOTH n8n recipes'
confirm arrays (slice B's report must specify; else derive from freshReadExecution semantics);
(4) LIVE validations: `pb prove` linkding (expect merge=WORKS ∧ parent=DNW), re-gate #7130 +
#9157 byte-identical; (5) finish site+README truth pass (stash@{0}); (6) then G1 remainder
(second engine, npm publish, getting-started, launch page).

---

## The goal (what we are building)

A tool that, when an AI agent says a change is done, returns **proof — not the agent's word —
that a real user can do the thing, across every service it touches**: a tri-state verdict
(WORKS / DOES NOT WORK / COULD NOT DETERMINE) the writing agent **cannot fake**, backed by
replayable evidence. One-stop, three phases: **code works → deployed & healthy → works as
intended (behavioral)**. Runs on the user's own infra; onboarding is agentic. Full vision:
`docs/product-plan.md`. This branch is greenfield — do NOT resurrect the old code on `main`.

## The soul (principles — must stay baked into the code, not prose)

1. **Propose / dispose.** The agent *proposes* (interpretation, actions, narration — fallible);
   a deterministic harness *disposes* (executes, captures out-of-band, seals, computes the
   verdict). The agent can never write the verdict, forge harness evidence, or touch the seal.
2. **Asymmetry.** Agent unreliability can *cost* a WORKS (→ CND) but must **never manufacture a
   false WORKS**. `false-WORKS = 0` is the one release-blocking metric.
3. **Honest by default.** CND unless proven; reproduce k/N to convict; verdict set LAST from
   sealed, harness-provenance receipts only.
4. **Every line earns its place.** No stubs, no one-off scripts, no filler. An honest CND is
   fine; a fake value is not.

Full property + the six mandatory mechanizations (M1–M6) and the false-WORKS vector list
(FW-1…FW-20): `docs/phase-3-theory.md` (§0–§2 property + mechanisms; §7 M1–M6; §8 readiness).

## What is DONE and VERIFIED (by hand, not just builder claims)

- **Honesty core + E1 gate** (`src/`): evidence/verdict/seal, zero-dependency (Node built-ins).
  Deterministic tri-state verdict; real ed25519 seal (tamper → UNVERIFIED). Commit `cffcb7b`.
- **Phase runners + fixtures + adversarial suite**: `src/phases/phase{1,2,3}.mjs`,
  `fixtures/shop-{honest,lying}`, `test/adversarial/`. Commit `41614e9`.
- **Propose/dispose made STRUCTURAL** (`src/harness.mjs` mint + `newBundle` forces `agent`): a
  fabricated `'harness'`-labelled receipt is downgraded to `agent` → verdict CND; the new
  `forge-harness-provenance` driver proves it. Fresh-session confirm leg content-bound (MUST-2);
  type gate runnable + green (MUST-3). Commit `086dbfb`. A surgical audit found propose/dispose
  was only *conventional* (a fabricated `'harness'` receipt reached WORKS); this pass closed it —
  the "principles in the soul, not prose" bar.
- **Verified:** `node --test` → **32/32**; `node src/cli.mjs gate` → **PASS** (10 malicious
  drivers held ≤ not-WORKS; honest → WORKS). `pb phase3 fixtures/shop-lying` →
  **DOES_NOT_WORK** naming the response-vs-store mismatch; `shop-honest` → **WORKS** (k=2).
  Adversarial attacks (lying cache-read, forged delta, owner-shadow, vacuous negative,
  async-rollback, **seed-match null-delta**) all held — no false-WORKS.
- **Corpus** (`corpus/`): the 12 blind battle-test cases; `false-WORKS = 0` = release gate.
- **Phase-correctness validation vs the 12-PR corpus** (`docs/phase-validation-2026-07-18.md`):
  ultracode workflow (Fable-5 planned complex/core/product → one rubric; 6 Opus auditors, one per
  contract phase P1–P6; every break adversarially verified). Found ONE **LIVE false-WORKS in the
  built core** — a null-delta `equals`/`unchanged` tautology: `evalEffect` never rejected a no-op
  and `relationHolds('equals')` ignores `before`, so a genuine harness delta with `before==after`
  reached WORKS. The E1 gate missed it because all 9 drivers used `op:'increased'`. **FIXED**
  (`verdict.mjs`: a null delta may FALSIFY but never CONFIRM — "absence is a catch", §12.8,
  preserved & re-verified by the `rule 2` test) + locked by E1 driver `seed-match-null-delta` and
  adversarial `(e)`/`(e-sanity)` tests. `false-WORKS=0` is honest-green again. Full per-phase
  verdict + remaining roadmap in the validation doc.
- **Proof arc, all committed:** `86826eb` clean scratch → theory `9d8efed` → battle-test #1
  `1bc4d27` → campaign `f289c00` (12 blind PRs, honesty 12/12) → corpus `5bf6200` → core
  `cffcb7b` → runners `41614e9`.

## Architecture (where things live)

```
src/types.mjs      typed contracts + provenance ranks (agent<tool<harness)
src/evidence.mjs   content-address (sha256), bundle, seal/verifySeal (ed25519)
src/verdict.mjs    the deterministic tri-state truth-table (the honesty spine)
src/e1/            malicious-driver suite (drivers.mjs) + gate (gate.mjs)
src/phases/        phase1 (repo tests) · phase2 (compose health) · phase3 (HTTP-driven Catch)
src/cli.mjs        `pb` dispatcher: gate | phase1 | phase2 | phase3
fixtures/          shop-honest / shop-lying (two-service HTTP app w/ a planted coupon bug)
test/              verdict, e1, phase1, phase3 + test/adversarial/
```

## How to VERIFY (any session, from repo root)

```
node --test                  # expect 32/32
node src/cli.mjs gate         # expect GATE: PASS (10 malicious held incl. forge-harness-provenance, seed-match-null-delta = CND)
npm i && npm run typecheck    # authoritative type gate — pinned @types/node 20.19.43 → clean
node src/cli.mjs phase3 fixtures/shop-lying  --intent "coupon SAVE20 => total 20% less"  # DOES_NOT_WORK
node src/cli.mjs phase3 fixtures/shop-honest --intent "coupon SAVE20 => total 20% less"  # WORKS (k=2)
```

**Type gate authority:** `npm run typecheck` (pinned `@types/node` 20.19.43 + lockfile) is the
green, authoritative gate. Editor LSP diagnostics from a *different* ambient `@types/node`
(e.g. `phase3` `child.on`, a fixture's `IncomingMessage.signal`) are version-mismatch artifacts,
not defects — point the editor at the workspace TypeScript/types to silence them.

## NEXT (the bounded v1 — finishable; do NOT chase breadth)

1. **Core-fundamentals surgical pass — DONE** (`086dbfb` structural propose/dispose; then the
   2026-07-18 phase-validation found + FIXED the null-delta `equals` tautology, keeping 32/32 +
   gate PASS). No churn-for-taste.
2. **Verdict-contract slices the validation surfaced.** **(a) DNW not k-gated — DONE** (`b9f4325`):
   rule 2 now convicts only when the failure reproduced (`reproduce.kFail >= 2`), else CND; `kFail`
   is a SEPARATE failure count in phase1/phase3 (reusing `reproduce.k`, which counts successes,
   would flip `shop-lying`→CND — that trap is why it's separate). **(b) Owner-shadow on
   non-quantified effects (FW-P1-B) — NOT a verdict-layer fix (tried, reverted, proven unsound).**
   A verdict-only `identity === actorIdentity` floor on non-quantified effects OVER-FIRES on
   legitimate single-actor effects: `phase1`'s `suite-passes` effect runs as `identity:'ci'` under
   `actorIdentity:'ci'`, so the floor flipped an honest WORKS→CND (empirical proof a string floor
   can't tell owner-shadow-masking from a genuine single-actor effect). The right home: **rule 5
   already catches owner-shadow for `quantified` claims** — a *generalizable* user capability should
   be marked `quantified` by the **P1 compiler** (unbuilt); a genuinely non-quantified effect is not
   an owner-shadow risk. So FW-P1-B is a **P1-compiler responsibility + capture-side auth-context**
   (which front door / independent session — the signal that distinguishes the trap from a single
   actor lives on the drive/capture side, not the verdict). Land it WITH that slice, not before.
3. **BUILD ARCHITECTURE — decided 2026-07-18 (Fable-designed, Akash-approved).** Strategic call:
   BUILD THE SURFACE, don't harden the core speculatively (the FW-P1-B revert is empirical proof a
   latent fix ahead of its surface is wrong code; theory §8 wants an *executed* case next; the core
   is honest-green for every reachable path). Dependency rule (Akash): no hard zero-dep rule, but no
   "whole-world" deps in pb — **the project-under-test's own deps live in its conjure/container, not
   in pb**. Concrete (all keep pb's runtime deps at ZERO; trust core `verdict.mjs`/`harness.mjs`
   stays FROZEN):
   - **Store tap (persisted leg):** `docker exec <ctr> sqlite3 -json <db> "<static query>"` (or
     `psql` for Postgres SUTs) — reads the store file out-of-band = HARNESS provenance (NOT the app's
     endpoint, §1.1/§4); sqlite CLI overlaid into the SUT image by the recipe. No pb DB dep.
   - **Browser drive:** a containerized `selenium/standalone-chromium` sidecar driven over **W3C
     WebDriver (JSON over `fetch`)** — browser deps live in a container like the SUT's; customer-
     portable. No pb browser dep (Playwright-as-pb-dep rejected).
   - **Setup recipe:** a per-repo `pb-recipe-v1` JSON (generalizes `fixtures/*/pb-fixture.json`) —
     build-from-tree@SHA, conjure, out-of-band tap cmd, fresh-world recreate, disclosed REST setup,
     front-door URL. The **walk stays agent-proposed** (never recipe data — avoids the Gherkin grave).
   - **REPO-AGNOSTIC, NEVER OVERFIT TO n8n (Akash, 2026-07-18).** n8n is case **#1 of N**, not THE
     case — the pipeline is recipe-driven (no repo hardcoded in `conjure/storetap/drive`) and
     **verification RANDOMLY PICKS a recipe from the corpus pool each run**, so any n8n-specific
     assumption surfaces immediately. Grow the pool across the 12-PR corpus (a SQLite AND a Postgres
     repo, a form AND a CRUD/admin front door). A repo whose surface isn't built yet (canvas =
     documenso, egress = ghost, very-big = posthog/sentry) declines to **honest CND** — never a
     forced n8n-shaped fit. The release gate runs the FULL pool; iteration random-picks.
4. **Real-repo Catch roadmap (M1→M7).** First target **n8n #7130** (single-process, plain-DOM Form
   Trigger, SQLite store; merge SHA `3ddc176dfa2d3d99a328a29a3a8613e35ff456a0`, n8n@1.12.0);
   cal.com is the evidence-picked fallback if conjure is infeasible. **Progress:** M1 spike ✅
   CONJURE FEASIBLE (`m1-n8n/RECIPE-FACTS.md`) · **M2 ✅ `870ffb8`** (`src/recipe.mjs` loader +
   `recipes/n8n-form-trigger-pr7130/`) · **M3 ✅ `fcd2d4d`, hand-verified** (`src/conjure.mjs` +
   `pb conjure`: builds real n8n from-tree, mints code-identity fingerprint = P3-1 landed, form
   serves; note from-tree build is NOT bit-reproducible → git SHA is the stable identity,
   image_digest is a per-build attestation) · **M4 ✅ `0538fa3`** (`src/storetap.mjs`: `docker exec
   sqlite3` out-of-band delta, mints the persisted leg). **ANTI-OVERFIT UNIT ✅ COMPLETE + PROVEN
   LIVE (§3):** pool = **n8n (run/sqlite/http-drive) + documenso (compose/postgres/canvas-drive-
   deferred)**, both conjure LIVE, hand-verified. Slice A ✅ `41c6dca` (recipe contract + psql tap
   generalized off n8n: conjure.mode run|compose, engine-discriminated store_tap sqlite|postgres,
   drive descriptor; documenso recipe) · Slice B ✅ `2d2771e` (`conjure.mjs` mode-aware: `docker
   compose up` for the Postgres class; documenso up live, /api/health 200, psql tap Field=0
   out-of-band) · random-pick ✅ `5c7d799` (`src/pool.mjs` listRecipes/pickRandom + `pb conjure
   --random`). documenso's Konva-canvas drive was CND-deferred, now **✅ FEASIBLE** (spike `5bd6ed8`: a W3C-Actions
   `clickAt`/`pointer` coordinate capability in `browserdrive.mjs` placed a Field on the real Konva canvas →
   psql tap `"Field"` 0→1 = a 2nd EXECUTABLE Catch target, genuinely NOT n8n-shaped; runCatch wiring
   [cookie-inject + `NEXT_PUBLIC_WEBAPP_URL=host.docker.internal` env + a two-psql-tap addFields walk + flip
   `drive.mode:browser`] is the documented follow-up in `docs/documenso-canvas-spike.md`). **DIFFERENTIAL GROUNDING (2026-07-18
   via gh) — documenso #3031 is NOT a simple-walk differential:** it = `feat: add field multiselect` (touches
   only the field renderer + e2e tests), so the Field infra PRE-EXISTS at parent `977d0733` → a place-a-Field
   walk persists a Field at BOTH merge+parent (non-discriminating = a fake Catch). So documenso is a proven
   CAPABILITY / 2nd-engine target (postgres+canvas, anti-overfit value banked) but a real documenso
   DIFFERENTIAL needs the multiselect-specific walk OR a different discriminating documenso PR — do NOT force
   a non-discriminating Catch. **medusa spike** (3rd repo, Postgres+
   Redis) was still building/paused at pause-time — bonus, not a blocker; fold in if it lands.
   **M5 ✅ DONE + PROVEN LIVE** (`src/browserdrive.mjs` + `test/browserdrive.test.mjs`): containerized
   `selenium/standalone-chromium:4.27.0` sidecar driven over W3C WebDriver as JSON over `fetch` (ZERO pb
   browser dep — Playwright-as-dep stays rejected), repo-agnostic primitive-op client (navigate/find/
   click/type/text/execute/teardown) whose WALK is caller-scripted (agent-proposed, never recipe-baked —
   avoids the Gherkin grave), `localhost`→`host.docker.internal` rewrite so the container reaches the
   host-published SUT, TOOL-provenance minted attempt receipt (ground truth stays the harness store tap).
   **owner-shadow now *testable***. Hand-proven LIVE end-to-end: real chromium → conjured n8n rendered Form
   Trigger → typed+submitted THROUGH the browser → out-of-band sqlite tap showed `execution_entity` 0→1
   status=`success` (row workflowId == conjure's captured workflow_id) → minted tool attempt → clean
   teardown (no orphans, port freed). 76/76 tests + gate PASS + typecheck clean. **M6 ✅ DONE + PROVEN LIVE — the first EXECUTED differential Catch** (`src/catch.mjs` + `pb prove`;
   commits `e35f056` conjure buildSha override + recipe parent_sha · `7392314` Catch harness · `ee75f6a`
   differential runner · `30387b7` walk hardening). `node src/cli.mjs prove recipes/n8n-form-trigger-pr7130`
   → **DIFFERENTIAL: PASS** — merge `3ddc176d`→WORKS (k=2 fresh worlds, each persisted an execution + a
   genuinely FRESH REST confirm leg re-observed the same id) vs parent `869b8f14`→CND whose reason NAMES the
   feature-absent cause (`Node not found: n8n-nodes-base.formTrigger` → workflow won't activate), NOT a
   harness artifact. **catch.mjs honesty (hand-verified):** a feature-absent reproduction (conjure/drive
   throws) → `executed:false` → counts toward NEITHER k nor kFail → CND, never a false DNW; merge-WORKS is
   no tautology (`op:'increased'` on the execution id needs a real non-null delta + a content-bound fresh
   leg + k≥2). 82/82 tests + gate PASS + typecheck clean; honesty core FROZEN (git-confirmed). Deferred to
   M7: the negative claim + quantifier/owner-shadow. **M6 TARGET (grounded 2026-07-18 via gh):** n8n #7130 =
   `feat(n8n Form Trigger Node): New node` — merge `3ddc176d` HAS the node (form serves → browser-drive
   submit persists an `execution_entity` row → WORKS) vs its SINGLE parent
   `869b8f14caaf334f011bcd87d3928dc8ab41f62e` where the FormTrigger node type does NOT exist → the
   recipe's workflow.json fails to activate / the form 404s → the SAME walk cannot execute → CND ≠ WORKS
   = clean anti-tautology (the PR IS why it works). M6 needs a small `conjure` SHA-override to build the
   parent from-tree; the differential is MEASURED, and if a target ever fails to discriminate, honest-CND
   and pick another corpus PR.) **M7 ✅ DONE (hardening the executed Catch):** `runCatch` now SEALS the
   assembled bundle (ed25519) + PERSISTS it to a run dir + RE-READS that on-disk artifact through a new
   `sealedVerdict` gate → the judgement is bound to tamper-evident evidence (mutate a persisted receipt →
   UNVERIFIED, proven live) — the seal-stripping latent fix, landed WITH its surface (`7fb6717`). Plus 4
   `catch-*` adversarial drivers mirroring the real Catch shape (each cheats one leg: forged-harness delta,
   app-read-as-delta, null-delta tautology on the id, stale confirm leg) — all held ≠WORKS in `pb gate`
   (now 14 malicious), `da82fc2`. 96/96 tests + gate PASS + typecheck clean + live differential RE-CONFIRMED on the sealed `runCatch` path
   (`pb prove` → merge WORKS ∧ parent CND, sealed receipts persisted to disk); honesty core FROZEN. **P1 ✅ FIRST CUT DONE — the walk is now AGENT-PROPOSED** (`src/proposer.mjs` +
   `runCatch` wiring, commit `445a601`; Fable-architected): a Sonnet agent reads the intent + a HARNESS-run
   introspection snapshot → proposes a validated `{walk, claim}` (Anthropic Messages API over `fetch`, NO
   SDK, forced `propose_walk` tool; injectable `llmFn` seam) → the harness executes / taps / assembles-with-
   the-PROPOSED-claim / seals / verdicts. **mint-boundary landed WITH its surface:** `proposer.mjs` imports
   NEITHER `mint` NOR `sealBundle` (pure data); the proposed claim can only POINT at harness-minted receipts.
   Honesty proven by ADVERSARIAL mock proposals: FW-P1-A tautology + FW-P1-B static-diff → null-delta guard →
   CND; FW-P1-D `execute`/`navigate` → validator rejects → CND; FW-P1-E quantifier-dodge → ADD-only intent-
   lint → rule 5 → CND (FW-P1-C claim-substitution bounded to ∅ for n8n's single-observable recipe). Mock
   end-to-end differential PASS (merge=WORKS ∧ parent=CND, claim FROM the proposal) — INDEPENDENTLY
   RE-CONFIRMED live (fresh workflowIds, k=2, docker clean). 114/114 tests, gate PASS,
   typecheck clean, honesty core FROZEN. **STILL DEFERRED:** owner-shadow INSTANTIATION capture (≥2 distinct
   non-actor sessions + a confirmed negative — capture-side, NOT a verdict floor); an adaptive re-propose loop
   (must reset the world per retry); and **M5 = the real-Sonnet capability live proof.** TWO proposer seams now exist (commit `63f7bd9`):
   `defaultLlmFn` (Anthropic API — needs `ANTHROPIC_API_KEY`, UNSET; and this env sets a custom
   `ANTHROPIC_BASE_URL` the API path would have to honor) and **`claudeCliLlmFn` — the PRIMARY path: a real
   Sonnet via the local `claude` CLI on the SUBSCRIPTION (no key), cold neutral cwd + `--disallowedTools`, the
   reply STILL gated by `validateProposal`.** `pb prove` auto-selects claude-cli when no key (or force
   `PB_PROPOSER=claude-cli`). **M5 CAPABILITY ✅ PROVEN (2026-07-18):** a REAL cold Sonnet (a `model:sonnet` subagent given ONLY the
   intent + introspection + observables, 0 tools — exactly what the seam sends) proposed `type
   input[name="field-0"] → click submit`, claim `execution_entity.max_id increased`; RELAYED through the seam
   (so `validateProposal` gated it) it drove the LIVE differential → **merge `3ddc176d`=WORKS (k=2, real
   executions persisted, fresh-REST confirm agrees) ∧ parent `869b8f14`=CND (feature-absent)** = DIFFERENTIAL
   PASS, docker clean. So the FULL product loop (plain intent → conjure → REAL agent proposes the walk →
   harness disposes → unfakeable merge-vs-parent verdict) is proven END-TO-END. **M5 AUTONOMOUS HEADLESS ✅ PROVEN
   (2026-07-18) — the mechanical residual is CLOSED:** pb now invokes the LLM headless ALL BY ITSELF via
   `claudeCliLlmFn` — `node src/cli.mjs prove recipes/n8n-form-trigger-pr7130` auto-selects claude-cli when
   no `ANTHROPIC_API_KEY`, spawns `claude -p` in a cold neutral cwd, the real Sonnet proposes the
   `{walk, claim}`, `validateProposal` gates the reply, and the harness drives the differential →
   **DIFFERENTIAL PASS RE-VERIFIED** (merge `3ddc176d`=WORKS, k=2 real executions persisted + fresh-REST
   confirm ∧ parent `869b8f14`=CND feature-absent), docker clean. **Seam confirmed LIVE / NO-CACHE** — a
   fresh headless `claude -p` spawn each run, not a replayed transcript. The one-time unblock that closed
   it: `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` → pb's nested `claude -p` auths headless
   indefinitely (the earlier "OAuth session expired" is gone; pb code never touches the token). So the FULL
   product loop is proven AUTONOMOUS end-to-end: one command → conjure → pb's OWN headless Sonnet proposes
   the walk → harness disposes → unfakeable merge-vs-parent verdict.
   **DIFFERENTIAL VALIDITY VERIFIED — #7130 parent=CND is HONEST, not a hollow Catch (2026-07-18,
   `docs/differential-validity-2026-07-18.md`):** a challenge asked whether "Node not found" on the parent
   leg means pb is broken (a FALSE CND). REFUTED from ground truth — #7130 = `feat(n8n Form Trigger Node):
   New node`, merge `3ddc176d` has EXACTLY ONE parent `869b8f14`; GitHub /files shows it ADDS
   `packages/nodes-base/nodes/Form/FormTrigger.node.ts` (+`.node.json`, `form.svg`, `interfaces.ts`,
   `utils.ts`, all status `added`) + MODIFIES `package.json` to register the node; the contents API for
   `FormTrigger.node.ts` @ `869b8f14` returns HTTP 404 = ABSENT at parent. So parent=CND (`Node not found`
   at activation — n8n validates node types at activation, not creation → the form never comes up → the
   walk cannot execute → `executed:false` → counts toward NEITHER k nor kFail → CND, never a false DNW) is
   a GENUINE feature-absent condition, honest tri-state. The PASS is real. **The REAL limitation it
   exposes:** #7130 is an ADDITIVE-PR differential — parent=CND is the STRONGEST possible result for a
   new-node PR (absent code cannot be behaviorally tested), but pb has NOT yet EXECUTED a MODIFYING/BUGFIX-PR
   differential where the parent RUNS the same walk and returns **DOES_NOT_WORK** (walk ran, effect went
   missing). That is the differential with teeth.
   **NEXT EXECUTABLE PROOF — a modifying-PR parent=DNW differential (judge-chosen 2026-07-18): n8n #9157**
   `fix(Respond to Webhook Node): Fix issue stopping form trigger response` — merge
   `6c63cd971162d3f018b210d221ffc2a56535550a`, VERIFIED single parent
   `91e59120c49802bbeb545809527d223af1967f9d` (~n8n 1.38.0, Apr 2024). A `+3/-1` MODIFYING diff (adds
   `n8n-nodes-base.formTrigger` to a new `WEBHOOK_NODE_TYPES` allow-list, gated `if (nodeVersion >= 1.1)`).
   Reuses the EXACT proven Form Trigger browser front door (ZERO new drive capability) and the identical
   self-contained `docker/images/n8n-custom/Dockerfile` conjure already builds (`ARG N8N_RELEASE_TYPE=dev`
   present). The move that gives it teeth: the workflow's own `settings {saveDataErrorExecution:"none",
   saveDataSuccessExecution:"all"}` turns the parent's mid-execution `NodeOperationError` into a MISSING
   `execution_entity` row → **merge=WORKS** (row persists, `max_id` increased + fresh-REST confirm) **∧
   parent=DOES_NOT_WORK** (walk ran, `executed:true`, but no row → `"increased"` FALSIFIES → kFail=2/2) — a
   BEHAVIORAL failure, structurally distinct from #7130's feature-absent CND. Build recipe dir
   `recipes/n8n-respondwebhook-formtrigger-pr9157/` by cloning the proven recipe and changing ONLY
   `code_identity` (SHAs above) + `workflow.json` (Form Trigger → RespondToWebhook typeVersion 1.1,
   `responseMode:responseNode`, the `saveData*` settings). Build-time residuals only (normal for from-tree):
   OMIT `build_overlay` first (this SHA has NO `corepack` anchor line → `overlayDockerfile` throws; add one
   only on a real integrity-key failure), confirm the FormTrigger `responseMode` value + the
   `/webhook/{id}/…` suffix at 1.38. Fallbacks: **#10992** (browser-driven Wait-node variant, era 1.61,
   buildable now) and **#33022** (cleanest NATIVE row-count differential BUT needs a new pre-docker-build
   compile stage conjure lacks — n8n 2.28 dropped the self-contained Dockerfile). Run: `node src/cli.mjs
   prove recipes/n8n-respondwebhook-formtrigger-pr9157`.
   **Second engine (documenso) — `ready:false`:** postgres+canvas capability banked (browser-drive
   reaches/manipulates the real Konva canvas; psql tap `"Field"` 0→1 live) but a real documenso DIFFERENTIAL
   is BLOCKED — PR #3031 = `feat: add field multiselect` touches only the Shift+click multi-select renderer,
   so a place-one-field walk is NON-DISCRIMINATING (merge=WORKS ∧ parent=WORKS, correctly reported as
   no-PASS, not a wiring bug). A discriminating documenso Catch needs the multiselect-specific walk (#3031's
   own e2e `runShiftClickMultiSelectFlow`) PLUS new harness surface (cookie-inject in `browserdrive.mjs`; a
   postgres-shaped delta in `catch.mjs`, whose row/max-id logic is sqlite/n8n-shaped today; a documenso
   confirm leg — the current one calls n8n-only REST routes; multipart bodies + per-step headers +
   cross-service captures in recipe setup). Not a drop-in. **Lyric (ENG-17397) — cluster-gated:** headless
   auth is fully ready (gh `0prodigy` + `mic` DE-JWT headless re-mint + `akashpathak` static client-cert)
   but the base-coherent lyriclet `akashpathak` (ns `delta`, `k8s-attach`) is HIBERNATED; waking it is the
   mutating, confirmation-gated `mic byoc power akashpathak start` — CANNOT run headless. See item 6.** Ponytail: one recipe, ≤2 store adapters, 3 drive
   primitives — generality earned per case. The from-tree SUT image stays cached → warm conjure ~6s.
5. **Phases 1–2 to production shape** (code-works, deployed-healthy) on the same class — after M6.
6. **QUEUED MAJOR PHASE — Lyric k8s-attach dogfood (ENG-17397)** (Akash, 2026-07-18; "after" the OSS
   Catch). Point pb at a REAL Lyric multi-repo + dev-package change: ENG-17397 = Actions/Stages/
   Controls across **7 repos** (appservice `ENG-17397-action-and-interrupts`, metadata-service,
   mosaic-function-stage-control [new], mosaic-function-scenario, lyric-py/lyric-runner-py
   `ENG-17398` dev-pinned wheels, ui-monorepo) + db-migrations + Nuclio functions (see
   `~/lyric/.tickets/ENG-17397/branches.json`). This is the FIRST **Lyric class** (k8s-attach
   substrate), complementing the OSS docker-compose class — same `pb-recipe-v1` contract, new modes.
   **GAP RECON DONE (2026-07-18, architect vs the real tree) — framing CORRECTED:** the Lyric side
   has pb-shaped *shape* (recipe-equivalent `~/lyric/.tickets/ENG-17397/appservice/ready.yaml` with
   attach targets + drive verbs + L3–L5 checks + honest not-run; `lyric-devops/scripts/lyric-mongo.sh`
   = genuine out-of-band Mongo tap; `evidence/*/manifest.json` schema-2 `substrate:k8s-attach` + `pins`
   image-digest/k8s-ctx/repo-SHA + `artifacts` provenance/sha256/exitCode; the `lyric-qa` 12-op drive).
   BUT it is **UNIFY the contract + evidence semantics, REBUILD the execution against the new core** —
   NOT "unify, not build from zero." Because: (i) the schema-2 emitter / k8s-attach substrate exists
   NOWHERE in `~/lyric` source — it is the **external OLD pb v0.1.0**, zero shared code with product-v1;
   (ii) every Lyric manifest is `selfAttested:true` with **NO seal**, provenance a plain string = exactly
   the forgery the new core downgrades to `agent` (`evidence.mjs:78-83,107-113`); (iii) NO L4/L5
   behavioral verdict has EVER executed (all 7 recorded runs are L3-health / phase-1 / cluster-unreachable);
   (iv) `k8s-attach` conjure + `mongo`(+clickhouse/redis) store engine are NEW recipe surface (`recipe.mjs`
   is `from_tree|pinned_image` / `run|compose` / `sqlite|postgres`); `drive:note-lifecycle` is already in
   the enum (EXTENDS, not new); (v) `fresh_world:recreate` + reproduce-k≥2 do NOT map to a shared BYOC
   cluster. **DNW CONFIRMED SOUND + a clean differential (static-verified):** `expireStageControls`
   (`appservice/.../executions.helper.ts:441`) does an unscoped `.filter({executionId,status in
   [queued,running]})`; `metadata-service/.../stage-control.schema.ts` has NO `@AuthValidation` (the
   diagnosis's primary fix LANDED on-branch) → merge-SHA=WORKS (controls expire on terminal + user-action
   email + ack-proceed), parent-SHA=stuck-`queued` DNW. Target the natural-completion terminal path for the
   WORKS leg; cancel-path (parent-vs-note id, `executions.service.ts:478`) + executor-`ack` are SEPARATE
   DNW probes. **BIGGEST RISK = the BYOC substrate itself:** base-skew (known-failures F3) + reconcile-revert
   (F2) can manufacture a FALSE `DOES_NOT_WORK` before pb's logic runs — de-risk FIRST via a `lyric-devops`
   base-coherence preflight (hard L3 gate) + re-read the deployed image digest AT DRIVE TIME and seal THAT,
   not the pre-run pin. **Code-identity: derive the fingerprint from FILES not prose — and the FILES have
   traps (build step (a) DONE — draft resolved them: `docs/lyric-eng17397-recipe-draft.md`, committed
   `8b57440`):** `branches.json` holds branch NAMES not SHAs (resolve the 7 real SHAs via `git rev-parse`
   on the ticket worktrees); the MAIN-worktree wheel versions are STALE (`mds-sdk 1.8.1.dev17397`,
   `lyric_py 1.3.39.dev17398`) — bind the coherent TICKET-worktree values (`lyric_py 1.3.40.dev17398`,
   `mds-sdk 2.0.4.dev17399`, co-located with the SHAs); cluster ctx/ns is operator-supplied (prose
   `redcat/redcat` vs manifest `akashpathak/delta`); `branches.json` lists db-migrations NOT ui-monorepo.
   The draft also enumerated the 6 `recipe.mjs` growth items (multi-repo code-identity, k8s-attach conjure,
   mongo tap, new-note-per-iteration fresh-world, operator-env setup, REST front-door). **TWO HUMAN DECISIONS before the phase starts:** (1) reproduce model
   on a shared cluster — new note/exec per iteration (rec: preserves k≥2) vs relaxed-k; (2) drive surface —
   appservice API + mongo (rec: matches today's assets) vs adding the ui-monorepo end-user leg (not built/
   fingerprinted today). **Cheapest-failure-first order:** (a) ✅ DONE — paper `ready.yaml`→`pb-recipe-v1` draft (`8b57440`);
   (b) ✅ DONE — schema-2 manifest → minted+sealed receipts adapter (`src/lyric/manifest-adapter.mjs`,
   `f50d02b`): on a REAL ENG-17397 manifest → honest **CND** (L3-health/not-run, no write-set delta), and
   **anti-laundering PROVEN** (a declared-`harness` app-curl caps to tool; a plain relabel floors to agent —
   only `mint()` yields harness; a real `lyric-mongo.sh` out-of-band read correctly stays harness) → "unify
   the evidence semantics on real Lyric data" HOLDS, no cluster needed. **NEXT (cluster-GATED — needs
   `lyric-devops` + a base-coherent BYOC lyriclet, CANNOT run from here):** (c) `k8s-attach` conjure +
   `mongo` store engine [medium]; (d) operator-supervised live `pb verify --ratify` [medium, destructive-
   gated] — with the F3/F2 base-coherence preflight FIRST.

**Deferred = scale-later (honest CND until built):** universal conjure of arbitrary systems
(the open-ended part — CONJURE is "never proven complete, only progressively hardened"),
native-client drive (AppFlowy), giant multi-service apps (PostHog/Sentry), the corpus
breadth-validation across all repos, the hosted ledger. Open vectors: FW-12 (fixture-world
divergence), FW-14 (config divergence), O1–O4 in `docs/phase-3-theory.md` §7.

## Operating constraints (live)

- **Spend limit** has interrupted background builds twice — always use **resumable workflows**
  and commit each verified slice immediately, so a kill loses nothing.
- Fable runs only as a subagent; Sonnet is the intended production driver (the theory must stay
  Sonnet-executable — that's what M1–M6 are for).
- reddit.com / x.com are blocked to the web crawler.

## Cross-session memory

The durable index is `~/.claude/.../memory/product-experience-first-pivot.md` (points here).
Update both this file and that memory at the end of a session.
