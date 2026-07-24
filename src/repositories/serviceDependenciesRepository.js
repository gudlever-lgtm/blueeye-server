'use strict';

// Data-access for `service_dependencies` (migration 066) — the 'service_dep'
// edges of the unified topology graph. Pure data-access; the aggregation (flow
// rows -> edges), host resolution and Top-N truncation live in
// src/topology/serviceDependencyAggregator.js, and the graph merge with the
// LLDP 'l2_link' edges lives in src/topology/graph.js.

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    srcHostId: Number(row.src_host_id),
    dstHostId: Number(row.dst_host_id),
    dstPort: Number(row.dst_port),
    proto: row.proto ?? null,
    bytes: num(row.bytes),
    packets: num(row.packets),
    connCount: num(row.conn_count),
    firstSeen: toIso(row.first_seen),
    lastSeen: toIso(row.last_seen),
  };
}

const COLS =
  'id, src_host_id, dst_host_id, dst_port, proto, bytes, packets, conn_count, first_seen, last_seen';

function createServiceDependenciesRepository(db) {
  const { pool } = db;

  // Upserts one aggregated edge. The scheduled job recomputes the FULL rolling
  // window each run, so the volume columns are REPLACED (not summed) on
  // collision; last_seen advances and first_seen keeps the earliest observation
  // (bounded by the rolling window / age-out).
  async function upsert({ srcHostId, dstHostId, dstPort, proto = 'tcp', bytes = 0, packets = 0, connCount = 0, firstSeen, lastSeen }) {
    const first = firstSeen || lastSeen || new Date();
    const last = lastSeen || firstSeen || new Date();
    const [res] = await pool.query(
      `INSERT INTO service_dependencies
         (src_host_id, dst_host_id, dst_port, proto, bytes, packets, conn_count, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         proto = VALUES(proto),
         bytes = VALUES(bytes),
         packets = VALUES(packets),
         conn_count = VALUES(conn_count),
         last_seen = VALUES(last_seen),
         first_seen = LEAST(first_seen, VALUES(first_seen))`,
      [srcHostId, dstHostId, dstPort, proto, bytes, packets, connCount, first, last],
    );
    return res;
  }

  // Upserts a batch of edges (one job run's recomputed aggregate). Skips rows
  // missing a required key. Returns the number upserted.
  async function upsertMany(edges) {
    let n = 0;
    for (const e of Array.isArray(edges) ? edges : []) {
      if (e == null || e.srcHostId == null || e.dstHostId == null || e.dstPort == null) continue;
      await upsert(e); // eslint-disable-line no-await-in-loop
      n += 1;
    }
    return n;
  }

  // Deletes edges not seen since `olderThan` (rolling-window age-out).
  async function ageOut(olderThan) {
    const [res] = await pool.query('DELETE FROM service_dependencies WHERE last_seen < ?', [olderThan]);
    return res.affectedRows || 0;
  }

  // Every edge (graph-build input), bounded so a build can never scan unbounded.
  async function listAll({ limit = 100000 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500000 ? limit : 100000;
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_dependencies ORDER BY bytes DESC LIMIT ?`,
      [lim],
    );
    return rows.map(mapRow);
  }

  // Edges touching one host (as source or destination), heaviest first. Backs
  // GET /api/topology/dependencies?host=<id>. limit defaults to the Top-N.
  async function listForHost({ hostId, direction = 'both', limit = 50, offset = 0 }) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 1000 ? limit : 50;
    const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    let where;
    let params;
    if (direction === 'out') { where = 'src_host_id = ?'; params = [hostId]; }
    else if (direction === 'in') { where = 'dst_host_id = ?'; params = [hostId]; }
    else { where = '(src_host_id = ? OR dst_host_id = ?)'; params = [hostId, hostId]; }
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_dependencies WHERE ${where} ORDER BY bytes DESC, id ASC LIMIT ? OFFSET ?`,
      [...params, lim, off],
    );
    return rows.map(mapRow);
  }

  async function countForHost({ hostId, direction = 'both' }) {
    let where;
    let params;
    if (direction === 'out') { where = 'src_host_id = ?'; params = [hostId]; }
    else if (direction === 'in') { where = 'dst_host_id = ?'; params = [hostId]; }
    else { where = '(src_host_id = ? OR dst_host_id = ?)'; params = [hostId, hostId]; }
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM service_dependencies WHERE ${where}`,
      params,
    );
    return rows && rows[0] ? Number(rows[0].n) : 0;
  }

  return { upsert, upsertMany, ageOut, listAll, listForHost, countForHost };
}

module.exports = { createServiceDependenciesRepository, mapRow };
