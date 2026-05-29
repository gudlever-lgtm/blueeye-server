'use strict';

// Selects the full agent record plus the joined location name. LEFT JOIN
// because location_id is nullable (and ON DELETE SET NULL can clear it).
const SELECT_AGENT = `
  SELECT a.id, a.hostname, a.platform, a.arch, a.last_seen, a.status,
         a.location_id, l.name AS location_name,
         a.display_name, a.notes, a.meta, a.created_at, a.updated_at
  FROM agents a
  LEFT JOIN locations l ON l.id = a.location_id`;

// MySQL JSON columns come back already parsed via mysql2, but be defensive in
// case a driver/string slips through.
function parseMeta(meta) {
  if (meta === null || meta === undefined) return null;
  if (typeof meta === 'string') {
    try {
      return JSON.parse(meta);
    } catch {
      return null;
    }
  }
  return meta;
}

function mapRow(row) {
  return {
    id: row.id,
    hostname: row.hostname,
    platform: row.platform,
    arch: row.arch,
    last_seen: row.last_seen,
    status: row.status,
    location_id: row.location_id,
    location_name: row.location_name ?? null,
    display_name: row.display_name,
    notes: row.notes,
    meta: parseMeta(row.meta),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Data-access layer for the `agents` table.
function createAgentsRepository(db) {
  const { pool } = db;

  async function findAll() {
    const [rows] = await pool.query(`${SELECT_AGENT} ORDER BY a.id`);
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(`${SELECT_AGENT} WHERE a.id = ?`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  // Updates ONLY the server-managed fields. Agent-reported fields (hostname,
  // platform, arch, last_seen, status) are never touched here. Returns the
  // refreshed row.
  async function updateManaged(id, { display_name = null, location_id = null, notes = null, meta = null }) {
    await pool.query(
      `UPDATE agents
          SET display_name = ?, location_id = ?, notes = ?, meta = ?
        WHERE id = ?`,
      [display_name, location_id, notes, meta === null ? null : JSON.stringify(meta), id]
    );
    return findById(id);
  }

  async function remove(id) {
    const [result] = await pool.query('DELETE FROM agents WHERE id = ?', [id]);
    return result.affectedRows > 0;
  }

  // Sets the agent-reported status (online/offline) and refreshes last_seen.
  async function setStatus(id, status) {
    await pool.query(
      'UPDATE agents SET status = ?, last_seen = NOW() WHERE id = ?',
      [status, id]
    );
  }

  // Bumps last_seen without changing status (heartbeats / REST traffic).
  async function touchLastSeen(id) {
    await pool.query('UPDATE agents SET last_seen = NOW() WHERE id = ?', [id]);
  }

  return { findAll, findById, updateManaged, remove, setStatus, touchLastSeen };
}

module.exports = { createAgentsRepository };
