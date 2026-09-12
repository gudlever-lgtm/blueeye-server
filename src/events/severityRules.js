'use strict';

// Severity rules — "this kind of event is a warning for us, not a critical".
//
// BlueEyes decides severity at detection: the analysis detector from a MAD
// z-score, Service Assurance from the kind of failure. Both are reasonable
// defaults and neither knows your business. A packet-loss anomaly that pages one
// customer at 3am is background noise to another.
//
// A rule says: events matching THIS get THAT severity, from now on.
//
// PURE: rules and an event in, a severity decision out. No database, no clock.
// The store layer applies what this decides; every judgement lives here, where
// it can be argued with in a test.
//
// Two things this deliberately cannot do:
//
//   * It cannot make an event disappear. INFO is the floor. Something that
//     silently deletes events is a different and far more dangerous control,
//     and it is not going to hide behind this one.
//   * It cannot change an event without saying so. Every decision carries the
//     rule that made it and what the severity WOULD have been, because a
//     machine that quietly downgrades criticals is one where the dashboard goes
//     green and nobody looks again.

const SEVERITIES = ['INFO', 'WARN', 'CRIT'];
const RANK = { INFO: 0, WARN: 1, CRIT: 2 };

// The fields a rule may match on, per source. A NULL/absent field means "any",
// so a rule with only `metric` covers that metric everywhere and adding
// `host_id` narrows it to one agent.
const MATCH_FIELDS = {
  finding: ['match_metric', 'match_kind', 'match_host_id'],
  service_assurance: ['match_kind', 'match_application_id'],
};

// What the rule field is called on the event it is matched against.
const EVENT_FIELD = {
  match_metric: 'metric',
  match_kind: 'kind',
  match_host_id: 'host_id',
  match_application_id: 'application_id',
};

const isSeverity = (v) => SEVERITIES.includes(v);

// Case-insensitive for text, exact for ids. A metric is a machine name the
// operator typed into a form; making them match its capitalisation would be a
// support ticket, not a safety feature.
function fieldMatches(ruleValue, eventValue) {
  if (ruleValue === null || ruleValue === undefined || ruleValue === '') return true; // "any"
  if (eventValue === null || eventValue === undefined) return false;
  if (typeof ruleValue === 'number' || typeof eventValue === 'number') {
    return Number(ruleValue) === Number(eventValue);
  }
  return String(ruleValue).trim().toLowerCase() === String(eventValue).trim().toLowerCase();
}

// How specific a rule is: how many fields it actually pins down. The most
// specific matching rule wins, so "http_5xx on THIS application" beats
// "http_5xx everywhere" — which is the order a person would expect and the only
// one that makes a general rule safe to write.
function specificityOf(rule) {
  const fields = MATCH_FIELDS[rule.source] || [];
  return fields.reduce((n, f) => n + (fieldMatches(rule[f], undefined) ? 0 : 1), 0);
}

function matches(rule, event) {
  if (!rule || !event) return false;
  if (rule.enabled === false || rule.enabled === 0) return false;
  if (rule.source !== event.source) return false;
  if (!isSeverity(rule.severity)) return false;
  const fields = MATCH_FIELDS[rule.source];
  if (!fields) return false;
  return fields.every((f) => fieldMatches(rule[f], event[EVENT_FIELD[f]]));
}

// The rule that governs this event, or null.
//
// Most specific wins. A tie is broken by the NEWEST rule, because two equally
// specific rules matching the same event is a person changing their mind, and
// the later decision is the one they meant.
function ruleFor(rules, event) {
  const candidates = (Array.isArray(rules) ? rules : []).filter((r) => matches(r, event));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => {
    const s = specificityOf(b) - specificityOf(a);
    if (s !== 0) return s;
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  })[0];
}

