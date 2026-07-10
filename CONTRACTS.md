# CONTRACTS — Proofbench scaffold

Module: `github.com/0prodigy/proofbench` · Go 1.23 · dep: `gopkg.in/yaml.v3`.
Builders fill in stub bodies (`errors.New("not implemented")`) **without changing any signature, type, tag, or enum**.

## Package map

| Package | Purpose |
|---|---|
| `internal/evidence` | Evidence bundle v2 (PLAN §5): manifest, artifacts, checks, run capture, assert predicates |
| `internal/manifest` | `ready.yaml` / `workspace.yaml` model (PLAN §4), parse/validate, auto-detect |
| `internal/substrate` | Substrate adapters (`local`, `compose`, `k8s-attach`): Up / Ready / Seed / Down |
| `internal/verify` | Orchestrates a verification run → evidence bundle + tri-state summary |
| `internal/report` | Markdown report per bundle; static hub index over a bundle root |
| `internal/checkdriver` | CheckDriver family (`exec`, `playwright`): `Driver` interface, `Env`, `New` selector |
| `cmd/pb` | CLI dispatch (complete — do not touch) |
| `spec/` | Versioned JSON Schemas for ready.yaml + evidence manifest v2 |

## Slice ownership (each builder edits ONLY its own files)

| Slice | Owns |
|---|---|
| evidence-core | `internal/evidence/core.go` |
| evidence-run | `internal/evidence/run.go` |
| evidence-assert | `internal/evidence/assert.go` |
| spec-schemas | `spec/` |
| manifest-parse | `internal/manifest/parse.go` |
| manifest-detect | `internal/manifest/detect.go` |
| substrate | `internal/substrate/` (`local.go`, `compose.go`, `seed.go`, `k8sattach.go`), `fixtures/` |
| checkdriver | `internal/checkdriver/` (`checkdriver.go`, `exec.go`, `playwright.go`) |
| verify | `internal/verify/` |
| report | `internal/report/` |
| docs | `README.md`, `LICENSE`, `docs/`, `examples/` |

## Frozen for builders

- **All `types.go` files** (`internal/evidence/types.go`, `internal/manifest/types.go`, `internal/substrate/types.go`) — shared types, enums, json/yaml tags, and the `Substrate` interface + `New` factory.
- **`internal/checkdriver/checkdriver.go`** — the `Driver` interface, the `Env` struct, and the `New` selector are frozen alongside the `types.go` files above; builders implement driver bodies, not this contract.
- **`cmd/pb/main.go`** — the CLI contract (flags, positionals, exit codes) is final; implement the stubs it calls.
- `PLAN.md`, this file, `go.mod` (add test-only deps via your own `go get` only if unavoidable — prefer stdlib).

Contract questions go to the orchestrator, not into a unilateral edit. `go build ./...` and `go vet ./...` must stay green after every slice.

## Contract-change protocol

A frozen file (any file in "Frozen for builders" above) is never edited unilaterally. To change one:

1. **Raise it as an issue**, stating the rationale — what's frozen, why it must change, and what breaks if it doesn't.
2. **Get an orchestrator decision**, recorded on the issue, before any code is written.
3. **Land it as one atomic change** that updates the code, the corresponding `spec/` schema, and `PLAN.md` §4/§5 together — never split across separate PRs or slices.

Every builder reads [CONTRIBUTING.md's "Code standards"](CONTRIBUTING.md#code-standards) section first, before touching their slice.

New tests follow a one-`_test.go`-per-owned-source-file rule (e.g. `k8sattach_test.go` for `k8sattach.go`) — do not pile new tests into a shared file spanning multiple slices.
