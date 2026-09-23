'use strict';

// Turns two consecutive counter snapshots into the rates for the interval
// between them — and, more importantly, decides when it must NOT.
//
// This is where the audit's two hardest questions get answered, and both have
// the same shape: there are cases where the arithmetic produces a number and
// the number is a lie. A fabricated rate is worse than a missing one, because
// it is indistinguishable from a measurement.
//
//   COUNTER RESET. A device that rebooted has counters that restarted at zero.
//   Subtracting across that boundary gives a huge negative, and the usual
//   Math.max(delta, 0) turns it into 0 — which reads as "no traffic in that
//   minute" and would pull a flatline detector towards "this port is dead".
//
//   ifIndex RENUMBERING. A module goes into a chassis and every index after it
//   shifts. The counter behind the new index belongs to a DIFFERENT port, so
//   the subtraction is two unrelated ports minus each other.
//
// In both cases the raw counter is stored and every rate is null, with
// `discontinuity` saying which case it was. Null plus a reason is the
// difference between "we measured nothing" and "we do not know".
//
// Pure. No database, no clock, no I/O — the one file in this feature where a
// wrong answer is invisible until somebody acts on it.

// Beyond this, a "rate" is an average over so long that it describes nothing.
// Two counter reads twenty minutes apart cannot show a two-minute error burst;
// reporting 0.3 errors/second would hide it behind the average.
const MAX_DELTA_SEC = 600;

// Below this, the clock noise between two polls is a large fraction of the
// interval and the rate is mostly measurement error.
const MIN_DELTA_SEC = 5;

// SNMP TimeTicks are hundredths of a second.
const TICKS_PER_SEC = 100;

// How much slack to allow between the device's own uptime and the wall clock
// before calling it a restart. Devices drift, agents pause, and a poll that
// took four seconds is not a reboot.
const UPTIME_SLACK_SEC = 30;

const COUNTER_FIELDS = [
  'inOctets', 'outOctets', 'inUcastPkts', 'outUcastPkts',
  'inMcastPkts', 'inBcastPkts', 'outMcastPkts', 'outBcastPkts',
  'inErrors', 'outErrors', 'inDiscards', 'outDiscards',
  'fcsErrors', 'alignmentErrors', 'lateCollisions', 'carrierSenseErrors',
];

// What a port's duplex can be, as the agent names dot3StatsDuplexStatus. Anything
// else is not an answer and becomes null.
const DUPLEX_VALUES = ['half', 'full', 'unknown'];

// 32-bit and 64-bit counter ceilings, for the wrap question below.
const WRAP32 = 2 ** 32;

// Did the device restart between these two readings?
//
// THE CASE EVERYBODY FORGETS is the third one. A switch that reboots at
// 03:00:10 and is back up at 03:00:40 has a RISING sysUpTime at the 03:01 poll
// — it just rose by twenty seconds instead of sixty. Comparing against zero
// misses it; comparing against the ELAPSED REAL TIME catches it.
function detectReboot({ prevTicks, nextTicks, elapsedSec }) {
  if (prevTicks == null || nextTicks == null) return false;
  if (nextTicks < prevTicks) return true; // plainly went backwards
  const uptimeGrewSec = (nextTicks - prevTicks) / TICKS_PER_SEC;
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return false;
  return uptimeGrewSec + UPTIME_SLACK_SEC < elapsedSec;
}

// One counter's delta, or null.
//
// A DECREASE that is not a reboot is either a 32-bit wrap or a device doing
// something unreasonable. On a 64-bit counter it is never a wrap: an octet
// counter would have to run for months at 100 Gbit/s to get there, so a
// decrease means the device is lying and the honest answer is null.
//
// On a 32-bit counter a wrap is real and common — a saturated gigabit port
// wraps ifInOctets in about 34 seconds — which is exactly why it cannot be
// corrected for at a 60-second interval: the counter may have wrapped once,
// twice or five times and nothing in the data says which. So a decrease on a
// narrow counter is also null, marked as a wrap, rather than a guess with
// 2^32 added to it.
function delta(prev, next, { hc = true } = {}) {
  if (prev == null || next == null) return { value: null, wrapped: false };
  if (next >= prev) return { value: next - prev, wrapped: false };
  // A decrease. Neither case produces a number worth storing.
  return { value: null, wrapped: !hc && prev < WRAP32 };
}

