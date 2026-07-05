# Proofbench Spec — `spec/v0`

This directory contains the versioned JSON Schema (draft 2020-12) definitions for the two core Proofbench documents. The schemas are the **interoperability contract**: any tool that produces or consumes these documents — the `pb` CLI, the hub renderer, third-party runners — must conform to them.

---

## Documents

### `ready.schema.json` — Readiness Manifest

Governs `ready.yaml`, the per-repo declarative spec of how a service becomes runnable and testable on any substrate. A manifest answers: what are this service's dependencies, how do you start it, how do you know it's healthy, how do you exercise it, and what must be true for the run to be valid?

Key design principle: **derive, don't restate.** A manifest points into existing truth (compose files, devcontainer.json, AGENTS.md) via `sources` rather than duplicating it.

Required top-level fields: `service`, `run` (specifically `run.modes`).

### `evidence-v2.schema.json` — Evidence Bundle Manifest

Governs `evidence/<runId>/manifest.json`, the machine-checkable record of one verification run. A bundle answers: what was claimed, what was exercised, what was observed, and what is the verdict?

Required top-level fields: `schema` (must be `2`), `runId`, `claim`, `phase`, `startedAt`, `artifacts`, `verdict`.

---

## Versioning policy

`spec/v0` is **frozen once the `v0` tag is pushed to the repository.** After that point:

- **Additive changes only within a version:** new optional fields may be added; no existing field may be removed, renamed, or have its type narrowed; no new required fields may be added to an already-released schema.
- **Breaking changes require a new version directory** (`spec/v1`, etc.) with a new `$id` URI and a migration note in this README.
- **The Go types in `internal/evidence/types.go` and `internal/manifest/types.go` are the source of truth.** Any discrepancy between those types and these schemas is a bug in the schemas, not the types.

---

## Annotated examples

### `ready.yaml` — full annotated example

```yaml
# ready.yaml (schema: proofbench/spec/v0/ready.schema.json)

# Required: short identifier used as a key in workspace.yaml and in log output.
service: orders-api

# Optional: one-sentence description for auto-generated docs and agent context.
role: REST API for order lifecycle

# sources: derive, don't restate. The harness reads these files to extract
# deps, healthchecks, and env rather than duplicating them here.
sources:
  compose: ./docker-compose.yml
  devcontainer: .devcontainer/devcontainer.json
  agentsmd: ./AGENTS.md

# run: required. Declares supported substrates and the start/probe recipe.
run:
  # modes: at least one required. Substrates this service can run on.
  modes: [local, compose, k8s-attach]

  # local: bare-process start recipe (required when 'local' is in modes).
  local:
    start: npm run dev
    env:
      # file: load a .env-style file into the process environment.
      file: .env.local
      # overrides: applied after the file; may use ${resources.<name>.host}.
      overrides:
        DB_HOST: "${resources.db.host}"

  # ready: k8s readiness-probe vocabulary. The harness polls until healthy.
  # Specify exactly one of http / tcp / exec.
  ready:
    http: ":8080/healthz"
    timeout: 60s

# resources: Score-style typed deps, resolved per substrate via the 'via' map.
# Placeholder ${resources.<name>.host} is available in env overrides.
resources:
  db:
    type: postgres
    via:
      compose: postgres
      k8s: svc/orders-db
  queue:
    type: kafka
    via:
      k8s: svc/kafka
    optional: false
  auth-svc:
    type: service
    repo: ../auth-service
    via:
      k8s: svc/auth

# seed: ordered steps that prepare the data layer.
# Steps run in declaration order after their 'after' deps complete.
seed:
  - name: schema
    run: npm run db:migrate
    after: [db]
  - name: fixtures
    run: npm run db:seed -- --tiny
    after: [schema]

# drive: real product entrypoints. Exercise the actual product path,
# not a look-alike or curl one-liner.
drive:
  create-order:
    run: ./scripts/create-order.sh
    identity: env:USER_EMAIL   # inject identity from env
    output: json

# checks: declared validation surfaces. Each check names its proof-ladder
# level and the predicates that must hold.
checks:
  - name: order-roundtrip
    level: L4                  # L4 = effect verified (data/API probe)
    exercise: drive.create-order
    expect:
      - "exitCode(order-roundtrip)==0"
      - "http(http://localhost:8080/orders)==200"
      - "rows(orders.json)>0"
  - name: e2e-ui
    level: L5                  # L5 = end-to-end observed
    exercise: playwright tests/e2e/order.spec.ts
    expect:
      - "exitCode(e2e-ui)==0"
    artifacts: [screenshot, recording]

# gates: human approval required before destructive/irreversible steps.
# An unapproved gate yields 'inconclusive' in the evidence bundle — never a fake pass.
gates:
  - on: deploy
    reason: "cluster release is irreversible"

# known_walls: failure traps with symptom + cause + recovery.
# Agents consult this before spending time debugging.
known_walls:
  - symptom: "401 from artifact registry"
    cause: "token expiry"
    recover: "gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin gcr.io"
```

