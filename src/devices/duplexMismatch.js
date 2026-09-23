'use strict';

const crypto = require('crypto');
const { numOrNull } = require('../lib/num');

// The duplex-mismatch indicator: a port that reports HALF duplex while late
// collisions or FCS errors are rising on it.
//
// WHY THIS IS A RULE AND NOT A Z-SCORE. The error-rate baselines (deviceIngest)
// can say "this port's FCS rate is unusual". They cannot say WHY, and the why
// is the whole difference between "replace the cable" and "change one setting":
// both ends forced to 100/full is fine, both on auto is fine, but one end forced
// to 100/full and the other on auto negotiates the auto end down to HALF duplex.
// The half-duplex end then sees late collisions (the far end transmits without
// listening), and the full-duplex end sees FCS errors (its frames are cut off by
// the collision). Late collisions on a half-duplex port are not a statistic to
// baseline; on a switched network they essentially only happen this way.
//
// The port's duplex was validated and thrown away before migration 116, so this
// could not be said at all.
//
// Pure: a stored counter row in, a verdict out.

// One finding per port per this long. A mismatch lasts until somebody changes a
// setting, and one finding says so; sixty would bury it.
const REFRACTORY_MINUTES = 60;

function fmt(v) {
  if (v == null) return '–';
  return v < 1 ? v.toFixed(2) : String(Math.round(v * 100) / 100);
}

// Returns null, or { lateCollPps, fcsPps } when the row is the indicator.
function detectDuplexMismatch(row) {
  if (!row || row.duplex !== 'half' || row.discontinuity) return null;
  const late = numOrNull(row.lateCollPps);
  const fcs = numOrNull(row.fcsPps);
  if (!(late > 0) && !(fcs > 0)) return null;
  return { lateCollPps: late, fcsPps: fcs };
}

function explain({ ifName, deviceName, lateCollPps, fcsPps }) {
  const where = `Port ${ifName} on ${deviceName}`;
  const seen = [];
  if (lateCollPps > 0) seen.push(`late collisions (${fmt(lateCollPps)}/s)`);
  if (fcsPps > 0) seen.push(`FCS errors (${fmt(fcsPps)}/s)`);
  return `${where} is running HALF duplex and is collecting ${seen.join(' and ')}. `
    + 'That is the signature of a duplex mismatch: one end hard-set to full duplex, the other left on '
    + 'auto-negotiation, which then falls back to half. The half-duplex end sees late collisions because the '
    + 'far end transmits without waiting; the full-duplex end sees FCS errors because its frames are cut '
    + 'short. Set both ends to auto-negotiation, or both to the same fixed speed and duplex — a cable swap '
    + 'will not fix it.';
}

// Builds the finding for one row. `hostId` is the polling agent, like every
// other switch finding (migration 110).
function buildDuplexFinding(row, verdict, { hostId, deviceName, ifName, at = null } = {}) {
  const ts = at || new Date(row.ts);
  const metric = `if.${row.interfaceId}.duplex.mismatch`;
  const name = ifName || row.ifName || `interface ${row.interfaceId}`;
  const device = deviceName || `device ${row.deviceId}`;
  const observed = verdict.lateCollPps > 0 ? verdict.lateCollPps : verdict.fcsPps;
  return {
    id: crypto.randomUUID(),
    hostId: String(hostId),
    deviceId: Number(row.deviceId),
    interfaceId: Number(row.interfaceId),
    metric,
    // WARN, not CRIT: the port still passes traffic, badly. It is the kind of
    // fault that costs a site a week of "the network is slow" until somebody
    // finds it, not the kind that takes it down.
    severity: 'WARN',
    kind: 'THRESHOLD',
    observed,
    baseline: null,
    deviation: null,
    window: [new Date(ts.getTime() - (Number(row.deltaSec) || 60) * 1000), ts],
    explanation: explain({ ifName: name, deviceName: device, ...verdict }),
    evidence: [{
      hostId: String(hostId),
      deviceId: Number(row.deviceId),
      interfaceId: Number(row.interfaceId),
      metric,
      value: observed,
      ts,
      labels: {
        iface: name,
        device,
        duplex: row.duplex,
        lateCollPps: verdict.lateCollPps,
        fcsPps: verdict.fcsPps,
        lateCollisions: numOrNull(row.lateCollisions),
        fcsErrors: numOrNull(row.fcsErrors),
      },
    }],
    correlatedWith: [],
    createdAt: ts,
    acked: false,
  };
}

module.exports = { detectDuplexMismatch, buildDuplexFinding, REFRACTORY_MINUTES };
