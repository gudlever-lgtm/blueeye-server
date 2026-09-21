'use strict';

// Data-access for `device_interfaces` (migration 108) — the ports on a polled
// switch.
//
// THE POINT OF THIS FILE is that it is the only place that knows an interface's
// identity is its NAME and not its ifIndex. Everything downstream — counters,
// findings, the port table on the device page — refers to a row id here, so a
// switch that renumbers its ifIndexes over a reboot moves one column in one row
// and leaves every historical measurement pointing at the right port.
//
// The counterpart is `upsertMany` returning the renumbered rows: the poll that
// notices ifIndex moved is also the poll whose counter delta spans two
// different ports, and the caller has to know.

const COLUMNS = [
  'id', 'device_id', 'if_name', 'name_source', 'if_index', 'if_index_changed_at',
  'if_alias', 'if_descr', 'if_type', 'speed_mbps', 'admin_status', 'oper_status',
  'phys_address', 'first_seen', 'last_seen',
];
const BASE_COLUMNS = COLUMNS.join(', ');
const PREFIXED = (alias) => COLUMNS.map((c) => `${alias}.${c}`).join(', ');

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    deviceId: Number(row.device_id),
    ifName: row.if_name,
    nameSource: row.name_source,
    ifIndex: row.if_index == null ? null : Number(row.if_index),
    ifIndexChangedAt: toIso(row.if_index_changed_at),
    ifAlias: row.if_alias ?? null,
    ifDescr: row.if_descr ?? null,
    ifType: row.if_type == null ? null : Number(row.if_type),
    speedMbps: row.speed_mbps == null ? null : Number(row.speed_mbps),
    adminStatus: row.admin_status ?? null,
    operStatus: row.oper_status ?? null,
    physAddress: row.phys_address ?? null,
    firstSeen: toIso(row.first_seen),
    lastSeen: toIso(row.last_seen),
    deviceName: row.device_name ?? undefined,
    deviceHost: row.device_host ?? undefined,
  };
}

