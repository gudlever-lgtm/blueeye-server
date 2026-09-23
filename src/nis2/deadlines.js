'use strict';

// NIS2 Article 23 incident-reporting deadlines. They are deterministic offsets
// from when the entity became aware of a SIGNIFICANT incident, so we COMPUTE them
// on read rather than storing columns (always correct, and a change to the rules
// applies to history too):
//   - early warning:          within 24 hours of becoming aware      (23(4)(a))
//   - incident notification:  within 72 hours of becoming aware      (23(4)(b))
//   - final report:           within one month of the NOTIFICATION   (23(4)(d))
//
// Only incidents that carry a reporting duty get deadlines (notificationRequired,
// or nis2Relevant as a fallback). Anchored on detectedAt (fallback createdAt).
//
// SUBMISSION. Each stage's submission to the CSIRT/authority is recorded on the
// incident (earlyWarningSubmittedAt / notificationSubmittedAt /
// finalReportSubmittedAt, migration 122). A stage with a submission time is
// 'submitted' — with `onTime` saying whether it beat its deadline — and no
// longer counts towards the incident's worst status. Before those columns
// existed every stage stayed 'overdue' for ever once its time had passed, even
// for an incident that was reported on the dot, which made the status useless
// as a to-do list. A stage without one is still time-based:
// 'upcoming' | 'due-soon' | 'overdue', never a silent "met".
//
// The final report's clock starts at the notification's SUBMISSION when that is
// recorded (the directive's wording). Until it is, the due date is anchored on
// detection + 30 days — earlier than the law requires, never later, so the
// status can only err on the side of reporting sooner.

const HOUR = 3600 * 1000;
const STAGES = [
  { stage: 'early-warning', label: 'Early warning', offsetMs: 24 * HOUR, submittedField: 'earlyWarningSubmittedAt' },
  { stage: 'notification', label: 'Incident notification', offsetMs: 72 * HOUR, submittedField: 'notificationSubmittedAt' },
  { stage: 'final-report', label: 'Final report', offsetMs: 30 * 24 * HOUR, submittedField: 'finalReportSubmittedAt', after: 'notificationSubmittedAt' },
];
// 'submitted' ranks with 'none': a stage that has gone to the authority is not
// something anyone has to do any more.
const RANK = { overdue: 3, 'due-soon': 2, upcoming: 1, submitted: 0, none: 0 };

function isApplicable(incident) {
  return !!(incident && (incident.notificationRequired || incident.nis2Relevant));
}

const parseTime = (v) => {
  if (v == null || v === '') return NaN;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
};

// Returns { applicable, anchor, stages:[{stage,label,dueAt,hoursRemaining,status,
// submittedAt,onTime}], nextDueAt, worstStatus }. Pure (modulo the injected clock).
function computeIncidentDeadlines(incident, { now = Date.now(), dueSoonHours = 12 } = {}) {
  if (!isApplicable(incident)) return { applicable: false, stages: [], worstStatus: 'none', nextDueAt: null };
  const anchorIso = (incident && (incident.detectedAt || incident.createdAt)) || null;
  const anchor = anchorIso ? Date.parse(anchorIso) : NaN;
  if (Number.isNaN(anchor)) {
    return { applicable: true, anchor: null, stages: [], worstStatus: 'none', nextDueAt: null, reason: 'no detection time' };
  }
  const dueSoonMs = dueSoonHours * HOUR;
  let worst = null;
  let nextDueAt = null;
  const stages = STAGES.map((s) => {
    const base = s.after && Number.isFinite(parseTime(incident[s.after])) ? parseTime(incident[s.after]) : anchor;
    const dueMs = base + s.offsetMs;
    const msLeft = dueMs - now;
    const submittedMs = parseTime(incident[s.submittedField]);
    const submitted = Number.isFinite(submittedMs);
    const status = submitted ? 'submitted'
      : msLeft < 0 ? 'overdue' : (msLeft <= dueSoonMs ? 'due-soon' : 'upcoming');
    if (!submitted && (worst === null || RANK[status] > RANK[worst])) worst = status;
    if (!submitted && status !== 'overdue' && nextDueAt === null) nextDueAt = new Date(dueMs).toISOString();
    return {
      stage: s.stage,
      label: s.label,
      dueAt: new Date(dueMs).toISOString(),
      // What the due date was counted from — detection, or the notification's
      // submission for the final report once that is recorded.
      dueFrom: base === anchor ? 'detection' : 'notification-submitted',
      hoursRemaining: Math.round(msLeft / HOUR),
      status,
      submittedAt: submitted ? new Date(submittedMs).toISOString() : null,
      // Only meaningful for a submitted stage: did it beat the deadline?
      onTime: submitted ? submittedMs <= dueMs : null,
    };
  });
  return {
    applicable: true,
    anchor: new Date(anchor).toISOString(),
    stages,
    // Every stage submitted → 'submitted'; otherwise the worst open stage.
    worstStatus: worst === null ? 'submitted' : worst,
    nextDueAt,
  };
}

// Attaches `.deadlines` to each incident (additive; non-applicable incidents get
// { applicable:false }). Keeps the existing incident shape intact.
function withDeadlines(incidents, opts) {
  return (Array.isArray(incidents) ? incidents : []).map((i) => ({ ...i, deadlines: computeIncidentDeadlines(i, opts) }));
}

// Compliance-deadline overview: only incidents with a duty, each with its
// deadlines, sorted most-urgent first (overdue → due-soon → upcoming →
// submitted, then by the next due time), plus counts.
function deadlineOverview(incidents, opts) {
  const items = withDeadlines(incidents, opts)
    .filter((i) => i.deadlines.applicable && i.deadlines.stages.length)
    .sort((a, b) => {
      const r = RANK[b.deadlines.worstStatus] - RANK[a.deadlines.worstStatus];
      if (r !== 0) return r;
      return String(a.deadlines.nextDueAt || '').localeCompare(String(b.deadlines.nextDueAt || ''));
    });
  const summary = { overdue: 0, dueSoon: 0, upcoming: 0, submitted: 0, total: items.length };
  for (const i of items) {
    if (i.deadlines.worstStatus === 'overdue') summary.overdue += 1;
    else if (i.deadlines.worstStatus === 'due-soon') summary.dueSoon += 1;
    else if (i.deadlines.worstStatus === 'submitted') summary.submitted += 1;
    else summary.upcoming += 1;
  }
  return { summary, incidents: items };
}

module.exports = { computeIncidentDeadlines, withDeadlines, deadlineOverview, isApplicable, STAGES };
