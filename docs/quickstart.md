# Quickstart

This guide walks through a full Proofbench verification in about 60 seconds using the `examples/basic` service — a minimal HTTP server with an `/healthz` endpoint and a `POST /orders` endpoint that appends to a JSON file. No Docker required.

Every command and output block below is pasted verbatim from a real run of `bin/pb`, in order — copy-paste the whole page and you'll get the same shape of result (bundle paths and timestamps will differ). The rendered version of this walkthrough, plus a guide for onboarding your own repo from scratch, lives at [site/docs/quickstart.html](../site/docs/quickstart.html) and [site/docs/onboard-your-repo.html](../site/docs/onboard-your-repo.html).

---

## Prerequisites

- Go 1.23 or later
- `curl` (for the drive verb in the example)

Build the CLI:

```
git clone https://github.com/0prodigy/proofbench
cd proofbench
go build -o bin/pb ./cmd/pb
export PATH="$PWD/bin:$PATH"
```

A clean build prints nothing and exits 0.

---

## Step 1 — Explore the example

```
ls examples/basic/
```

```
main.go     README.md     ready.yaml
```

`main.go` is an HTTP server on port 8391. `ready.yaml` declares how to bring it up, how to exercise it, and what to verify.

---

## Step 2 — Generate your own manifest (optional)

For a repo of your own that doesn't have a `ready.yaml` yet:

```
pb init
```

Proofbench auto-detects project shape from what's already there (Docker Compose files, a `Procfile`, `package.json` scripts, a `Makefile`, `go.mod`) plus a best-effort grep for a health-check path and port, and writes a draft. Fields it can't confidently derive (most commonly `run.local.start`) come back as a literal `TODO` placeholder that `pb lint` refuses to pass — by design, not a bug. Real output from a fresh service directory:

```
ready.yaml
next steps:
  1. edit ready.yaml — set start:, ready:, and a checks: block
  2. pb lint          # validate the manifest
  3. pb verify        # bring up, exercise, produce an evidence bundle
```

For this walkthrough we use the manifest already checked in at `examples/basic/`. For the full field-by-field walkthrough of turning a fresh `pb init` scaffold into a passing `L4` verdict, see [Onboard your repo](../site/docs/onboard-your-repo.html) and the [ready.yaml reference](../site/docs/manifest.html).

---

## Step 3 — Bring the service up

```
cd examples/basic
pb up --substrate local --manifest ready.yaml
```

This runs the `start` command from `run.local.start` in the manifest (`go run .`).

Real output:

```
up: basic-orders (local)
```

---

## Step 4 — Wait for readiness

```
pb ready --manifest ready.yaml
```

Polls the probe declared in `run.ready` (`http :8391/healthz`) until it returns healthy or times out.

Real output:

```
ready: http :8391/healthz ok
```

---

## Step 5 — Seed data (if applicable)

```
pb seed --manifest ready.yaml
```

Runs each step in `seed[]` in dependency order. The basic example declares none, so this is an honest no-op rather than a silent skip:

```
seed: no seed steps declared
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

Real output:

```
{"status":"ok"}
{"status":"created"}
bundle:  evidence/20260710-054110-verify
proof:   L4
verdict: pass
note:    2 pass, 0 fail, 0 not-run
  [pass] up
  [pass] order-roundtrip
```

The two JSON lines are the real captured stdout of the `up` check's `curl` and the `order-roundtrip` drive verb's `curl`, streamed as the harness runs them — not narration. `note:` is a one-line pass/fail/not-run tally; on a fail it also names the failing checks, and each `[fail] <name>` line carries its own reason after an em dash (see the k8s-attach fixture example further down, or [Onboard your repo](../site/docs/onboard-your-repo.html#when-verify-fails) for a full failing run).

`pb verify` exits `0` only when every check passed and the verdict is `pass`; a non-zero exit means at least one check failed. The bundle is written regardless — an honest fail is still evidence.

---

## Step 7 — Read the report

```
pb report evidence/20260710-054110-verify
```

Prints a Markdown report you can paste into a PR comment or Jira ticket. Real output:

```markdown
✅ **PASS** — orders endpoint appends to orders.json

proof level L4 · phase verify · substrate=local

