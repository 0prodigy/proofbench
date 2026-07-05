# Contributing to Proofbench

Apache-2.0. Contributions welcome.

---

## Build and test

```
go build ./...
go vet ./...
go test ./...
```

All three must pass before any PR is mergeable. The project has no external runtime dependencies beyond the Go standard library and `gopkg.in/yaml.v3`.

---

## Package map

| Package | Purpose |
|---------|---------|
| `internal/evidence` | Evidence bundle v2: manifest, artifacts, checks, run capture, assert predicates |
| `internal/manifest` | `ready.yaml` / `workspace.yaml` model, parse/validate, auto-detect |
| `internal/substrate` | Substrate adapters (`local`, `compose`): Up / Ready / Seed / Down |
| `internal/verify` | Orchestrates a verification run into an evidence bundle + tri-state summary |
| `internal/report` | Markdown report per bundle; static hub index over a bundle root |
| `cmd/pb` | CLI dispatch — final; implement the package stubs, not this file |
| `spec/` | Versioned JSON Schemas for `ready.yaml` and the evidence manifest v2 |

See [CONTRACTS.md](CONTRACTS.md) for the full stub ownership map and the frozen files list.

---

## Slice ownership

Each contributor owns the files listed under their slice in CONTRACTS.md. Do not edit files outside your slice. The types files (`internal/*/types.go`) and `cmd/pb/main.go` are frozen — raise a contract question rather than editing them unilaterally.

---

## Spec changes

Any change to the `ready.yaml` schema, the evidence manifest schema, or the CLI surface (flags, subcommands, exit codes) requires a corresponding update to [PLAN.md](PLAN.md). Open an issue or PR that updates the spec sections (§4 and §5) before or alongside the implementation.

---

## Tests

- Use table-driven tests for non-trivial logic.
- Use `t.TempDir()` for any test that touches the filesystem.
- Prefer the standard library (`testing`, `bytes`, `os`, `path/filepath`) — no test frameworks.

---

## Code style

- `gofmt` and `go vet` clean.
- Smallest precise diff: read the entrypoint first; don't add scope.
- No external dependencies beyond `gopkg.in/yaml.v3`. If you think you need one, open an issue first.
- Comments only where necessary — avoid restating what the code says.
