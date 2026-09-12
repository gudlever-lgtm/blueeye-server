'use strict';

// The incident lifecycle and its timeline (V3 Phase 1).
//
//     INC-2026-00124
//     Customer Portal degraded
//     Started 14:03 · Affected: Customer Search · 23 failures
//     Likely cause: Customer API · Status: OPEN
//
// PURE: state and events in, decisions out. No database, no clock beyond what a
// caller passes — every judgement lives here where it can be argued with.
//
// The rule that shapes everything: a timeline is built from events that ACTUALLY
// HAPPENED, each with the time it happened. Not a narrative composed afterwards.
// An operator reading "14:07 service marked DEGRADED" must be able to trust that
// something marked it degraded at 14:07, or the timeline is worthless at exactly
// the moment it is read — during the post-mortem.

const STATUS = {
  OPEN: 'open',
  INVESTIGATING: 'investigating',
  IDENTIFIED: 'identified',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
};

// "Not resolved" — the set six V2 queries meant when they said `status = 'open'`.
// Named once, so an incident moved to 'investigating' can never silently vanish
// from the dashboard it most needs to be on.
const ACTIVE = [STATUS.OPEN, STATUS.INVESTIGATING, STATUS.IDENTIFIED];

// What may follow what.
//
// Forward is the normal path, but going BACK from identified to investigating is
// allowed on purpose: being wrong about a cause is ordinary, and a lifecycle
// that cannot express "we thought we knew, we were wrong" pushes people into
// closing and reopening, which destroys the timeline.
//
// Reopening a resolved incident is allowed too — a fix that did not hold is the
// same incident, not a new one, and forcing a new one hides the recurrence.
const TRANSITIONS = {
  [STATUS.OPEN]: [STATUS.INVESTIGATING, STATUS.IDENTIFIED, STATUS.RESOLVED],
  [STATUS.INVESTIGATING]: [STATUS.IDENTIFIED, STATUS.RESOLVED, STATUS.OPEN],
  [STATUS.IDENTIFIED]: [STATUS.RESOLVED, STATUS.INVESTIGATING],
  [STATUS.RESOLVED]: [STATUS.CLOSED, STATUS.OPEN],
  // Closed is the end. Something that comes back is a new incident, because
  // "closed" is the statement that this one is finished being looked at.
  [STATUS.CLOSED]: [],
};

// Timeline event kinds BlueEyes itself writes. Open-ended in the database so
// detectors can ship without a migration; named here so a reader has one place
// to learn what exists.
const EVENT = {
  OPENED: 'incident.opened',
  FAILURE: 'failure.observed',
  REPEATED: 'failure.repeated',
  CORRELATED: 'correlation.concluded',
  HEALTH: 'service.health_changed',
  SEVERITY: 'incident.severity_changed',
  STATUS: 'incident.status_changed',
  ACKNOWLEDGED: 'incident.acknowledged',
  RECOVERED: 'failure.recovered',
  RESOLVED: 'incident.resolved',
  NOTIFIED: 'notification.sent',
  NOTIFY_FAILED: 'notification.failed',
  NOTE: 'incident.note',
};

const IMPACT = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' };

// Criticality of the worst affected journey decides impact. Severity is how bad
// the technical fault is; impact is what it costs. A CRIT on a page nobody uses
// is not a high-impact incident, and conflating the two is how alert fatigue
// starts.
const IMPACT_BY_CRITICALITY = {
  critical: IMPACT.CRITICAL,
  high: IMPACT.HIGH,
  normal: IMPACT.MEDIUM,
  low: IMPACT.LOW,
};

const isStatus = (s) => Object.values(STATUS).includes(s);

// May this incident go there, and if not, why not.
function canTransition(from, to) {
  if (!isStatus(from)) return { ok: false, reason: `"${from}" is not an incident status` };
  if (!isStatus(to)) return { ok: false, reason: `"${to}" is not an incident status` };
  if (from === to) return { ok: false, reason: `it is already ${to}` };
  if (!(TRANSITIONS[from] || []).includes(to)) {
    return {
      ok: false,
      reason: from === STATUS.CLOSED
        ? 'a closed incident stays closed — if it happens again, that is a new incident'
        : `an incident cannot go from ${from} to ${to}`,
    };
  }
  return { ok: true };
}

// The human reference, derived rather than stored.
//
//   INC-2026-00124
//
// Derived from the id and the year it opened, so it is unique by construction
// and needs no counter — and a counter is exactly the thing that produces two
// incidents with the same number the first time two workers open one at once.
function referenceFor(incident) {
  if (!incident || typeof incident !== 'object' || !incident.id) return null;
  const opened = incident.opened_at ? new Date(incident.opened_at) : null;
  const year = opened && !Number.isNaN(opened.getTime()) ? opened.getUTCFullYear() : new Date().getUTCFullYear();
  return `INC-${year}-${String(incident.id).padStart(5, '0')}`;
}