function createDeviceInterfacesRepository(db) {
  const { pool } = db;

  // Upserts one poll's interface list for one device, and reports what changed
  // in a way the counter path can act on.
  //
  // Returns { upserted, renumbered: [{ ifName, from, to }] }. `renumbered` is
  // the load-bearing half: a port whose ifIndex moved has a counter reading
  // that belongs to a DIFFERENT port than last time, and a delta across that
  // boundary is a fabricated number. The caller marks the cycle discontinuous
  // rather than storing it.
  async function upsertMany(deviceId, interfaces, { at = new Date() } = {}) {
    const rows = Array.isArray(interfaces) ? interfaces.filter((i) => i && i.ifName) : [];
    if (!rows.length) return { upserted: 0, renumbered: [] };

    // Read the current index map first, so a move can be REPORTED rather than
    // just overwritten. One indexed read per poll against at most a few
    // thousand rows.
    const [existing] = await pool.query(
      'SELECT if_name, if_index FROM device_interfaces WHERE device_id = ?', [deviceId],
    );
    const before = new Map(existing.map((r) => [r.if_name, r.if_index == null ? null : Number(r.if_index)]));

    const renumbered = [];
    const placeholders = [];
    const params = [];
    for (const i of rows) {
      const prev = before.has(i.ifName) ? before.get(i.ifName) : undefined;
      const next = i.ifIndex == null ? null : Number(i.ifIndex);
      const moved = prev !== undefined && prev !== null && next !== null && prev !== next;
      if (moved) renumbered.push({ ifName: i.ifName, from: prev, to: next });

      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      params.push(
        deviceId, i.ifName, i.nameSource || 'ifName', next,
        // Only stamped when it actually moved; a first sighting is not a move.
        moved ? at : null,
        i.ifAlias ?? null, i.ifDescr ?? null,
        i.ifType == null ? null : Number(i.ifType),
        i.speedMbps == null ? null : Number(i.speedMbps),
        i.adminStatus ?? null, i.operStatus ?? null, i.physAddress ?? null,
        at, at,
      );
    }

    // COALESCE on if_index_changed_at: a poll where nothing moved must not
    // erase the timestamp of the move before it.
    const [res] = await pool.query(
      `INSERT INTO device_interfaces
         (device_id, if_name, name_source, if_index, if_index_changed_at,
          if_alias, if_descr, if_type, speed_mbps, admin_status, oper_status,
          phys_address, first_seen, last_seen)
       VALUES ${placeholders.join(', ')}
       ON DUPLICATE KEY UPDATE
         name_source  = VALUES(name_source),
         if_index     = VALUES(if_index),
         if_index_changed_at = COALESCE(VALUES(if_index_changed_at), if_index_changed_at),
         if_alias     = VALUES(if_alias),
         if_descr     = VALUES(if_descr),
         if_type      = VALUES(if_type),
         speed_mbps   = VALUES(speed_mbps),
         admin_status = VALUES(admin_status),
         oper_status  = VALUES(oper_status),
         phys_address = VALUES(phys_address),
         last_seen    = VALUES(last_seen)`,
      params,
    );
    return { upserted: Number(res.affectedRows || 0), renumbered };
  }

  // ifName -> row id, for one device. The counter path resolves its samples
  // through this rather than carrying an ifIndex into a time series.
  async function idMapForDevice(deviceId) {
    const [rows] = await pool.query(
      'SELECT id, if_name, if_index FROM device_interfaces WHERE device_id = ?', [deviceId],
    );
    const byName = new Map();
    const byIndex = new Map();
    for (const r of rows) {
      byName.set(r.if_name, Number(r.id));
      if (r.if_index != null) byIndex.set(Number(r.if_index), Number(r.id));
    }
    return { byName, byIndex };
  }

  async function listForDevice(deviceId, { limit = 1000 } = {}) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM device_interfaces
        WHERE device_id = ?
        ORDER BY if_index IS NULL, if_index ASC, if_name ASC
        LIMIT ?`,
      [deviceId, limit],
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${PREFIXED('i')},
              d.display_name AS device_name, d.host AS device_host
         FROM device_interfaces i
         JOIN snmp_devices d ON d.id = i.device_id
        WHERE i.id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async function countForDevice(deviceId) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM device_interfaces WHERE device_id = ?', [deviceId],
    );
    return Number((rows[0] && rows[0].n) || 0);
  }

  // Ports not re-observed within the window. Longer-lived than the forwarding
  // table by design: a module pulled out over a holiday and put back should
  // recognise its own history rather than arriving as a brand-new port.
  // Every port MAC we have read, fleet-wide — the join the topology merge
  // resolves an LLDP chassis id through.
  //
  // Two columns rather than the whole row: this is a lookup table, and a full
  // interface inventory to build it would be the largest read on that screen.
  async function listMacs({ limit = 50000 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500000 ? limit : 50000;
    const [rows] = await pool.query(
      `SELECT device_id, phys_address FROM device_interfaces
        WHERE phys_address IS NOT NULL AND phys_address <> ''
        ORDER BY device_id ASC LIMIT ?`,
      [lim],
    );
    return rows.map((r) => ({ deviceId: Number(r.device_id), physAddress: r.phys_address }));
  }

  async function purgeBefore(cutoff, { batchSize = 2000 } = {}) {
    let removed = 0;
    for (;;) {
      const [res] = await pool.query(
        'DELETE FROM device_interfaces WHERE last_seen < ? ORDER BY last_seen LIMIT ?',
        [cutoff, batchSize],
      );
      const n = Number(res.affectedRows || 0);
      removed += n;
      if (n < batchSize) break;
    }
    return removed;
  }

  return { upsertMany, idMapForDevice, listForDevice, listMacs, findById, countForDevice, purgeBefore };
}

module.exports = { createDeviceInterfacesRepository, mapRow };
