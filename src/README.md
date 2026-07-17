# pb — honesty core + E1 gate (stage 1)

This is the **deterministic spine** of Phase 3: the part that proves a *lying
prosecutor* cannot manufacture a `WORKS`. There is no real app or browser here —
the malicious "drivers" are scripted evidence bundles fed to the pure verdict
function. See `docs/phase-3-theory.md` (§0–§2, §7) for the property (P′) this encodes.

## What's here

| File | Role |
|---|---|
| `types.mjs` | Frozen enums + JSDoc typedefs: `Provenance` (agent<tool<harness, `rankOf`), `Verdict`, `ClaimState`, `Receipt`, `Claim`, `EffectCheck`. |
| `evidence.mjs` | `contentAddress` (sha256), `newBundle`, `sealBundle`/`verifySeal` — a real ed25519 seal over a manifest digest of intent+claims+receipts+verdict. Tamper-evident: any post-seal mutation ⇒ `verifySeal` false. |
| `verdict.mjs` | `verdict(bundle)` — pure, deterministic. State is set **last from receipts**, never from a claim's own assertion. Implements rules 1–7. |
| `e1/drivers.mjs` | `MALICIOUS_DRIVERS` (one per cheat) + `HONEST_DRIVER`. |
| `e1/gate.mjs` | `runGate()` — every malicious driver must be **not** `WORKS` (tampered-seal ⇒ `UNVERIFIED`); the honest driver must be `WORKS`. |
| `cli.mjs` | `pb gate` (table + exit code). `prove`/`phase1`/`phase2`/`phase3` are honest "not built yet" placeholders. |

## The verdict rules (in order)

1. Only `tool|harness` receipts satisfy a claim; `agent` receipts corroborate only.
2. Any `FALSIFIED` claim ⇒ `DOES_NOT_WORK`.
3. An effect claim is `CONFIRMED` only if its `EffectCheck` binds a delta receipt that
   is harness-provenance **and** not `sourcePR` (M3) **and** has a confirm leg
   (fresh-session, or content-bound egress §1.5); else `NOT_EXECUTED`.
4. A negative claim is `CONFIRMED` only with **both** a null delta **and** an attempt
   receipt (M1); else `NOT_EXECUTED`.
5. Quantifier lint (§1.4/FW-11): a quantified claim needs ≥2 `CONFIRMED` instantiations
   with **distinct identity ≠ actorIdentity**, plus ≥1 `CONFIRMED` negative; else `NOT_EXECUTED`.
6. `WORKS` requires ≥1 `CONFIRMED` effect claim, all declared claims `CONFIRMED`
   (or justified-N/A), and `reproduce.k ≥ 2` — a single walk is never `WORKS` (FW-6).
7. Else nothing falsified but something `NOT_EXECUTED`/missing ⇒ `COULD_NOT_DETERMINE`,
   naming what + why.

## Run it

```
node --test          # verdict rules 1-7 + the E1 gate
node src/cli.mjs gate # the gate as a table, with an exit code
```

## Not here (stage 2)

`conjure` (bring the real system up) and `drive` (user-shaped walk + out-of-band
capture) — the real Catch — land next. This stage is the release-gating honesty
core they must flow through without ever producing a false `WORKS`.
