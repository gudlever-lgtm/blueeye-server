'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateRow, deriveSequenceState, groupRows } = require('../src/incidents/detection');

const REACH = { metric: 'reachability', warning_value: null, critical_value: null, debounce_count: 3 };
const LAT = { metric: 'latency', warning_value: 150, critical_value: 300, debounce_count: 3 };
const LOSS = { metric: 'packet_loss', warning_value: 2, critical_value: 5, debounce_count: 3 };

// Helper: a row at minute `m` past a fixed base.
const base = Date.parse('2026-06-01T00:00:00Z');
const row = (m, extra) => ({ ts: new Date(base + m * 60000), target: 't', ...extra });

// ---- evaluateRow -----------------------------------------------------------

test('evaluateRow: reachability fails critical on a down probe, passes when ok', () => {
  assert.deepEqual(evaluateRow({ ok: false }, 'reachability', REACH), { state: 'fail', severity: 'critical' });
  assert.deepEqual(evaluateRow({ ok: true }, 'reachability', REACH), { state: 'pass' });
});

test('evaluateRow: latency warns at >=warning, criticals at >=critical, passes below', () => {
  assert.deepEqual(evaluateRow({ rttMs: 120 }, 'latency', LAT), { state: 'pass' });
  assert.deepEqual(evaluateRow({ rttMs: 150 }, 'latency', LAT), { state: 'fail', severity: 'warning' });
  assert.deepEqual(evaluateRow({ rttMs: 305 }, 'latency', LAT), { state: 'fail', severity: 'critical' });
});

test('evaluateRow: a missing metric reading is neutral (skip), not a recovery', () => {
  assert.deepEqual(evaluateRow({ rttMs: null }, 'latency', LAT), { state: 'skip' });
  assert.deepEqual(evaluateRow({ lossPct: undefined }, 'packet_loss', LOSS), { state: 'skip' });
});

// ---- deriveSequenceState: debounce ----------------------------------------

test('debounce does not open before debounce_count consecutive failures', () => {
  // two failures (<3) — no incident yet.
  const s = deriveSequenceState([row(0, { ok: false }), row(1, { ok: false })], 'reachability', REACH);
  assert.equal(s.open, false);
});

test('opens exactly at debounce_count, started_at = FIRST failure of the run', () => {
  const rows = [row(0, { ok: false }), row(1, { ok: false }), row(2, { ok: false })];
  const s = deriveSequenceState(rows, 'reachability', REACH);
  assert.equal(s.open, true);
  assert.equal(s.severity, 'critical');
  assert.equal(s.startedAt.toISOString(), new Date(base).toISOString()); // first failure, not the 3rd
});

test('a passing result mid-run resets the counter (no premature open)', () => {
  const rows = [
    row(0, { ok: false }), row(1, { ok: false }),
    row(2, { ok: true }), // recovery resets
    row(3, { ok: false }), row(4, { ok: false }),
  ];
  const s = deriveSequenceState(rows, 'reachability', REACH);
  assert.equal(s.open, false); // only 2 consecutive after the reset
});

test('started_at points to the first failure of the CURRENT run after an earlier reset', () => {
  const rows = [
    row(0, { ok: false }), row(1, { ok: true }), // blip
    row(2, { ok: false }), row(3, { ok: false }), row(4, { ok: false }), // real run from minute 2
  ];
  const s = deriveSequenceState(rows, 'reachability', REACH);
  assert.equal(s.open, true);
  assert.equal(s.startedAt.toISOString(), new Date(base + 2 * 60000).toISOString());
});

// ---- deriveSequenceState: recovery ----------------------------------------

test('an open incident closes when a result returns under threshold', () => {
  const rows = [
    row(0, { ok: false }), row(1, { ok: false }), row(2, { ok: false }), // opens
    row(3, { ok: true }), // recovers
  ];
  const s = deriveSequenceState(rows, 'reachability', REACH);
  assert.equal(s.open, false);
  assert.equal(s.lastRecoveryAt.toISOString(), new Date(base + 3 * 60000).toISOString());
});

test('latency severity escalates within a run (warning then critical)', () => {
  const rows = [row(0, { rttMs: 160 }), row(1, { rttMs: 170 }), row(2, { rttMs: 350 })];
  const s = deriveSequenceState(rows, 'latency', LAT);
  assert.equal(s.open, true);
  assert.equal(s.severity, 'critical');
  assert.equal(s.startedAt.toISOString(), new Date(base).toISOString());
});

test('skipped rows do not count toward debounce nor resolve', () => {
  const rows = [
    row(0, { rttMs: 200 }), row(1, { rttMs: null }), row(2, { rttMs: 200 }), row(3, { rttMs: 200 }),
  ];
  // three failing latency rows (the null is skipped) => opens, started at minute 0.
  const s = deriveSequenceState(rows, 'latency', LAT);
  assert.equal(s.open, true);
  assert.equal(s.startedAt.toISOString(), new Date(base).toISOString());
});

test('a healthy-only window reports firstHealthyAt (fallback recovery time)', () => {
  const rows = [row(0, { ok: true }), row(1, { ok: true })];
  const s = deriveSequenceState(rows, 'reachability', REACH);
  assert.equal(s.open, false);
  assert.equal(s.lastRecoveryAt, null); // no fail→pass transition was seen
  assert.equal(s.firstHealthyAt.toISOString(), new Date(base).toISOString());
});

// ---- groupRows -------------------------------------------------------------

test('groupRows splits by metric+target and only emits latency/loss where present', () => {
  const rows = [
    { ts: new Date(base), target: 'a', ok: true, rttMs: 10, lossPct: 0 },
    { ts: new Date(base), target: 'b', ok: false }, // down: no rtt/loss
  ];
  const groups = groupRows(rows);
  const keys = groups.map((g) => `${g.metric}/${g.target}`).sort();
  assert.deepEqual(keys, ['latency/a', 'packet_loss/a', 'reachability/a', 'reachability/b']);
});
