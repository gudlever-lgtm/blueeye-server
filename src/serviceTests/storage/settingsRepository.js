'use strict';

// Data-access for `service_test_settings` — the module's key/JSON override store
// (migration 078). Mirrors the shape of BlueEye's own settingsRepository but
// lives inside the module, so extraction takes its settings with it rather than
// leaving a stray key behind in `app_settings`.
function createServiceTestSettingsRepository({ db }) {
  const { pool } = db;

  function parseValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return null; }
    }
    return value;
  }

  async function get(key) {
    const [rows] = await pool.query('SELECT value FROM service_test_settings WHERE setting_key = ?', [key]);
    return rows[0] ? parseValue(rows[0].value) : null;
  }

  // Every stored override at once, as { section: value } — one query, so the
  // settings service can answer a "show me everything" read without N round trips.
  async function getAll() {
    const [rows] = await pool.query('SELECT setting_key, value FROM service_test_settings');
    const out = {};
    for (const r of rows) out[r.setting_key] = parseValue(r.value);
    return out;
  }

  async function set(key, value, updatedBy = null) {
    await pool.query(
      `INSERT INTO service_test_settings (setting_key, value, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
      [key, JSON.stringify(value), updatedBy]
    );
    return value;
  }

  return { get, getAll, set };
}

module.exports = { createServiceTestSettingsRepository };
