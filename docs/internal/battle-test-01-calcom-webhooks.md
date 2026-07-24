# Battle-test #1 — Cal.com org-scoped webhooks (blind)

*Purpose: prove or break the Phase-3 theory against a real, complex, multi-service feature —
not a toy ("did the total update"). Method: an adversarial agent (Fable) traced the full
pipeline against a real change **blind to its outcome** (told it was "a proposal under review";
forbidden from looking up whether it merged). It cloned Cal.com and grounded the trace in the
actual webhook code. The orchestrator alone knew the outcome and revealed it only after.*

**Target:** Cal.com PR #15144, "org-wide webhooks" — an org owner creates one webhook scoped to
the whole organization; it should fire for booking/meeting events from **any** user or team in
the org. Chosen because its essence is an **async outbound delivery to a third-party endpoint
across services** — the hardest case for the theory's honesty boundaries (egress, async
settling, cross-service causality, third-party-essence).

---

## Headline

The honesty **core survives** contact with a real feature — propose/dispose, sealed receipts,
tri-state, reproduce-to-convict, front-door discipline all held. But the trace found:

1. **A class-fatal gap in the property as written (B1).** `P′(b)` requires the effect to be a
   *persisted-state delta* confirmed on a *fresh-session user surface*. A webhook delivery is
   neither (Cal.com has no delivery-log table and no delivery UI). Read literally, the theory
   returns **CND on the central claim of the entire outbound-delivery class** — honest, but
   useless for async/event-driven/callback features. **Fixable (R1).**
2. **A new false-WORKS vector (FW-11, "owner-shadow / quantifier collapse").** A walk that only
   exercises the configuring owner's own event (CREATED-only) passes **all three** day-one
   mechanisms while never testing the actual feature (org-wide scoping for *other* members).
   Real delta, real binding, front-door walk, effectChecks ≥ 1, hostiles "survived" → a false
   WORKS on a real feature. **The theory's true remaining gap. Fixable (R2).**
3. **A mechanism that does not survive contact (B4).** Mutation attribution as written
   ("any delta with no user-action cause → CND") would **false-CND every real app** — ambient
   churn (sessions, cron, queue heartbeats) is constant. **Fixable (R4).**

And two genuine strengths the feature *revealed*:

- **User-configured destinations are verifiable without stubs.** The webhook URL is *user data
  typed through the front door*, so pointing it at a pb-controlled receiver is a legitimate
  user-shaped act, not a double. This **rescues the whole callback/webhook class from CND** —
  the "third-party essence → CND" rule only applies to *fixed-vendor* destinations (calendar
  sync). A real insight the toy demo never surfaces.
- **The sealed room proves negatives.** "Org A must not receive org B's bookings" is provable as
  *zero egress to the receiver in the window* — stronger evidence than any normal test suite
  produces.

**Verdict on the theory: revisable-and-buildable, not broken — but not shippable as written.**
Two mandatory revisions (R1, R2) + three hardening (R3–R5).

---

## The blind phase-by-phase trace (condensed)

- **P1 Promise.** One sentence is enough as *input*, not as *contract*: the universal quantifier
  ("any user or team") forces a structured claim matrix. The **discriminating** claim is
  delivery for a booking on an org **member who is not the owner and has no webhook of their
  own** — the only claim that separates "org scoping works" from "the row acts like the owner's
  personal webhook." Plus a child-team claim (a different code path) and a **negative**
  (out-of-org booking → no delivery = the privacy hostile). Plural event class → **one claim per
  selected trigger** (load-bearing; see the reveal).
- **P2 Environment.** Conjure is possible and mostly honest: real Next.js app + Postgres
  (pb-owned) + the real dispatch path; declared doubles for SMTP (sink) and wildcard subdomain
  DNS (orgs live on subdomains — not optional); sealed out: Google/Outlook/Daily/Stripe →
  **instant-meeting leg is NOT-EXECUTED → CND** (honest). Hazards: the feature is invisible
  without `ORGANIZATIONS_ENABLED` + flag + subdomain `WEBAPP_URL` (must mine the repo's own e2e
  topology, R5); and an org world (owner, accepted member, child team, outsider) **cannot be
  built through the front door** → fixture-built → verdict rests on fixture-shaped predicates
  (R3, FW-12).
- **P3/P4 Walk.** Owner creates the org webhook pointing at `hooks.pb.local/<nonce>`; anonymous
  bookers hit the public pages of a **member**, a **child team**, and an **outsider**; cancel a
  booking (via the attendee link read from the SMTP sink). Hostiles that matter: out-of-org leak
  (negative), inactive-toggle, trigger-filter mismatch, non-owner-cannot-create (UI-only →
  N/A-by-vocabulary, auto-confessed). Decoy the mechanisms must reject: the form's "test-ping"
  button — killed by **content binding** (payload must contain the booking uid minted *in the
  window*).
- **P5 Capture / the crux.** The receiver is **not a stub** (user-supplied URL). The egress
  effect = the POST left the app in-window with payload bound to a persisted entity. The
  **negative** (no cross-org delivery) is provable via the egress ledger. Delayed triggers →
  the write-set oracle sees the persisted `WebhookScheduledTriggers` row now; the *delivery* leg
  is honestly `notCovered` without clock control (split verdict).
