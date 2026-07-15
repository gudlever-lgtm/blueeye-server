'use strict';

// Regression: a hostile/malformed agent payload must never crash the interface
// health computation. `validateResults` only checks object-ness + size at ingest,
// so `traffic.interfaces` can carry a null / non-object element. Before the fix,
// `computeInterfaceHealth` did `Number(i.rxBytesPerSec)` on that element and threw
// a TypeError — which, in the unguarded /fleet/health loop, 500'd the whole
// fleet dashboard for every operator (one agent poisons all).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeInterfaceHealth, interfaceHealthSummary } = require('../src/health/interfaceHealth');

test('computeInterfaceHealth skips null/non-object interface elements instead of throwing', () => {
  const traffic = {
    elapsedSec: 10,
    interfaces: [
      null,
      'not-an-object',
      42,
      { iface: 'eth0', rxBytesPerSec: 100, txBytesPerSec: 50, speedMbps: 1000, operStatus: 'up' },
    ],
  };
  let out;
  assert.doesNotThrow(() => { out = computeInterfaceHealth(traffic); });
  // Only the one real interface survives.
  assert.equal(out.length, 1);
  assert.equal(out[0].iface, 'eth0');
});

test('interfaceHealthSummary tolerates an all-malformed interfaces array', () => {
  const summary = interfaceHealthSummary({ elapsedSec: 5, interfaces: [null, undefined, 0] });
  // No usable interfaces => null summary, not a crash.
  assert.equal(summary, null);
});

test('computeInterfaceHealth handles a non-array interfaces field', () => {
  assert.doesNotThrow(() => computeInterfaceHealth({ interfaces: null }));
  assert.doesNotThrow(() => computeInterfaceHealth({ interfaces: 'oops' }));
  assert.doesNotThrow(() => computeInterfaceHealth(null));
});
