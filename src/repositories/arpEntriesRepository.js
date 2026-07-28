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

  // Age-out. A neighbour entry is a snapshot of a segment; one that has not been
  // re-observed for the retention window is a stale answer, and a stale answer to
  // "where is this MAC" is worse than no answer.
  async function purgeBefore(cutoff) {
    const [res] = await pool.query('DELETE FROM arp_entries WHERE last_seen < ?', [cutoff]);
    return res.affectedRows || 0;
  }

  return { upsertMany, findByMac, findByIp, listForAgent, purgeBefore };
}

module.exports = { createArpEntriesRepository };
