'use strict';

function parseValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

// Data-access for the `app_settings` key/value store (runtime-editable settings).
function createSettingsRepository(db) {
  const { pool } = db;

  async function get(key) {
    const [rows] = await pool.query('SELECT value FROM app_settings WHERE setting_key = ?', [key]);
    return rows[0] ? parseValue(rows[0].value) : null;
  }

  async function set(key, value) {
    await pool.query(
      'INSERT INTO app_settings (setting_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [key, JSON.stringify(value)]
    );
    return value;
  }

  return { get, set };
}

module.exports = { createSettingsRepository };
