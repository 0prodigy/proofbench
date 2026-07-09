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

---

## Code standards

Mandatory — violations get your slice rejected.

1. **Deps.** Go stdlib + `gopkg.in/yaml.v3` only. Never add a dependency.
2. **Frozen contracts.** Never edit `internal/*/types.go`, `checkdriver.go`'s `Driver` interface, or the `Substrate` interface. `cmd/pb/main.go` is orchestrator-owned; changes only via the contract-change protocol in CONTRACTS.md.
3. **Errors.** Wrap as `"pkg.Func: context: %w"`; use typed errors for expected degradation (see `ComposeUnavailable`). Never swallow an error into a silent default.
4. **Enums.** A closed `valid*` map is validated at every boundary. Enum changes update the Go consts and the `spec/v0` schema in the same change.
5. **Tri-state discipline.** A check that did not run is not-run with a reason — never pass, never absent. Verdicts are derived from evidence and set last.
6. **Tests.** Table-driven, `t.TempDir()`, stdlib only, fake external binaries via PATH shims (see the existing `python3`/`docker` patterns in `internal/substrate/substrate_test.go`). No `t.Skip` except true integration tests.
7. **Subprocesses.** Own process group, killed on cleanup, bounded by a timeout (mirror `internal/evidence/run.go`).
8. **Comments** say why, not what. No `ponytail:` or other review-tool markers. Delete dead code — never keep it "for later".
9. **Determinism.** Sort map keys before any iteration that produces output.
10. **Smallest precise diff.** `gofmt`/`go vet`/`go test ./...` must be green before you finish. Do not `git commit` or push. Do not edit files outside your listed slice.
