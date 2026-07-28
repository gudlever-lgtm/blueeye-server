'use strict';

// Data-access for `discovered_devices` (migration 069) — active-discovery
// candidates. Pure data-access; the scan engine + promotion logic live in
// src/discovery/.

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    ip: row.ip,
    hostname: row.hostname ?? null,
    openPorts: row.open_ports ? String(row.open_ports).split(',').map(Number).filter((n) => Number.isInteger(n)) : [],
    icmp: !!row.icmp,
    status: row.status,
    promotedAgentId: row.promoted_agent_id == null ? null : Number(row.promoted_agent_id),
    foundByAgentId: row.found_by_agent_id == null ? null : Number(row.found_by_agent_id),
    firstSeen: toIso(row.first_seen),
    lastSeen: toIso(row.last_seen),
  };
}

const COLS = 'id, ip, hostname, open_ports, icmp, found_by_agent_id, status, promoted_agent_id, first_seen, last_seen';

function createDiscoveredDevicesRepository(db) {
  const { pool } = db;

  // Upsert a candidate observed by a sweep. Re-observing an existing IP refreshes
  // hostname/ports/icmp/last_seen but NEVER changes status (an ignored or promoted
  // device stays ignored/promoted — a later sweep must not resurrect it).
  async function upsertCandidate({ ip, hostname = null, openPorts = [], icmp = false, seenAt = null, foundByAgentId = null }) {
    const seen = seenAt || new Date();
    const ports = Array.isArray(openPorts) ? openPorts.join(',') : (openPorts || '');
    const finder = Number.isInteger(Number(foundByAgentId)) && Number(foundByAgentId) > 0 ? Number(foundByAgentId) : null;
    const [res] = await pool.query(
      `INSERT INTO discovered_devices (ip, hostname, open_ports, icmp, found_by_agent_id, status, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, 'discovered', ?, ?)
       ON DUPLICATE KEY UPDATE hostname = VALUES(hostname), open_ports = VALUES(open_ports), icmp = VALUES(icmp),
         found_by_agent_id = COALESCE(VALUES(found_by_agent_id), found_by_agent_id), last_seen = VALUES(last_seen)`,
      [ip, hostname, ports, icmp ? 1 : 0, finder, seen, seen],
    );
    return res;
  }

  async function list({ status = null, limit = 200, offset = 0 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 2000 ? limit : 200;
    const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status, lim, off] : [lim, off];
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM discovered_devices ${where} ORDER BY last_seen DESC, id DESC LIMIT ? OFFSET ?`,
      params,
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM discovered_devices WHERE id = ?`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async function setStatus(id, status, { promotedAgentId = null } = {}) {
    const [res] = await pool.query(
      'UPDATE discovered_devices SET status = ?, promoted_agent_id = ? WHERE id = ?',
      [status, promotedAgentId, id],
    );
    return res.affectedRows || 0;
  }

  // IP-or-hostname lookup for the universal search field. Exact on the IP,
  // prefix/substring on the reverse-DNS name — the same matching rule the agent
  // and site resolvers use, so one search behaves consistently across sources.
  //
  // `ignored` candidates are excluded: an operator has explicitly said this is
  // not a device they care about, and resurfacing it in every search would undo
  // that decision one result row at a time.
  async function search({ q, limit = 10 } = {}) {
    const needle = String(q == null ? '' : q).trim();
    if (!needle) return [];
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 10;
    // ESCAPE '\\' so a literal % or _ in the query is matched as itself rather
    // than as a wildcard.
    const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM discovered_devices
        WHERE status <> 'ignored' AND (ip = ? OR hostname LIKE ? ESCAPE '\\')
        ORDER BY (ip = ?) DESC, last_seen DESC, id DESC
        LIMIT ?`,
      [needle, like, needle, lim],
    );
    return rows.map(mapRow);
  }

  async function countByStatus() {
    const [rows] = await pool.query('SELECT status, COUNT(*) AS n FROM discovered_devices GROUP BY status');
    const out = { discovered: 0, promoted: 0, ignored: 0 };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  return { upsertCandidate, list, search, findById, setStatus, countByStatus };
}

module.exports = { createDiscoveredDevicesRepository, mapRow };
