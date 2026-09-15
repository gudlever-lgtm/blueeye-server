'use strict';

const { parseJson, intOrNull } = require('./shape');
const { secretFields } = require('../monitors/types');

// Data-access for `service_monitors` (migration 094) — the definition and the
// current state of every non-browser check.
//
// The secrets rule is the credentials table's rule, for the same reason: every
// secret a monitor needs lives in ONE AES-256-GCM blob, `list()` and `findById()`
// never return it, and only `findByIdWithSecrets()` — called by the checker at
// check time — decrypts. There is no code path where an API response, a log line
// or an incident's evidence can pick up an SMTP password by accident.
function createMonitorsRepository({ db, secretBox = null, now = () => new Date() }) {
  const { pool } = db;
  const COLS = `id, tenant_id, application_id, environment_id, name, type, target, description,
    config, secrets_encrypted, interval_sec, warn_ms, crit_ms, enabled, last_run_at, last_status,
    last_summary, last_duration_ms, consecutive_failures, created_by, created_at, updated_at`;

  const encrypt = (obj) => {
    const keys = Object.keys(obj || {});
    if (!keys.length) return null;
    const json = JSON.stringify(obj);
    return secretBox ? secretBox.encrypt(json) : json;
  };

  const decrypt = (blob) => {
    if (!blob) return {};
    let json = blob;
    if (secretBox) {
      // A decrypt failure (a rotated key, a tampered row) yields no secrets
      // rather than a wrong value: the check then reports "misconfigured",
      // which is the honest outcome.
      try { json = secretBox.decrypt(blob); } catch { return {}; }
    }
    try { return JSON.parse(json) || {}; } catch { return {}; }
  };

  // The safe shape: says WHICH secrets are stored, never what they are.
  function shape(row) {
    if (!row) return null;
    const stored = row.secrets_encrypted ? decrypt(row.secrets_encrypted) : {};
    const has = {};
    for (const field of secretFields(row.type)) has[field] = !!stored[field];
    return {
      id: row.id,
      application_id: row.application_id,
      environment_id: row.environment_id,
      name: row.name,
      type: row.type,
      target: row.target,
      description: row.description,
      config: parseJson(row.config, {}),
      has_secrets: has,
      interval_sec: row.interval_sec,
      warn_ms: row.warn_ms,
      crit_ms: row.crit_ms,
      enabled: !!row.enabled,
      last_run_at: row.last_run_at,
      last_status: row.last_status,
      last_summary: row.last_summary,
      last_duration_ms: row.last_duration_ms,
      consecutive_failures: row.consecutive_failures,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_monitors WHERE id = ? LIMIT 1`, [id]);
    return shape(rows[0]);
  }

  // The ONLY path that returns plaintext secrets. Used by the sweep and by the
  // "check now" route, never by a list.
  async function findByIdWithSecrets(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_monitors WHERE id = ? LIMIT 1`, [id]);
    if (!rows[0]) return null;
    return { ...shape(rows[0]), secrets: decrypt(rows[0].secrets_encrypted) };
  }

  async function list({ applicationId = null, type = null, enabled = null, limit = 500 } = {}) {
    const where = [];
    const params = [];
    if (applicationId) { where.push('application_id = ?'); params.push(applicationId); }
    if (type) { where.push('type = ?'); params.push(type); }
    if (enabled !== null && enabled !== undefined) { where.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    const n = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_monitors
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY type, name LIMIT ${n}`,
      params
    );
    return rows.map(shape);
  }

  async function create(input) {
    const [res] = await pool.query(
      `INSERT INTO service_monitors
         (application_id, environment_id, name, type, target, description, config, secrets_encrypted,
          interval_sec, warn_ms, crit_ms, enabled, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        intOrNull(input.application_id),
        intOrNull(input.environment_id),
        input.name,
        input.type,
        input.target,
        input.description ?? null,
        JSON.stringify(input.config || {}),
        encrypt(input.secrets || {}),
        intOrNull(input.interval_sec) || 900,
        intOrNull(input.warn_ms),
        intOrNull(input.crit_ms),
        input.enabled === false ? 0 : 1,
        intOrNull(input.created_by),
      ]
    );
    return findById(res.insertId);
  }

  // `secrets` merges: a field present replaces the stored one, a field set to ''
  // clears it, and an absent field is left alone. That is what lets an operator
  // rename a monitor without re-typing every password.
  async function update(id, patch) {
    const [rows] = await pool.query('SELECT type, config, secrets_encrypted FROM service_monitors WHERE id = ? LIMIT 1', [id]);
    if (!rows[0]) return null;

    const sets = [];
    const params = [];
    const set = (col, value) => { sets.push(`${col} = ?`); params.push(value); };

    if (patch.name !== undefined) set('name', patch.name);
    if (patch.target !== undefined) set('target', patch.target);
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.application_id !== undefined) set('application_id', intOrNull(patch.application_id));
    if (patch.environment_id !== undefined) set('environment_id', intOrNull(patch.environment_id));
    if (patch.interval_sec !== undefined) set('interval_sec', intOrNull(patch.interval_sec) || 900);
    if (patch.warn_ms !== undefined) set('warn_ms', intOrNull(patch.warn_ms));
    if (patch.crit_ms !== undefined) set('crit_ms', intOrNull(patch.crit_ms));
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
    if (patch.config !== undefined) set('config', JSON.stringify(patch.config || {}));

    if (patch.secrets !== undefined) {
      const merged = { ...decrypt(rows[0].secrets_encrypted) };
      for (const [field, value] of Object.entries(patch.secrets || {})) {
        if (value === '' || value === null) delete merged[field];
        else merged[field] = value;
      }
      set('secrets_encrypted', encrypt(merged));
    }
    if (!sets.length) return findById(id);
    params.push(id);
    await pool.query(`UPDATE service_monitors SET ${sets.join(', ')} WHERE id = ?`, params);
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM service_monitors WHERE id = ?', [id]);
    return (res.affectedRows || 0) > 0;
  }

  // The sweep's work list: enabled monitors whose interval has elapsed. A
  // monitor that has never run has a NULL last_run_at and is always due, and the
  // arithmetic is done in SQL so a fleet of monitors is one round trip.
  async function dueForCheck({ limit = 100 } = {}) {
    const at = now();
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_monitors
        WHERE enabled = 1
          AND (last_run_at IS NULL OR last_run_at <= DATE_SUB(?, INTERVAL interval_sec SECOND))
        ORDER BY last_run_at IS NOT NULL, last_run_at ASC
        LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)}`,
      [at]
    );
    return rows.map(shape);
  }

  // Stamps the outcome of one check onto the monitor. The failure streak is kept
  // here rather than counted from history on every sweep — the write already
  // knows the number, and a COUNT per monitor per sweep is a scan paid forever.
  async function recordRun(id, { status, summary = null, durationMs = null, at = null, failed = false }) {
    await pool.query(
      `UPDATE service_monitors
          SET last_run_at = ?, last_status = ?, last_summary = ?, last_duration_ms = ?,
              consecutive_failures = ${failed ? 'consecutive_failures + 1' : '0'}
        WHERE id = ?`,
      [at || now(), String(status || '').slice(0, 24), summary === null ? null : String(summary).slice(0, 512), intOrNull(durationMs), id]
    );
    return findById(id);
  }

  return { list, findById, findByIdWithSecrets, create, update, remove, dueForCheck, recordRun };
}

module.exports = { createMonitorsRepository };
