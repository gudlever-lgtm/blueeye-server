'use strict';

// Data-access for `arp_entries` (migration 073) — the IP↔MAC identity source
// behind the universal search field.
//
// One row per (agent_id, ip). Re-observing an address bumps last_seen; observing
// a DIFFERENT MAC on the same address rewrites the mac and stamps mac_changed_at,
// so "this binding just moved" stays visible without keeping a history table
// that would turn every identity lookup into a time query.

const BASE_COLUMNS = `id, agent_id, ip, mac, interface, source,
  first_seen, last_seen, mac_changed_at`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    ip: row.ip,
    mac: row.mac,
    interface: row.interface ?? null,
    source: row.source,
    firstSeen: toIso(row.first_seen),
    lastSeen: toIso(row.last_seen),
    macChangedAt: toIso(row.mac_changed_at),
  };
}

function createArpEntriesRepository(db) {
  const { pool } = db;

  // Upserts a batch of parsed entries for one agent.
  //
  // NOT a wholesale replace (unlike host_connections): an evidence snapshot only
  // covers whatever the neighbour table held at that instant, and deleting rows
  // it did not mention would throw away a perfectly good binding learned from
  // the capabilities cycle. Rows age out on last_seen instead — see purgeBefore.
  //
  // mac_changed_at only moves when the MAC actually differs: VALUES(mac) is
  // compared against the stored one, so a re-observation of the same binding is
  // a plain last_seen bump.
  async function upsertMany(agentId, entries, { source = 'capabilities', at = new Date() } = {}) {
    const rows = Array.isArray(entries) ? entries : [];
    if (!rows.length) return 0;

    const values = [];
    const params = [];
    for (const e of rows) {
      values.push('(?, ?, ?, ?, ?, ?, ?, NULL)');
      params.push(agentId, e.ip, e.mac, e.interface || null, source, at, at);
    }

    const [res] = await pool.query(
      `INSERT INTO arp_entries
         (agent_id, ip, mac, interface, source, first_seen, last_seen, mac_changed_at)
       VALUES ${values.join(', ')}
       ON DUPLICATE KEY UPDATE
         mac_changed_at = IF(mac <> VALUES(mac), VALUES(last_seen), mac_changed_at),
         mac = VALUES(mac),
         interface = COALESCE(VALUES(interface), interface),
         source = VALUES(source),
         last_seen = VALUES(last_seen)`,
      params
    );
    return res.affectedRows || 0;
  }

  // MAC → every place it has been seen. Exact match on the normalised form; the
  // caller normalises the user's input with the SAME function the parser uses,
  // which is what makes three spellings of one MAC resolve identically.
  async function findByMac({ mac, limit = 25 }) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM arp_entries
        WHERE mac = ? ORDER BY last_seen DESC LIMIT ?`,
      [mac, limit]
    );
    return rows.map(mapRow);
  }

  // IP → the MAC(s) behind it. Several rows are expected and correct: the same
  // RFC1918 address legitimately exists at more than one site.
  async function findByIp({ ip, limit = 25 }) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM arp_entries
        WHERE ip = ? ORDER BY last_seen DESC LIMIT ?`,
      [ip, limit]
    );
    return rows.map(mapRow);
  }

  async function listForAgent({ agentId, limit = 500 }) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM arp_entries
        WHERE agent_id = ? ORDER BY last_seen DESC LIMIT ?`,
      [agentId, limit]
    );
    return rows.map(mapRow);
  }

  // IPv4 addresses the fleet's neighbour tables have seen, aggregated per /24 —
  // the coverage report's "subnets seen but not covered" (src/coverage/).
  //
  // Aggregated in SQL so the answer is one row per prefix, never one per
  // address; capped by `limit` and ordered busiest first, so a capped answer
  // drops the smallest subnets rather than an arbitrary slice. `agents` is how
  // many agents' tables the prefix came from — evidence, not coverage: an
  // agent that ARPs for an address is next to that segment, not necessarily
  // in it. The LIKE pair keeps IPv6 out (a /24 of a v6 address means nothing).
  async function subnetSummary({ since, limit = 500 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
    const [rows] = await pool.query(
      `SELECT SUBSTRING_INDEX(ip, '.', 3) AS prefix,
              COUNT(DISTINCT ip) AS ips, COUNT(DISTINCT agent_id) AS agents,
              MAX(last_seen) AS last_seen
         FROM arp_entries
        WHERE ip LIKE '%.%.%.%' AND ip NOT LIKE '%:%' AND last_seen >= ?
        GROUP BY prefix
        ORDER BY ips DESC, prefix ASC
        LIMIT ?`,
      [since, lim],
    );
    return rows.map((r) => ({
      prefix: String(r.prefix),
      ips: Number(r.ips) || 0,
      agents: Number(r.agents) || 0,
      lastSeen: toIso(r.last_seen),
    }));
  }

  // The MACs behind a set of IPs — how the coverage report recognises an
  // agent's own NIC in a switch's forwarding table (agents report their IPs,
  // not their MACs). One IN () read, bounded on both sides.
  async function macsForIps(ips, { limit = 5000 } = {}) {
    const list = (Array.isArray(ips) ? ips : []).filter((ip) => typeof ip === 'string' && ip).slice(0, 1000);
    if (!list.length) return [];
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 50000 ? limit : 5000;
    const [rows] = await pool.query(
      'SELECT DISTINCT ip, mac FROM arp_entries WHERE ip IN (?) LIMIT ?',
      [list, lim],
    );
    return rows.map((r) => ({ ip: r.ip, mac: r.mac }));
  }

  // Which of `macs` are already known — to this agent, or (with `locationId`)
  // to ANY agent at that site, so a device that moved between two agents' view
  // on the same site is not "new". The new-device detector asks this BEFORE the
  // upsert that would make every MAC known. Bounded by the IN list (the caller
  // passes one report's worth) and served by idx_arp_mac.
  async function knownMacs({ macs, agentId = null, locationId = null } = {}) {
    const list = [...new Set((Array.isArray(macs) ? macs : []).filter((m) => typeof m === 'string' && m))].slice(0, 5000);
    if (!list.length) return new Set();
    let rows;
    if (locationId != null) {
      [rows] = await pool.query(
        `SELECT DISTINCT a.mac FROM arp_entries a JOIN agents g ON g.id = a.agent_id
          WHERE g.location_id = ? AND a.mac IN (?)`,
        [locationId, list],
      );
    } else {
      [rows] = await pool.query(
        'SELECT DISTINCT mac FROM arp_entries WHERE agent_id = ? AND mac IN (?)',
        [agentId, list],
      );
    }
    return new Set(rows.map((r) => r.mac));
  }

  // When this agent's neighbour table was first seen — the new-device
  // detector's "is there a baseline yet" guard. null when it has no rows.
  async function oldestFirstSeen(agentId) {
    const [rows] = await pool.query('SELECT MIN(first_seen) AS oldest FROM arp_entries WHERE agent_id = ?', [agentId]);
    const v = rows[0] && rows[0].oldest;
    return v ? new Date(v) : null;
  }

  // Age-out. A neighbour entry is a snapshot of a segment; one that has not been
  // re-observed for the retention window is a stale answer, and a stale answer to
  // "where is this MAC" is worse than no answer.
  async function purgeBefore(cutoff) {
    const [res] = await pool.query('DELETE FROM arp_entries WHERE last_seen < ?', [cutoff]);
    return res.affectedRows || 0;
  }

  return { upsertMany, findByMac, findByIp, listForAgent, subnetSummary, macsForIps, knownMacs, oldestFirstSeen, purgeBefore };
}

module.exports = { createArpEntriesRepository };
