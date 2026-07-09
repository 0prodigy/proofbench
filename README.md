# Proofbench

**The system of record for agent proof** — an open harness AI coding agents use to prove their changes work, functionally and end-to-end, on any company's setup, backed by portable evidence bundles.

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

Requires Go 1.23+.

```
git clone https://github.com/launchwings/proofbench
cd proofbench
go build -o bin/pb ./cmd/pb
```

Add `bin/` to your `PATH`, or copy `bin/pb` to `/usr/local/bin`.

---

## 60-second walkthrough

### 1. Generate a manifest

```
pb init
```

Auto-detects your repo (Procfile, compose file, `package.json` scripts, `AGENTS.md`) and writes `ready.yaml`. Edit it to taste — or use the generated manifest as-is for a first run.

### 2. Bring the service up

```
pb up --substrate local
```

Starts the service described in `ready.yaml` on the local substrate (bare process). Use `--substrate compose` to use Docker Compose instead.

### 3. Wait for readiness

```
pb ready
```

Polls the probe declared in `run.ready` until it passes or times out.

### 4. Seed data

```
pb seed
```

Runs each step in `seed[]` in dependency order.

### 5. Run a verification

```
pb verify --ticket ENG-123 --claim "orders endpoint persists to disk"
```

Executes every `checks[]` entry in the manifest, wraps each command in the capture harness, evaluates the declared predicates, and writes an evidence bundle under `evidence/`.

Output:

```
bundle:  evidence/20260704-101500-verify
proof:   L4
verdict: pass
  [pass] up
  [pass] order-roundtrip
```

### 6. Render a report

```
pb report evidence/20260704-101500-verify
```

Prints a Markdown report for the bundle — paste it into a PR comment or ticket.

### 7. Build a hub index

```
pb hub
```

Writes `.pb/hub/index.html` — an HTML index over every bundle under `evidence/`. Open it in a browser to browse all runs.

---

## GitHub Action

`action.yml` at the repo root wraps `pb verify` for CI — raise a PR, get end-to-end proof as a workflow artifact.

```yaml
- uses: launchwings/proofbench@main
  with:
    manifest: ready.yaml
    substrate: local
    working-directory: .
    evidence-dir: .proofbench/evidence
```

`@v0` will be the pinned ref once the first tagged release lands; until then, use `@main`.

The step's own exit code follows the bundle's `verdict` (from `manifest.json`), not `pb`'s raw exit status: `pass` succeeds, `fail` always fails the job, and `inconclusive` fails the job too unless you set `allow-inconclusive: 'true'` — an unproven change must not read as green. The evidence bundle is uploaded as a workflow artifact on every run (`if: always()`), and the step exposes `verdict` and `bundle-path` outputs for later steps (e.g. a PR comment).

---

## Non-goals

Proofbench is **not**:

- A CI system. It runs inside the agent loop pre-merge; CI can also invoke it, but it doesn't replace CI.
- A sandbox or runtime (E2B, Daytona, Modal). It runs on top of those via substrate adapters.
- A human test-authoring tool (Momentic, QA Wolf). Agent-generated durable automation — committed checks and specs verified by the harness — is explicitly in scope (ADR-0001).
- An agent. Agent-agnostic by design — bring Claude Code, Cursor, Codex, or OpenHands.

---

## Docs

- [PLAN.md](PLAN.md) — roadmap and design rationale
- [docs/adr/](docs/adr/) — architecture decision records
- [docs/prd-stage1.md](docs/prd-stage1.md) — Stage 1 PRD (OSS wedge)
- [docs/backlog.md](docs/backlog.md) — backlog
- [CONTEXT.md](CONTEXT.md) — project context
- [spec/](spec/) — manifest and evidence bundle schemas (v0)

---

## Status

v0 harness working and validated against a real production ticket; Stage 1 (the OSS wedge) is in progress. Spec and bundle format are under active development; breaking changes expected before v1.
