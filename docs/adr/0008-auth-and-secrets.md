# Auth and secrets: references, validated sessions, named bypass flows

Manifests carry secrets by reference only — `secretRef` schemes (env | file |
sops | vault | cloud secret managers | broker), never values; the validator
rejects inline plaintext. Locked founder decision, 2026-07-06.

- **Session artifact**: Playwright `storageState` JSON is the cookie/session
  format (interop with existing suites), reused only after a Cypress-style
  validate-before-reuse probe — a stale session forces fresh auth, never
  silently false-green evidence.
- **SSO under test** uses NAMED, admin-controlled IdP bypass flows the customer
  configures: Okta bypass group, Auth0 ROPG / password-only test connection,
  mock SAML IdPs in CI. We never invent MFA defeats.
- **TOTP**: store the Base32 seed as a secretRef, derive codes at call time
  (RFC 6238) — the seed is the durable secret, not any single code.
- **Irreducible human MFA** (push/SMS/email OTP) = watch-mode human takeover: a
  `gates` entry pauses the run and the evidence bundle records `not-run` with
  the gate name.