| check | state | expect | observed |
|---|---|---|---|
| up | pass | http(http://localhost:8391/healthz)==200 | status=200 |
| order-roundtrip | pass | exitCode(order-roundtrip)==0 && rows(orders.json)>0 | exitCode=0; rows=1 |

**Artifacts**

- `up`, exit 0, 0.0s
- `order-roundtrip`, exit 0, 0.0s

`orders.json` persists between runs, so a second verify reports `rows=2` — delete it (and `evidence/`) to reset the example.

---
`evidence/20260710-054110-verify` · run `20260710-054110-verify`
```

---

## Step 8 — Build a hub index

```
pb hub --root evidence --out .pb/hub/index.html
```

Writes an HTML index over every bundle under `evidence/`. Open `.pb/hub/index.html` in a browser to browse all runs for this repo.

Real output:

```
.pb/hub/index.html
```

---

## Bring the service down

```
pb down --manifest ready.yaml
```

Stops the process started by `pb up`. Real output:

```
down: basic-orders (pid 66143) stopped
```

---

## What's in an evidence bundle?

```
evidence/20260710-054110-verify/
  manifest.json          # schema v2: checks, artifacts, verdict, proof level
  01-up.log              # captured stdout+stderr from the health check drive
  02-order-roundtrip.log # captured stdout+stderr from the order drive verb
```

`manifest.json` is the source of truth. It records:

- The claim and ticket.
- The proof-ladder level reached (`L0`–`L5`).
- Each check: name, state (`pass|fail|not-run`), level, expect predicate, observed value.
- Each artifact: type, path, SHA-256, provenance (`harness` vs `agent`).
- The verdict and the `note` tally, set last from the check results.

The format is open — see the [evidence bundle format reference](../site/docs/evidence-format.html) and `spec/` for the JSON Schema.

---

## k8s-attach (BYOC)

`k8s-attach` is the fourth substrate: it never creates or deletes anything in
a cluster (Shape-A, ADR-0011). `pb up --substrate k8s-attach` only asserts that
the target pods are live and opens `kubectl port-forward` tunnels; `pb down`
only kills the forwards it opened. Full guide: [Attach your cluster](../site/docs/k8s-attach.html).

```
pb up --substrate k8s-attach --manifest ready.yaml
```

```
forward svc/appservice:8000 -> 127.0.0.1:54217
```

```
pb ready --manifest ready.yaml
```

```
ready tcp 127.0.0.1:54217 -> ok
```

One `forward ...` line per tunnel opened (one per unique locator — a resource
and `sources.k8s` naming the same locator share a single tunnel), and one
`ready ...` line naming the resolved probe and its outcome.

### Naming the cluster context

Put a `workspace.yaml` next to your manifest naming the kubectl context and
the granted namespace to forward into. Full reference:
[workspace.yaml & env](../site/docs/configuration.html).

```yaml
contexts:
  k8s-attach: "redcat@redcat"   # <kube-context>@<namespace>
```

Override at run time without editing the file:

```
export PB_K8S_CONTEXT=redcat
export PB_K8S_NAMESPACE=redcat
```

`PB_K8S_CONTEXT` / `PB_K8S_NAMESPACE` always win over `workspace.yaml`.

### Resource placeholders

`resources.<name>.via.k8s` names what to forward (e.g. `svc/appservice:8000`).
`pb up` binds each to an ephemeral local port; reference the live forward
anywhere in the manifest — probes, drive verbs, checks — with:

```
${resources.<name>.host}
${resources.<name>.port}
```

Env can also be **derived** from a live pod instead of a checked-in file:

```yaml
run:
  local:
    env:
      derive:
        from: k8s-pod
        pod: "deploy/appservice"
```

### Attach-only guarantee

`k8s-attach` is read/observe only: port-forward, read (`kubectl get`), and
`exec`-based env derivation. It never applies, creates, deletes, or scales a
cluster object. Destructive actions a drive verb performs (firing an
execution, writing a scenario doc) are the drive verb's own doing and must
carry a `gates[]` entry — the substrate itself only opens tunnels.

### Redeploy caveat

A port-forward pins to the pod(s) live when `pb up` ran. If the target rolls
out (a new deploy, a pod restart) while forwards are open, the tunnel goes
stale — the local port stays bound but the far end is gone. `pb ready` /
`pb verify` will fail against a dead forward. Recover with:

```
pb down --manifest ready.yaml
pb up --substrate k8s-attach --manifest ready.yaml
```

There is no live re-attach yet; always cycle `down`/`up` after a rollout of
anything you're attached to.

---

## Next steps

- Onboard a repo with no `ready.yaml` yet — see [Onboard your repo](../site/docs/onboard-your-repo.html) for the full `pb init` → `pb lint` → edit → `pb verify` walkthrough, including the scaffold-rejection error and a real failing run.
- Add drive verbs that exercise real product entrypoints.
- Add `L4` checks that assert observable effects (rows in a database, API responses, file contents) — see the [proof ladder](../site/docs/proof-ladder.html).
- Use `pb evidence run` and `pb evidence assert` in shell scripts to build checks outside the manifest.
- Use `--substrate compose` to run against Docker Compose instead of bare processes.
- Run `pb help <command>` anytime for a command's full flag list and an example invocation.
