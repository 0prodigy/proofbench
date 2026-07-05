# Launch matrix: substrates, shapes, onboarding, auth tiers

v1 ships docker/compose GA plus k8s-attach, covering both founder deployment
modes. Integration shapes A (user/CI builds, we test with proof) and B (our
agent builds, deploys, and tests) run on the same `pb` verbs — shape B is the
agent driving them, not a second product. Locked founder decision, 2026-07-06.

## Consequences

- Per-repo `ready.yaml` generation IS onboarding — there is no separate setup
  flow; auto-detect proposes the manifest on first run.
- Auth at launch: basic, API-key, and cookie (Playwright `storageState`) ship in
  OSS; SSO credential-brokering is enterprise-tier only (ADR-0008).
