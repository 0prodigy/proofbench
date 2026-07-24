# Validation corpus

Real merged PRs the tool must verdict correctly. Every case was **blind battle-tested**
(the analyzing agent was not told the outcome). This is the "be our own first customer"
gate: **false-WORKS = 0 across the corpus is release-blocking.**

Blind Sonnet campaign verdict distribution: {"WORKS": 4, "COULD_NOT_DETERMINE": 7, "DOES_NOT_WORK": 1} — **no false-WORKS across 12.**
See `../docs/internal/battle-test-campaign-summary.md` and `../docs/internal/battle-test-01-calcom-webhooks.md`.

Each `battle-tests/*.json` holds the compiled discriminating promise, conjure feasibility,
the blind verdict + basis, holds/breaks, and the new-vector findings for one PR. As conjure
support for each stack is built, these move from **blind prediction** to **executed run**.

| Project | Size | Blind verdict | PR |
|---|---|---|---|
| calcom/cal.com (now calcom/cal.diy) | medium | `WORKS` | https://github.com/calcom/cal.diy/pull/26872 (formerly calcom/cal.com; repo was renamed -- GitHub redirects calcom/cal.com/pull/26872 to this URL) |
| twentyhq/twenty | medium | `COULD_NOT_DETERMINE` | https://github.com/twentyhq/twenty/pull/11041 |
| AppFlowy-IO/AppFlowy | medium | `COULD_NOT_DETERMINE` | https://github.com/AppFlowy-IO/AppFlowy/pull/7172 ("feat: enable to reorder favorites", merged 2025-01-09) |
| rudderlabs/rudder-server | medium | `COULD_NOT_DETERMINE` | https://github.com/rudderlabs/rudder-server/pull/7119 |
| PostHog/posthog | very-big | `COULD_NOT_DETERMINE` | https://github.com/PostHog/posthog/pull/65748 |
| novuhq/novu | small | `COULD_NOT_DETERMINE` | https://github.com/novuhq/novu/pull/8561 (feat(worker,api-service,dashboard): chat custom webhook provider) |
| medusajs/medusa | medium | `COULD_NOT_DETERMINE` | https://github.com/medusajs/medusa/pull/10622 (feat(core-flows,dashboard,js-sdk,medusa,types): support Fulfillment Options) |
| supabase/supabase | medium | `DOES_NOT_WORK` | https://github.com/supabase/supabase/pull/40695 |
| getsentry/sentry | very-big | `COULD_NOT_DETERMINE` | https://github.com/getsentry/sentry/pull/106833 |
| documenso/documenso | small | `WORKS` | https://github.com/documenso/documenso/pull/3031 |
| TryGhost/Ghost | medium | `WORKS` | https://github.com/TryGhost/Ghost/pull/15783 ("Added ability to send test email with chosen newsletter", merged 2023-01-09) |
| n8n-io/n8n | medium | `WORKS` | https://github.com/n8n-io/n8n/pull/7130 (merged 2023-10-17) |
