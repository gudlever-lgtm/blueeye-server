'use strict';

// Data-access for `alert_dispatch_log` (migration 059) — a durable record of alerts
// actually dispatched to channels. Two consumers:
//   * the alerting dispatcher records each finding-level + cluster-level send;
//   * the cross-agent cluster alert reads it to (a) fire once per cluster
//     (existsForCluster) and (b) reference the members already alerted individually
//     (listAlertedFindings), so it never resends their alerts.
//
// Pure data-access. Metadata only — never payload.

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function createAlertDispatchLogRepository(db) {
  const { pool } = db;

  // Records one dispatched alert. `channels` is a comma-separated list of channel
  // names that sent OK. Returns the new id.
  async function record({ subjectType, subjectId, hostId = null, metric = null, severity = null, channels = null, sentAt }) {
    const [res] = await pool.query(
      `INSERT INTO alert_dispatch_log
         (subject_type, subject_id, host_id, metric, severity, channels, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [subjectType, String(subjectId), hostId == null ? null : String(hostId), metric, severity, channels, sentAt],
    );
    return Number(res.insertId);
  }

  // True if a cluster-level alert has already been logged for this cluster — the
  // durable "fire once per cluster" guard.
  async function existsForCluster(clusterId) {
    const [rows] = await pool.query(
      "SELECT 1 FROM alert_dispatch_log WHERE subject_type = 'cluster' AND subject_id = ? LIMIT 1",
      [String(clusterId)],
    );
    return rows.length > 0;
  }

  // The subset of `findingIds` that already have a finding-level alert logged — the
  // members the cluster alert should REFERENCE, not resend. Returns [] for empty input.
  async function listAlertedFindings(findingIds) {
    const ids = (Array.isArray(findingIds) ? findingIds : []).map(String).filter(Boolean);
    if (ids.length === 0) return [];
    const [rows] = await pool.query(
      `SELECT DISTINCT subject_id FROM alert_dispatch_log
        WHERE subject_type = 'finding' AND subject_id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    );
    return rows.map((r) => r.subject_id);
  }

  // Recent log rows (for a future read API / audit). Bounded.
  async function list({ subjectType = null, limit = 500 } = {}) {
    const where = [];
    const params = [];
    if (subjectType) { where.push('subject_type = ?'); params.push(subjectType); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT id, subject_type, subject_id, host_id, metric, severity, channels, sent_at, created_at
         FROM alert_dispatch_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id DESC LIMIT ?`,
      params,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      hostId: r.host_id ?? null,
      metric: r.metric ?? null,
      severity: r.severity ?? null,
      channels: r.channels ?? null,
      sentAt: toIso(r.sent_at),
      createdAt: toIso(r.created_at),
    }));
  }

  return { record, existsForCluster, listAlertedFindings, list };
}

module.exports = { createAlertDispatchLogRepository };
