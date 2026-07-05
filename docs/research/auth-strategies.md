# Auth Strategies — how Proofbench authenticates against customer systems

Status: research + ADR-ready recommendation. Feeds an ADR set. Date: 2026-07-06.
Scope: the four modes Akash fixed as required — **basic**, **SSO** (OIDC/SAML incl. Okta/Auth0/Google; test-user bypass; TOTP/2FA), **API key**, **cookie/session injection** — plus a secrets-reference design for `ready.yaml`, a cloud credential-broker sketch, and the session-reuse/caching model.

Grounding: existing `spec/v0/ready.schema.json` + `internal/manifest/types.go`. Today the only auth-shaped field is `DriveVerb.Identity` (`identity: env:USER_EMAIL`, a bare string) — this doc proposes the full `auth` block that generalizes it. Per `spec/README.md`'s versioning policy, everything below is additive to `spec/v0` (new optional fields only).

---

## 1. Prior art (what exists today, and what we take from it)

### 1.1 Playwright — `storageState` + auth setup projects
The dominant browser-testing pattern. Authenticate once in a `setup` project, save `context.storageState()` (cookies + localStorage + IndexedDB) to a JSON file under `playwright/.auth/`, declare it as a `dependencies` target for every other project so tests bootstrap already-authenticated. Per-worker variants exist for tests that mutate server-side state (unique account per worker); multiple role files (`admin.json`, `user.json`) cover RBAC testing. Playwright's own docs are explicit that the state file "may contain sensitive cookies and headers that could be used to impersonate you" and must be `.gitignore`'d — never committed. Session storage isn't covered by `storageState` and needs a manual `addInitScript` shim. Recorded state must be deleted/regenerated on expiry; Playwright provides no 2FA/OTP mocking at all — that's explicitly out of scope in their docs, confirming it's a real, unsolved gap even for the market leader.
[Playwright Authentication](https://playwright.dev/docs/auth) · [Network/HAR](https://playwright.dev/docs/network) · [Mock APIs](https://playwright.dev/docs/mock) · [storageState security note (BrowserStack)](https://www.browserstack.com/guide/playwright-storage-state) · [token-expiry-mid-suite gotcha](https://playwrightsolutions.com/handling-multiple-login-states-between-different-tests-in-playwright/)

**Also relevant:** Playwright's virtual WebAuthn authenticator (`context.credentials`) can seed or register real passkeys for automated testing — a forward-looking pattern for a 5th auth mode we are explicitly deferring (see §7 open questions).

### 1.2 Cypress — `cy.session()`
Same idea, different mechanics: `cy.session(id, setup, { validate })` caches cookies/localStorage/sessionStorage keyed by an id; the `setup` callback (real login) only runs once per id per run, subsequent calls "restore and validate." The **`validate` callback is the important addition Playwright lacks structurally** — before trusting a cached session, Cypress re-checks it's actually still valid and silently re-runs `setup` if not. `cacheAcrossSpecs` extends reuse across the whole run, not just one spec file. This validate-before-reuse discipline is the single best idea to steal for our session-cache model (§6).
[cy.session() docs](https://docs.cypress.io/api/commands/session) · [Cypress blog on cy.session](https://www.cypress.io/blog/authenticate-faster-in-tests-cy-session-command) · [session validation deep-dive](https://thetestingpirate.be/posts/2025/2025-03-27_cypresssessionvalidation/)

### 1.3 Browser-testing vendors (QA Wolf, Momentic, Ranger)
None publish a generalized SSO recipe publicly — each punts to "write it as code" (QA Wolf: tests are plain Playwright/Appium code the team owns and versions) or an enterprise add-on (Momentic ships SAML SSO as an enterprise/admin feature for logging into *Momentic itself*, not a generic customer-SSO-under-test story; Ranger leans on synthetic test-data generation — including "Google authenticator codes" as one of 50+ generated data types — implying TOTP-seed-based generation is already industry-normal). **Conclusion: there is no vendor-published SSO-under-test standard to adopt wholesale — this is genuinely white space**, consistent with PLAN.md §1's read that verification tooling is unowned.
[QA Wolf docs](https://docs.qawolf.com/qawolf/Welcome-to-QA-Wolf) · [QA Wolf CLI](https://github.com/qawolf/cli) · [Momentic docs](https://momentic.ai/docs) · [Ranger](https://www.ranger.net/)

### 1.4 SSO test-user / bypass patterns (Okta, Auth0, Google)
Every major IdP has a **documented, admin-controlled bypass path** — none of them require us to defeat MFA ourselves:
- **Okta**: a "Temp Bypass MFA" group / MFA bypass policy scoped to specific users, with tightened session-lifetime settings as compensating control. This is customer-configured, opt-in, and reversible — exactly the shape we want (never something the harness does unprompted).
  [Bypass Okta MFA for a specific set of users](https://support.okta.com/help/s/article/bypass-mfa?language=en_US) · [Selenium/Okta automation discussion](https://devforum.okta.com/t/selenium-automation-for-okta-multifactor-authentication-bypassing-or-automating-mfa/33399)
- **Auth0**: the community- and docs-endorsed pattern is the **Resource Owner Password Grant (ROPG)** — trade a username/password directly for a token via Auth0's token endpoint, skipping the hosted login page and any UI-level MFA challenge entirely. Auth0's own guidance: "never test or visit third-party sites you don't control... query the Auth0 API to provide a token." A second pattern: a dedicated **password-only test connection**, separate from the production passwordless/MFA connection real users hit.
  [Bypassing authentication for integration tests](https://community.auth0.com/t/bypassing-authentication-for-integration-tests/20983) · [Bypass passwordless login for automated tests](https://community.auth0.com/t/bypass-passwordless-login-for-automated-tests/113332) · [Cypress+Auth0 ROPG pattern](https://auth0.com/blog/end-to-end-testing-with-cypress-and-auth0/)
- **Google Workspace**: super-admin accounts structurally bypass SSO/MFA by design (fallback so admins aren't locked out if the IdP is down) — a real, already-existing bypass surface, but one we should never default to since it's the highest-privilege account in the org.
  [Bypass SSO for specific users](https://support.google.com/a/thread/57871280/bypass-sso-for-specific-users?hl=en) · [Super administrator SSO](https://support.google.com/a/answer/6341409?hl=en)

**Design implication:** our schema should *name* these patterns (`flow: test-bypass-group`, `flow: password-grant`, `flow: password-connection`) as customer-declared choices, never invent our own MFA-defeat mechanism.

### 1.5 TOTP/2FA — enroll once, derive at runtime
Convergent guidance across every 2FA-testing source: **the Base32 TOTP seed is the durable secret, not any single 6-digit code.** Enroll a dedicated test user once, capture its seed, store the seed in a secret manager, and derive the live code at call time per RFC 6238 (`pyotp`/`speakeasy`-equivalent). This sidesteps clock-drift and code-reuse flakiness (servers typically tolerate ±1 window, ~30–60s drift) and is exactly how Ranger's "Google authenticator codes" synthetic-data feature and Auth0/Selenium TOTP recipes work.
[pyotp+Selenium guide](https://robonito.com/blog/post/automate-totp-authentication-testing-qa-guide/) · [MailSlurp Auth0 MFA + TOTP](https://www.mailslurp.com/examples/selenium-auth0-mfa-login-test-totp-api/) · [speakeasy (HOTP/TOTP)](https://github.com/speakeasyjs/speakeasy)

For **irreducible human MFA** (push notification, SMS, email OTP not derivable from a seed) — no vendor claims to solve this generically. The honest answer is a human-in-the-loop pause, which we already have machinery for (see §5.2).

### 1.6 Mock/test IdPs for SAML
A healthy ecosystem of throwaway SAML IdPs exists specifically so SP-side SSO can be integration-tested without touching a real corporate IdP: **Mock SAML** (hosted, free), **MockServer's SAML mock** (single API call stands up a full IdP, including deliberately-defective-assertion negative tests), **DummyIDP**, and the self-hosted **mock-saml2-idp** Docker image built explicitly for CI with "automatic logins." These are the right tool when the customer's staging environment can register a second, test-only IdP trust — the SAML analog of Auth0's password-only test connection.
[Mock SAML](https://mocksaml.com/) · [MockServer SAML mocking](https://www.mock-server.com/mock_server/mocking_saml.html) · [DummyIDP](https://dummyidp.com/) · [mock-saml2-idp](https://github.com/pfrest/mock-saml2-idp)

### 1.7 HAR replay
Playwright natively records (`recordHar` / `browserContext.routeFromHAR`) and replays HTTP Archives, matching strictly on URL + method + (for POST) payload. The documented failure mode is exactly what we'd hit reusing HAR for auth: **dynamic values (request IDs, timestamps, per-session tokens) break strict matching** on replay. Verdict: HAR is a fine *cookie/session capture format* for read-mostly, low-volatility checks, but not a general session-injection mechanism — `storageState` is the better artifact for that (§1.1), HAR is better reserved for full API-mocking of non-auth traffic.
[Playwright Network docs](https://playwright.dev/docs/network) · [HAR dynamic-parameter problem write-up](https://medium.com/@sdgroup/harmageddon-is-cancelled-how-we-taught-playwright-to-replay-har-with-dynamic-parameters-efc4cc24894e)

### 1.8 Credential vaulting in CI
Three mature, complementary patterns, all directly reusable:
- **OIDC federation** (GitHub Actions → AWS/GCP/Azure/Vault): the workflow's own OIDC identity token is exchanged for a *short-lived* cloud credential — no long-lived secret ever sits in CI config. This is the gold standard for anything that can be modeled as "the runner has a workload identity."
  [GitHub OIDC](https://docs.github.com/en/actions/concepts/security/openid-connect) · [Configuring OIDC in cloud providers](https://docs.github.com/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-cloud-providers)
- **Vault dynamic secrets**: for things that can't be OIDC-federated directly (DB creds, third-party API keys), Vault mints a *per-request*, TTL'd credential and auto-revokes it — the CI job authenticates to Vault with its own identity, never holds a static secret.
  [Dynamic and static secrets in CI/CD](https://developer.hashicorp.com/well-architected-framework/secure-systems/secure-applications/ci-cd-secrets/dynamic-and-static-secrets) · [Vault GitHub Action](https://www.hashicorp.com/en/blog/vault-github-action)
- **SOPS + age/KMS**: for secrets that must live *in the repo* (declarative, reviewable, GitOps-friendly), SOPS encrypts values in-place in a YAML/JSON file, leaving keys visible for diffability, decryptable only by holders of the age/KMS key. This is the right default for **teams with no existing Vault** — zero additional infra beyond one age keypair.
  [SOPS](https://github.com/getsops/sops) · [SOPS+age guide](https://oneuptime.com/blog/post/2026-02-09-sops-age-encryption-kubernetes-secrets/view) · [Flux SOPS guide](https://fluxcd.io/flux/guides/mozilla-sops/)
- **Kubernetes External Secrets Operator**: for `k8s-attach` substrate, the established pattern is *don't put secrets in the manifest or the cluster at all* — an ESO `ExternalSecret` CR pulls from the org's existing cloud secret manager on a sync interval and materializes a k8s Secret. We should read from this when it's already present (derive, don't restate — same principle as `sources:` in `ready.yaml`) rather than compete with it.
  [External Secrets Operator](https://external-secrets.io/latest/provider/kubernetes/)

### 1.9 How agent/browser-agent vendors handle customer creds
This is the most directly on-point research for our specific problem (an *autonomous agent* driving *someone else's* login):
- **Cognition/Devin**: pushes users to a first-class "Secrets" feature (Settings page) rather than pasting credentials into chat/prompts — the model only ever sees a reference, and Cognition explicitly warns that anyone with session access can reach the filesystem/shell, so credential handling has to assume the *agent session*, not just the model, is a trust boundary.
  [Devin/Cognition security docs](https://docs.devin.ai/admin/security)
- **WorkOS's "Securing AI agents" framework** names four increasingly-safe patterns for Operator-style computer-use agents: (1) direct plaintext injection — worst, mitigate with short sessions + output redaction; (2) session-cookie injection — better, needs encrypted-enclave storage + rotation; (3) OAuth delegated auth with scoped, short-lived tokens — good; (4) SSO/identity federation with a **"watch mode" human takeover for MFA and other sensitive steps** — this is the pattern that generalizes to our irreducible-human-MFA case (§1.5, §5.2). WorkOS's strongest architectural point: store the real session/token in a vault and let the agent hold only "a placeholder token while the real session details remain locked away" — i.e., the agent's context window should never contain the raw secret.
  [WorkOS — Securing AI agents](https://workos.com/blog/securing-ai-agents-operator-models-and-authentication)
- **Agent Vault (Infisical, OSS)** and **1Password Unified Access** both independently converge on the same shape: a **proxy/broker sits between the agent and the target**, the agent holds a dummy/placeholder credential string, the broker swaps it for the real one only in the outbound request, host-scoped by policy — so a prompt-injected or fully-compromised agent session literally cannot exfiltrate the real secret, because it never had it. 1Password additionally frames this as a policy shift from "trust once at login" (human model) to "confirm authority at every access" (agent model), with a roadmap toward fully ephemeral, per-task-scoped credentials for agents specifically (vs. session-based access for humans).
  [Agent Vault docs](https://docs.agent-vault.dev/) · [Agent Vault repo (Infisical)](https://github.com/Infisical/agent-vault) · [1Password Unified Access for agents](https://openclawai.io/blog/1password-unified-access-agent-credentials/)
- **The threat is not hypothetical**: OpenAI Operator has been demonstrated automating credential-stuffing, and a critical CVE (CVSS 9.3) exists in a popular open-source browser-use agent for whitelist bypass via crafted URLs — i.e., "just let the agent type the password" is an actively-exploited-class risk, not a theoretical one.
  [Operator + credential stuffing](https://pushsecurity.com/blog/how-new-ai-agents-will-transform-credential-stuffing-attacks) · [AI agent credential-handling risk overview](https://coasty.ai/blog/ai-agent-credential-handling-security-nightmare-2026-20260518)

**This is the single strongest signal in the whole research set**: the entire industry — CI secret patterns, agent-credential vendors, and password-manager incumbents — is converging on the same primitive: **the executor (agent/runner) never holds the raw secret; it holds a reference, and a broker resolves the reference at the point of use, scoped and audited.** Our design in §4–6 adopts this as the spine.

### 1.10 Adjacent prior art already in our own PLAN.md lineage
- **Skaffold `verify`**: runs post-deploy validation as a container/k8s Job using the ambient kubeconfig/kube-context — i.e., it inherits cluster auth rather than declaring its own, confirming our instinct to *derive* substrate credentials (k8s-attach → current kubeconfig context) rather than reinvent them, and reserve our `auth` block for **target-system** (the thing under test) auth, not substrate auth.
  [Skaffold verify](https://skaffold.dev/docs/verify/)

---

## 2. What "derive, don't restate" means for auth specifically

Two different auth surfaces must not be conflated:
1. **Substrate auth** — how the harness reaches the environment (kubeconfig context for `k8s-attach`, SSH/docker socket for `local`/`compose`, provider API key for `remote`). Already implicitly covered by existing substrate/resource resolution; **not** what this doc's `auth` block is for.
2. **Target-system auth** — how a *drive verb* or *check* proves an identity to the product under test (log in as a customer user, call an API as a service). **This is what `ready.yaml`'s new `auth` block governs.**

---

## 3. The four modes, concretely

### 3.1 Basic auth
Username/password (or a bearer credential) injected as an `Authorization: Basic` header or into the drive verb's process environment. Lowest complexity; reuses the existing `EnvSpec.Overrides` plumbing — the auth resolver just resolves `secretRef`s into env vars/headers before `run` executes.

### 3.2 SSO (OIDC / SAML)
Automation-friendly path, in priority order:
1. **`flow: password-grant`** (OIDC ROPG, or the SAML password-connection analog) — trade credentials directly for a token/assertion via the IdP's token endpoint, skip the hosted UI and any UI-rendered MFA entirely. Works for Auth0-style ROPG and for an Okta org where ROPG/native auth is enabled. This is the default we recommend when the customer's IdP supports it (§1.4).
2. **`flow: test-bypass-group`** — a dedicated automation user placed in an IdP-side MFA-bypass group (Okta Temp Bypass MFA, Google super-admin bypass) — customer-configured, least-privilege, reversible. Requires nothing from us beyond respecting whatever the customer already set up.
3. **`flow: mock-idp`** — for SAML SPs whose staging environment can register a second, test-only IdP trust, point it at Mock SAML / mock-saml2-idp / DummyIDP for a fully synthetic, MFA-free login (§1.6). Best for pure SP-behavior testing, not for verifying the real IdP integration itself.
4. **`flow: totp`** — when MFA can't be bypassed but *is* TOTP-based, store the Base32 seed as a `secretRef` and derive the live code at call time (§1.5). Composable with flows 1–3 (e.g., password-grant login + a TOTP step in the same profile).
5. **`flow: human-mfa`** — irreducible MFA (push/SMS/email OTP). Declared as a `gates` entry (`on: mfa-challenge`); the run pauses and the evidence bundle records `not-run` with the gate name — WorkOS's "watch mode" pattern, expressed through machinery we already have rather than new code.

Storage-state reuse (§3.4) applies on top of any of these flows once a session is established — SSO is expensive to re-run per check, cheap to cache-and-validate.

### 3.3 API key
Placement is configurable (`header` / `query` / `cookie` — target systems vary between `Authorization: Bearer`, `X-API-Key`, `?api_key=`); value always a `secretRef`, never inline. An optional non-secret `rotation_hint` free-text field lets a `known_walls` entry reference "401 = key rotated," reusing the existing trap-with-recovery pattern already in the schema (`Wall`).

### 3.4 Cookie / session injection
Two capture sources, matching §1.1/§1.7's conclusions:
- **`source: storage-state`** — the *primary* recommended source. Deliberately **schema-compatible with Playwright's own `storageState` JSON shape** (cookies + per-origin localStorage) so a customer's existing Playwright auth-setup artifacts are directly reusable — an interop point, not a competing format (PLAN.md §8: "every interop is distribution").
- **`source: har`** — recommended only for low-volatility, read-mostly checks, given Playwright's own documented strict-matching failure on dynamic values (§1.7).

Both are session material, not "config" — they are `secretRef`-only in the schema, never inline, matching the near-universal warning across Playwright/BrowserStack/Cypress sources that these files must never be committed.

---

## 4. `ready.yaml` — the `auth` block

Extends `spec/v0` additively (new optional top-level `auth` key + new optional `auth` field on `DriveVerb`/`CheckSpec`; existing `Identity string` field is kept as a deprecated shorthand, not removed — see §4.3).

```yaml
# ready.yaml — auth block (schema: proofbench/spec/v0, additive)

auth:
  # default: which profile applies when a drive verb / check doesn't name one.
  default: primary

  profiles:
    primary:
      mode: sso                                   # basic | api-key | sso | cookie
      sso:
        protocol: oidc                             # oidc | saml
        provider: okta                             # okta | auth0 | google | generic (informational)
        issuer: https://acme.okta.com
        flow: password-grant                       # password-grant | test-bypass-group | mock-idp | totp | human-mfa
        client_id: "secretRef:vault://kv/proofbench/okta#client_id"
        test_user:
          username: "secretRef:vault://kv/proofbench/okta#test_user"
          password: "secretRef:vault://kv/proofbench/okta#test_password"
        mfa:
          type: totp                               # none | totp | human
          totp_seed: "secretRef:vault://kv/proofbench/okta#totp_seed"

    admin:
      mode: sso
      sso:
        protocol: oidc
        provider: okta
        flow: test-bypass-group
        test_user:
          username: "secretRef:sops://secrets.enc.yaml#okta.admin_user"
          password: "secretRef:sops://secrets.enc.yaml#okta.admin_password"

    svc-to-svc:
      mode: api-key
      api_key:
        placement: header
        header: Authorization
        prefix: "Bearer "
        value: "secretRef:awssm://us-east-1/proofbench/orders-api-key"

    ui-smoke:
      mode: cookie
      cookie:
        source: storage-state                      # storage-state | har
        storage_state: "secretRef:vault://kv/proofbench/ui#storage_state_json"
        domain: app.acme.example.com

  cache:
    key: "${profile}:${substrate}:${resources.target.host}"   # Cypress-style session id
    ttl: 45m
    validate: { http: "/api/me", expect: "http.status==200" } # Cypress cy.session validate() analog
    store: local-encrypted                          # local-encrypted | broker (cloud)

drive:
  create-order:
    run: ./scripts/create-order.sh
    auth: primary            # NEW — supersedes bare `identity:` shorthand
    output: json

checks:
  - name: order-roundtrip
    level: L4
    exercise: drive.create-order
    auth: admin              # NEW — per-check override, e.g. an admin-only check
    expect: [ "exitCode==0", "http.status==201" ]
```

### 4.1 Design rules
- **No inline plaintext, ever.** Every leaf value under `auth.profiles.*` that carries a credential is typed `secretRef` (see §4.2) at the schema level — the validator rejects a value that isn't `secretRef`-shaped. This is the one non-negotiable rule that everything else serves.
- **Mode-specific sub-blocks** (`basic`, `sso`, `api_key`, `cookie`) keep each mode's fields from polluting the others — mirrors the existing `Probe` pattern (`http`/`tcp`/`exec`, exactly one populated).
- **Profiles are named and reusable** across `drive` and `checks` — one `auth` declaration serves many verbs/checks, same relationship `resources` already has to `run`/`seed`.
- **Per-check override** lets a suite mix identities (an `admin` profile for a settings-change check, `primary` for everything else) without duplicating the whole manifest.

### 4.2 `secretRef` — the secrets-reference scheme
A `secretRef` is a string with a URI-like scheme naming *where to resolve it*, never the value itself:

| Scheme | Resolves via | Best for |
|---|---|---|
| `env:VAR_NAME` | process environment at run time | local dev, CI that already injects secrets as env vars |
| `file:./relative/path` | a local, `.gitignore`'d file | local dev convenience (never committed) |
| `sops://path/to/file.enc.yaml#yaml.path` | SOPS decrypt (age/KMS key from runner env) | teams with **no** existing secret-manager infra — repo-resident, reviewable, zero extra services (§1.8) |
| `vault://mount/path#field` | HashiCorp Vault KV or dynamic-secret engine | teams already running Vault; supports dynamic (auto-expiring) creds natively (§1.8) |
| `awssm://region/secret-name`, `gcpsm://project/secret/version`, `azkv://vault-name/secret` | the org's existing cloud secret manager | `k8s-attach` substrate, orgs already using ESO (§1.8) — we read the same source ESO reads, never duplicate it |
| `broker://profile-name` | the **cloud credential broker** (§5) | hosted product; defers resolution entirely off the local process |

The Go type is a tagged union (`internal/manifest/types.go` convention):
```go
// SecretRef never carries a resolved value in the manifest — only a scheme + locator.
type SecretRef struct {
    Scheme  string // env | file | sops | vault | awssm | gcpsm | azkv | broker
    Locator string // scheme-specific address, parsed from the "scheme://..." or "scheme:..." string
}
```
Resolution happens exactly once, immediately before a drive verb/check runs, into an in-memory value that is (a) never written to disk unencrypted, (b) never included in evidence-bundle artifacts or logs — the capture layer must redact any string matching a resolved secret value before it reaches `artifacts[]` (extends the existing anti-fabrication provenance model in `evidence-v2.schema.json` to a second purpose: anti-leakage).

### 4.3 Backward compatibility
`DriveVerb.Identity` (`identity: env:USER_EMAIL`) is retained as sugar: if `auth` is absent and `identity` is present, the resolver treats it as an implicit `mode: basic`/`env`-scheme profile. No existing manifest breaks; new manifests should prefer `auth`.

---

## 5. Cloud credential-broker sketch

Local/OSS resolves `secretRef`s itself (env/file/sops/vault/cloud-sm — §4.2). The **hosted product's differentiator** is a `broker://` resolver that never lets the raw secret reach the runner process at all — directly modeled on Agent Vault's and 1Password Unified Access's proxy pattern (§1.9), generalized from "LLM/API provider keys" to "arbitrary customer target-system credentials."

```
 pb runner (local box, customer cluster, or hosted sandbox)
        │  auth.profiles.primary.sso.test_user.password = "secretRef:broker://primary"
        ▼
 pb-broker checkout API  ── org auth, run-scoped ──▶  policy check (org, repo, run_id, target host)
        │                                                    │
        │  mints scoped, short-lived credential               │ audit log entry
        │  (OAuth token if target supports delegated auth;    │ (who/what/when/ttl/revoked-at)
        │   else a leased vault secret with a TTL)             ▼
        ▼                                              evidence bundle: auth.brokerCheckout=<id>
 two delivery modes:
   (a) proxy mode  — runner's outbound HTTP goes through a broker-run sidecar (localhost
       HTTPS_PROXY); runner holds only a placeholder token; sidecar swaps it for the real
       credential on the wire, per-host policy-matched. Runner process/agent context NEVER
       sees the raw secret. (Agent Vault / 1Password pattern, §1.9.)
   (b) direct-return mode — for flows that must run in-process (e.g. TOTP code derivation,
       ROPG token exchange the runner performs itself) the broker returns the live value into
       a redacted memory region; the capture layer's redaction filter (§4.2) is mandatory here,
       not optional.
```

Key properties:
- **Never persisted locally.** Every checkout is fresh and TTL'd; the OSS local-encrypted cache (§6) is bypassed in broker mode — the broker *is* the cache, with its own lease-reuse window to avoid re-auth storms across a check suite.
- **Policy at checkout, not at storage.** Same shift 1Password names: authority is confirmed per-request, not granted once at login.
- **Audit trail feeds the evidence bundle**, not a side channel — `auth.brokerCheckout` becomes a `provenance: harness` artifact, so "which credential authenticated this run" is part of the tamper-evident record, not just an internal broker log.
- **Kill switch**: revoking a profile broker-side immediately invalidates future checkouts without touching any `ready.yaml`.
- **TOTP seeds and ROPG client secrets live only in the broker's vault** — the customer never hands them to a runner process at all, closing the exact gap WorkOS and Devin's docs both flag (agent session ≠ trusted boundary).

---

## 6. Session-reuse / caching model

Adopts Cypress's `cy.session()` shape (cache + **validate-before-trust**, §1.2) over Playwright's simpler "just reuse the file" shape (§1.1), because validate-before-trust is what prevents a stale/expired session from silently producing false "auth succeeded" evidence.

- **Cache key** = `${profile}:${substrate}:${resources.<target>.host}` — mirrors Cypress's session `id`, scoped so different substrates (local vs `k8s-attach` against a different cluster) or different target hosts never share a cached session.
- **Validate before every reuse**, not just on first capture: `cache.validate` runs a cheap authenticated probe (`http: /api/me` or similar); on failure, force a fresh auth run rather than proceeding on a stale session — this single rule is the fix for the #1 real-world Playwright complaint surfaced in research (token expires mid-suite, tests then fail confusingly instead of re-authenticating, §1.1).
- **TTL** is explicit and capped conservatively (default proposal: 45m) — never longer than the shorter of (target session lifetime, org policy); on expiry the cache entry is dropped, not silently extended.
- **Storage**: `store: local-encrypted` writes an age-encrypted blob outside the repo tree by default (e.g. `~/.proofbench/auth-cache/`, never `./playwright/.auth`-style in-repo unless the user opts in with an explicit insecure flag) — structurally prevents the single most common real-world mistake in every source above (committing a state file). `store: broker` defers entirely to §5 and keeps no local copy at all.
- **Invalidate on 401/403 mid-run**: one forced re-auth retry, then the check reports `fail`/`not-run` with a named reason — never silently continues unauthenticated (same tri-state discipline `evidence-v2.schema.json` already requires for checks generally).
- **Provenance**: every check result records `auth.cacheHit: true|false` and (in broker mode) `auth.brokerCheckout: <id>` in the evidence bundle — ties directly into the existing `provenance: harness|agent` anti-fabrication field, extended to answer "was this run's identity freshly proven or reused, and can we prove *that*."

---

## 7. ADR-ready recommendation

**Decision:** Add a first-class, additive `auth` block to `ready.yaml` (named profiles; one of `basic`/`sso`/`api-key`/`cookie` per profile) bound to a strict `secretRef` scheme (`env|file|sops|vault|awssm|gcpsm|azkv|broker`) that structurally forbids inline plaintext secrets in any manifest. SSO's automatable path is, in priority order: IdP-native password-grant/test-bypass-group/mock-IdP flows the *customer* configures (never a bypass we invent), with TOTP seeds resolved-and-derived at call time for MFA that is TOTP-based, and irreducible human MFA modeled as an existing `gates` entry (`on: mfa-challenge`) rather than new machinery. Session reuse follows Cypress's cache-plus-validate shape, not Playwright's blind-reuse shape. OSS ships local resolvers (env/file/sops/vault/cloud-sm) with zero required infra (SOPS+age as the zero-infra default); the hosted product's moat is a `broker://` resolver, proxy-style (Agent Vault/1Password pattern), that never lets the raw secret reach the runner/agent's context at all, with per-checkout audit logging feeding the evidence bundle's provenance field.

**Alternatives considered:**
1. *Delegate entirely to Playwright's `storageState`/auth-setup-projects and add nothing to `ready.yaml`.* Rejected — doesn't cover non-browser drive verbs (API/CLI checks), doesn't unify basic/API-key/cookie under one model, and has no secrets-reference or broker story (Playwright's own docs concede it doesn't address 2FA at all).
2. *Require the customer to hand the harness one long-lived, always-valid session token/cookie and stop there* (what a number of current browser-agent setups effectively do, per §1.9's threat research). Rejected — no rotation, no scoping, no audit trail; exactly the anti-pattern 1Password/Infisical/WorkOS are all actively moving away from, and it decays mid-suite as sessions age out.
3. *Build native, vendor-specific connectors (a real Okta app, a real Auth0 app, etc.) instead of generic OIDC/SAML + secretRef.* Rejected for v0 — large surface area and vendor sprawl for a problem the generic ROPG/test-bypass-group/mock-IdP patterns already solve; revisit only if a specific customer's IdP has no generic escape hatch.

**Consequences:**
- Positive: interoperates with a customer's existing Playwright/Cypress auth artifacts (`storageState` shape reused directly) — an adoption lever per PLAN.md §8 ("every interop is distribution"); OSS core stays credential-infra-agnostic (no vendored secret backend lock-in); hosted product gets a genuine, differentiated security story consistent with PLAN.md §9.
- Negative: schema grows (new `auth` block + `SecretRef` type + profile indirection) — must ship additive-only per `spec/README.md`'s versioning policy. Local-only OSS users without Vault get just `env`/`file`/`sops` — weaker than broker mode; mitigate with a documented SOPS+age zero-infra quickstart.
- Ongoing cost: TOTP/mock-IdP/test-bypass-group flows all require the *customer* to provision a dedicated automation user or test connection — a real (if small) onboarding step, which should be folded into the onboarding flow Akash scoped as integration shape (A)/(B) config, not treated as a one-off script.

**Open questions (flag for follow-up ADRs, do not block v0 on these):**
- Does any `auth` profile using a full browser-redirect flow (`authorization-code`, no ROPG available — increasingly common as IdPs harden) need a headed-browser-once-then-cache fallback, since Playwright itself has no 2FA-mocking story and some modern Okta/Azure AD orgs disable ROPG outright?
- Should `workspace.yaml` gain an org-level `auth-defaults` so N services behind one corporate SSO don't each redeclare a profile?
- Does a per-check `auth` override (switching to a higher-privilege profile) need the same `gates` treatment as destructive ops, to prevent a compromised/malicious manifest edit from quietly escalating a check's identity?
- When (if at all) does passkey/WebAuthn support (Playwright's virtual authenticator, §1.1) become a fifth first-class mode?
