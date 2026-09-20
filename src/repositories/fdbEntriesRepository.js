'use strict';

// Data-access for `fdb_entries` (migration 105) — which switch port a MAC is on.
//
// This is the second identity source, beside `arp_entries`. ARP answers
// "what holds this IP"; this answers "where is this MAC plugged in". Universal
// search reads both, and both carry provenance and an age, so a three-week-old
// answer is visibly stale rather than confidently wrong.

const BASE_COLUMNS = `id, device_id, mac, vlan, bridge_port, prev_bridge_port,
  move_count, last_move_at, if_index, if_name,
  status, port_mac_count, first_seen, last_seen`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    deviceId: Number(row.device_id),
    mac: row.mac,
    // 0 means the device reported no VLAN (BRIDGE-MIB only), never a real id.
    vlan: Number(row.vlan),
    bridgePort: Number(row.bridge_port),
    // Where it was before, how many times it has moved, and when last. A MAC
    // bouncing between two ports is the signature of a forwarding loop, and
    // before migration 111 the upsert overwrote the evidence every sweep.
    prevBridgePort: row.prev_bridge_port == null ? null : Number(row.prev_bridge_port),
    moveCount: row.move_count == null ? 0 : Number(row.move_count),
    lastMoveAt: toIso(row.last_move_at),
    ifIndex: row.if_index == null ? null : Number(row.if_index),
    ifName: row.if_name ?? null,
    status: row.status,
    portMacCount: Number(row.port_mac_count),
    firstSeen: toIso(row.first_seen),
    lastSeen: toIso(row.last_seen),
    // Joined columns, present only on the reads that ask for them.
    deviceName: row.device_name ?? undefined,
    deviceHost: row.device_host ?? undefined,
  };
}

function createFdbEntriesRepository(db) {
  const { pool } = db;

  // Upserts one sweep's entries for one device.
  //
  // NOT a wholesale replace, for the same reason arp_entries is not: a report
  // is capped (a big chassis runs to tens of thousands of rows) and deleting
  // what it did not mention would throw away perfectly good entries that simply
  // did not fit. Rows age out on last_seen instead — see purgeBefore.
  //
  // A MAC that MOVED to a different port rewrites bridge_port/if_name in place
  // and bumps last_seen. There is no history table: a forwarding entry ages out
  // of the switch itself in minutes, so "where was this MAC three weeks ago" is
  // a question this data cannot honestly answer.
  async function upsertMany(deviceId, entries, { at = new Date() } = {}) {
    const rows = Array.isArray(entries) ? entries : [];
    if (!rows.length) return 0;

    const placeholders = [];
    const params = [];
    for (const e of rows) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      params.push(
        deviceId, e.mac, e.vlan ?? 0, e.bridgePort,
        e.ifIndex ?? null, e.ifName ?? null,
        e.status || 'learned', e.portMacCount ?? 1, at, at, at,
      );
    }

    // THE MOVE IS RECORDED IN THE UPSERT ITSELF. Doing it in SQL rather than
    // reading the rows first keeps the sweep one statement — a big chassis is
    // five thousand rows, and a read-compare-write per MAC would turn one
    // round trip into ten thousand.
    //
    // The CASE is the whole of it: bridge_port changing is a move; everything
    // else is the same MAC on the same port and must leave the counters alone.
    // `last_move_at` is COALESCEd so a sweep where nothing moved does not erase
    // the time of the move before it.
    const [res] = await pool.query(
      `INSERT INTO fdb_entries
         (device_id, mac, vlan, bridge_port, if_index, if_name, status,
          port_mac_count, first_seen, last_seen, last_move_at)
       VALUES ${placeholders.join(', ')}
       ON DUPLICATE KEY UPDATE
         prev_bridge_port = IF(bridge_port <> VALUES(bridge_port), bridge_port, prev_bridge_port),
         move_count       = move_count + IF(bridge_port <> VALUES(bridge_port), 1, 0),
         last_move_at     = IF(bridge_port <> VALUES(bridge_port), VALUES(last_move_at), last_move_at),
         bridge_port      = VALUES(bridge_port),
         if_index         = VALUES(if_index),
         if_name          = VALUES(if_name),
         status           = VALUES(status),
         port_mac_count   = VALUES(port_mac_count),
         last_seen        = VALUES(last_seen)`,
      params,
    );
    return Number(res.affectedRows || 0);
  }

  // "Where is this MAC?" — the search path. Joined to the device so a hit can
  // name the switch without a second query, and ordered freshest first because
  // a MAC that moved has two rows and the recent one is the answer.
  async function findByMac(mac, { limit = 25 } = {}) {
    const [rows] = await pool.query(
      `SELECT f.id, f.device_id, f.mac, f.vlan, f.bridge_port, f.if_index, f.if_name,
              f.status, f.port_mac_count, f.first_seen, f.last_seen,
              d.display_name AS device_name, d.host AS device_host
         FROM fdb_entries f
         JOIN snmp_devices d ON d.id = f.device_id
        WHERE f.mac = ?
        ORDER BY f.last_seen DESC
        LIMIT ?`,
      [mac, limit],
    );
    return rows.map(mapRow);
  }

  // Everything on one device, for the per-switch port table.
  async function listForDevice(deviceId, { limit = 500, ifName = null } = {}) {
    const where = ['device_id = ?'];
    const params = [deviceId];
    if (ifName) { where.push('if_name = ?'); params.push(ifName); }
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM fdb_entries
        WHERE ${where.join(' AND ')}
        ORDER BY port_mac_count ASC, bridge_port ASC, mac ASC
        LIMIT ?`,
      [...params, limit],
    );
    return rows.map(mapRow);
  }

  // What is on one port. The question that follows "where is this MAC" when the
  // answer turns out to be an uplink.
  async function listForPort(deviceId, bridgePort, { limit = 200 } = {}) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM fdb_entries
        WHERE device_id = ? AND bridge_port = ?
        ORDER BY last_seen DESC LIMIT ?`,
      [deviceId, bridgePort, limit],
    );
    return rows.map(mapRow);
  }

  // The MACs on one device that have moved recently. The ONLY query the loop
  // detector makes against this table: a count and the two ports, never a
  // history.
  async function movingMacs(deviceId, { since, limit = 500 } = {}) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM fdb_entries
        WHERE device_id = ? AND last_move_at IS NOT NULL AND last_move_at >= ?
        ORDER BY move_count DESC, last_move_at DESC
        LIMIT ?`,
      [deviceId, since, limit],
    );
    return rows.map(mapRow);
  }

  // The first row inserted for a device has no move to record; this makes the
  // insert-time defaults explicit for a caller that wants them.
  async function countForDevice(deviceId) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM fdb_entries WHERE device_id = ?', [deviceId],
    );
    return Number((rows[0] && rows[0].n) || 0);
  }

  // Ages out entries not re-observed within the window. Deleting one costs a
  // search hit that was already stale; the binding is re-learned on the next
  // sweep. Batched so a long-neglected table does not lock the ingest out.
  async function purgeBefore(cutoff, { batchSize = 5000 } = {}) {
    let removed = 0;
    for (;;) {
      const [res] = await pool.query(
        'DELETE FROM fdb_entries WHERE last_seen < ? ORDER BY last_seen LIMIT ?',
        [cutoff, batchSize],
      );
      const n = Number(res.affectedRows || 0);
      removed += n;
      if (n < batchSize) break;
    }
    return removed;
  }

  return {
    upsertMany,
    findByMac,
    listForDevice,
    listForPort,
    movingMacs,
    countForDevice,
    purgeBefore,
  };
}

module.exports = { createFdbEntriesRepository, mapRow };
