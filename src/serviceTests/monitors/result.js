'use strict';

const { STATUS, KIND } = require('./types');

// The result every checker returns, built here so eight check types cannot
// invent eight slightly different shapes.
//
//   { status, kind, summary, value, unit, duration_ms, timings, detail, error_message }
//
// PURE. A checker does the I/O; these functions only say what the outcome was.

const MAX_SUMMARY = 500;
const MAX_ERROR = 1000;

const clip = (s, max) => (s === null || s === undefined ? null : String(s).slice(0, max));

function base(status, { kind = null, summary = null, value = null, unit = null, durationMs = null, timings = null, detail = null, error = null } = {}) {
  return {
    status,
    kind,
    summary: clip(summary, MAX_SUMMARY),
    value: Number.isFinite(value) ? value : null,
    unit: unit || null,
    duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    timings: timings && typeof timings === 'object' ? timings : null,
    detail: detail && typeof detail === 'object' ? detail : null,
    error_message: clip(error, MAX_ERROR),
  };
}

const ok = (opts) => base(STATUS.OK, opts);
const failed = (kind, opts = {}) => base(STATUS.FAILED, { ...opts, kind });
const unreachable = (opts = {}) => base(STATUS.UNREACHABLE, { kind: KIND.UNREACHABLE, ...opts });
const misconfigured = (opts = {}) => base(STATUS.MISCONFIGURED, { kind: KIND.MISCONFIGURED, ...opts });
const unknown = (opts = {}) => base(STATUS.UNKNOWN, opts);

// Re-judges a healthy result against the operator's thresholds. Separated from
// the check so the same rule applies to every type, and so a threshold change
// takes effect on the next check without touching a checker.
//
// `slowKind` names what was slow ("the mail was delivered, eventually"), which
// is a different incident from "the mail bounced".
function applyThresholds(result, { warnMs = null, critMs = null, slowKind = KIND.SLOW, what = 'The check' } = {}) {
  if (!result || result.status !== STATUS.OK) return result;
  const measured = Number.isFinite(result.value) && result.unit === 'ms' ? result.value : result.duration_ms;
  if (!Number.isFinite(measured)) return result;
  const crit = Number.isFinite(critMs) ? critMs : null;
  const warn = Number.isFinite(warnMs) ? warnMs : null;
  if (crit !== null && measured >= crit) {
    return { ...result, status: STATUS.SLOW, kind: slowKind, severity_hint: 'CRIT', summary: `${what} took ${Math.round(measured)} ms (over the ${crit} ms limit).` };
  }
  if (warn !== null && measured >= warn) {
    return { ...result, status: STATUS.SLOW, kind: slowKind, severity_hint: 'WARN', summary: `${what} took ${Math.round(measured)} ms (over the ${warn} ms warning).` };
  }
  return result;
}

module.exports = { ok, failed, unreachable, misconfigured, unknown, applyThresholds, STATUS, KIND };
