# Trust boundary: agent proposes, harness proves

Verdicts must stay trustworthy even when both the change and the verification automation are agent-authored, so only the deterministic harness can anchor a verdict. Agent-supplied artifacts always carry a provenance flag (`provenance` in evidence bundle v2) and can never anchor a verdict — only harness-collected evidence can. An exploratory agent round (computer-use / Playwright) has exactly one durable output — committed `checks[]` in ready.yaml and/or Playwright specs — replayed deterministically by the harness thereafter; nothing the agent merely observed during exploration counts as proof.

## Consequences

- Neutrality is the counter-position to agent vendors grading their own homework; it only holds while this boundary holds.
- A flaky or unreachable environment yields an honest `not-run`/`inconclusive`, never a default-green — the agent cannot paper over it.
