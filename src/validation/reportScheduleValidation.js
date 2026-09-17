'use strict';

// Validation for scheduled reports (POST/PUT /api/report-schedules).
//
// A schedule says which report, over how long a window, for whom, and how often.
// The recurrence is the same one test packages use (src/schedule/recurrence.js),
// so "the 1st at 06:00" means one thing in this product.

const { validateRecurrence } = require('../schedule/recurrence');
const { REPORT_IDS, FORMATS } = require('../reports/definitions');

const NAME_MAX = 255;
const MAX_RECIPIENTS = 20;
const EMAIL_MAX = 254;
// A window is RELATIVE ("the last N days") and resolved at fire time. 400 days
// covers a year-on-year report and stops a schedule asking for a decade of rows
// every morning.
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 400;
const SEVERITIES = ['info', 'warning', 'critical'];

// Deliberately simple, and deliberately not RFC 5322: this address is handed to
// an SMTP server, so what matters is that it cannot carry a header injection
// (no CR/LF, no commas) and that it looks like an address at all.
const EMAIL_RE = /^[^\s@,;:<>"'\\]+@[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?\.[A-Za-z]{2,24}$/;

function validateRecipients(raw, errors) {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.recipients = 'recipients must be a non-empty array of email addresses';
    return undefined;
  }
  if (raw.length > MAX_RECIPIENTS) { errors.recipients = `too many recipients (max ${MAX_RECIPIENTS})`; return undefined; }
  const out = [];
  for (const entry of raw) {
    const email = typeof entry === 'string' ? entry.trim() : '';
    if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
      errors.recipients = `not a usable email address: ${String(entry).slice(0, 64)}`;
      return undefined;
    }
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

function validateParams(raw, report, errors) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  if (input.location_id !== undefined && input.location_id !== null && input.location_id !== '') {
    const id = Number(input.location_id);
    if (!Number.isInteger(id) || id <= 0) { errors.params = 'params.location_id must be a positive integer'; return undefined; }
    out.locationId = id;
  }
  if (report === 'probe_outages' && input.severity !== undefined && input.severity !== null && input.severity !== '') {
    const sev = String(input.severity).toLowerCase();
    if (!SEVERITIES.includes(sev)) { errors.params = `params.severity must be one of: ${SEVERITIES.join(', ')}`; return undefined; }
    out.severity = sev;
  }
  return out;
}

function validateReportScheduleInput(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const value = {};

  if (typeof input.name !== 'string' || input.name.trim() === '') errors.name = 'name is required';
  else if (input.name.trim().length > NAME_MAX) errors.name = `name must be at most ${NAME_MAX} characters`;
  else value.name = input.name.trim();

  const report = String(input.report || '');
  if (!REPORT_IDS.includes(report)) errors.report = `report must be one of: ${REPORT_IDS.join(', ')}`;
  else value.report = report;

  const format = input.format === undefined || input.format === null || input.format === '' ? 'csv' : String(input.format);
  if (!FORMATS.includes(format)) errors.format = `format must be one of: ${FORMATS.join(', ')}`;
  else value.format = format;

  const windowDays = input.window_days === undefined || input.window_days === null || input.window_days === ''
    ? 7 : Number(input.window_days);
  if (!Number.isInteger(windowDays) || windowDays < MIN_WINDOW_DAYS || windowDays > MAX_WINDOW_DAYS) {
    errors.window_days = `window_days must be an integer between ${MIN_WINDOW_DAYS} and ${MAX_WINDOW_DAYS}`;
  } else {
    value.window_days = windowDays;
  }

  const params = validateParams(input.params, report, errors);
  if (params !== undefined) value.params = params;

  const recipients = validateRecipients(input.recipients, errors);
  if (recipients !== undefined) value.recipients = recipients;

  const { value: recurrence, errors: re } = validateRecurrence(input.schedule_spec);
  if (re) errors.schedule_spec = Object.values(re).join('; ');
  else value.schedule_spec = recurrence;

  value.enabled = input.enabled === undefined ? true : !!input.enabled;

  return Object.keys(errors).length ? { errors } : { value };
}

module.exports = {
  validateReportScheduleInput,
  MAX_RECIPIENTS,
  MIN_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  SEVERITIES,
};
