'use strict';

// Validation for the recording surface (V2 §1 "Recording", §13 "Security").
//
// Two very different callers, so two very different postures:
//
//   * `validateRecordingStart` guards an operator's request from the dashboard.
//     Ordinary field validation — it may be strict, because a person is reading
//     the error message.
//
//   * `validateCaptureBatch` guards the INGEST path, which is reachable from a
//     browser on a customer's own site with only a capture token. It is the one
//     place in the module where a request arrives without a session, so it is
//     written to bound everything: how many events, how big each field, and
//     which keys survive at all. Anything unrecognised is DROPPED rather than
//     stored — an unknown key would be data the recorder could put into our
//     database without anyone having decided it should be there.
//
// Dropping beats rejecting here: a recorder a version behind must still produce
// a usable recording, and a single odd event must not throw away the journey the
// operator just performed.

const { isSecretField } = require('./secrets');
const { numOrNull } = require('../storage/shape');

const MAX_EVENTS_PER_BATCH = 200;
const MAX_STRING = 512;
const MAX_URL = 2048;

const EVENT_KINDS = new Set(['navigate', 'click', 'input', 'select', 'check', 'submit']);
// Everything the targeting layer knows how to use, and nothing else.
const TARGET_KEYS = ['role', 'name', 'label', 'text', 'placeholder', 'id', 'css'];

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function str(value, max = MAX_STRING) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value).slice(0, max);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function cleanTarget(raw) {
  if (!isPlainObject(raw)) return null;
  const out = {};
  for (const key of TARGET_KEYS) {
    const v = str(raw[key]);
    if (v) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

// One observation, reduced to the fields the translation layer reads.
//
// The value of a password field is never taken, whatever the recorder sent. The
// recorder is written to send `value: null` for one — but the recorder runs on a
// page the customer controls, so trusting it would be trusting the wrong side of
// the boundary. The rule is enforced here, on the server, where it holds even if
// the browser-side script is replaced entirely.
function cleanEvent(raw) {
  if (!isPlainObject(raw)) return null;
  const kind = str(raw.kind, 32);
  if (!kind || !EVENT_KINDS.has(kind)) return null;

  // `Number(null)` is 0, which is 1970 — and the translation sorts by `at`, so a
  // recorder that omitted a timestamp would have that event sorted to the front
  // of the journey. Absent means "now", not "the beginning of time".
  const at = numOrNull(raw.at);
  const event = { kind, at: at === null ? Date.now() : at };
  const url = str(raw.url, MAX_URL);
  if (url) event.url = url;
  const target = cleanTarget(raw.target);
  if (target) event.target = target;
  const tagName = str(raw.tagName, 32);
  if (tagName) event.tagName = tagName.toUpperCase();
  const inputType = str(raw.inputType, 32);
  if (inputType) event.inputType = inputType.toLowerCase();
  const autocomplete = str(raw.autocomplete, 64);
  if (autocomplete) event.autocomplete = autocomplete;
  if (typeof raw.checked === 'boolean') event.checked = raw.checked;

  // The secret rule, enforced server-side, from the same definition the
  // translation uses (./secrets.js). A password field contributes the FACT that
  // it was filled; never what was typed into it.
  if (isSecretField(event)) event.value = null;
  else {
    const value = str(raw.value);
    if (value !== null) event.value = value;
  }

  // An event that says nothing about an element and is not a navigation cannot
  // become a step, so it is not worth storing.
  if (kind !== 'navigate' && !event.target) return null;
  if (kind === 'navigate' && !event.url) return null;
  return event;
}

// The ingest body. Returns { value } or { errors } — the same contract the rest
// of the module's validators use, so a route hands `errors` straight to a 400.
function validateCaptureBatch(body) {
  if (!isPlainObject(body)) return { errors: { _: 'the request body must be an object' } };
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token || token.length > 128) return { errors: { token: 'a capture token is required' } };
  if (body.events !== undefined && !Array.isArray(body.events)) {
    return { errors: { events: 'events must be a list' } };
  }
  const raw = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_BATCH) : [];
  const events = [];
  for (const item of raw) {
    const cleaned = cleanEvent(item);
    if (cleaned) events.push(cleaned);
  }
  return { value: { token, events } };
}

function validateRecordingStart(body, { nameMax = 120 } = {}) {
  if (!isPlainObject(body)) return { errors: { _: 'the request body must be an object' } };
  const errors = {};
  const value = {};

  const appId = Number.parseInt(body.application_id, 10);
  if (!Number.isInteger(appId) || appId <= 0) errors.application_id = 'an application is required';
  else value.application_id = appId;

  const name = str(body.name, nameMax + 1);
  if (!name) errors.name = 'a name is required';
  else if (name.length > nameMax) errors.name = `the name is too long (max ${nameMax})`;
  else value.name = name;

  if (body.ttl_minutes !== undefined) {
    const ttl = Number.parseInt(body.ttl_minutes, 10);
    // A recording session is minutes of work, not a standing endpoint. The cap
    // is what keeps an abandoned one from being a capture URL open for a week.
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 240) errors.ttl_minutes = 'between 1 and 240 minutes';
    else value.ttl_minutes = ttl;
  }
  return Object.keys(errors).length ? { errors } : { value };
}

module.exports = {
  validateCaptureBatch, validateRecordingStart, cleanEvent, cleanTarget,
  EVENT_KINDS, TARGET_KEYS, MAX_EVENTS_PER_BATCH,
};
