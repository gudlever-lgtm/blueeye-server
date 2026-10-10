'use strict';

const {
  scopeMatches, specificityOf, validateScope, MATCH_FIELDS, SEVERITIES, RANK,
} = require('./severityRules');
const { CHANNEL_NAMES } = require('../analysis/alerting/config');
const { validateAttack } = require('./attack');

// Event patterns — one named match, used by every policy that needs it.
//
// BlueEyes has had a matcher since migration 086: a severity rule pins down
// source/metric/kind/agent/application, blank means "any", and the most
// specific match wins. What it did not have is a way to write that match ONCE
// and hang more than one decision off it. So "packet loss on the warehouse
// links" had to be typed into a severity rule, and could not be expressed to
// the alerting dispatcher at all — which saw a severity and nothing else.
//
// A pattern is that same match with a name. A severity rule points at one
// instead of carrying its own fields; an alert route hangs off one to say where
// its events go, from which severity, and how often. The matcher itself is
// unchanged and is NOT reimplemented here — scopeMatches/specificityOf come
// from severityRules.js, so a pattern and a rule can never disagree about what
// "matches" means.
//
// PURE: patterns, routes and an event in, a decision out. No database, no
// clock.

// The pattern that governs this event, or null.
//
// Most specific wins — "packet_loss on gw-core" beats "packet_loss everywhere" —
// and a tie goes to the NEWEST pattern, because two equally specific patterns
// matching the same event is a person changing their mind. The same order as
// severity rules, deliberately: one surprising precedence rule in a product is
// one too many.
function patternFor(patterns, event) {
  const hits = (Array.isArray(patterns) ? patterns : []).filter((p) => scopeMatches(p, event));
  if (!hits.length) return null;
  return hits.sort((a, b) => {
    const s = specificityOf(b) - specificityOf(a);
    if (s !== 0) return s;
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  })[0];
}

// Where this event's alerts go: { pattern, route } or null.
//
// ONE route per pattern (the table has a UNIQUE key on pattern_id), so there is
// no tie to break: the pattern decides which events, and its route decides
// where they go. Two destinations for two severities are two patterns.
//
// A route whose `min_severity` the event does not reach returns null — the
// event's own pattern has already said it is below the bar, and falling back to
// the per-channel minimums would make the route's threshold decorative.
// `routed: false` is how the dispatcher tells that apart from "nothing matched",
// which it must, because one means don't alert and the other means alert as
// before.
function routeFor(patterns, routes, event) {
  const pattern = patternFor(patterns, event);
  if (!pattern) return null;
  const list = Array.isArray(routes) ? routes : [];
  const route = list.find((r) => Number(r.pattern_id) === Number(pattern.id) && r.enabled !== false && r.enabled !== 0);
  // A pattern with no route still NAMES the pattern. The caller wants it: the
  // dispatcher stamps the pattern's ATT&CK technique on the alert whether or
  // not the pattern also redirects it, and `route: null` is how it knows to
  // dispatch the default way while still carrying the label.
  if (!route) return { pattern, route: null, routed: true };
  const floor = route.min_severity ? (RANK[route.min_severity] || 0) : 0;
  const sev = RANK[event && event.severity] || 0;
  if (floor && sev < floor) return { pattern, route, routed: false };
  return { pattern, route, routed: true };
}

// The channel names a route sends to, as an array. Stored as a comma-separated
// string (a short closed set, not a relation), read back here so nothing else
// has to know that.
function channelsOf(route) {
  if (!route || !route.channels) return [];
  return String(route.channels).split(',').map((s) => s.trim()).filter(Boolean);
}

// ------------------------------------------------------------------ validation

const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000; // a day; longer is a maintenance window

// Validates a pattern the operator is about to save.
//
// A pattern with nothing pinned down would govern every event from its source,
// which is never what anyone means — refused, exactly as a severity rule is.
function validatePattern(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: { _: 'the request body must be an object' } };
  }
  const errors = {};
  const value = {};

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) errors.name = 'give the pattern a name — it is what the rules and the route refer to';
  else if (name.length > 80) errors.name = 'too long (max 80)';
  else value.name = name;

  if (!MATCH_FIELDS[input.source]) {
    errors.source = `source must be one of: ${Object.keys(MATCH_FIELDS).join(', ')}`;
  } else {
    value.source = input.source;
  }

  const pinned = validateScope(input, value, errors, 'pattern');
  if (!pinned && !errors.source) {
    errors._ = 'a pattern needs at least one thing to match on, or it would cover every event from this source';
  }

  // The MITRE ATT&CK technique the OPERATOR says this match is (src/events/
  // attack.js, migration 147). Optional, and both fields or neither.
  validateAttack(input, value, errors);

  // Required, for the same reason a severity rule's reason is: a grouping that
  // routes alerts and cannot say why is the one somebody inherits and dare not
  // touch.
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) errors.reason = 'say why this grouping exists — whoever inherits it will need to know';
  else if (reason.length > 500) errors.reason = 'too long (max 500)';
  else value.reason = reason;

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') errors.enabled = 'enabled must be true or false';
    else value.enabled = input.enabled;
  }

  return Object.keys(errors).length ? { errors } : { value };
}

// Validates a route the operator is about to save.
//
// `channels` is never allowed to be empty. A route with no channel is a mute
// button, and muting already exists as a control that says so on the screen and
// expires on its own (maintenance windows) — it is not going to hide behind
// alert routing.
function validateRoute(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: { _: 'the request body must be an object' } };
  }
  const errors = {};
  const value = {};

  const raw = Array.isArray(input.channels)
    ? input.channels
    : (typeof input.channels === 'string' ? input.channels.split(',') : null);
  if (!raw) {
    errors.channels = 'name at least one channel to send to';
  } else {
    const names = [...new Set(raw.map((c) => String(c).trim().toLowerCase()).filter(Boolean))];
    const unknown = names.filter((n) => !CHANNEL_NAMES.includes(n));
    if (!names.length) errors.channels = 'name at least one channel to send to';
    else if (unknown.length) errors.channels = `unknown channel(s): ${unknown.join(', ')} — known: ${CHANNEL_NAMES.join(', ')}`;
    else value.channels = names.join(',');
  }

  if (input.min_severity === undefined || input.min_severity === null || input.min_severity === '') {
    value.min_severity = null;
  } else if (!SEVERITIES.includes(input.min_severity)) {
    errors.min_severity = `min_severity must be one of: ${SEVERITIES.join(', ')}, or blank for each channel's own`;
  } else {
    value.min_severity = input.min_severity;
  }

  if (input.cooldown_ms === undefined || input.cooldown_ms === null || input.cooldown_ms === '') {
    value.cooldown_ms = null;
  } else {
    const n = Number(input.cooldown_ms);
    if (!Number.isInteger(n) || n < 0 || n > MAX_COOLDOWN_MS) {
      errors.cooldown_ms = `cooldown_ms must be a whole number of milliseconds between 0 and ${MAX_COOLDOWN_MS}, or blank for the global one`;
    } else {
      value.cooldown_ms = n;
    }
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) errors.reason = 'say why these events go here';
  else if (reason.length > 500) errors.reason = 'too long (max 500)';
  else value.reason = reason;

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') errors.enabled = 'enabled must be true or false';
    else value.enabled = input.enabled;
  }

  return Object.keys(errors).length ? { errors } : { value };
}

module.exports = {
  patternFor, routeFor, channelsOf, validatePattern, validateRoute,
  CHANNEL_NAMES, MAX_COOLDOWN_MS,
};
