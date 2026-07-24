# Spike: driving documenso's Konva `<canvas>` to place a Field — FEASIBLE

**Date:** 2026-07-18 · **SUT:** documenso @ `97835b8d` (v2.14.0), recipe
`recipes/documenso-envelope-fields-pr3031` (compose · postgres tap on `"Field"`).
**Question:** can pb's browser-drive primitive drive documenso's Konva canvas editor to place a
Field, verified out-of-band via the psql tap? **Answer: YES.** This makes documenso a viable 2nd
EXECUTABLE Catch target (anti-overfit: the Catch is not n8n-shaped — different store engine,
different drive surface).

## Live result (proven end-to-end, standalone)

```
psql "Field" BEFORE: 0
walk: select the "Name" field button → W3C Actions pointer click over the .react-pdf__Page center
psql "Field" AFTER:  1   (delta +1, within ~1s of the autosave debounce)
persisted row: id=1 type=NAME page=1 recipientId=2 x=13.1% y=40.7% inserted=false
```

The load-bearing signal is the **out-of-band psql tap** (harness provenance), not any DOM read.

## The canvas-walk technique

Documenso v2.14.0's field placement is NOT a per-field DOM node — the placed fields render on a
Konva `<canvas>` over a react-pdf page (`.react-pdf__Page`). Placement is driven by the app's own
`window` `mouseup` listener (`envelope-editor-fields-drag-drop.tsx` → `editorFields.addField`),
which hit-tests the cursor against the page via `document.elementsFromPoint(clientX, clientY)`
(`use-document-element.ts`). So the walk is:

1. Advance to the **Add Fields** step (`?step=addFields`) — a recipient + envelope item are
   auto-selected (both required or `onMouseClick` early-returns).
2. Select a field type — click a field-type `<button>` (sets `selectedField`; the window mouseup
   listener attaches on the next tick).
3. **Place it** — a real W3C Actions pointer `move → down → up` at the **viewport center of the
   `.react-pdf__Page`** (coords computed via `execute` + `getBoundingClientRect`). This is the new
   `browserdrive` capability: `client.clickAt(x, y)` (and the general `client.pointer(actions)`).
4. Documenso **autosaves** (`useEnvelopeAutosave`, ~2s debounce) → `trpc.envelope.field.set`
   persists the `"Field"` row. No explicit Save button. The psql tap then reads +1.

`clickAt`/`pointer` are the COORDINATE escape hatch (complementing `execute`, the JS escape
hatch) — general to any canvas surface (Konva, PDF placement, drawing), never recipe-baked.

## Load-bearing topology finding (general to browser-drive, not documenso-specific)

The containerized chromium reaches the host-published SUT via `host.docker.internal`. documenso
builds **absolute** asset URLs (the PDF: `/api/files/.../item.pdf`) from `NEXT_PUBLIC_WEBAPP_URL`,
which defaults to `http://localhost:3000`. Inside the browser container `localhost` is the
container itself → the PDF fetch fails (`TypeError: Failed to fetch`) → react-pdf shows "Something
went wrong while loading the document" → no page, no canvas. The fix is to make the SUT emit
browser-reachable self-URLs: set `NEXT_PUBLIC_WEBAPP_URL=http://host.docker.internal:3000`
(runtime env — read via `process.env` server-side and `window.__ENV__` client-side, so no
rebuild). With that, react-pdf fetches the PDF from a reachable host and the canvas renders.
n8n's Form Trigger (M5) never hit this because it drives a same-origin form with relative URLs.

## Reaching a drivable authenticated editor (setup — allowed to use the API/DB)

- **Auth:** `POST /api/auth/email-password/signup` → retrieve the verification token from the
  inbucket mailbox (`GET :9000/api/v1/mailbox/{localpart}`) → `POST
  /api/auth/email-password/verify-email {token}` auto-authenticates (sets the signed `sessionId`
  cookie). Login otherwise requires `emailVerified`.
- **Envelope:** `POST /api/v2/envelope/create` (multipart `payload` + `files[]`, header
  `x-team-id`) — creates an **internalVersion=2** envelope (the Konva editor). `document.create`
  makes internalVersion=1 and the `/edit` route redirects to the legacy DOM editor, so it must be
  `envelope.create`. Team id/url come from the user's auto-created personal org (psql, setup only).
- **Editor URL:** `/t/{teamUrl}/documents/{envelopeId}/edit` (the `envelope_…` id string, not the
  numeric one). The session cookie is injected into the browser via WebDriver addCookie for the
  `host.docker.internal` domain (the hono signed value is domain-independent).

## Follow-up (NOT done here — a separate slice)

Flip the recipe `drive.mode` to `'browser'` and wire the documenso Catch into `runCatch`
(`src/catch.mjs`). That slice must add, on the drive/setup side: (a) session-cookie injection into
the browser client, (b) the `NEXT_PUBLIC_WEBAPP_URL=host.docker.internal` conjure/compose env for
this recipe class, (c) the agent-proposed addFields walk above bracketed by the two psql `"Field"`
taps. The `"Field"` delta is the effect the differential Catch (PR #3031) would adjudicate. This
spike changed only `src/browserdrive.mjs` (the `clickAt`/`pointer` capability) + its unit test;
the honesty core and `src/catch.mjs` are untouched, and `documenso` stays honest-`deferred` until
the wiring lands.
