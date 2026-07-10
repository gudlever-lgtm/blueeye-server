'use strict';

// Pure read-model for the incident timeline (Fase 2). Merges rows already read
// from existing tables — findings (anomalies), audit_events (config-changes on
// the device) and audit_log (manual + automatic status changes) — into one
// flat, chronological event list. No storage of its own.
//
// Playbook-runs are intentionally absent: there is no playbook subsystem in this
// codebase, so that source is always empty (the shape leaves room for Fase 3+).
//
// Event shape (flat list):
//   { type, timestamp, description, severity?, status?, actor?, startedAt?,
//     endedAt?, ref: { kind, id } }

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function ms(v) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// Tie-break order among events sharing a timestamp — keeps the story readable.
const TYPE_ORDER = { anomaly: 0, config_change: 1, status_change: 2 };

// Manual transitions are recorded as "from→to[: comment]"; pull the target
// status so the UI can colour the event.
function statusFromDetail(detail) {
  if (typeof detail !== 'string') return null;
  const m = detail.match(/→\s*([a-z]+)/);
  return m ? m[1] : null;
}

function describeConfigChange(c) {
  const who = c.actorLabel ? ` by ${c.actorLabel}` : '';
  const what = c.action || `${c.method || ''} ${c.path || ''}`.trim() || 'change';
  return `Config change: ${what}${who}`;
}

function buildTimeline({ anomalies = [], configChanges = [], statusChanges = [] } = {}) {
  const events = [];

  for (const a of anomalies) {
    const win = Array.isArray(a.window) ? a.window : [null, null];
    events.push({
      type: 'anomaly',
      timestamp: toIso(a.createdAt),
      description: a.explanation || `${a.severity || ''} ${a.metric || 'anomaly'}`.trim(),
      severity: a.severity || null,
      startedAt: toIso(win[0]) || toIso(a.createdAt),
      endedAt: toIso(win[1]),
      ref: { kind: 'anomaly', id: a.id },
    });
  }

  for (const c of configChanges) {
    events.push({
      type: 'config_change',
      timestamp: toIso(c.lastSeenAt || c.ts),
      description: describeConfigChange(c),
      actor: c.actorLabel || null,
      ref: { kind: 'config_change', id: c.id },
    });
  }

  for (const s of statusChanges) {
    // Tolerant of both the real audit_log row (snake_case) and the fake shape.
    const detail = s.detail;
    const createdAt = s.created_at ?? s.createdAt;
    const actor = s.actor_email ?? s.actorEmail
      ?? ((s.actor_role ?? s.actorRole) === 'system' ? 'system' : null);
    events.push({
      type: 'status_change',
      timestamp: toIso(createdAt),
      description: detail || s.action || 'status change',
      status: statusFromDetail(detail),
      actor,
      ref: { kind: 'audit_log', id: s.id },
    });
  }

  events.sort((x, y) => ms(x.timestamp) - ms(y.timestamp)
    || (TYPE_ORDER[x.type] - TYPE_ORDER[y.type])
    || (x.ref.id > y.ref.id ? 1 : x.ref.id < y.ref.id ? -1 : 0));

  return events;
}

module.exports = { buildTimeline, statusFromDetail };
