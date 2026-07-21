// @ts-check
/**
 * Provider-registry unit tests — the M2 seam extraction. Pure config→provider resolution, no docker,
 * no network: the registry maps a recipe's config to the EXISTING phase provider (conjure/tapStore/
 * openBrowser), rejects an unknown mode/engine with an honest error, and — as the DEFAULT wiring —
 * lets an explicitly injected seam WIN over the config-keyed default (catch.mjs's mock-injection path).
 * The live conjure→drive→tap plumbing itself is proven by `pb prove`, not here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { environmentProvider, tapProvider, driveProvider, argoTapProvider, resolveCatchSeams, resolveArgoSeams } from '../src/registry.mjs';
import { conjure } from '../src/conjure.mjs';
import { tapStore } from '../src/storetap.mjs';
import { openBrowser } from '../src/browserdrive.mjs';
import { openWorkflowRun, k8sExecTap } from '../src/argoworkflows.mjs';

/** @param {any} x @returns {any} */
const asAny = (x) => x;

/**
 * A minimal recipe carrying only the config fields the registry keys on (n8n golden shape: from_tree /
 * run / sqlite / drive.mode:"http" — note the golden recipe is browser-driven despite drive.mode:"http").
 * Overridable per case to exercise each phase's dispatch.
 * @param {any} [over]
 */
function makeRecipe(over = {}) {
  return asAny({
    code_identity: { mode: 'from_tree' },
    conjure: { mode: 'run' },
    store_tap: { engine: 'sqlite' },
    drive: { mode: 'http' },
    ...over,
  });
}

test('registry: config→provider — a from_tree/run/compose/pinned_image recipe resolves Environment to the existing conjure', () => {
  assert.equal(environmentProvider(makeRecipe()), conjure);
  assert.equal(environmentProvider(makeRecipe({ conjure: { mode: 'compose' } })), conjure);
  assert.equal(environmentProvider(makeRecipe({ code_identity: { mode: 'pinned_image' } })), conjure);
});

test('registry: a missing conjure.mode defaults to run (single container), still resolving to conjure', () => {
  assert.equal(environmentProvider(makeRecipe({ conjure: {} })), conjure);
});

test('registry: config→provider — a sqlite/postgres/mongo recipe resolves Tap to the existing tapStore', () => {
  assert.equal(tapProvider(makeRecipe()), tapStore);
  assert.equal(tapProvider(makeRecipe({ store_tap: { engine: 'postgres' } })), tapStore);
  assert.equal(tapProvider(makeRecipe({ store_tap: { engine: 'mongo' } })), tapStore);
});

test('registry: drive.mode DISPATCH — grandfathered modes resolve to the browser drive (#7130 http stays browser-driven)', () => {
  // The n8n golden recipe declares drive.mode:"http" yet browser-drives today — this must not change.
  assert.equal(driveProvider(makeRecipe({ drive: { mode: 'http' } })), openBrowser);
  assert.equal(driveProvider(makeRecipe({ drive: { mode: 'browser' } })), openBrowser);
  assert.equal(driveProvider(makeRecipe({ drive: { mode: 'note-lifecycle' } })), openBrowser);
  assert.equal(driveProvider(makeRecipe({ drive: { mode: 'deferred' } })), openBrowser);
  assert.equal(driveProvider(makeRecipe({ drive: undefined })), openBrowser); // absent ⇒ deferred ⇒ browser
});

test('registry: drive.mode DISPATCH — argo-workflows resolves to the Argo drive/observe provider', () => {
  assert.equal(driveProvider(makeRecipe({ drive: { mode: 'argo-workflows' } })), openWorkflowRun);
});

test('registry: drive.mode DISPATCH — an unknown mode has no registered drive provider (honest error)', () => {
  assert.throws(
    () => driveProvider(makeRecipe({ drive: { mode: 'k8s-attach' } })),
    /registry: drive\.mode has no registered drive provider[\s\S]*k8s-attach/
  );
});

test('registry: argo tap dispatch — k8s-exec resolves to the (live-gated) store-direct tap; any other engine errors', () => {
  assert.equal(argoTapProvider(makeRecipe({ store_tap: { engine: 'k8s-exec' } })), k8sExecTap);
  assert.throws(
    () => argoTapProvider(makeRecipe({ store_tap: { engine: 'sqlite' } })),
    /registry: store_tap\.engine[\s\S]*requires a 'k8s-exec' out-of-band store tap/
  );
});

