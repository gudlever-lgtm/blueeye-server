'use strict';

// Data-access for `device_arp_entries` (migration 125) — the ARP table of a
// polled router or L3 switch, read over IP-MIB by the SNMP topology poll.
//
// The twin of arpEntriesRepository (073) for a DEVICE rather than an agent,
// with the same rules: one row per (device, ip); re-observing an address bumps
// last_seen; a DIFFERENT MAC behind the same address rewrites it and stamps
// mac_changed_at; rows age out on last_seen rather than being replaced, so a
// poll that happened to catch a short table does not throw away a good
// binding learned the poll before.
//
// Reads carry the device's name and host with them (a join, not a read per
// row) because every consumer — search, the device page, the new-device
// detector — names the router the address was seen on.

const BASE_COLUMNS = `a.id, a.device_id, a.ip, a.mac, a.if_index, a.if_name,
  a.first_seen, a.last_seen, a.mac_changed_at`;
const DEVICE_COLUMNS = `d.display_name AS device_name, d.host AS device_host,
  d.location_id AS device_location_id, d.sys_location AS device_sys_location`;

// One upsert statement carries at most this many rows. A full table is 8 192
// rows — ~57 000 bound values in one statement, one enormous packet against
// max_allowed_packet and one long row-lock hold — so it is chunked.
const UPSERT_CHUNK = 1000;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    deviceId: Number(row.device_id),
    ip: row.ip,
    mac: row.mac,
    ifIndex: row.if_index == null ? null : Number(row.if_index),
    ifName: row.if_name ?? null,
    firstSeen: toIso(row.first_seen),
    lastSeen: toIso(row.last_seen),
    macChangedAt: toIso(row.mac_changed_at),
    // Present on the joined reads only.
    ...(row.device_host !== undefined ? {
      deviceName: row.device_name ?? null,
      deviceHost: row.device_host ?? null,
      deviceLocationId: row.device_location_id == null ? null : Number(row.device_location_id),
      deviceSysLocation: row.device_sys_location ?? null,
    } : {}),
  };
}

function createDeviceArpEntriesRepository(db) {
  const { pool } = db;

  // Upserts one poll's table for one device. Returns the affected-row count.
  async function upsertMany(deviceId, entries, { at = new Date() } = {}) {
    const rows = Array.isArray(entries) ? entries : [];
    if (!rows.length) return 0;
    let affected = 0;
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK);
      const values = [];
      const params = [];
      for (const e of chunk) {
        values.push('(?, ?, ?, ?, ?, ?, ?, NULL)');
        params.push(deviceId, e.ip, e.mac, e.ifIndex ?? null, e.ifName ?? null, at, at);
      }
      // eslint-disable-next-line no-await-in-loop
      const [res] = await pool.query(
        `INSERT INTO device_arp_entries
           (device_id, ip, mac, if_index, if_name, first_seen, last_seen, mac_changed_at)
         VALUES ${values.join(', ')}
         ON DUPLICATE KEY UPDATE
           mac_changed_at = IF(mac <> VALUES(mac), VALUES(last_seen), mac_changed_at),
           mac = VALUES(mac),
           if_index = COALESCE(VALUES(if_index), if_index),
           if_name = COALESCE(VALUES(if_name), if_name),
           last_seen = VALUES(last_seen)`,
        params,
      );
      affected += Number(res.affectedRows || 0);
    }
    return affected;
  }

  // IP → the MAC(s) behind it, on every router that has it. Several rows are
  // expected: the same RFC1918 address exists at more than one site.
  async function findByIp({ ip, limit = 25 }) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS}, ${DEVICE_COLUMNS}
         FROM device_arp_entries a JOIN snmp_devices d ON d.id = a.device_id
        WHERE a.ip = ? ORDER BY a.last_seen DESC LIMIT ?`,
      [ip, limit],
    );
    return rows.map(mapRow);
  }

  // MAC → every address it holds, on every router that has seen it.
  async function findByMac({ mac, limit = 25 }) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS}, ${DEVICE_COLUMNS}
         FROM device_arp_entries a JOIN snmp_devices d ON d.id = a.device_id
        WHERE a.mac = ? ORDER BY a.last_seen DESC LIMIT ?`,
      [mac, limit],
    );
    return rows.map(mapRow);
  }

  // One device's table, newest first — the device page.
  async function listForDevice(deviceId, { limit = 500 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 10000 ? limit : 500;
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM device_arp_entries a
        WHERE a.device_id = ? ORDER BY a.last_seen DESC, a.ip ASC LIMIT ?`,
      [deviceId, lim],
    );
    return rows.map(mapRow);
  }

  async function countForDevice(deviceId) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM device_arp_entries WHERE device_id = ?', [deviceId],
    );
    return Number((rows[0] && rows[0].n) || 0);
  }

  // Which of `macs` are already known — to this device, or (with `locationId`)
  // to ANY polled device at that site. The new-device detector asks this BEFORE
  // the upsert that would make every MAC known. Bounded by the IN list.
  async function knownMacs({ macs, deviceId = null, locationId = null } = {}) {
    const list = [...new Set((Array.isArray(macs) ? macs : []).filter((m) => typeof m === 'string' && m))].slice(0, 10000);
    if (!list.length) return new Set();
    let rows;
    if (locationId != null) {
      [rows] = await pool.query(
        `SELECT DISTINCT a.mac FROM device_arp_entries a JOIN snmp_devices d ON d.id = a.device_id
          WHERE d.location_id = ? AND a.mac IN (?)`,
        [locationId, list],
      );
    } else if (deviceId != null) {
      [rows] = await pool.query(
        'SELECT DISTINCT mac FROM device_arp_entries WHERE device_id = ? AND mac IN (?)',
        [deviceId, list],
      );
    } else {
      return new Set();
    }
    return new Set(rows.map((r) => r.mac));
  }

  // When this device's ARP table was first seen — the detector's "is there a
  // baseline yet" guard. null when it has no rows.
  async function oldestFirstSeen(deviceId) {
    const [rows] = await pool.query(
      'SELECT MIN(first_seen) AS oldest FROM device_arp_entries WHERE device_id = ?', [deviceId],
    );
    const v = rows[0] && rows[0].oldest;
    return v ? new Date(v) : null;
  }

  async function purgeBefore(cutoff, { batchSize = 5000 } = {}) {
    let removed = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const [res] = await pool.query(
        'DELETE FROM device_arp_entries WHERE last_seen < ? ORDER BY last_seen LIMIT ?',
        [cutoff, batchSize],
      );
      const n = Number(res.affectedRows || 0);
      removed += n;
      if (n < batchSize) break;
    }
    return removed;
  }

  return {
    upsertMany, findByIp, findByMac, listForDevice, countForDevice, knownMacs, oldestFirstSeen, purgeBefore,
  };
}

module.exports = { createDeviceArpEntriesRepository, mapRow, UPSERT_CHUNK };
