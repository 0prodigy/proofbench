# Proofbench

> When an AI agent says a feature is done, get **proof, not its word**, that a real user
> can actually do the thing — as a verdict the agent **cannot fake**, with evidence you
> can **replay**.

## What it is

pb is the verification layer between an AI agent's claim of "done" and a human's (later:
policy's) approval to deploy. The agent only ever **proposes** — the interpretation of a
plain-English intent, the walk to try; a deterministic **harness disposes** — it brings
your real system up, drives it, reads the persisted effect out-of-band, seals the
evidence, and computes one of three verdicts by fixed rules the agent cannot touch:
**WORKS · DOES NOT WORK · COULD NOT DETERMINE**, bound to the exact code (SHA or image
digest) that ran. Uncertainty is the honest default — a failure must reproduce (k≥2 from
a fresh world) to become a conviction, so the agent's own unreliability can only ever cost
you a WORKS, never manufacture a false one. pb never implements a change and never
deploys it.

## Install / quickstart

`proofbench` is on the npm registry — no clone needed to run the honesty gate:

```
npx proofbench gate
```

or install the `pb` CLI globally:

```
npm i -g proofbench
pb gate
```

`pb gate` runs the E1 malicious-driver honesty gate — deterministic, Docker-free,
network-free, seconds to run — and is the install smoke test. Everything past `gate`
(`conjure`, `prove`) needs Docker and an agent (the `claude` CLI or `ANTHROPIC_API_KEY`);
see [docs/getting-started.md](docs/getting-started.md) for prerequisites.

The npm package ships only `src/` (the engine) — `recipes/` and `fixtures/` do not ship.
To author recipes or run the shipped example recipes, clone the repo instead:

```
git clone -b product-v1 https://github.com/0prodigy/proofbench.git && cd proofbench
node src/cli.mjs gate
```

(The repo's default branch, `main`, predates this rewrite and is historical only — clone
`product-v1` explicitly, as above.)

## Four differential catches, executed live and sealed

Every case below ran the identical agent-proposed walk twice — once built at the PR's
merge SHA, once at its parent — so the verdict pair proves the PR itself, not just the
repo in general, is why it works (`merge = WORKS ∧ parent ≠ WORKS`). Each pair is
committed as a sealed, ed25519-signed evidence bundle under `site/cases/`; see
[docs/integration.md](docs/integration.md) for the case-file format.

- **n8n #9157** — merge [`6c63cd97`](site/cases/n8n-respondwebhook-formtrigger-pr9157.merge.json)
  = WORKS ∧ parent [`91e59120`](site/cases/n8n-respondwebhook-formtrigger-pr9157.parent.json)
  = DOES NOT WORK (falsified, reproduced 2/2) — the first live regression catch: a form
  submit's execution row goes missing at the parent SHA.
- **linkding #1170** — merge [`6c874aff`](site/cases/linkding-default-mark-shared-pr1170.merge.json)
  = WORKS ∧ parent [`723b843c`](site/cases/linkding-default-mark-shared-pr1170.parent.json)
  = DOES NOT WORK (reproduced 2/2) — a second repo, a different stack (Django + sqlite,
  not Node).
- **n8n #7130** — merge [`3ddc176d`](site/cases/n8n-form-trigger-pr7130.merge.json) =
  WORKS ∧ parent [`869b8f14`](site/cases/n8n-form-trigger-pr7130.parent.json) = COULD NOT
  DETERMINE — the earned green: the feature is simply absent at the parent, not broken.
  Interactive, self-verifying case file at `site/case.html`.
- **documenso #3031** — merge [`97835b8d`](site/cases/documenso-envelope-fields-pr3031.merge.json)
  = WORKS ∧ parent [`977d0733`](site/cases/documenso-envelope-fields-pr3031.parent.json)
  = DOES NOT WORK (kFail=2/2) — a second execution engine (Postgres tap + a real Konva
  `<canvas>` browser drive): the identical shift-click-multiselect walk leaves 2 field
  rows instead of 1 at the parent, because its click handler ignores Shift and replaces
  the selection instead of extending it.

## What's supported today

- **Docker is the one shipped substrate** — `conjure.mode: 'run'` (a single container,
  e.g. n8n) or `'compose'` (a multi-service graph, e.g. documenso's app + postgres +
  inbucket). No Kubernetes, no cloud account, no `pb`-managed cloud infra.
- **Code identity:** build from source at an exact SHA (`from_tree`, with an optional
  `parent_sha` for the differential), or pin an already-built image by digest
  (`pinned_image`).
- **Store tap** (the out-of-band, harness-only read of the persisted effect): a sqlite
  file inside the container, or a separate Postgres container via `docker exec`.
- **Drive:** an HTTP walk, or a real click/type/click walk through a pinned Chromium
  sidecar.
- **Honest CND, not silent failure**, outside that shape: no Dockerfile / not
  container-buildable, Kubernetes / a live cluster (designed, then excised as unwired
  surface — see `DEFERRED.md`), serverless/managed backends, and mobile/native front
  doors all decline today, naming exactly what's missing rather than guessing a verdict.

## Learn more

- [docs/getting-started.md](docs/getting-started.md) — recipe authoring, the full
  `pb-recipe-v1` field walkthrough, and what a verdict means, worked end to end.
- [docs/integration.md](docs/integration.md) — the integration contract for wiring pb
  into a pipeline: the recipe field reference, the substrate-selector/registry seam,
  the adapter contract, exit codes, the sealed case-file format, and a CI sketch.
- `site/index.html` — the launch page (the four catches above, a supported-stacks
  matrix, and the honesty model in more depth); `site/case.html` is a live, offline
  self-verifying case file you can open directly.

Agents working in this repo read `CLAUDE.md` first — it is binding.
