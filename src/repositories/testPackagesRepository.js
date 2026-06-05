'use strict';

// Data-access for `test_packages` — server-defined sets of probe/traffic tests
// pushed to agents to run (see docs + src/services/testPackageRunner.js). JSON
// columns (targets/items/last_run_summary) are parsed on read; mysql2 may return
// them already-parsed depending on driver settings, so parseJson tolerates both.

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function rowToPackage(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    schedule_ms: Number(row.schedule_ms) || 0,
    targets: parseJson(row.targets) || { mode: 'all', agentIds: [], locationIds: [] },
    items: parseJson(row.items) || [],
    created_by: row.created_by != null ? String(row.created_by) : null,
    last_run_at: row.last_run_at,
    last_run_summary: parseJson(row.last_run_summary),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const COLS =
  'id, name, enabled, schedule_ms, targets, items, created_by, last_run_at, last_run_summary, created_at, updated_at';

function createTestPackagesRepository(db) {
  const { pool } = db;

  async function findAll() {
    const [rows] = await pool.query(`SELECT ${COLS} FROM test_packages ORDER BY id DESC`);
    return rows.map(rowToPackage);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM test_packages WHERE id = ?`, [id]);
    return rowToPackage(rows[0]);
  }

  // Enabled packages that have a real schedule — the only ones the scheduler ticks.
  async function findEnabledScheduled() {
    const [rows] = await pool.query(`SELECT ${COLS} FROM test_packages WHERE enabled = 1 AND schedule_ms > 0`);
    return rows.map(rowToPackage);
  }

  async function create({ name, enabled = true, schedule_ms = 0, targets, items, created_by = null }) {
    const [result] = await pool.query(
      `INSERT INTO test_packages (name, enabled, schedule_ms, targets, items, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, enabled ? 1 : 0, schedule_ms, JSON.stringify(targets), JSON.stringify(items), created_by]
    );
    return findById(result.insertId);
  }

  async function update(id, { name, enabled, schedule_ms, targets, items }) {
    await pool.query(
      `UPDATE test_packages
       SET name = ?, enabled = ?, schedule_ms = ?, targets = ?, items = ?
       WHERE id = ?`,
      [name, enabled ? 1 : 0, schedule_ms, JSON.stringify(targets), JSON.stringify(items), id]
    );
    return findById(id);
  }

  async function remove(id) {
    const [result] = await pool.query('DELETE FROM test_packages WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  async function setLastRun(id, summary) {
    await pool.query('UPDATE test_packages SET last_run_at = NOW(), last_run_summary = ? WHERE id = ?', [
      JSON.stringify(summary),
      id,
    ]);
  }

  return { findAll, findById, findEnabledScheduled, create, update, remove, setLastRun };
}

module.exports = { createTestPackagesRepository, rowToPackage };
