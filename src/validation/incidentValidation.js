'use strict';

const { METRICS, SEVERITY } = require('../incidents/detection');

const SEVERITIES = Object.freeze(Object.values(SEVERITY));

// Validates the report time-range query (?from=&to=). Both are REQUIRED, must be
// parseable dates, and from must be strictly before to. Returns { value: { from,
// to } } (Date objects) or { errors } — a 400 for any problem.
function validateReportRange(query) {
  const q = query && typeof query === 'object' ? query : {};
  const errors = {};
  const value = {};

  for (const key of ['from', 'to']) {
    const raw = q[key];
    if (raw === undefined || raw === null || raw === '') {
      errors[key] = `${key} is required`;
      continue;
    }
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      errors[key] = `${key} must be a valid date`;
    } else {
      value[key] = d;
    }
  }

  if (value.from && value.to && value.from.getTime() >= value.to.getTime()) {
    errors.range = 'from must be before to';
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

function parseOptionalValue(raw, field, errors) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    errors[field] = `${field} must be a non-negative number or null`;
    return null;
  }
  return n;
}

// Validates a threshold write (PUT). Body: { metric, warning_value,
// critical_value, debounce_count }. metric is required + one of the enum;
// value columns are optional numbers (null for reachability); debounce_count is
// an optional positive integer (defaults to 3). When both values are present,
// critical must be >= warning. Returns { value } ready for the repo, or { errors }.
function validateThresholdInput(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  if (!input.metric || !METRICS.includes(input.metric)) {
    errors.metric = `metric must be one of: ${METRICS.join(', ')}`;
  } else {
    value.metric = input.metric;
  }

  value.warning_value = parseOptionalValue(input.warning_value, 'warning_value', errors);
  value.critical_value = parseOptionalValue(input.critical_value, 'critical_value', errors);

  if (
    value.warning_value !== null && value.critical_value !== null &&
    !errors.warning_value && !errors.critical_value &&
    value.critical_value < value.warning_value
  ) {
    errors.critical_value = 'critical_value must be greater than or equal to warning_value';
  }

  if (input.debounce_count === undefined || input.debounce_count === null || input.debounce_count === '') {
    value.debounce_count = 3;
  } else {
    const n = Number(input.debounce_count);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      errors.debounce_count = 'debounce_count must be an integer between 1 and 100';
    } else {
      value.debounce_count = n;
    }
  }

  return Object.keys(errors).length > 0 ? { errors } : { value };
}

// Validates an optional ?severity= filter. Empty ⇒ null (no filter).
function validateSeverityFilter(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  if (!SEVERITIES.includes(raw)) {
    return { errors: { severity: `severity must be one of: ${SEVERITIES.join(', ')}` } };
  }
  return { value: raw };
}

module.exports = { validateReportRange, validateThresholdInput, validateSeverityFilter };
