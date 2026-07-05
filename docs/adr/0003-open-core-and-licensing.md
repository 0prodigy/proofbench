# Open core and licensing: everything OSS, paid is hosted operations

Everything that produces or verifies proof — spec, harness/engine, substrate adapters, agents, hub — is Apache-2.0 and fully self-hostable; paid is exclusively managed cloud (hosted retained ledger/hub, publishers) and enterprise operations (SSO/RBAC, compliance exports, retention, credential-brokered BYOC, fleet supervision). The boundary is drawn once, at launch, and chosen deliberately to be near-impossible to move later: every paid capability is inherently hosted/multi-tenant operations, never a CLI feature behind a paywall — the GitLab shape, because every post-launch relicense (MongoDB, Elastic, HashiCorp, Redis) triggered a permanent foundation-backed fork (`docs/research/business-model.md` §1.6).

## Consequences

- We pre-commit to never restricting anything the OSS core already does; a future BSL/SSPL-style lever is deliberately foreclosed.
- Cloud must earn its price entirely on hosted-operations value, not feature-gating — raising the bar on ledger/analytics investment.
