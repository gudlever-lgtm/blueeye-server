'use strict';

// Data-access for `report_schedules` (migration 100) — the recurring sends of
// the availability and probe-outage reports. JSON columns are parsed on read;
// mysql2 may return them already parsed depending on driver settings, so
// parseJson tolerates both (same shape as testPackagesRepository).

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function rowToSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    report: row.report,
    format: row.format,
    window_days: Number(row.window_days) || 7,
    params: parseJson(row.params) || {},
    schedule_spec: parseJson(row.schedule_spec),
    recipients: parseJson(row.recipients) || [],
    enabled: !!row.enabled,
    created_by: row.created_by != null ? String(row.created_by) : null,
    last_run_at: row.last_run_at,
    last_run_status: row.last_run_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const COLS =
  'id, name, report, format, window_days, params, schedule_spec, recipients, enabled, created_by, '
  + 'last_run_at, last_run_status, created_at, updated_at';

function createReportSchedulesRepository(db) {
  const { pool } = db;

  async function findAll() {
    const [rows] = await pool.query(`SELECT ${COLS} FROM report_schedules ORDER BY id DESC`);
    return rows.map(rowToSchedule);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM report_schedules WHERE id = ?`, [id]);
    return rowToSchedule(rows[0]);
  }

  // The only ones the scheduler ticks.
  async function findEnabled() {
    const [rows] = await pool.query(`SELECT ${COLS} FROM report_schedules WHERE enabled = 1`);
    return rows.map(rowToSchedule);
  }

  async function create({ name, report, format = 'csv', window_days = 7, params = {}, schedule_spec, recipients, enabled = true, created_by = null }) {
    const [result] = await pool.query(
      `INSERT INTO report_schedules (name, report, format, window_days, params, schedule_spec, recipients, enabled, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, report, format, window_days, JSON.stringify(params || {}), JSON.stringify(schedule_spec),
        JSON.stringify(recipients || []), enabled ? 1 : 0, created_by]
    );
    return findById(result.insertId);
  }

  async function update(id, { name, report, format, window_days, params, schedule_spec, recipients, enabled }) {
    await pool.query(
      `UPDATE report_schedules
       SET name = ?, report = ?, format = ?, window_days = ?, params = ?, schedule_spec = ?, recipients = ?, enabled = ?
       WHERE id = ?`,
      [name, report, format, window_days, JSON.stringify(params || {}), JSON.stringify(schedule_spec),
        JSON.stringify(recipients || []), enabled ? 1 : 0, id]
    );
    return findById(id);
  }

  async function remove(id) {
    const [result] = await pool.query('DELETE FROM report_schedules WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  // What happened last time, in words, kept where the screen that created the
  // schedule can show it. A send that has been failing for three weeks must not
  // look healthy just because nothing threw where anybody could see.
  async function setLastRun(id, status) {
    await pool.query('UPDATE report_schedules SET last_run_at = NOW(), last_run_status = ? WHERE id = ?', [
      String(status).slice(0, 255),
      id,
    ]);
  }

  return { findAll, findById, findEnabled, create, update, remove, setLastRun };
}

module.exports = { createReportSchedulesRepository, rowToSchedule };
