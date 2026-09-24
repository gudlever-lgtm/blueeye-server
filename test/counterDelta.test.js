'use strict';

// Trin 3: two counter snapshots into one interval's rates — and the cases where
// the arithmetic produces a number that is a lie.
//
// A fabricated rate is worse than a missing one, because it is
// indistinguishable from a measurement. Every test below is about refusing to
// produce one.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeSample, detectReboot, delta, MAX_DELTA_SEC, MIN_DELTA_SEC, UPTIME_SLACK_SEC,
} = require('../src/devices/counterDelta');

const PREV = { inOctets: 1_000_000, outOctets: 500_000, inErrors: 10, outErrors: 0, inDiscards: 2, fcsErrors: 0, inBcastPkts: 100 };
const NEXT = { inOctets: 1_750_000, outOctets: 900_000, inErrors: 16, outErrors: 0, inDiscards: 2, fcsErrors: 3, inBcastPkts: 160 };

// ==================================================== the ordinary interval
test('an ordinary interval becomes bits per second and a utilisation', () => {
  const s = computeSample({ current: NEXT, previous: PREV, elapsedSec: 60, speedMbps: 1000 });
  assert.equal(s.deltaSec, 60);
  // Rounded to three places: a bit-per-second figure with fifteen decimals is
  // precision the measurement never had.
  assert.equal(s.inBps, 100_000);
  assert.equal(s.outBps, 53_333.333);
  assert.equal(s.inErrPps, 0.1);
  assert.equal(s.fcsPps, 0.05);
  assert.equal(s.inBcastPps, 1);
  assert.equal(s.inUtilPct, 0.01, '100 kbit/s of a gigabit port');
  assert.equal(s.discontinuity, null);
});

test('the RAW counters are stored whatever happens to the rates', () => {
  // Without them a rate can never be recomputed, a reset can never be
  // recognised after the fact, and a missing cycle cannot be told apart from a
  // cycle that measured zero.
  const s = computeSample({ current: NEXT, previous: null });
  assert.equal(s.inOctets, 1_750_000);
  assert.equal(s.fcsErrors, 3);
  assert.equal(s.discontinuity, 'first');
  assert.equal(s.inBps, null);
});

test('utilisation is NULL without a speed, never zero', () => {
  // A percentage of an unknown is not a number, and 0 would read as an idle
  // port — which is the opposite of what an unknown speed means.
  const s = computeSample({ current: NEXT, previous: PREV, elapsedSec: 60, speedMbps: null });
  assert.equal(s.inUtilPct, null);
  assert.equal(s.inBps, (750_000 * 8) / 60, 'the rate itself still stands');
});

test('a counter the device did not answer for stays null through the arithmetic', () => {
  const s = computeSample({
    current: { ...NEXT, fcsErrors: null }, previous: { ...PREV, fcsErrors: null }, elapsedSec: 60,
  });
  assert.equal(s.fcsErrors, null);
  assert.equal(s.fcsPps, null, 'and no rate is invented for it');
  assert.equal(s.inBps, 100_000, 'the columns it DID answer are unaffected');
});

// =============================================================== the reboot
test('sysUpTime going backwards is a reboot', () => {
  assert.equal(detectReboot({ prevTicks: 500_000, nextTicks: 400, elapsedSec: 60 }), true);
});

test('a reboot BETWEEN two polls is caught, and it is the case everybody forgets', () => {
  // A switch that reboots at 03:00:10 and is back at 03:00:40 has a RISING
  // sysUpTime at the 03:01 poll — it rose by twenty seconds instead of sixty.
  // Comparing against zero misses it entirely.
  const prevTicks = 5_000_000;
  const nextTicks = 2_000; // twenty seconds of uptime
  assert.equal(detectReboot({ prevTicks, nextTicks, elapsedSec: 60 }), true);

  // And the same shape where the uptime did NOT restart: a 60-second interval
  // where uptime grew by 60 seconds is ordinary.
  assert.equal(detectReboot({ prevTicks, nextTicks: prevTicks + 6_000, elapsedSec: 60 }), false);
});

test('ordinary drift is not a reboot', () => {
  // Devices drift and a poll that took four seconds is not a restart.
  const prev = 1_000_000;
  assert.equal(detectReboot({ prevTicks: prev, nextTicks: prev + 5_600, elapsedSec: 60 }), false);
  assert.equal(
    detectReboot({ prevTicks: prev, nextTicks: prev + (60 - UPTIME_SLACK_SEC + 1) * 100, elapsedSec: 60 }),
    false,
    'inside the slack',
  );
});

test('an unknown uptime is never a reboot', () => {
  // A device that did not answer sysUpTime has not said it restarted.
  assert.equal(detectReboot({ prevTicks: null, nextTicks: 500, elapsedSec: 60 }), false);
  assert.equal(detectReboot({ prevTicks: 500, nextTicks: null, elapsedSec: 60 }), false);
});

test('a rebooted device stores its counters and NO rates', () => {
  // The clamp everybody writes — Math.max(next - prev, 0) — would put a 0 here,
  // and 0 reads as "no traffic in that minute", which would pull a flatline
  // detector towards calling a working port dead.
  const s = computeSample({ current: { inOctets: 400 }, previous: PREV, elapsedSec: 60, rebooted: true });
  assert.equal(s.inOctets, 400);
  assert.equal(s.inBps, null);
  assert.equal(s.deltaSec, null);
  assert.equal(s.discontinuity, 'reboot');
});

// ============================================================ the renumbering
test('a renumbered ifIndex invalidates the interval, not the reading', () => {
  // The counter behind the new index belongs to a different port, so the
  // subtraction is two unrelated ports minus each other.
  const s = computeSample({ current: NEXT, previous: PREV, elapsedSec: 60, renumbered: true });
  assert.equal(s.inOctets, 1_750_000);
  assert.equal(s.inBps, null);
  assert.equal(s.discontinuity, 'renumber');
});