---

### `manifest.json` — full annotated example

```jsonc
// evidence/20260704-101500-reverify/manifest.json

{
  // schema: must be 2 for evidence bundle v2.
  "schema": 2,

  // ticket: optional issue reference.
  "ticket": "ENG-20190",

  // runId: unique, human-readable. Convention: <YYYYMMDD>-<HHMMSS>-<phase>.
  "runId": "20260704-101500-reverify",

  // claim: one sentence — what this run is trying to prove.
  "claim": "sync(verse) propagates to sequenceNote on release",

  // phase: one of repro | verify | reverify | fix | report.
  "phase": "reverify",

  // kind + pairsWith: explicit before/after pairing by runId.
  // Never infer pairing from naming conventions.
  "kind": "after",
  "pairsWith": "20260702-144606-verify",

  // surface: free-form map of where this ran.
  "surface": {
    "substrate": "k8s-attach",
    "cluster": "delta-akash",
    "env": "delta"
  },

  // pins: exact versions/SHAs of everything exercised — makes the run reproducible.
  "pins": {
    "repo": "appservice@abc123",
    "image": "dataservice:redcat@sha256:deadbeef"
  },

  // proofLevel: highest proof-ladder rung reached.
  // L0=static-valid L1=builds L2=unit-green L3=healthy L4=effect-verified L5=e2e
  "proofLevel": "L4",

  "startedAt": "2026-07-04T10:15:00Z",
  "finishedAt": "2026-07-04T10:56:12Z",

  // checks: every declared check must appear. Use "not-run" rather than omitting —
  // never default-green.
  "checks": [
    {
      "name": "order-roundtrip",
      "state": "pass",          // tri-state: pass | fail | not-run
      "level": "L4",
      "expect": "db.orders.rows > @before",
      "observed": "42 > 17",   // actual value evaluated against predicate
      "artifacts": ["03-fire", "sn-post"]
    },
    {
      "name": "e2e-ui",
      "state": "not-run",       // explicitly not-run, not omitted
      "reason": "gate: cluster deploy pending"
    }
  ],

  // artifacts: all captured files. Set at verdict-seal time.
  "artifacts": [
    {
      "type": "command",        // command | snapshot | screenshot | log | recording | link
      "name": "03-fire",
      "path": "03-fire.log",
      "sha256": "a3f1c2...",    // hex SHA-256 for tamper-evidence
      "provenance": "harness", // harness (auto-captured) | agent (agent-supplied)
      "meta": {
        "cmd": "./scripts/create-order.sh",
        "exitCode": 0,
        "durationSec": 41
      }
    },
    {
      "type": "snapshot",
      "name": "sn-post",
      "path": "sn-post.json",
      "sha256": "7b2d9a...",
      "provenance": "harness",
      "meta": {
        "table": "orders",
        "rowsBefore": 17,
        "rowsAfter": 42
      }
    }
  ],

  // verdict: set last, after all artifacts and checks are evaluated.
  // pass | fail | inconclusive  (inconclusive = could not run, e.g. gate blocked)
  "verdict": "pass",

  // note: optional annotation on the verdict.
  "note": "set last, from artifacts"
}
```

---

## Proof ladder

Every evidence bundle names the highest rung it reached. The ladder encodes the lesson that "schema-valid != runs" and "exit code 0 != effect verified":

| Level | Name | What it proves |
|---|---|---|
| L0 | static-valid | Document parses and validates against this schema |
| L1 | builds/loads | Service binary or image was built without errors |
| L2 | unit-green | Unit/integration test suite passed |
| L3 | up+healthy | Service started and readiness probe returned healthy |
| L4 | effect-verified | A drive verb ran and a data/API/UI effect was observed |
| L5 | end-to-end observed | Full user journey exercised end-to-end |

A bundle that does not reach its declared check's level must record the blocking check as `not-run` with a `reason`, and set `verdict` to `inconclusive`.
