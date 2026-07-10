# Test-selection safety

Empty-selection is safe by construction (it degrades to AMBER, never green), but **positive** test-selection must **route-verify** every selected spec against the live product before it can contribute to a green — a tag alone is not trusted. Autonomous test **generation** stays gated behind the ADR-0015 honesty spine.

**Empirical evidence (kill-test E4, 2026-07-10, synthetic separate product/test repos):** the ∅-selection safety property held — uncovered code, brand-new code, and data-only changes all produced an **AMBER coverage-gap**, never a green. But **tag-only positive selection shipped a FALSE GREEN**: a mistagged spec claimed to cover `/inventory` while the request it actually issued hit `/users`, and the harness reported `/inventory` covered on the strength of the tag alone. The oracle believed the label, not the traffic.

**The decision:**

- **∅-selection / unmapped-path / data-only ⇒ coverage-gap AMBER, never green.** This property is confirmed and locked.
- **Every selected spec must be route-verified.** The route a spec references must equal a changed route, ideally confirmed **at runtime by the actual HTTP path issued** — not by the spec's declared tag. A spec whose issued path disagrees with its claimed coverage does not promote.
- **Drift check against the live route table.** The product's route table is checked against the live product; a spec mapped to a route that no longer exists (or has moved) is a drift failure, not a silent pass.
- **Autonomous generation stays gated.** Generated tests are ratified by a **human PR as the oracle**, with assertions **hash-pinned**, **generation ≠ execution** principals, **reuse-only fixtures**, and **no self-heal / no self-judge ever** — the same constraints ADR-0015 imposes on the check oracle and ADR-0010 imposes on self-evolving tests.

## Considered Options

- **Trust the spec's coverage tag as-is.** Rejected: E4 shipped a false green from exactly this — a mistagged spec running the wrong route. The tag is a claim; the issued HTTP path is the fact.
- **Verify only at the mapping layer (static route table), not at runtime.** Rejected as insufficient alone: a static map can itself be stale or mistagged, which is why runtime path confirmation is the preferred check and drift is a separate gate.
- **Allow autonomous generation to set coverage once it passes.** Rejected: an agent that both writes and grades its own tests is self-judged (ADR-0015 R2); generation output is a proposed diff for a human-ratified PR, never a promoting verdict.

## Consequences

- The coverage-gap AMBER path is confirmed safe and needs no new guard; the route-verify + drift-check guard is the net-new work, sequenced last among the five kill-test slices in `docs/backlog.md` because ∅-safety already prevents the worst failure mode.
- Positive selection gains a runtime path-assertion (the issued HTTP path must match the claimed route) and a route-table drift check, both of which lean on the attach/discovery surface from ADR-0017 to know the live product's routes.
- Generation inherits the full honesty-spine constraint set (ADR-0015) and the self-evolving-tests posture (ADR-0010); it produces proposals, not verdicts.
- Existing backlog test/driver items (e.g. driver families #4) are unaffected in contract; this ADR adds a promotion guard, not a new driver.
