'use strict';

const COLUMNS = 'id, location_id, metric, warning_value, critical_value, debounce_count, created_at, updated_at';

function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    warning_value: row.warning_value == null ? null : Number(row.warning_value),
    critical_value: row.critical_value == null ? null : Number(row.critical_value),
    debounce_count: Number(row.debounce_count),
  };
}

// Data-access for `incident_thresholds`. Lookup precedence: a location-specific
// row wins over the global default (location_id IS NULL) for the same metric.
function createIncidentThresholdsRepository(db) {
  const { pool } = db;

  // The effective threshold for one (location, metric): the location override if
  // present, else the global default. `location_id IS NULL` sorts last, so a
  // concrete-location row is preferred when both exist.
  async function getEffective(locationId, metric) {
    const [rows] = await pool.query(
      `SELECT ${COLUMNS} FROM incident_thresholds
       WHERE metric = ? AND (location_id = ? OR location_id IS NULL)
       ORDER BY (location_id IS NULL) ASC
       LIMIT 1`,
      [metric, locationId]
    );
    return mapRow(rows[0]) ?? null;
  }

  // All global defaults (location_id IS NULL), ordered by metric.
  async function listGlobal() {
    const [rows] = await pool.query(
      `SELECT ${COLUMNS} FROM incident_thresholds WHERE location_id IS NULL ORDER BY metric`
    );
    return rows.map(mapRow);
  }

  // All overrides stored for one location (does not include the global fallback).
  async function listByLocation(locationId) {
    const [rows] = await pool.query(
      `SELECT ${COLUMNS} FROM incident_thresholds WHERE location_id = ? ORDER BY metric`,
      [locationId]
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM incident_thresholds WHERE id = ?`, [id]);
    return mapRow(rows[0]) ?? null;
  }

  // Inserts or updates the threshold for (location_id, metric). location_id may
  // be null (global). MySQL treats NULL as distinct in a UNIQUE index, so ON
  // DUPLICATE KEY can't catch a duplicate global — we select-then-write instead,
  // which is uniform for both cases.
  async function upsert({ location_id = null, metric, warning_value = null, critical_value = null, debounce_count = 3 }) {
    const [existing] = await pool.query(
      `SELECT id FROM incident_thresholds WHERE metric = ? AND location_id ${location_id == null ? 'IS NULL' : '= ?'}`,
      location_id == null ? [metric] : [metric, location_id]
    );
    if (existing[0]) {
      await pool.query(
        `UPDATE incident_thresholds SET warning_value = ?, critical_value = ?, debounce_count = ? WHERE id = ?`,
        [warning_value, critical_value, debounce_count, existing[0].id]
      );
      return findById(existing[0].id);
    }
    const [res] = await pool.query(
      `INSERT INTO incident_thresholds (location_id, metric, warning_value, critical_value, debounce_count)
       VALUES (?, ?, ?, ?, ?)`,
      [location_id, metric, warning_value, critical_value, debounce_count]
    );
    return findById(res.insertId);
  }

  return { getEffective, listGlobal, listByLocation, findById, upsert };
}

module.exports = { createIncidentThresholdsRepository };
