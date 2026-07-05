# CONTRACTS — Proofbench scaffold

Module: `github.com/launchwings/proofbench` · Go 1.23 · dep: `gopkg.in/yaml.v3`.
Builders fill in stub bodies (`errors.New("not implemented")`) **without changing any signature, type, tag, or enum**.

## Package map

| Package | Purpose |
|---|---|
| `internal/evidence` | Evidence bundle v2 (PLAN §5): manifest, artifacts, checks, run capture, assert predicates |
| `internal/manifest` | `ready.yaml` / `workspace.yaml` model (PLAN §4), parse/validate, auto-detect |
| `internal/substrate` | Substrate adapters (`local`, `compose`): Up / Ready / Seed / Down |
| `internal/verify` | Orchestrates a verification run → evidence bundle + tri-state summary |
| `internal/report` | Markdown report per bundle; static hub index over a bundle root |
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
| substrate | `internal/substrate/` (`local.go`, `compose.go`, `seed.go`) |
| verify | `internal/verify/` |
| report | `internal/report/` |
| docs | `README.md`, `LICENSE`, `docs/`, `examples/` |

## Frozen for builders

- **All `types.go` files** (`internal/evidence/types.go`, `internal/manifest/types.go`, `internal/substrate/types.go`) — shared types, enums, json/yaml tags, and the `Substrate` interface + `New` factory.
- **`cmd/pb/main.go`** — the CLI contract (flags, positionals, exit codes) is final; implement the stubs it calls.
- `PLAN.md`, this file, `go.mod` (add test-only deps via your own `go get` only if unavoidable — prefer stdlib).

Contract questions go to the orchestrator, not into a unilateral edit. `go build ./...` and `go vet ./...` must stay green after every slice.
