'use strict';

// NIS2 Article 23 incident-reporting deadlines. They are deterministic offsets
// from when the entity became aware of a SIGNIFICANT incident, so we COMPUTE them
// on read rather than storing columns (no migration, always correct):
//   - early warning:          within 24 hours
//   - incident notification:  within 72 hours
//   - final report:           within 1 month (30 days)
//
// Only incidents that carry a reporting duty get deadlines (notificationRequired,
// or nis2Relevant as a fallback). The status is time-based only — the platform
// records the duty + due dates but does NOT (yet) record submission to the
// authority/CSIRT, so a stage is 'upcoming' | 'due-soon' | 'overdue', never a
// silent "met". Anchored on detectedAt (fallback createdAt).

const HOUR = 3600 * 1000;
const STAGES = [
  { stage: 'early-warning', label: 'Early warning', offsetMs: 24 * HOUR },
  { stage: 'notification', label: 'Incident notification', offsetMs: 72 * HOUR },
  { stage: 'final-report', label: 'Final report', offsetMs: 30 * 24 * HOUR },
];
const RANK = { overdue: 3, 'due-soon': 2, upcoming: 1, none: 0 };

function isApplicable(incident) {
  return !!(incident && (incident.notificationRequired || incident.nis2Relevant));
}

// Returns { applicable, anchor, stages:[{stage,label,dueAt,hoursRemaining,status}],
// nextDueAt, worstStatus }. Pure (modulo the injected clock).
function computeIncidentDeadlines(incident, { now = Date.now(), dueSoonHours = 12 } = {}) {
  if (!isApplicable(incident)) return { applicable: false, stages: [], worstStatus: 'none', nextDueAt: null };
  const anchorIso = (incident && (incident.detectedAt || incident.createdAt)) || null;
  const anchor = anchorIso ? Date.parse(anchorIso) : NaN;
  if (Number.isNaN(anchor)) {
    return { applicable: true, anchor: null, stages: [], worstStatus: 'none', nextDueAt: null, reason: 'no detection time' };
  }
  const dueSoonMs = dueSoonHours * HOUR;
  let worst = 'upcoming';
  let nextDueAt = null;
  const stages = STAGES.map((s) => {
    const dueMs = anchor + s.offsetMs;
    const msLeft = dueMs - now;
    const status = msLeft < 0 ? 'overdue' : (msLeft <= dueSoonMs ? 'due-soon' : 'upcoming');
    if (RANK[status] > RANK[worst]) worst = status;
    if (status !== 'overdue' && nextDueAt === null) nextDueAt = new Date(dueMs).toISOString();
    return {
      stage: s.stage,
      label: s.label,
      dueAt: new Date(dueMs).toISOString(),
      hoursRemaining: Math.round(msLeft / HOUR),
      status,
    };
  });
  return { applicable: true, anchor: new Date(anchor).toISOString(), stages, worstStatus: worst, nextDueAt };
}

// Attaches `.deadlines` to each incident (additive; non-applicable incidents get
// { applicable:false }). Keeps the existing incident shape intact.
function withDeadlines(incidents, opts) {
  return (Array.isArray(incidents) ? incidents : []).map((i) => ({ ...i, deadlines: computeIncidentDeadlines(i, opts) }));
}

// Compliance-deadline overview: only incidents with a duty, each with its
// deadlines, sorted most-urgent first (overdue → due-soon → upcoming, then by the
// next due time), plus counts.
function deadlineOverview(incidents, opts) {
  const items = withDeadlines(incidents, opts)
    .filter((i) => i.deadlines.applicable && i.deadlines.stages.length)
    .sort((a, b) => {
      const r = RANK[b.deadlines.worstStatus] - RANK[a.deadlines.worstStatus];
      if (r !== 0) return r;
      return String(a.deadlines.nextDueAt || '').localeCompare(String(b.deadlines.nextDueAt || ''));
    });
  const summary = { overdue: 0, dueSoon: 0, upcoming: 0, total: items.length };
  for (const i of items) {
    if (i.deadlines.worstStatus === 'overdue') summary.overdue += 1;
    else if (i.deadlines.worstStatus === 'due-soon') summary.dueSoon += 1;
    else summary.upcoming += 1;
  }
  return { summary, incidents: items };
}

module.exports = { computeIncidentDeadlines, withDeadlines, deadlineOverview, isApplicable, STAGES };
