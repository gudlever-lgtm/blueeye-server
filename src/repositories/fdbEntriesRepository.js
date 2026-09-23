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
const PREFIXED_COLUMNS = BASE_COLUMNS.split(',').map((c) => `f.${c.trim()}`).join(', ');

// `last_move_at` is a DATETIME without fractions, and the sweep's own rows are
// found again by comparing against it — so the sweep's timestamp is cut to the
// whole second BEFORE it is written. A Date with milliseconds would be rounded
// by MySQL on the way in and then never compare equal on the way out.
function wholeSecond(at) {
  const d = at instanceof Date ? at : new Date(at);
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

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
    // How many times it moved INSIDE the window the caller asked about —
    // present only on movingMacs(). Deliberately not `moveCount`, which is the
    // all-time figure and was once read as this one (see migration 117).
    movesInWindow: row.moves_in_window == null ? undefined : Number(row.moves_in_window),
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
    const sweepAt = wholeSecond(at);

    const placeholders = [];
    const params = [];
    for (const e of rows) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      params.push(
        deviceId, e.mac, e.vlan ?? 0, e.bridgePort,
        e.ifIndex ?? null, e.ifName ?? null,
        e.status || 'learned', e.portMacCount ?? 1, at, at, sweepAt,
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

    // THE MOVES THIS SWEEP SAW, kept (migration 117). The rows that moved are
    // exactly the ones whose last_move_at is this sweep AND that have moved at
    // least once — a MAC seen for the first time also carries this sweep's
    // time in last_move_at, but with move_count 0, and a first sighting is not
    // a move. One INSERT … SELECT, so the sweep stays two statements however
    // many MACs moved.
    await pool.query(
      `INSERT INTO fdb_mac_moves (device_id, mac, vlan, from_port, to_port, moved_at)
       SELECT device_id, mac, vlan, prev_bridge_port, bridge_port, last_move_at
         FROM fdb_entries
        WHERE device_id = ? AND last_move_at = ? AND move_count > 0`,
      [deviceId, sweepAt],
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

  // The MACs on one device that moved inside the window, each with HOW MANY
  // TIMES it moved in that window (`movesInWindow`). The only query the loop
  // detector makes against this table.
  //
  // Counted from fdb_mac_moves rather than read off move_count: move_count is
  // all-time and reset by nothing, so a MAC re-docked forty times over a month
  // would otherwise count as forty moves in ten minutes (migration 117).
  async function movingMacs(deviceId, { since, limit = 500 } = {}) {
    const [rows] = await pool.query(
      `SELECT ${PREFIXED_COLUMNS}, COUNT(m.id) AS moves_in_window
         FROM fdb_entries f
         JOIN fdb_mac_moves m
           ON m.device_id = f.device_id AND m.vlan = f.vlan AND m.mac = f.mac AND m.moved_at >= ?
        WHERE f.device_id = ?
        GROUP BY f.id
        ORDER BY moves_in_window DESC, f.last_move_at DESC
        LIMIT ?`,
      [since, deviceId, limit],
    );
    return rows.map(mapRow);
  }

  // The recorded moves are history with their own, SHORT retention: they answer
  // a question about the last few minutes and exist for nothing else.
  async function purgeMovesBefore(cutoff, { batchSize = 5000 } = {}) {
    let removed = 0;
    for (;;) {
      const [res] = await pool.query(
        'DELETE FROM fdb_mac_moves WHERE moved_at < ? ORDER BY moved_at LIMIT ?',
        [cutoff, batchSize],
      );
      const n = Number(res.affectedRows || 0);
      removed += n;
      if (n < batchSize) break;
    }
    return removed;
  }

  // VLAN names off Q-BRIDGE (migration 117). Upserted per sweep and aged out on
  // last_seen with the forwarding table, so a VLAN removed from the switch
  // simply stops being refreshed. Not a replace: a sweep whose VLAN walk came
  // back empty (the table is optional on plenty of switches) must not erase
  // names an earlier sweep read.
  async function upsertVlans(deviceId, vlans, { at = new Date() } = {}) {
    const rows = (Array.isArray(vlans) ? vlans : []).filter((v) => v && Number.isInteger(v.vlan) && v.name);
    if (!rows.length) return 0;
    const placeholders = [];
    const params = [];
    for (const v of rows) {
      placeholders.push('(?, ?, ?, ?, ?)');
      params.push(deviceId, v.vlan, String(v.name).slice(0, 64), at, at);
    }
    const [res] = await pool.query(
      `INSERT INTO device_vlans (device_id, vlan, name, first_seen, last_seen)
       VALUES ${placeholders.join(', ')}
       ON DUPLICATE KEY UPDATE
         name      = VALUES(name),
         last_seen = VALUES(last_seen)`,
      params,
    );
    return Number(res.affectedRows || 0);
  }

  async function listVlans(deviceId, { limit = 4096 } = {}) {
    const [rows] = await pool.query(
      `SELECT vlan, name, first_seen, last_seen FROM device_vlans
        WHERE device_id = ? ORDER BY vlan ASC LIMIT ?`,
      [deviceId, limit],
    );
    return rows.map((r) => ({
      vlan: Number(r.vlan),
      name: r.name,
      firstSeen: toIso(r.first_seen),
      lastSeen: toIso(r.last_seen),
    }));
  }

  async function purgeVlansBefore(cutoff) {
    const [res] = await pool.query('DELETE FROM device_vlans WHERE last_seen < ?', [cutoff]);
    return Number(res.affectedRows || 0);
  }

  // Every learned MAC on a port that is operationally UP, fleet-wide — the
  // coverage report's input for "hosts behind a switch port that nothing
  // monitors" (src/coverage/). Three columns and the port's MAC count rather
  // than whole rows: the report only counts, and it reads this once instead
  // of once per switch.
  //
  // Joined on the port NAME, which is the interface's identity here (an
  // ifIndex moves over a reboot; see deviceInterfacesRepository). A port the
  // interface table has never seen is left out rather than guessed up.
  // Bounded: a capped answer is a smaller count, and the caller says so.
  async function listUpPortMacs({ since, limit = 20000 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 200000 ? limit : 20000;
    const [rows] = await pool.query(
      `SELECT f.device_id, f.if_name, f.mac, f.port_mac_count
         FROM fdb_entries f
         JOIN device_interfaces i ON i.device_id = f.device_id AND i.if_name = f.if_name
        WHERE i.oper_status = 'up' AND f.status = 'learned' AND f.last_seen >= ?
        ORDER BY f.device_id ASC, f.if_name ASC, f.mac ASC
        LIMIT ?`,
      [since, lim],
    );
    return rows.map((r) => ({
      deviceId: Number(r.device_id),
      ifName: r.if_name,
      mac: r.mac,
      portMacCount: Number(r.port_mac_count) || 1,
    }));
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
    listUpPortMacs,
    countForDevice,
    purgeBefore,
    purgeMovesBefore,
    upsertVlans,
    listVlans,
    purgeVlansBefore,
  };
}

module.exports = { createFdbEntriesRepository, mapRow };