// What this incident costs, from the journeys it affects.
//
// Returns `unknown` when nothing says which journeys are affected. The spec is
// explicit that an unknown impact is reported as unknown and never invented,
// and "no journey information" is not the same as "low impact".
function assessImpact(rawInput = {}) {
  // A default parameter only covers `undefined`. Null, a string and a number all
  // reach here otherwise. Every pure module in V3 is read by a dashboard, where
  // throwing takes the page down instead of the analysis.
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  const { journeys = [], severity = null } = input;
  const affected = (Array.isArray(journeys) ? journeys : []).filter((j) => j && j.name);
  if (!affected.length) {
    return {
      impact: null,
      reason: 'No user journey is known to be affected, so the impact cannot be judged.',
      affected: [],
      // Said in as many words, because a blank on a screen reads as "none".
      affected_users: 'unknown',
    };
  }
  const worst = affected.reduce((a, j) => {
    const rank = { low: 0, normal: 1, high: 2, critical: 3 };
    return (rank[String(j.criticality || 'normal').toLowerCase()] ?? 1) > (rank[String(a.criticality || 'normal').toLowerCase()] ?? 1) ? j : a;
  }, affected[0]);
  const impact = IMPACT_BY_CRITICALITY[String(worst.criticality || 'normal').toLowerCase()] || IMPACT.MEDIUM;
  const names = affected.map((j) => j.name);
  return {
    impact,
    reason: affected.length === 1
      ? `${names[0]} is unavailable, and it is a ${String(worst.criticality || 'normal').toLowerCase()} journey.`
      : `${names.length} journeys are affected, the most important being ${worst.name}.`,
    affected: names,
    // BlueEyes watches journeys, not people. It has no way to know how many
    // users a broken journey cost, and a made-up number would be the least
    // trustworthy thing on the page.
    affected_users: 'unknown',
    severity,
  };
}

// One timeline entry.
function event(kind, summary, rawOpts = {}) {
  const opts = (rawOpts && typeof rawOpts === 'object') ? rawOpts : {};
  const { at = null, source = 'run', detail = null, actorId = null } = opts;
  return {
    kind,
    summary: String(summary || '').slice(0, 512),
    detail: detail || null,
    source,
    actor_id: actorId ?? null,
    // The time it HAPPENED. Null means the caller did not know, which the
    // renderer shows as such rather than substituting "now" — a guessed
    // timestamp in a timeline is worse than an admitted gap.
    occurred_at: at instanceof Date ? at : (at ? new Date(at) : null),
  };
}

// The events a failing run contributes to an incident's timeline.
//
// Everything here is something that demonstrably happened, with the time the run
// recorded for it. Nothing is invented, and nothing is timestamped "now".
function eventsFromRun(rawInput = {}) {
  const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) ? rawInput : {};
  const { run, correlation = null, isNew = false, occurrences = 0 } = input;
  if (!run || typeof run !== 'object') return [];
  const at = run.ended_at ? new Date(run.ended_at) : null;
  const out = [];

  if (isNew) {
    out.push(event(EVENT.OPENED, `Incident opened after ${run.test_name || 'a test'} failed`, { at }));
  }
  out.push(event(EVENT.FAILURE, run.error_message || `${run.test_name || 'A test'} failed`, {
    at, detail: { run_id: run.id ?? null, failure_kind: run.failure_kind || null },
  }));

  // Repetition is its own event. "It happened again" is the fact that turns a
  // blip into an outage, and a timeline that only shows the first failure hides
  // the thing the operator most needs to see.
  if (!isNew && occurrences > 1) {
    out.push(event(EVENT.REPEATED, `The same failure happened again (${occurrences} times in total)`, { at }));
  }

  if (correlation && correlation.conclusion) {
    out.push(event(EVENT.CORRELATED, correlation.confidence
      ? `${correlation.conclusion} (${correlation.confidence}% confident)`
      : correlation.conclusion, {
      at,
      source: 'correlation',
      detail: {
        layer: correlation.layer || null,
        confidence: correlation.confidence ?? null,
        ruled_out: correlation.ruled_out || [],
        not_checked: correlation.not_checked || [],
      },
    }));
  }
  return out;
}

// Orders a timeline for display.
//
// By when things HAPPENED, with the row id as the tie-break — two events in the
// same millisecond still have an order, and it is the order they were recorded
// in. Events with no time sink to the end rather than being dropped: a gap that
// is visible can be investigated, and one that is hidden cannot.
function orderTimeline(events) {
  const list = (Array.isArray(events) ? events : []).filter((e) => e && typeof e === 'object');
  const timed = list.filter((e) => e.occurred_at);
  const untimed = list.filter((e) => !e.occurred_at);
  timed.sort((a, b) => {
    const d = new Date(a.occurred_at) - new Date(b.occurred_at);
    if (d !== 0) return d;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
  return [...timed, ...untimed];
}

// How long this has been going on, from the timeline itself.
//
// An OPEN incident is measured to `now`, because "18 minutes" on a live outage
// must keep counting. A resolved one is measured to when it resolved, and never
// keeps growing afterwards.
function durationOf(incident, now = new Date()) {
  if (!incident || typeof incident !== 'object' || !incident.opened_at) return null;
  const start = new Date(incident.opened_at);
  if (Number.isNaN(start.getTime())) return null;
  const active = ACTIVE.includes(incident.status);
  const end = active ? now : (incident.resolved_at ? new Date(incident.resolved_at) : now);
  if (Number.isNaN(new Date(end).getTime())) return null;
  const ms = Math.max(0, new Date(end) - start);
  return { ms, minutes: Math.round(ms / 60000), ongoing: active };
}

module.exports = {
  STATUS, ACTIVE, TRANSITIONS, EVENT, IMPACT,
  canTransition, referenceFor, assessImpact, event, eventsFromRun, orderTimeline, durationOf,
};