test('registry: resolveArgoSeams wires the argo drive + tap; injection WINS over the config-keyed default', () => {
  const argoR = makeRecipe({ drive: { mode: 'argo-workflows' }, store_tap: { engine: 'k8s-exec' } });
  const def = resolveArgoSeams({}, argoR);
  assert.equal(def.argoRunFn, openWorkflowRun);
  assert.equal(def.argoTapFn, k8sExecTap);
  const myRun = asAny(async () => ({}));
  const myTap = asAny(async () => []);
  const inj = resolveArgoSeams(asAny({ argoRunFn: myRun, argoTapFn: myTap }), argoR);
  assert.equal(inj.argoRunFn, myRun);
  assert.equal(inj.argoTapFn, myTap);
});

test('registry: unknown type→honest error — an unknown conjure.mode has no registered environment provider', () => {
  assert.throws(
    () => environmentProvider(makeRecipe({ conjure: { mode: 'nope' } })),
    /registry: conjure\.mode has no registered environment provider[\s\S]*nope/
  );
});

test('registry: config→provider — the Lyric class (k8s-attach / multi_repo) resolves Environment to the existing conjure', () => {
  assert.equal(environmentProvider(makeRecipe({ conjure: { mode: 'k8s-attach' }, code_identity: { mode: 'multi_repo' } })), conjure);
});

test('registry: resolveCatchSeams routes a k8s-attach/multi_repo/mongo (the Lyric class) recipe end-to-end without throwing', () => {
  const lyricRecipe = makeRecipe({
    code_identity: { mode: 'multi_repo' },
    conjure: { mode: 'k8s-attach' },
    store_tap: { engine: 'mongo' },
    drive: { mode: 'note-lifecycle' },
  });
  const seams = resolveCatchSeams({}, lyricRecipe);
  assert.equal(seams.conjureFn, conjure);
  assert.equal(seams.tapStoreFn, tapStore);
});

test('registry: unknown type→honest error — an unknown code_identity.mode has no registered code-identity provider', () => {
  assert.throws(
    () => environmentProvider(makeRecipe({ code_identity: { mode: 'ci_attested' } })),
    /registry: code_identity\.mode has no registered code-identity provider[\s\S]*ci_attested/
  );
});

test('registry: unknown type→honest error — an unknown store_tap.engine has no registered tap provider', () => {
  assert.throws(
    () => tapProvider(makeRecipe({ store_tap: { engine: 'k8s-exec' } })),
    /registry: store_tap\.engine has no registered tap provider[\s\S]*k8s-exec/
  );
});

test('registry: resolveCatchSeams wires all three phases to the native providers when nothing is injected', () => {
  const seams = resolveCatchSeams({}, makeRecipe());
  assert.equal(seams.conjureFn, conjure);
  assert.equal(seams.tapStoreFn, tapStore);
  assert.equal(seams.openBrowserFn, openBrowser);
});

test('registry: injection overrides the registry — an INJECTED seam WINS over the config-keyed default', () => {
  const myConjure = asAny(async () => ({}));
  const myTap = asAny(async () => []);
  const myBrowser = asAny(async () => ({}));
  const seams = resolveCatchSeams(asAny({ conjureFn: myConjure, tapStoreFn: myTap, openBrowserFn: myBrowser }), makeRecipe());
  assert.equal(seams.conjureFn, myConjure);
  assert.equal(seams.tapStoreFn, myTap);
  assert.equal(seams.openBrowserFn, myBrowser);
});

test('registry: a partially-injected seam wins for its phase; the rest resolve via the registry', () => {
  const myTap = asAny(async () => []);
  const seams = resolveCatchSeams(asAny({ tapStoreFn: myTap }), makeRecipe());
  assert.equal(seams.tapStoreFn, myTap); // injection wins for tap
  assert.equal(seams.conjureFn, conjure); // registry default for the rest
  assert.equal(seams.openBrowserFn, openBrowser);
});

test('registry: full injection short-circuits registry resolution entirely (why catch.test.mjs mocks are safe)', () => {
  const myConjure = asAny(async () => ({}));
  const myTap = asAny(async () => []);
  const myBrowser = asAny(async () => ({}));
  // A recipe with UNKNOWN modes/engine would throw if the registry resolved it — but full injection
  // short-circuits every resolver, so this must NOT throw (a fully-mocked test never hits config checks).
  const badRecipe = makeRecipe({ conjure: { mode: 'nope' }, code_identity: { mode: 'nope' }, store_tap: { engine: 'nope' } });
  assert.doesNotThrow(() => resolveCatchSeams(asAny({ conjureFn: myConjure, tapStoreFn: myTap, openBrowserFn: myBrowser }), badRecipe));
});
