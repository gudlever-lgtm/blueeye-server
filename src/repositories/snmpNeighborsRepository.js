'use strict';

// Data-access for `snmp_neighbors` (migration 106) — LLDP as seen BY a switch.
//
// Deliberately NOT `lldp_neighbors` (063): that table keys on an `agents` id and
// these rows belong to an `snmp_devices` id. See the migration for why the two
// are kept apart rather than merged by reusing a nearby column.

const BASE_COLUMNS = `id, device_id, local_port, local_if_index, local_if_name,
  remote_chassis_id, remote_port_id, remote_port_desc, remote_sys_name,
  first_seen, last_seen`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    deviceId: Number(row.device_id),
    localPort: row.local_port == null ? null : Number(row.local_port),
    localIfIndex: row.local_if_index == null ? null : Number(row.local_if_index),
    localIfName: row.local_if_name ?? null,
    remoteChassisId: row.remote_chassis_id,
    remotePortId: row.remote_port_id ?? null,
    remotePortDesc: row.remote_port_desc ?? null,
    remoteSysName: row.remote_sys_name ?? null,
    firstSeen: toIso(row.first_seen),
    lastSeen: toIso(row.last_seen),
  };
}

function createSnmpNeighborsRepository(db) {
  const { pool } = db;

  // The UNIQUE key includes remote_port_id, which is nullable — and MySQL
  // treats NULLs in a unique index as distinct, so a neighbour reporting no
  // port id would accumulate a row per sweep. Coalescing to '' at write time
  // keeps one row per adjacency, which is what the key is for.
  async function upsertMany(deviceId, neighbours, { at = new Date() } = {}) {
    const rows = Array.isArray(neighbours) ? neighbours : [];
    if (!rows.length) return 0;

    const placeholders = [];
    const params = [];
    for (const n of rows) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      params.push(
        deviceId, n.localPort ?? null, n.localIfIndex ?? null, n.localIfName ?? null,
        n.remoteChassisId, n.remotePortId ?? '', n.remotePortDesc ?? null,
        n.remoteSysName ?? null, at, at,
      );
    }
    const [res] = await pool.query(
      `INSERT INTO snmp_neighbors
         (device_id, local_port, local_if_index, local_if_name, remote_chassis_id,
          remote_port_id, remote_port_desc, remote_sys_name, first_seen, last_seen)
       VALUES ${placeholders.join(', ')}
       ON DUPLICATE KEY UPDATE
         local_port       = VALUES(local_port),
         local_if_index   = VALUES(local_if_index),
         local_if_name    = VALUES(local_if_name),
         remote_port_desc = VALUES(remote_port_desc),
         remote_sys_name  = VALUES(remote_sys_name),
         last_seen        = VALUES(last_seen)`,
      params,
    );
    return Number(res.affectedRows || 0);
  }

  async function listForDevice(deviceId, { limit = 500 } = {}) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM snmp_neighbors
        WHERE device_id = ? ORDER BY local_if_name ASC, remote_sys_name ASC LIMIT ?`,
      [deviceId, limit],
    );
    return rows.map(mapRow);
  }

  // Every adjacency, fleet-wide. One read for the topology merge — a read per
  // device would be a query per switch on a screen that already makes a dozen.
  //
  // The cap is a guard rather than a page: a fleet whose switches see more than
  // this has a map nobody can read anyway, and the merge only draws the ends it
  // recognises.
  async function listAll({ limit = 20000 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 200000 ? limit : 20000;
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM snmp_neighbors ORDER BY id ASC LIMIT ?`, [lim],
    );
    return rows.map(mapRow);
  }

  async function purgeBefore(cutoff, { batchSize = 5000 } = {}) {
    let removed = 0;
    for (;;) {
      const [res] = await pool.query(
        'DELETE FROM snmp_neighbors WHERE last_seen < ? ORDER BY last_seen LIMIT ?',
        [cutoff, batchSize],
      );
      const n = Number(res.affectedRows || 0);
      removed += n;
      if (n < batchSize) break;
    }
    return removed;
  }

  return { upsertMany, listForDevice, listAll, purgeBefore };
}

module.exports = { createSnmpNeighborsRepository, mapRow };
