'use strict';

// Latency is only news when it actually MOVED.
//
// This file exists because of a real screen: 184 668 findings, 30 003 of them
// CRIT, and the worst offender read
//
//   Latency 0.9 ms to 67.207.67.3 — ~0.5 ms normal (z=7.4).
//
// Work the arithmetic backwards and the baseline's sigma is 54 MICROSECONDS.
// On a LAN that stable, any ordinary wobble clears z=6, so every wobble was a
// critical incident. The statistic was right and the question was wrong: "is
// this unusual for this target" is not "is this worth waking someone for".
//
// Loss and jitter always had absolute floors (LOSS_WARN, JITTER_WARN). Latency
// did not, and these pin the two bars it now has to clear first.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeAgentHealth, THRESHOLDS } = require('../src/health/probeHealth');

// Newest-first rows for one target, as computeAgentHealth expects. The values
// after the first are the baseline it will build.
function rows(values, { target = '192.168.1.1', now = Date.now() } = {}) {
  return values.map((rttMs, i) => ({
    type: 'ping', target, ok: true, rttMs, lossPct: 0, jitterMs: 1,
    ts: new Date(now - i * 60000).toISOString(),
  }));
}
const STABLE_LAN = [0.52, 0.48, 0.51, 0.49, 0.50, 0.52, 0.48, 0.51, 0.49, 0.50, 0.51];
const STABLE_WAN = [119, 118, 120, 117, 118, 119, 121, 118, 117, 119, 118];

test('the screenshot case: 0.9 ms against a 0.5 ms baseline is NOT critical', () => {
  const now = Date.now();
  const health = computeAgentHealth(rows([0.9].concat(STABLE_LAN), { now }), { now });
  assert.equal(health.status, 'ok', '0.4 ms of LAN jitter is not an incident');
  assert.equal(health.evidence.filter((e) => e.metric === 'latency').length, 0);
});

test('a real WAN degradation is still reported — as a warning', () => {
  // The other row from the same screen: 309.8 ms where ~118.6 ms is normal.
  // 191 ms is a genuine problem and must survive the floor. Latency has no
  // 'bad' tier, so it is a warning however far it moved.
  const now = Date.now();
  const health = computeAgentHealth(rows([309.8].concat(STABLE_WAN), { target: 'mundtrold.dk', now }), { now });
  assert.equal(health.status, 'warn');
  const lat = health.evidence.find((e) => e.metric === 'latency');
  assert.ok(lat, 'the latency evidence is what names the target');
  assert.equal(lat.target, 'mundtrold.dk');
});

test('both bars have to be cleared, not either one', () => {
  const now = Date.now();
  // Clears the ABSOLUTE bar (>= 5 ms) but not the proportional one: on a 118 ms
  // path, 6 ms is inside normal variation.
  const wanSmall = computeAgentHealth(rows([124].concat(STABLE_WAN), { now }), { now });
  assert.equal(wanSmall.status, 'ok', '5 ms on a 118 ms path is not a degradation');

  // Clears the PROPORTIONAL bar (+300%) but not the absolute one: 0.5 → 2 ms is
  // a big ratio and a tiny change.
  const lanRatio = computeAgentHealth(rows([2].concat(STABLE_LAN), { now }), { now });
  assert.equal(lanRatio.status, 'ok', 'a big ratio on a tiny number is still a tiny number');

  // Clears both: a LAN target that went from half a millisecond to 40.
  const lanReal = computeAgentHealth(rows([40].concat(STABLE_LAN), { now }), { now });
  assert.equal(lanReal.status, 'warn', 'that is a real fault and must still fire');
});

test('the floor never suppresses loss, jitter or unreachability', () => {
  // It gates ONE signal. A quiet-latency target that is dropping packets or
  // unreachable must still be reported — otherwise the fix trades a flood of
  // false criticals for a silence full of real ones.
  const now = Date.now();
  const lossy = rows([0.9].concat(STABLE_LAN), { now }).map((r, i) => (i === 0 ? { ...r, lossPct: 40 } : r));
  assert.equal(computeAgentHealth(lossy, { now }).status, 'bad');

  const jittery = rows([0.9].concat(STABLE_LAN), { now }).map((r, i) => (i === 0 ? { ...r, jitterMs: 150 } : r));
  assert.equal(computeAgentHealth(jittery, { now }).status, 'bad');

  const down = rows([0.9].concat(STABLE_LAN), { now }).map((r, i) => (i === 0 ? { ...r, ok: false, rttMs: null } : r));
  assert.equal(computeAgentHealth(down, { now }).status, 'down');
});

test('the thresholds are published, so they can be argued with', () => {
  assert.equal(THRESHOLDS.LAT_MIN_DELTA_MS, 5);
  assert.equal(THRESHOLDS.LAT_MIN_FRACTION, 0.2);
  // The floor is a PRE-condition on the z-score, not a replacement for it: a
  // target that moved 50 ms but always moves 50 ms is still normal.
  assert.ok(THRESHOLDS.Z_WARN > 0);
  assert.equal(THRESHOLDS.Z_BAD, undefined, 'latency has no bad tier');
});

// The value being judged is not part of its own baseline. It used to be: the
// latest RTT went into the median/MAD it was then compared with, pulling the
// centre toward itself and widening the spread by its own distance.
test('the latest sample is excluded from the baseline it is judged against', () => {
  const now = Date.now();
  const history = [10, 10, 10, 10, 11, 11, 11, 11]; // median 10.5, MAD 0.5
  const health = computeAgentHealth(rows([30].concat(history), { now }), { now });
  assert.equal(health.metrics.baselineMs, 10.5, 'median of the history only (with 30 included it was 11)');
  const sigma = 0.5 * 1.4826;
  assert.equal(health.metrics.latencyZ, Math.round(((30 - 10.5) / sigma) * 10) / 10);
  assert.equal(health.status, 'warn');
});

test('a baseline needs MIN_BASELINE samples BEFORE the one being judged', () => {
  const now = Date.now();
  const history = Array.from({ length: THRESHOLDS.MIN_BASELINE - 1 }, (_, i) => (i % 2 ? 10 : 11));
  // One short of a trusted baseline: no latency verdict, however high.
  const short = computeAgentHealth(rows([80].concat(history), { now }), { now });
  assert.equal(short.evidence.filter((e) => e.metric === 'latency').length, 0);
  const enough = computeAgentHealth(rows([80].concat(history, [10]), { now }), { now });
  assert.equal(enough.evidence.filter((e) => e.metric === 'latency').length, 1);
});
