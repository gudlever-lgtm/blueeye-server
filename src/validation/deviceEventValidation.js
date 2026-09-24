'use strict';

// Validation for the device-event batch an agent submits
// (POST /agents/me/device-events) and for the query the dashboard reads them
// back with (GET /api/device-events).
//
// The submitting agent is authenticated, but its INPUT is not trusted: every
// field in a row originated on a network device that anyone on the customer's
// LAN can send UDP to. A switch nobody owns can put whatever it likes in a
// syslog message, and the agent deliberately forwards what it could not
// classify rather than dropping it. So this is a real boundary, not a
// formality — bounds on every string, a fixed vocabulary for the enums, and a
// cap on how many rows one POST may carry.
//
// SHAPE-ONLY REJECTION. A row that fails validation is SKIPPED, and the
// response says how many were skipped; the batch is not refused. One malformed
// line out of 500 must not cost the other 499, which is the same rule the
// agent's per-line parser follows for the same reason.

const MAX_EVENTS_PER_BATCH = 1000;
const SUMMARY_MAX = 512;
const RAW_MAX = 2048;
const EVENT_TYPE_MAX = 64;
const TAG_MAX = 64;
const IFNAME_MAX = 64;
const HOSTNAME_MAX = 255;
const SOURCE_IP_MAX = 45;
const DETAIL_MAX_BYTES = 8192;
const TRANSPORTS = ['syslog', 'trap'];

// An event_type is a dotted lowercase identifier the agent's classify table
// produces. Constraining the SHAPE rather than listing the values is
// deliberate: the agent ships its own table and a newer agent must be able to
// send a type this server has not heard of without the row being refused.
// Backward compatibility runs in both directions here.
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;

// Accepts IPv4, IPv6 and the IPv4-mapped form. Not a parser — a bound and a
// character-class gate, so a hostname or an injection attempt cannot arrive in
// a column the UI prints.
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

const isStr = (v) => typeof v === 'string';

function str(v, max) {
  if (!isStr(v)) return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, max);
}

