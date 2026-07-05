# Self-evolving tests: one exploratory round, committed automation as the only durable output

Each feature gets at most one exploratory computer-use round — Peekaboo on the developer's own macOS desktop locally, a Playwright-driven browser in cloud/CI — and the round's only durable output is committed automation: `checks[]` entries in ready.yaml plus Playwright specs. The deterministic harness replays that automation on every subsequent run; the exploratory session itself never anchors a verdict (agent proposes, harness proves). Kill criterion from the product ruling: if after two design-partner cycles fewer than ~50% of explore-generated tests survive human review without rewrite, the agent is demoted to a manifest/spec-generator only.

## Consequences

The local exploratory round is macOS-only at launch — Peekaboo needs Screen Recording/Accessibility TCC grants and a live desktop session, so it cannot run headless in CI; Linux/Windows local dev gets the browser-only Playwright round. An explicit, documented gap, not a silent one.
