# Quickstart

This guide walks through a full Proofbench verification in about 60 seconds using the `examples/basic` service — a minimal HTTP server with an `/healthz` endpoint and a `POST /orders` endpoint that appends to a JSON file. No Docker required.

---

## Prerequisites

- Go 1.23 or later
- `curl` (for the drive verb in the example)

Build the CLI:

```
git clone https://github.com/launchwings/proofbench
cd proofbench
go build -o bin/pb ./cmd/pb
export PATH="$PWD/bin:$PATH"
```

---

## Step 1 — Explore the example

```
ls examples/basic/
```

```
main.go     ready.yaml     README.md
```

`main.go` is an HTTP server on port 8391. `ready.yaml` declares how to bring it up, how to exercise it, and what to verify.

---

## Step 2 — Generate your own manifest (optional)

For your own repo, run:

```
pb init
```

Proofbench auto-detects your project (Procfile, compose file, `package.json` scripts, `AGENTS.md`) and writes a `ready.yaml` draft. For this walkthrough we use the one already in `examples/basic/`.

Expected output:

```
ready.yaml
```

---

## Step 3 — Bring the service up

```
cd examples/basic
pb up --substrate local --manifest ready.yaml
```

This runs the `start` command from `run.local.start` in the manifest (`go run .`).

Expected output:

```
starting basic-orders (local)
```

---

## Step 4 — Wait for readiness

```
pb ready --manifest ready.yaml
```

Polls the probe declared in `run.ready` (`http :8391/healthz`) until it returns 200 or times out.

Expected output:

```
ready: http :8391/healthz -> 200 OK
```

---

## Step 5 — Seed data (if applicable)

```
pb seed --manifest ready.yaml
```

Runs each step in `seed[]` in dependency order. The basic example has no seed steps, so this is a no-op:

```
seed: no steps declared
```

---

## Step 6 — Run a verification

```
pb verify \
  --manifest ready.yaml \
  --ticket ENG-001 \
  --claim "orders endpoint appends to orders.json"
```

Proofbench:

1. Creates an evidence bundle directory under `evidence/`.
2. Executes each check declared in `checks[]`.
3. Wraps every command in the capture harness (tee + exit code recorded).
4. Evaluates the `expect` predicates.
5. Writes the bundle manifest (`manifest.json`) and seals it.

Expected output:

```
bundle:  evidence/20260704-101500-verify
proof:   L4
verdict: pass
  [pass] up
  [pass] order-roundtrip
```

A non-zero exit code means at least one check failed or the verdict is not `pass`. The bundle is written regardless — an honest fail is still evidence.

---

## Step 7 — Read the report

```
pb report evidence/20260704-101500-verify
```

Prints a Markdown report you can paste into a PR comment or Jira ticket:

```markdown
# Evidence bundle: 20260704-101500-verify

**Claim:** orders endpoint appends to orders.json
**Ticket:** ENG-001
**Proof level:** L4
**Verdict:** pass

## Checks

| Name | State | Expect | Observed |
|------|-------|--------|----------|
| up | pass | http(http://localhost:8391/healthz)==200 | 200 |
| order-roundtrip | pass | exitCode(order-roundtrip)==0, rows(orders.json)>0 | exit 0, 1 row |

## Artifacts

- `01-up.log` (command, harness)
- `02-order-roundtrip.log` (command, harness)
```

---

## Step 8 — Build a hub index

```
pb hub --root evidence --out .pb/hub/index.html
```

Writes an HTML index over every bundle under `evidence/`. Open `.pb/hub/index.html` in a browser to browse all runs for this repo.

Expected output:

```
.pb/hub/index.html
```

---

## Bring the service down

```
pb down --manifest ready.yaml
```

Stops the process started by `pb up`.

---

## What's in an evidence bundle?

```
evidence/20260704-101500-verify/
  manifest.json          # schema v2: checks, artifacts, verdict, proof level
  01-up.log              # captured stdout+stderr from the health check drive
  02-order-roundtrip.log # captured stdout+stderr from the order drive verb
```

`manifest.json` is the source of truth. It records:

- The claim and ticket.
- The proof-ladder level reached (`L0`–`L5`).
- Each check: name, state (`pass|fail|not-run`), expect predicate, observed value.
- Each artifact: type, path, SHA-256, provenance (`harness` vs `agent`).
- The verdict, set last from the check results.

The format is open. See `spec/` for the JSON Schema.

---

## Next steps

- Add your own `ready.yaml` to a real service.
- Add drive verbs that exercise real product entrypoints.
- Add `L4` checks that assert observable effects (rows in a database, API responses, file contents).
- Use `pb evidence run` and `pb evidence assert` in shell scripts to build checks outside the manifest.
- Use `--substrate compose` to run against Docker Compose instead of bare processes.