// Parses an ISO timestamp, refusing anything Date cannot read. Returns null
// rather than Invalid Date, which would otherwise reach the driver.
function isoDate(v) {
  if (!isStr(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Validates one submitted row. Returns the normalised event, or null when the
// row is unusable (no caller-visible error: the count is what is reported).
function validateDeviceEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const sourceIp = str(raw.sourceIp, SOURCE_IP_MAX);
  if (!sourceIp || !IP_RE.test(sourceIp)) return null;

  const receivedAt = isoDate(raw.receivedAt);
  if (!receivedAt) return null;

  // Severity is the one field with no sensible default: it drives the filter
  // that gets an operator from 4 000 notices to the 6 lines that matter, and a
  // guessed value would quietly mis-file the row.
  if (!Number.isInteger(raw.severity) || raw.severity < 0 || raw.severity > 7) return null;

  const transport = TRANSPORTS.includes(raw.transport) ? raw.transport : 'syslog';

  const eventType = str(raw.eventType, EVENT_TYPE_MAX);
  // An unrecognised SHAPE falls back to syslog.raw rather than failing the row:
  // the line itself is still evidence, and 'syslog.raw' is exactly what the
  // agent means by "I did not recognise this".
  const type = eventType && EVENT_TYPE_RE.test(eventType) ? eventType : 'syslog.raw';

  const summary = str(raw.summary, SUMMARY_MAX) || '(no message)';

  let facility = null;
  if (Number.isInteger(raw.facility) && raw.facility >= 0 && raw.facility <= 23) {
    facility = raw.facility;
  }

  const deviceTime = isoDate(raw.deviceTime);
  // Only trust a skew the device's own timestamp supports, and bound it: a
  // device claiming the year 1970 would otherwise store a skew of 1.7e12 and
  // overflow the INT column. Beyond a day either way the clock is not skewed,
  // it is wrong, and the UI says so from device_time alone.
  let clockSkewMs = null;
  if (deviceTime) {
    const skew = receivedAt.getTime() - deviceTime.getTime();
    if (Number.isFinite(skew) && Math.abs(skew) <= 86400000) clockSkewMs = Math.trunc(skew);
  }

  let occurrences = 1;
  if (Number.isInteger(raw.occurrences) && raw.occurrences > 0) {
    occurrences = Math.min(raw.occurrences, 1000000);
  }

  let detail = null;
  if (raw.detail && typeof raw.detail === 'object' && !Array.isArray(raw.detail)) {
    const json = JSON.stringify(raw.detail);
    if (json && Buffer.byteLength(json, 'utf8') <= DETAIL_MAX_BYTES) detail = raw.detail;
  }

  return {
    sourceIp,
    receivedAt,
    deviceTime,
    clockSkewMs,
    transport,
    facility,
    severity: raw.severity,
    eventType: type,
    deviceHostname: str(raw.host, HOSTNAME_MAX),
    tag: str(raw.tag, TAG_MAX),
    ifname: str(raw.ifname, IFNAME_MAX),
    summary,
    raw: str(raw.raw, RAW_MAX),
    detail,
    occurrences,
  };
}

// Validates a whole submitted batch. Returns { events, skipped } — or records
// errors.events and returns undefined when the batch itself is malformed
// (which IS a 400: the agent sent something that is not a batch at all).
function validateDeviceEventBatch(rawEvents, errors) {
  // A default parameter does not cover an explicit null, and this is called
  // from a route handler where the caller controls the body. Both validators
  // here take the same precaution.
  const errs = errors && typeof errors === 'object' ? errors : {};
  if (!Array.isArray(rawEvents)) {
    errs.events = 'events must be an array';
    return undefined;
  }
  if (rawEvents.length > MAX_EVENTS_PER_BATCH) {
    errs.events = `events must contain at most ${MAX_EVENTS_PER_BATCH} entries`;
    return undefined;
  }
  const events = [];
  let skipped = 0;
  for (const row of rawEvents) {
    const e = validateDeviceEvent(row);
    if (e) events.push(e);
    else skipped += 1;
  }
  return { events, skipped };
}

const MAX_LIMIT = 500;
const MAX_MINUTES = 7 * 24 * 60;

// Validates the dashboard's read query. Returns the normalised filter, or
// undefined with errors recorded (a 400) — an out-of-range window is a caller
// mistake worth naming, not something to silently clamp.
function validateDeviceEventQuery(query, errors) {
  // Explicit null defeats a default parameter, and both of these arrive from a
  // route handler where the caller controls the shape.
  const q0 = query && typeof query === 'object' ? query : {};
  const errs = errors && typeof errors === 'object' ? errors : {};
  const out = {};

  if (q0.minutes !== undefined && q0.minutes !== '') {
    const n = Number(q0.minutes);
    if (!Number.isInteger(n) || n < 1 || n > MAX_MINUTES) {
      errs.minutes = `minutes must be an integer between 1 and ${MAX_MINUTES}`;
    } else {
      out.minutes = n;
    }
  } else {
    out.minutes = 120;
  }

  if (q0.limit !== undefined && q0.limit !== '') {
    const n = Number(q0.limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      errs.limit = `limit must be an integer between 1 and ${MAX_LIMIT}`;
    } else {
      out.limit = n;
    }
  } else {
    out.limit = 100;
  }

  if (q0.offset !== undefined && q0.offset !== '') {
    const n = Number(q0.offset);
    if (!Number.isInteger(n) || n < 0 || n > 1000000) {
      errs.offset = 'offset must be an integer between 0 and 1000000';
    } else {
      out.offset = n;
    }
  } else {
    out.offset = 0;
  }

  // maxSeverity filters syslog-numerically: LOWER is worse, so "severity <= 4"
  // means warning and above. Naming it maxSeverity rather than minSeverity is
  // the one place this inversion is spelled out.
  if (q0.maxSeverity !== undefined && q0.maxSeverity !== '') {
    const n = Number(q0.maxSeverity);
    if (!Number.isInteger(n) || n < 0 || n > 7) {
      errs.maxSeverity = 'maxSeverity must be an integer between 0 and 7';
    } else {
      out.maxSeverity = n;
    }
  }

  if (q0.deviceId !== undefined && q0.deviceId !== '') {
    const n = Number(q0.deviceId);
    if (!Number.isInteger(n) || n < 1) errs.deviceId = 'deviceId must be a positive integer';
    else out.deviceId = n;
  }

  if (q0.agentId !== undefined && q0.agentId !== '') {
    const n = Number(q0.agentId);
    if (!Number.isInteger(n) || n < 1) errs.agentId = 'agentId must be a positive integer';
    else out.agentId = n;
  }

  // The polled switch that SENT the events (migration 133) — an snmp_devices
  // id, a different space from deviceId (an agent id).
  if (q0.snmpDeviceId !== undefined && q0.snmpDeviceId !== '') {
    const n = Number(q0.snmpDeviceId);
    if (!Number.isInteger(n) || n < 1) errs.snmpDeviceId = 'snmpDeviceId must be a positive integer';
    else out.snmpDeviceId = n;
  }

  if (q0.transport !== undefined && q0.transport !== '') {
    if (!TRANSPORTS.includes(q0.transport)) {
      errs.transport = `transport must be one of: ${TRANSPORTS.join(', ')}`;
    } else {
      out.transport = q0.transport;
    }
  }

  if (q0.eventType !== undefined && q0.eventType !== '') {
    const t = str(q0.eventType, EVENT_TYPE_MAX);
    if (!t || !EVENT_TYPE_RE.test(t)) errs.eventType = 'eventType must be a dotted identifier';
    else out.eventType = t;
  }

  if (q0.q !== undefined && q0.q !== '') {
    const q = str(query.q, 128);
    if (!q) errs.q = 'q must be a non-empty string';
    else out.q = q;
  }

  return Object.keys(errs).length ? undefined : out;
}

module.exports = {
  validateDeviceEvent,
  validateDeviceEventBatch,
  validateDeviceEventQuery,
  MAX_EVENTS_PER_BATCH,
  TRANSPORTS,
  EVENT_TYPE_RE,
};