// ================================================================== the gaps
test('an interval too long to mean anything is a gap, not an average', () => {
  // Two reads twenty minutes apart cannot show a two-minute error burst;
  // reporting 0.3 errors/second would hide it behind the average.
  const s = computeSample({ current: NEXT, previous: PREV, elapsedSec: MAX_DELTA_SEC + 1 });
  assert.equal(s.discontinuity, 'gap');
  assert.equal(s.inBps, null);
});

test('an interval too short is mostly clock noise', () => {
  const s = computeSample({ current: NEXT, previous: PREV, elapsedSec: MIN_DELTA_SEC - 1 });
  assert.equal(s.discontinuity, 'gap');
});

test('a nonsensical elapsed time never divides', () => {
  for (const elapsedSec of [0, -60, NaN, null, undefined]) {
    const s = computeSample({ current: NEXT, previous: PREV, elapsedSec });
    assert.equal(s.discontinuity, 'gap', String(elapsedSec));
    assert.equal(s.inBps, null);
  }
});

// ================================================================== the wrap
test('a 64-bit counter going backwards is NOT a wrap — the device is wrong', () => {
  // An octet counter would have to run for months at 100 Gbit/s to reach 2^64.
  // A decrease means the device is lying, and the honest answer is null.
  const d = delta(5_000_000_000, 4_000, { hc: true });
  assert.equal(d.value, null);
  assert.equal(d.wrapped, false);
});

test('a 32-bit counter going backwards is a wrap, and STILL not corrected for', () => {
  // A saturated gigabit port wraps ifInOctets in ~34 seconds, which is exactly
  // why a 60-second interval cannot correct for it: the counter may have
  // wrapped once, twice or five times and nothing in the data says which.
  // Adding 2^32 would be a guess with a decimal point on it.
  const d = delta(4_000_000_000, 1_000, { hc: false });
  assert.equal(d.value, null);
  assert.equal(d.wrapped, true);

  const s = computeSample({
    current: { inOctets: 1_000 }, previous: { inOctets: 4_000_000_000 },
    elapsedSec: 60, hc: false,
  });
  assert.equal(s.discontinuity, 'wrap');
  assert.equal(s.inBps, null);
});

test('a wrap on one direction marks the whole row', () => {
  // Both directions are read from the same device at the same moment. Half a
  // trustworthy row invites somebody to read the other half as if it were fine.
  const s = computeSample({
    current: { inOctets: 1_000, outOctets: 900_000 },
    previous: { inOctets: 4_000_000_000, outOctets: 500_000 },
    elapsedSec: 60, hc: false,
  });
  assert.equal(s.discontinuity, 'wrap');
  assert.equal(s.outBps, null);
});

test('a counter that did not move is a real zero, and says so', () => {
  // "No traffic" and "we did not look" must never read the same. This is the
  // whole argument for storing the raw counter beside the rate.
  const same = { inOctets: 1_000_000, inErrors: 10 };
  const s = computeSample({ current: same, previous: same, elapsedSec: 60, speedMbps: 1000 });
  assert.equal(s.inBps, 0);
  assert.equal(s.inErrPps, 0);
  assert.equal(s.inUtilPct, 0);
  assert.equal(s.discontinuity, null);
});

// ============================================================ the reset
// Found in a real end-to-end run: a 64-bit counter went DOWN while sysUpTime
// kept rising (no reboot) — `clear counters` on the switch. The rate was
// dropped, but `discontinuity` stayed NULL, so the row read "the delta is
// real" with no rate in it. A NULL rate always carries its reason now.
test('a 64-bit counter going backwards with no reboot is a counter_reset, and voids the row', () => {
  const s = computeSample({
    current: { inOctets: 4_000, outOctets: 2_000, inErrors: 0 },
    previous: { inOctets: 5_000_000_000, outOctets: 3_000_000_000, inErrors: 12 },
    elapsedSec: 60, rebooted: false, hc: true, speedMbps: 1000,
  });
  assert.equal(s.discontinuity, 'counter_reset');
  for (const k of ['inBps', 'outBps', 'inErrPps', 'inUtilPct']) assert.equal(s[k], null, k);
  assert.equal(s.inOctets, 4_000, 'the raw counter is still stored');
});

test('ONE counter reset (an error counter) is enough: no rate is left without a reason', () => {
  const s = computeSample({
    current: { ...NEXT, inErrors: 0 },
    previous: PREV,
    elapsedSec: 60, hc: true,
  });
  assert.equal(s.discontinuity, 'counter_reset');
  assert.equal(s.inBps, null, 'half a row invites reading the other half as fine');
});

test('a reboot still wins over a reset, and a counter the device did not answer for is not a reset', () => {
  const back = { current: { inOctets: 4_000 }, previous: { inOctets: 5_000_000_000 }, elapsedSec: 60 };
  assert.equal(computeSample({ ...back, rebooted: true }).discontinuity, 'reboot');
  const silent = computeSample({ current: { ...NEXT, fcsErrors: null }, previous: PREV, elapsedSec: 60 });
  assert.equal(silent.discontinuity, null);
  assert.equal(silent.fcsPps, null, 'no answer is no rate — and not a reset');
});

test('a 32-bit ERROR counter that wrapped voids the row as a wrap, not silently', () => {
  const s = computeSample({
    current: { inOctets: 2_000_000, inErrors: 5 },
    previous: { inOctets: 1_000_000, inErrors: 4_000_000_000 },
    elapsedSec: 60, hc: false,
  });
  assert.equal(s.discontinuity, 'wrap');
});
