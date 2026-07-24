'use strict';

// Data-access for `lldp_neighbors` (migration 063). Pure data-access; the graph
// build + adjacency queries live in src/topology/lldpGraph.js and the cached
// service in src/topology/lldpGraphService.js.

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    localAgentId: Number(row.local_agent_id),
    localChassisId: row.local_chassis_id ?? null,
    localPort: row.local_port ?? null,
    remoteChassisId: row.remote_chassis_id,
    remotePort: row.remote_port ?? null,
    linkState: row.link_state ?? null,
    lastSeen: toIso(row.last_seen),
  };
}

const COLS = 'id, local_agent_id, local_chassis_id, local_port, remote_chassis_id, remote_port, link_state, last_seen';

function createLldpNeighborsRepository(db) {
  const { pool } = db;

  // Upserts one observed adjacency, bumping last_seen (+ refreshing the local
  // chassis) when the edge already exists. `lastSeen` defaults to now.
  async function upsert({ localAgentId, localChassisId = null, localPort = null, remoteChassisId, remotePort = null, linkState = null, lastSeen = null }) {
    const seen = lastSeen || new Date();
    const [res] = await pool.query(
      `INSERT INTO lldp_neighbors
         (local_agent_id, local_chassis_id, local_port, remote_chassis_id, remote_port, link_state, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_seen = VALUES(last_seen), local_chassis_id = VALUES(local_chassis_id), link_state = VALUES(link_state)`,
      [localAgentId, localChassisId, localPort, remoteChassisId, remotePort, linkState, seen],
    );
    return res;
  }

  // Upserts a batch of neighbors reported by one agent in a single collection
  // cycle. Skips malformed entries (a remote chassis id is required). Returns the
  // number of edges upserted.
  async function upsertMany(localAgentId, neighbors, { localChassisId = null, lastSeen = null } = {}) {
    let n = 0;
    for (const nb of Array.isArray(neighbors) ? neighbors : []) {
      const remoteChassisId = nb && (nb.remoteChassisId ?? nb.remote_chassis_id);
      if (!remoteChassisId) continue;
      await upsert({ // eslint-disable-line no-await-in-loop
        localAgentId,
        localChassisId: nb.localChassisId ?? nb.local_chassis_id ?? localChassisId ?? null,
        localPort: nb.localPort ?? nb.local_port ?? null,
        remoteChassisId,
        remotePort: nb.remotePort ?? nb.remote_port ?? null,
        linkState: nb.linkState ?? nb.link_state ?? null,
        lastSeen,
      });
      n += 1;
    }
    return n;
  }

  // Deletes rows not seen since `olderThan`. Returns the number aged out.
  async function ageOut(olderThan) {
    const [res] = await pool.query('DELETE FROM lldp_neighbors WHERE last_seen < ?', [olderThan]);
    return res.affectedRows || 0;
  }

  // Every fresh row (optionally only those seen since `since`) — the graph build
  // input. Bounded so a build can never scan an unbounded table.
  async function listAll({ since = null, limit = 100000 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500000 ? limit : 100000;
    const where = since ? 'WHERE last_seen >= ?' : '';
    const params = since ? [since, lim] : [lim];
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM lldp_neighbors ${where} ORDER BY id ASC LIMIT ?`,
      params,
    );
    return rows.map(mapRow);
  }

  // Filtered, paginated list for the API. `targetAgentId` matches either the
  // reporting agent OR (via its chassis) the neighbor side, so "neighbors of X"
  // returns both directions.
  function listFilter(targetAgentId) {
    if (targetAgentId == null) return { clause: '', params: [] };
    // A subquery resolves the target's own chassis id(s) so remote-side matches work.
    return {
      clause: `WHERE local_agent_id = ?
               OR remote_chassis_id IN (SELECT local_chassis_id FROM lldp_neighbors
                                        WHERE local_agent_id = ? AND local_chassis_id IS NOT NULL)`,
      params: [targetAgentId, targetAgentId],
    };
  }

  async function list({ targetAgentId = null, limit = 50, offset = 0 } = {}) {
    const { clause, params } = listFilter(targetAgentId);
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 50;
    const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM lldp_neighbors ${clause} ORDER BY last_seen DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, lim, off],
    );
    return rows.map(mapRow);
  }

  async function count({ targetAgentId = null } = {}) {
    const { clause, params } = listFilter(targetAgentId);
    const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM lldp_neighbors ${clause}`, params);
    return Number(rows[0] ? rows[0].n : 0);
  }

  // The reporting agent's OWN current neighbour rows — the "previous snapshot" a
  // poll cycle is diffed against for change detection. Ordered for stable diffs.
  async function listByAgent(localAgentId) {
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM lldp_neighbors WHERE local_agent_id = ? ORDER BY id ASC`,
      [localAgentId],
    );
    return rows.map(mapRow);
  }

  // Deletes one specific edge (used to reconcile a removed/moved neighbour so it
  // is not re-emitted as a change on the next poll). NULL-safe on port fields.
  async function deleteEdge({ localAgentId, localPort = null, remoteChassisId, remotePort = null }) {
    const [res] = await pool.query(
      `DELETE FROM lldp_neighbors
       WHERE local_agent_id = ?
         AND (local_port <=> ?) AND remote_chassis_id = ? AND (remote_port <=> ?)`,
      [localAgentId, localPort, remoteChassisId, remotePort],
    );
    return res.affectedRows || 0;
  }

  return { upsert, upsertMany, ageOut, listAll, list, count, listByAgent, deleteEdge };
}

module.exports = { createLldpNeighborsRepository, mapRow, COLS };
