# All execution concerns are pluggable driver families

Every execution concern is a driver family behind a common Go interface, selected
per run: substrates (local | compose | k8s), check drivers (exec, playwright,
computer-use), build strategies (external-artifact = shape A, buildkit = shape B),
and auth providers. The v0 `Substrate` interface (`Up`/`Ready`/`Seed`/`Down`,
`internal/substrate/types.go`) is the seed of this pattern — new families follow
its shape: a small frozen interface plus a `New(kind, ...)` selector. Locked
founder decision, 2026-07-06.

## Consequences

- Adding a tool means adding a driver, never forking the engine or the manifest
  schema.
- New concerns arrive as new orthogonal families (e.g. a `Builder` step that runs
  before `Up`), not as new methods on a frozen interface (CONTRACTS.md).
- The manifest names what a service supports; the driver is chosen at run time —
  substrate choice is never baked into `ready.yaml`.