// The severity this event should be stored with.
//
//   applySeverity(rules, {
//     source: 'finding', severity: 'CRIT', metric: 'rtt', kind: 'ANOMALY', host_id: 'a1'
//   })
//   -> { severity, original_severity, severity_rule_id, changed, rule }
//
// `original_severity` and `severity_rule_id` are null when no rule applied —
// the columns then say plainly "this is what was detected", rather than
// recording a no-op.
function applySeverity(rules, event) {
  const detected = event && isSeverity(event.severity) ? event.severity : null;
  const unchanged = {
    severity: detected, original_severity: null, severity_rule_id: null, changed: false, rule: null,
  };
  if (!event || !detected) return unchanged;

  const rule = ruleFor(rules, event);
  if (!rule) return unchanged;
  // A rule that agrees with the detector is not a change. Recording it as one
  // would put "downgraded from CRIT to CRIT" on the screen and make the
  // provenance meaningless.
  if (rule.severity === detected) return unchanged;

  return {
    severity: rule.severity,
    original_severity: detected,
    severity_rule_id: rule.id ?? null,
    changed: true,
    rule,
  };
}

// One sentence for the screen, so an operator reading a downgraded event knows
// immediately that a person decided this and which decision it was.
function describeDecision(decision, { lang = 'en' } = {}) {
  if (!decision || !decision.changed) return null;
  const from = decision.original_severity;
  const to = decision.severity;
  const direction = RANK[to] < RANK[from]
    ? (lang === 'da' ? 'nedgraderet' : 'downgraded')
    : (lang === 'da' ? 'opgraderet' : 'upgraded');
  const why = (decision.rule && decision.rule.reason) ? ` — ${decision.rule.reason}` : '';
  return lang === 'da'
    ? `${from} ${direction} til ${to} af en regel${why}`
    : `${from} ${direction} to ${to} by a rule${why}`;
}

// Validates a rule the operator is about to save.
//
// A rule with no match fields at all would govern EVERY event from its source,
// which is never what anyone means and is how an estate goes quiet overnight.
// It is refused rather than warned about.
function validateRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { errors: { _: 'the request body must be an object' } };
  }
  const errors = {};
  const value = {};

  if (!MATCH_FIELDS[input.source]) {
    errors.source = `source must be one of: ${Object.keys(MATCH_FIELDS).join(', ')}`;
  } else {
    value.source = input.source;
  }
  if (!isSeverity(input.severity)) {
    errors.severity = `severity must be one of: ${SEVERITIES.join(', ')}`;
  } else {
    value.severity = input.severity;
  }

  const fields = MATCH_FIELDS[input.source] || [];
  let pinned = 0;
  for (const field of fields) {
    const raw = input[field];
    if (raw === undefined || raw === null || String(raw).trim() === '') { value[field] = null; continue; }
    if (field === 'match_application_id') {
      const n = Number.parseInt(raw, 10);
      if (!Number.isInteger(n) || n <= 0) { errors[field] = 'that application does not look valid'; continue; }
      value[field] = n;
    } else {
      const s = String(raw).trim();
      if (s.length > 255) { errors[field] = 'too long (max 255)'; continue; }
      value[field] = s;
    }
    pinned += 1;
  }
  // Fields belonging to the OTHER source are rejected rather than ignored: a
  // rule that silently dropped `match_host_id` would match far more than the
  // person who wrote it believed.
  //
  // Only when they carry a VALUE. An edit validates the stored row merged with
  // the patch, and a stored row always has every column — including the other
  // source's, sitting at NULL. A null field pins nothing down, so there is
  // nothing to drop and nothing to warn about; refusing it would make every
  // rule uneditable.
  for (const key of Object.keys(input)) {
    if (!key.startsWith('match_')) continue;
    if (fields.includes(key)) continue;
    const raw = input[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    errors[key] = `${key} does not apply to a ${input.source} rule`;
  }
  if (!pinned && !errors.source) {
    errors._ = 'a rule needs at least one thing to match on, or it would govern every event from this source';
  }

  // The reason is required. A rule that downgrades criticals and cannot say why
  // is the one somebody inherits in two years and dare not delete.
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) errors.reason = 'say why this rule exists — whoever inherits it will need to know';
  else if (reason.length > 500) errors.reason = 'too long (max 500)';
  else value.reason = reason;

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') errors.enabled = 'enabled must be true or false';
    else value.enabled = input.enabled;
  }

  return Object.keys(errors).length ? { errors } : { value };
}

module.exports = {
  applySeverity, ruleFor, matches, specificityOf, describeDecision, validateRule,
  SEVERITIES, RANK, MATCH_FIELDS, EVENT_FIELD,
};
