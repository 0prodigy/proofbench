# Proofbench

**The system of record for agent proof.** AI coding agents say a change works; Proofbench proves it — functionally, end-to-end, on your real infrastructure — and writes a portable evidence bundle the harness collects, never the agent's own narration. Bring your own agent, your own compute; Proofbench is the harness in between.

Two pillars:

1. **Readiness manifest** (`ready.yaml`) — a per-repo declarative spec of how a service becomes runnable and testable: dependencies, seed data, health probes, drive verbs, and validation surfaces. The same manifest works locally, in containers, or attached to your own cluster — substrate selected at runtime.

2. **Evidence engine** — a capture harness that produces a schema'd, portable evidence bundle: command logs with exit codes, before/after data snapshots, API responses, execution IDs — attached to the PR or ticket and rendered by a local hub. The harness collects the evidence; not the agent's narration.

**How it fits your stack.** Proofbench is agent-agnostic — any agent drives it via the CLI or MCP. It is substrate-pluggable: the same manifest runs on `local`, `compose`, or `k8s-attach` (driver families per ADR-0005). And it covers both delivery shapes: **shape A** (you build, we prove) today, and **shape B** (the agent builds, deploys, and proves — Stage 2).

---

## Proof ladder

Every `pb verify` run names the rung reached. A report that doesn't name a rung is not a proof.

| Level | Name | What it means |
|-------|------|---------------|
| L0 | static-valid | Manifest parses and passes schema validation |
| L1 | builds/loads | Service builds or loads without errors |
| L2 | unit-green | Unit tests pass |
| L3 | up+healthy | Service starts and health probe returns 200 |
| L4 | effect-verified | A drive verb produced an observable effect (data row, API response) |
| L5 | end-to-end observed | Full user-facing flow exercised and confirmed |

---

## Install

No clone required — pick one of the first two.

**Go users** (needs Go 1.23+):

```
go install github.com/0prodigy/proofbench/cmd/pb@latest
```

**Everyone else** — one-line installer (downloads the right prebuilt binary from the latest GitHub release):

```
curl -sSL https://raw.githubusercontent.com/0prodigy/proofbench/main/install.sh | sh
```

**Prebuilt binaries** are on the [releases page](https://github.com/0prodigy/proofbench/releases) if you'd rather grab one by hand.

**Build from source** (fallback):

```
git clone https://github.com/0prodigy/proofbench
cd proofbench
go build -o bin/pb ./cmd/pb
```

Add `bin/` to your `PATH`, or copy `bin/pb` to `/usr/local/bin`.

---

## 60-second quickstart

[`examples/basic`](examples/basic/) is a minimal HTTP order-capture service with a `ready.yaml` already written — no Docker required. This is the actual output of running it:

```
cd examples/basic
pb up --substrate local --manifest ready.yaml
```
```
up: basic-orders (local)
```

```
pb ready --manifest ready.yaml
```
```
ready: http :8391/healthz ok
```

```
pb verify --manifest ready.yaml --ticket ENG-001 --claim "orders endpoint appends to orders.json"
```
```
{"status":"ok"}
{"status":"created"}
bundle:  evidence/20260710-053615-verify
proof:   L4
verdict: pass
note:    2 pass, 0 fail, 0 not-run
  [pass] up
  [pass] order-roundtrip
```

```
pb down --manifest ready.yaml
```
```
down: basic-orders (pid 56419) stopped
```

`pb report evidence/20260710-053615-verify` prints a Markdown report for the bundle — paste it into a PR comment or ticket. `pb hub --root evidence --out .pb/hub/index.html` writes an HTML index over every bundle under `evidence/`.

For your own repo instead of the example, run `pb init` — it auto-detects your project (Procfile, compose file, `package.json` scripts, `AGENTS.md`) and drafts a `ready.yaml` to edit to taste. See the [full quickstart](docs/quickstart.md) for every step in detail, including seeding and the hub index.

---

## GitHub Action

`action.yml` at the repo root wraps `pb verify` for CI — raise a PR, get end-to-end proof as a workflow artifact. The repo is public, so this reference works as written:

```yaml
- uses: 0prodigy/proofbench@v0
  with:
    manifest: ready.yaml
    substrate: local
    working-directory: .
    evidence-dir: .proofbench/evidence
```

`@v0` tracks the current v0 release line; `@main` works before the first tag lands.

The step's own exit code follows the bundle's `verdict` (from `manifest.json`), not `pb`'s raw exit status: `pass` succeeds, `fail` always fails the job, and `inconclusive` fails the job too unless you set `allow-inconclusive: 'true'` — an unproven change must not read as green. The evidence bundle is uploaded as a workflow artifact on every run (`if: always()`), and the step exposes `verdict` and `bundle-path` outputs for later steps (e.g. a PR comment). Full reference: [the CI docs](https://0prodigy.github.io/proofbench/docs/ci.html).

---

## Non-goals

Proofbench is **not**:

- A CI system. It runs inside the agent loop pre-merge; CI can also invoke it, but it doesn't replace CI.
- A sandbox or runtime (E2B, Daytona, Modal). It runs on top of those via substrate adapters.
- A human test-authoring tool (Momentic, QA Wolf). Agent-generated durable automation — committed checks and specs verified by the harness — is explicitly in scope (ADR-0001).
- An agent. Agent-agnostic by design — bring Claude Code, Cursor, Codex, or OpenHands.

---

## Docs

The docs site is live at **https://0prodigy.github.io/proofbench/**. Start here:

- [docs/quickstart.md](docs/quickstart.md) — the full walkthrough this README's 60-second version is drawn from, including seeding and the hub index
- [examples/basic/](examples/basic/) — the runnable example service + `ready.yaml` used above
- [manifest reference](https://0prodigy.github.io/proofbench/docs/manifest.html) — full field-by-field `ready.yaml` reference, generated from the schema
- [CI reference](https://0prodigy.github.io/proofbench/docs/ci.html) — the GitHub Action end to end
- [spec/](spec/) — the versioned `ready.yaml` / evidence bundle JSON Schemas (v0), the interoperability contract
- [CONTRIBUTING.md](CONTRIBUTING.md) — build/test commands and the package map

Design rationale and roadmap:

- [PLAN.md](PLAN.md) — roadmap and design rationale
- [docs/adr/](docs/adr/) — architecture decision records
- [docs/prd-stage1.md](docs/prd-stage1.md) — Stage 1 PRD (OSS wedge)
- [docs/backlog.md](docs/backlog.md) — backlog
- [CONTEXT.md](CONTEXT.md) — project context

---

## License

Apache-2.0 — see [LICENSE](LICENSE). The evidence bundle format is open and portable; export your data any time.

---

## Status

v0 harness working and validated against a real production ticket; Stage 1 (the OSS wedge) is in progress. Spec and bundle format are under active development; breaking changes expected before v1.
