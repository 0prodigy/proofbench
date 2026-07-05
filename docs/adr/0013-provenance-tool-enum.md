# Evidence provenance gains a third enum value: `tool`

Evidence v2 provenance becomes a three-value enum (locked founder decision,
2026-07-06):

- **`harness`** — strictly harness-spawned and teed: the binary ran the process
  and captured the bytes itself (`Bundle.Run`).
- **`tool`** — harness-directed tool output (Playwright traces, Peekaboo
  captures): the harness chose the tool, its flags, and its output path, but
  did not tee the bytes (`Capture.File`).
- **`agent`** — operator/agent-supplied files, including Seal's sweep.

Decided now, while spec/v0 is pre-freeze, because sharp provenance semantics
ARE the product's anti-fabrication claim. This overrules the widen-`harness`
recommendation in docs/design/driver-interfaces.md §9.

## Consequences

Cost is one enum value in spec/v0 + Validate + the hub/report provenance chip.
`Capture.File` records `tool`; driver-interfaces §2/§8.1 are superseded.
