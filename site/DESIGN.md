# Proofbench site design system — "The Verdict Ledger"

Status: ruling · 2026-07-10 · This file is the contract for site/. Implementers derive
every color, type, and layout decision from it. Deviations need orchestrator sign-off.

## 1. Concept

Proofbench is **the system of record for agent proof**. The site is designed as a
living record — an official document that fills itself in with real system output.

The inversion that makes it ours: the page ground is **paper** (cool porcelain, ink
text, ledger discipline), and the *evidence* — terminals, bundles, manifests — sits in
**dark slabs** that visually pop as "the real thing". Every dark-AI-startup site makes
the chrome dark and the content glow; we make the record light and the machine output
dark. Agentfield is warm-black + gold; the generic default is near-black + blue; we are
neither.

Anti-patterns explicitly banned (frontend-design skill): warm cream #F4F1EA + terracotta;
near-black + lone acid accent; broadsheet hairline-rule newspaper look; purple gradient
hero; Inter as body face; emoji section markers; everything centered.

## 2. Tokens

Define on `:root`; redefine under `@media (prefers-color-scheme: dark)` and again under
`:root[data-theme="dark"]` / `:root[data-theme="light"]` (toggle must win both ways).
Style components ONLY through tokens.

### Light (default — the ledger)

--paper:      #F2F4F1   /* cool porcelain, green-grey bias — NOT warm cream */
--paper-2:    #E9EDE9   /* inset panels, table stripes */
--ink:        #14201A   /* green-black ink — headings, body */
--ink-2:      #45544C   /* secondary text (AA on paper) */
--ink-3:      #6A776F   /* metadata, captions (large text only) */
--line:       #C9D2CB   /* rules, borders */
--proof:      #0B6B44   /* brand = proof green; links, primary CTA, pass */
--fail:       #A93226   /* oxblood stamp red */
--notrun:     #96690D   /* ochre — not-run/gated */
--slab:       #101613   /* dark evidence slabs (terminals, bundles) */
--slab-ink:   #DCE5DE   /* text inside slabs */
--slab-line:  #26302A
--seal:       #0B6B44   /* stamp/seal strokes */

### Dark (the archive at night — equal care, not an inversion)

--paper:      #0F1512
--paper-2:    #151C18
--ink:        #E4EAE5
--ink-2:      #A9B5AC
--ink-3:      #7E8B82
--line:       #273129
--proof:      #43C98A   /* brightened for contrast on dark */
--fail:       #E4695C
--notrun:     #D9A83E
--slab:       #0A0F0C   /* slabs stay darker than paper — hierarchy preserved */
--slab-ink:   #D7E0D9
--slab-line:  #222C25
--seal:       #43C98A

Semantic tri-state (pass/fail/not-run) IS the brand vocabulary — proof green doubles as
brand accent deliberately: Proofbench's product is "pass, with proof". Fail/not-run are
semantic only, never decorative.

## 3. Type

Three roles, self-hosted woff2 in site/assets/fonts/ (subset latin, weights listed only):

- **Display — Spectral (600, 500)**: serif designed for documents; headlines, the
  certificate. Used with restraint: h1/h2 and the record artifacts. `text-wrap: balance`.
- **Body — Public Sans (400, 600)**: the U.S. federal design-system face — literally
  built for official records. All running text, nav, UI.
- **Mono — IBM Plex Mono (400, 500)**: terminals, digests, serials, code, eyebrows
  (uppercase, +0.08em tracking).

Scale: 13 / 15 / 17 (body) / 20 / 26 / 34 / 46 / 60. Running text ≤ 68ch.
`font-variant-numeric: tabular-nums` anywhere digits align. NO Inter, NO Space Grotesk.

## 4. Layout & structure

- 12-col grid, max-width 1140px, generous but DENSE — no empty voids between sections.
  Section rhythm: eyebrow (mono, small caps) → display headline → content. Left-aligned.
- **Structure is information**: the pipeline sections are numbered as ledger entries
  (№1 manifest → №2 bring-up → №3 drive → №4 evidence → №5 verdict) because it IS a
  real sequence. Nothing else gets numbers.
- Docs: fixed left sidebar (grouped Diátaxis nav), content column ≤ 68ch, right-side
  "on this page" TOC on wide screens. Every page: prev/next links, copy button on every
  code block, search input filtering a static JSON index.

## 5. Signature element (the one bold spend)

**The hero is a verification record filling itself in.** Left: a paper certificate
(Spectral, serial number, fields: repo, substrate, rung, verdict — initially blank
dashes). Right: a dark terminal slab replaying the REAL redcat run (typed line by
line). As each terminal milestone lands, the corresponding certificate field inks in;
when `verdict: pass` prints, a circular **PROOF·L3 seal stamps onto the certificate**
(scale 1.4→1 + slight rotate, 300ms, one thunk — the page's single orchestrated
moment). `prefers-reduced-motion`: everything pre-filled, no typing, seal static.
No-JS: fully pre-filled state in markup.

Everything else stays quiet. No parallax, no scroll-jacking, no gradient blobs.

## 6. Motion language (meaning only)

- Terminal typing = live run. Blinking caret only while "running".
- Seal stamp = verdict landed (once, hero only).
- Proof-ladder rungs fill L0→L3 in step with the hero run.
- Status dots pulse ONLY next to genuinely live claims (e.g. "port-forward open").
- Hover: cards lift 1px + border darkens. That's it. Durations 120–300ms.

## 7. Honesty rules (non-negotiable)

- Every number on the page is real and traceable to a run in this repo's history
  (redcat: verdict pass, proof L3, image digest pin; explore: $1.70 · 9 turns · 8
  proposed checks; acceptance 6/6). NO fake testimonials, NO invented star counts,
  NO fabricated dashboards. If we don't have it, we don't show it.
- Terminal content is verbatim from real runs (may be trimmed, never invented).

## 8. Voice

Short declarative pairs, noun-first, contrast framing. Headline: "Your agents say it
works. Proofbench proves it." Section heads follow the pattern: "No narration. Just
exit codes." / "One manifest. Any substrate." / "Verdicts are set last — by the
harness, never the agent." Buttons say what happens: "Run the quickstart", "Read the
spec". Errors and empty states explain the fix.

## 9. Functional chrome (parity with the best, all vanilla JS, zero build)

- Tabbed install/quickstart widget (tabs = substrates: local / compose / k8s-attach),
  copy button, in hero and footer.
- Theme toggle (stamps data-theme, persisted to localStorage).
- FAQ accordion (native <details>).
- Comparison table: "LLM code review" vs "Proofbench" (grounded in the pr-af teardown).
- Docs search: static JSON index + client-side filter (title+headings+keywords).
- llms.txt at site root indexing all pages (AI agents are a first-class docs audience).
- Copy buttons on ALL code blocks, docs and landing.

Accessibility floor: visible keyboard focus (2px proof-green outline), AA contrast both
themes, semantic landmarks, skip-link on docs pages.
