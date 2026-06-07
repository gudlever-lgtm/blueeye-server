'use strict';

// Selects the full agent record plus the joined location name. LEFT JOIN
// because location_id is nullable (and ON DELETE SET NULL can clear it).
const SELECT_AGENT = `
  SELECT a.id, a.hostname, a.platform, a.arch, a.last_seen, a.status, a.capabilities,
         a.location_id, l.name AS location_name,
         a.display_name, a.notes, a.meta, a.monitor_config, a.created_at, a.updated_at,
         (SELECT MAX(r.created_at) FROM results r WHERE r.agent_id = a.id) AS last_report_at
  FROM agents a
  LEFT JOIN locations l ON l.id = a.location_id`;

// MySQL JSON columns come back already parsed via mysql2, but be defensive in
// case a driver/string slips through.
function parseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function mapRow(row) {
  return {
    id: row.id,
    hostname: row.hostname,
    platform: row.platform,
    arch: row.arch,
    last_seen: row.last_seen,
    last_report_at: row.last_report_at ?? null,
    status: row.status,
    capabilities: parseJson(row.capabilities),
    location_id: row.location_id,
    location_name: row.location_name ?? null,
    display_name: row.display_name,
    notes: row.notes,
    meta: parseJson(row.meta),
    monitor_config: parseJson(row.monitor_config),
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

  // Total registered agents — used by the usage service for plan-limit checks
  // (cheaper than findAll() when all we need is the count).
  async function count() {
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM agents');
    return Number(rows[0] && rows[0].n) || 0;
  }

  // Agents as internal map hosts: { hostId, siteName, lat, lng, status }. Site
  // coordinates come from the joined location (manually set; nullable). This is
  // host/site metadata — never GeoIP. Optionally filtered to one host.
  async function findForGeo(hostId = null) {
    const where = [];
    const params = [];
    if (hostId) { where.push('a.id = ?'); params.push(hostId); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT a.id AS hostId, a.status, l.name AS siteName, l.latitude AS lat, l.longitude AS lng
       FROM agents a LEFT JOIN locations l ON l.id = a.location_id
       ${clause} ORDER BY a.id`,
      params
    );
    return rows.map((r) => ({
      hostId: r.hostId,
      siteName: r.siteName ?? null,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
      status: r.status,
    }));
  }

  // Updates ONLY the server-managed fields. Agent-reported fields (hostname,
  // platform, arch, last_seen, status, capabilities) are never touched here.
  // Returns the refreshed row.
  async function updateManaged(
    id,
    { display_name = null, location_id = null, notes = null, meta = null, monitor_config = null }
  ) {
    await pool.query(
      `UPDATE agents
          SET display_name = ?, location_id = ?, notes = ?, meta = ?, monitor_config = ?
        WHERE id = ?`,
      [
        display_name,
        location_id,
        notes,
        meta === null ? null : JSON.stringify(meta),
        monitor_config === null ? null : JSON.stringify(monitor_config),
        id,
      ]
    );
    return findById(id);
  }

  // Stores agent-reported capabilities (what the agent can do).
  async function setCapabilities(id, capabilities) {
    await pool.query('UPDATE agents SET capabilities = ? WHERE id = ?', [
      capabilities === null ? null : JSON.stringify(capabilities),
      id,
    ]);
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

  return {
    findAll,
    findById,
    count,
    findForGeo,
    updateManaged,
    setCapabilities,
    remove,
    setStatus,
    touchLastSeen,
  };
}

module.exports = { createAgentsRepository };
