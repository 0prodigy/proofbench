// @ts-check
/**
 * E1 gate tests: the whole gate passes, and each driver lands correctly on its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runGate } from '../src/e1/gate.mjs';
import { MALICIOUS_DRIVERS, HONEST_DRIVER } from '../src/e1/drivers.mjs';
import { verdict } from '../src/verdict.mjs';
import { verifySeal } from '../src/evidence.mjs';
import { Verdict } from '../src/types.mjs';

test('runGate().passed === true (no malicious driver reaches WORKS; honest driver is WORKS)', () => {
  const { passed, rows } = runGate();
  assert.equal(passed, true);
  const honest = rows.find((r) => r.name === HONEST_DRIVER.name);
  assert.ok(honest, 'honest driver row present');
  assert.equal(honest.verdict, Verdict.WORKS);
  for (const r of rows) {
    if (r.name === HONEST_DRIVER.name) continue;
    assert.notEqual(r.verdict, Verdict.WORKS, `${r.name} must not reach WORKS`);
  }
});

test('each malicious driver individually: seal intact but not WORKS (tampered-seal => UNVERIFIED)', () => {
  assert.equal(MALICIOUS_DRIVERS.length, 9);
  for (const d of MALICIOUS_DRIVERS) {
    const bundle = d.build();
    assert.ok(bundle.seal, `${d.name} must be sealed`);
    if (d.name === 'tampered-seal') {
      assert.equal(verifySeal(bundle, bundle.seal.publicKey), false, 'tampered seal must not verify');
    } else {
      assert.equal(verifySeal(bundle, bundle.seal.publicKey), true, `${d.name} seal should verify`);
      assert.notEqual(verdict(bundle).state, Verdict.WORKS, `${d.name} must not reach WORKS`);
    }
  }
});

test('honest driver: seal verifies and the verdict is WORKS', () => {
  const b = HONEST_DRIVER.build();
  assert.ok(b.seal);
  assert.equal(verifySeal(b, b.seal.publicKey), true);
  assert.equal(verdict(b).state, Verdict.WORKS);
});