function rate(value, seconds) {
  if (value == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return value / seconds;
}

function round(n, places = 3) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// Computes one interface's sample. `prev` is the previous reading for the SAME
// interface row (not the same ifIndex — see migration 108), or null.
//
// Returns the row that gets stored: every raw counter, every rate, and the
// reason a rate is missing when one is.
function computeSample({
  current,
  previous = null,
  elapsedSec = null,
  speedMbps = null,
  rebooted = false,
  renumbered = false,
  hc = true,
} = {}) {
  const raw = {};
  for (const f of COUNTER_FIELDS) raw[f] = current && current[f] != null ? Number(current[f]) : null;
  // Duplex is a STATE, not a counter: it is true of the moment it was read, so
  // it survives every discontinuity below. A reboot voids the rates; it does
  // not make "this port negotiated half duplex" any less the case.
  raw.duplex = current && DUPLEX_VALUES.includes(current.duplex) ? current.duplex : null;

  // The reasons are checked in order of how badly they invalidate the delta.
  let discontinuity = null;
  if (!previous) discontinuity = 'first';
  else if (rebooted) discontinuity = 'reboot';
  else if (renumbered) discontinuity = 'renumber';
  else if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) discontinuity = 'gap';
  else if (elapsedSec > MAX_DELTA_SEC) discontinuity = 'gap';
  else if (elapsedSec < MIN_DELTA_SEC) discontinuity = 'gap';

  if (discontinuity) {
    return {
      ...raw,
      deltaSec: null,
      inBps: null, outBps: null,
      inErrPps: null, outErrPps: null,
      inDiscPps: null, outDiscPps: null,
      fcsPps: null, lateCollPps: null, inBcastPps: null,
      inUtilPct: null, outUtilPct: null,
      discontinuity,
    };
  }

  const d = (field) => delta(previous[field] == null ? null : Number(previous[field]), raw[field], { hc });
  const inOct = d('inOctets');
  const outOct = d('outOctets');
  const inErr = d('inErrors');
  const outErr = d('outErrors');
  const inDisc = d('inDiscards');
  const outDisc = d('outDiscards');
  const fcs = d('fcsErrors');
  // Late collisions, as a rate like FCS. On a full-duplex link there are none
  // at all (collisions do not exist there), and on a half-duplex one they only
  // happen when the far end is transmitting without listening — which is what a
  // duplex mismatch IS. The raw counter was stored and never analysed: a
  // counter only ever rises, so the detector could not baseline it.
  const lateColl = d('lateCollisions');
  const inBcast = d('inBcastPkts');

  // A wrap on ANY octet counter voids the whole row. The two directions are
  // read from the same device at the same moment, so a counter that wrapped
  // says the interval was long enough for one to — and half a trustworthy row
  // invites somebody to read the other half as if it were fine.
  if (inOct.wrapped || outOct.wrapped) {
    return {
      ...raw,
      deltaSec: null,
      inBps: null, outBps: null,
      inErrPps: null, outErrPps: null,
      inDiscPps: null, outDiscPps: null,
      fcsPps: null, lateCollPps: null, inBcastPps: null,
      inUtilPct: null, outUtilPct: null,
      discontinuity: 'wrap',
    };
  }

  const inBps = rate(inOct.value == null ? null : inOct.value * 8, elapsedSec);
  const outBps = rate(outOct.value == null ? null : outOct.value * 8, elapsedSec);
  // Utilisation needs a speed. NULL when the device did not report one: a
  // percentage of an unknown is not a number, and 0 would read as an idle port.
  const capacityBps = speedMbps && speedMbps > 0 ? speedMbps * 1e6 : null;

  return {
    ...raw,
    deltaSec: Math.round(elapsedSec),
    inBps: round(inBps),
    outBps: round(outBps),
    inErrPps: round(rate(inErr.value, elapsedSec)),
    outErrPps: round(rate(outErr.value, elapsedSec)),
    inDiscPps: round(rate(inDisc.value, elapsedSec)),
    outDiscPps: round(rate(outDisc.value, elapsedSec)),
    fcsPps: round(rate(fcs.value, elapsedSec)),
    lateCollPps: round(rate(lateColl.value, elapsedSec)),
    inBcastPps: round(rate(inBcast.value, elapsedSec)),
    inUtilPct: capacityBps && inBps != null ? round((inBps / capacityBps) * 100, 2) : null,
    outUtilPct: capacityBps && outBps != null ? round((outBps / capacityBps) * 100, 2) : null,
    discontinuity: null,
  };
}

module.exports = {
  computeSample,
  detectReboot,
  delta,
  COUNTER_FIELDS,
  DUPLEX_VALUES,
  MAX_DELTA_SEC,
  MIN_DELTA_SEC,
  UPTIME_SLACK_SEC,
  TICKS_PER_SEC,
};
