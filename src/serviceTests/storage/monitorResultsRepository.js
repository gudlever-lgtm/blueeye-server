'use strict';

const { parseJson, numOrNull, intOrNull } = require('./shape');

// Data-access for `service_monitor_results` (migration 094) — one row per check.
//
// Unlike the certificate table, this one IS history, and deliberately: "the mail
// took four seconds yesterday and ninety today" is the finding, and a state row
// cannot hold it. Which is also why it is swept — see `purgeOlderThan`, driven
// by the same retention setting as incidents.
function createMonitorResultsRepository({ db, now = () => new Date() }) {
  const { pool } = db;
  const COLS = `id, monitor_id, status, kind, duration_ms, value, unit, summary, error_message,
    timings, detail, trigger_source, requested_by, checked_at`;

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      monitor_id: row.monitor_id,
      status: row.status,
      kind: row.kind,
      duration_ms: row.duration_ms,
      // numOrNull rather than Number(): a measurement nobody took must never
      // read back as a measurement of zero.
      value: numOrNull(row.value),
      unit: row.unit,
      summary: row.summary,
      error_message: row.error_message,
      timings: parseJson(row.timings, null),
      detail: parseJson(row.detail, null),
      trigger_source: row.trigger_source,
      requested_by: row.requested_by,
      checked_at: row.checked_at,
    };
  }

  const cut = (v, max) => (v === null || v === undefined ? null : String(v).slice(0, max));

  async function record(monitorId, result, { triggerSource = 'schedule', requestedBy = null, at = null } = {}) {
    const [res] = await pool.query(
      `INSERT INTO service_monitor_results
         (monitor_id, status, kind, duration_ms, value, unit, summary, error_message, timings, detail,
          trigger_source, requested_by, checked_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        monitorId,
        result.status || 'unknown',
        cut(result.kind, 48),
        intOrNull(result.duration_ms),
        numOrNull(result.value),
        cut(result.unit, 16),
        cut(result.summary, 512),
        cut(result.error_message, 4000),
        result.timings ? JSON.stringify(result.timings) : null,
        result.detail ? JSON.stringify(result.detail) : null,
        triggerSource === 'manual' ? 'manual' : 'schedule',
        intOrNull(requestedBy),
        at || now(),
      ]
    );
    return findById(res.insertId);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_monitor_results WHERE id = ? LIMIT 1`, [id]);
    return shape(rows[0]);
  }

  async function list({ monitorId = null, status = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (monitorId) { where.push('monitor_id = ?'); params.push(monitorId); }
    if (status) { where.push('status = ?'); params.push(status); }
    const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_monitor_results
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY checked_at DESC, id DESC LIMIT ${n}`,
      params
    );
    return rows.map(shape);
  }

  // Availability and the measurement over a window — what the history chart
  // draws, computed in SQL so the whole series never crosses the wire.
  async function summary(monitorId, { hours = 24 } = {}) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS checks,
              SUM(status = 'ok') AS ok_count,
              SUM(status = 'slow') AS slow_count,
              SUM(status IN ('failed','unreachable')) AS bad_count,
              AVG(value) AS avg_value,
              MAX(value) AS max_value,
              MIN(checked_at) AS since
         FROM service_monitor_results
        WHERE monitor_id = ? AND checked_at >= DATE_SUB(?, INTERVAL ? HOUR)`,
      [monitorId, now(), Math.min(Math.max(Number(hours) || 24, 1), 8760)]
    );
    const row = rows[0] || {};
    const checks = Number(row.checks) || 0;
    return {
      checks,
      ok: Number(row.ok_count) || 0,
      slow: Number(row.slow_count) || 0,
      bad: Number(row.bad_count) || 0,
      // Availability over the window, or null when nothing was measured — a
      // monitor that never ran is not 0% available, it is unmeasured.
      availability: checks ? (Number(row.ok_count) + Number(row.slow_count)) / checks : null,
      avg_value: numOrNull(row.avg_value),
      max_value: numOrNull(row.max_value),
      since: row.since || null,
    };
  }

  // The history as a CHART rather than a list: availability per bucket, and the
  // measurement's shape inside it.
  //
  // Same bucketing as the run-history charts (stats/period.js decides what a
  // period and a bucket are, and hands the SQL format down), so "this week" means
  // the same thing on both screens and is cut in the VIEWER's time zone — bucketing
  // in UTC would put the first hours of a Copenhagen day in the previous one.
  //
  // `unknown` counts towards neither available nor unavailable: it is the outcome
  // that says nobody managed to look, and folding it into either would be
  // inventing a fact. It stays in `checks` so a bucket's numbers still add up.
  async function series({ monitorId, from, to, sqlFormat, offsetMinutes = 0 } = {}) {
    // The bucket expression's placeholders come FIRST: they sit in the SELECT
    // list, which MySQL binds before the WHERE clause.
    const params = [Number(offsetMinutes) || 0, String(sqlFormat), monitorId, from, to];
    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(DATE_SUB(checked_at, INTERVAL ? MINUTE), ?) AS bucket,
              COUNT(*) AS checks,
              SUM(status = 'ok') AS ok_count,
              SUM(status = 'slow') AS slow_count,
              SUM(status IN ('failed','unreachable')) AS bad_count,
              SUM(status = 'misconfigured') AS misconfigured_count,
              SUM(status = 'unknown') AS unknown_count,
              ROUND(AVG(value)) AS avg_value,
              MAX(value) AS max_value,
              MIN(value) AS min_value
         FROM service_monitor_results
        WHERE monitor_id = ? AND checked_at >= ? AND checked_at < ?
        GROUP BY bucket
        ORDER BY bucket`,
      params
    );
    return rows.map((row) => {
      const checks = Number(row.checks) || 0;
      const good = (Number(row.ok_count) || 0) + (Number(row.slow_count) || 0);
      const bad = (Number(row.bad_count) || 0) + (Number(row.misconfigured_count) || 0);
      const judged = good + bad;
      return {
        bucket: row.bucket,
        checks,
        ok: Number(row.ok_count) || 0,
        slow: Number(row.slow_count) || 0,
        bad: Number(row.bad_count) || 0,
        misconfigured: Number(row.misconfigured_count) || 0,
        unknown: Number(row.unknown_count) || 0,
        // null when nothing was judged in this bucket — a bar that is not drawn,
        // which is a different statement from a bar at zero.
        availability: judged ? good / judged : null,
        avg_value: numOrNull(row.avg_value),
        max_value: numOrNull(row.max_value),
        min_value: numOrNull(row.min_value),
      };
    });
  }

  async function purgeOlderThan(days) {
    const keep = Math.min(Math.max(Number(days) || 90, 1), 3650);
    const [res] = await pool.query(
      'DELETE FROM service_monitor_results WHERE checked_at < DATE_SUB(?, INTERVAL ? DAY)',
      [now(), keep]
    );
    return res.affectedRows || 0;
  }

  return { record, findById, list, summary, series, purgeOlderThan };
}

module.exports = { createMonitorResultsRepository };