- **P6 Verdict.** Deterministic from receipts. Most probable: **DOES NOT WORK (partial
  implementation)** — decisive moment: *"cancelled the member's booking: the member's personal
  webhook received BOOKING_CANCELLED; the org endpoint received nothing."*

---

## Where the theory HOLDS vs BREAKS (ranked)

**Holds:** user-configured destination ⇒ sealed-room-verifiable outbound; content-binding
defeats decoys; provable negatives; tri-state honest at boundaries (instant-meeting CND,
delayed-trigger split); the hostile walk catches the likely real bug **if** the claim matrix
forces per-trigger probes.

**Breaks / must-revise:**
- **B1 (fatal, fixable):** `P′(b)` CNDs all egress effects. → R1.
- **B2 → FW-11 (fatal, fixable):** owner-shadow / quantifier collapse passes all mechanisms. → R2.
- **B3 → FW-12 (open, boundable):** fixture-world divergence — the verdict rests on
  fixture-shaped rows production may not produce. → R3 disclosure.
- **B4 (false-CND death, fixable):** mutation attribution CNDs every real app. → R4.
- **B5:** flag/license-gated features defeat naive conjure. → R5.
- **B6 (class ceiling, honest):** cron/time-shifted delivery legs need declared clock control →
  split verdict (now-leg confirmed, later-leg `notCovered`).
- **FW-14 (open):** sandbox flags ≠ customer prod config — a WORKS speaks about *code*, and must
  stay silent about *config* divergence.

---

## Mandatory + hardening revisions (fold into the theory)

- **R1 (mandatory) — egress-aware effect check.** Promote the sealed-room egress ledger +
  pb-controlled receivers to first-class observed stores. An **egress effect check** is
  admissible iff (i) the POST leaves the app container inside a settle-extended user-action
  window, (ii) payload content binds to an entity the same window persisted (booking uid /
  walk-minted nonce), (iii) optionally matches the front-door-configured secret. For egress
  claims, **content binding replaces the fresh-session surface leg.** Carve-out codified: *a
  destination the user configures through the front door is user data; aiming it at a controlled
  surface is a walk, not a double.* (Fixed-vendor destinations remain CND.)
- **R2 (mandatory) — day-one mechanism #4: quantifier lint.** Intent containing any / all /
  every / whole-X forces **≥2 distinct in-scope instantiations that are not the configuring
  actor**, plus **≥1 out-of-scope negative**, enforced at *verdict time* like `effectChecks ≥ 1`.
  Plural event classes force per-trigger claims or an explicit `Assumed:` narrowing sealed into
  the echo. Closes owner-shadow structurally; adequacy beyond quantifiers stays corpus-bounded.
- **R3 — worldProvenance tier** (`PRODUCT-BUILT | REPO-FIXTURE | PB-FIXTURE`) in every case
  file, preferring the repo's own seed/e2e fixtures, plus a world-shape receipt listing the
  fixture rows the claims' queries actually read.
- **R4 — attribution calibration.** Idle-baseline subtraction + causal-chain (FK) attribution
  for harness-known async writers (queue/scheduled rows inherit the originating window);
  unattributed writes to *claim-relevant* tables stay fatal. (Replaces the too-strict rule.)
- **R5 — conjure topology mining includes the repo's own e2e/CI config** (feature flags,
  subdomain DNS, seeds); declared-substrate interventions (DNS, SMTP, later clock) are receipted
  and disclosed, never silent.

---

## The blind prediction, and the reveal

**Fable's blind call (no outcome knowledge):** most probable verdict **DOES NOT WORK — partial
implementation**, because the change threads org resolution into only two call sites
(`handleNewBooking`, `handleInstantMeeting`) while dispatch is **per-call-site**, so an honest
per-trigger claim set would falsify on CANCELLED.

**The reveal (orchestrator):** PR #15144 **merged June 2024**. A spot-check of the current
Cal.com HEAD shows `getOrgIdFromMemberOrTeamId` now threaded across many handlers
(reschedule, confirm, **cancel**) plus a centralized `WebhookService` — i.e. the org-scoping
coverage **was completed by later PRs**, not this one. The PR's own change surface (two handlers)
is consistent with the blind prediction: **partial at merge, completed later.** "Merged" meant
"reviewed and accepted," **not** "complete" — exactly the sibling-path miss the product exists
to surface.

**Honest caveat (no overclaim):** we did **not** build pb and run it against the PR's
merge-point commit, so we have not *proven* a merge-time delivery gap — we have a grounded blind
prediction consistent with the change surface and with the later completion visible in HEAD. The
battle-test's value is not "we matched the merge outcome"; it is that **the theory produced a
discriminating, non-toy, honest verdict on a hard cross-service feature, and named a real risk
class human review ships.**

---

## What this proves

1. The theory is not a toy-only design: on a real async/multi-service feature it compiles a
   *discriminating* claim matrix and targets the *actual* risk (per-trigger threading), not a
   status code.
2. Proving on paper caught a **class-fatal property gap (B1)** and a **false-WORKS vector
   (FW-11)** *before any code* — the entire point of theory-first.
3. The feature *revealed* two real strengths (user-configured-destination verifiability;
   provable negatives) that generalize well beyond webhooks.
4. Next battle-tests should stress the still-open items: FW-12 (fixture-world divergence) and
   FW-14 (config divergence), plus a native-client target (AppFlowy) to probe the web-front-door
   assumption, and a pure-backend data pipeline (rudder-server) to probe the API-only drive path.
