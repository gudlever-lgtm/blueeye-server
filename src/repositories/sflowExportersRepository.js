'use strict';

// Data-access for `sflow_exporters` (migration 128) — which sFlow exporters
// each agent hears from, and whether each one matched a registered device.
//
// Written by the sFlow counter ingest (src/devices/sflowCounterIngest.js) on
// every report that carries counter samples or the exporter list the agent
// heard flow samples from (traffic.sflowExporters); read by the coverage report,
// which lists the exporters that match no device ("sFlow exporter not
// registered as a device").

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    address: row.address,
    deviceId: row.device_id == null ? null : Number(row.device_id),
    interfaces: Number(row.interfaces) || 0,
    firstSeen: toIso(row.first_seen),
    lastSeen: toIso(row.last_seen),
  };
}

function createSflowExportersRepository(db) {
  const { pool } = db;

  // Upserts one report's exporters: [{ agentId, address, deviceId, interfaces }].
  // `first_seen` is kept on a repeat; everything else is the latest sighting,
  // including device_id — an exporter registered since the last report stops
  // being a gap on the next one.
  //
  // `interfaces: null` means "heard, but no counter samples counted in this
  // report" — an exporter known only from its flow samples (the agent's
  // traffic.sflowExporters). Such a row is inserted with 0 and, on a repeat,
  // leaves the stored count alone, so a report that carried only flow samples
  // from a switch never zeroes the port count its counter samples recorded.
  // One statement per kind (at most two).
  async function recordSeen(rows, { at = new Date() } = {}) {
    const list = (Array.isArray(rows) ? rows : [])
      .filter((r) => r && r.agentId != null && typeof r.address === 'string' && r.address);
    if (!list.length) return 0;
    const counted = list.filter((r) => r.interfaces != null);
    const heardOnly = list.filter((r) => r.interfaces == null);
    let affected = 0;
    for (const [part, keepCount] of [[counted, false], [heardOnly, true]]) {
      if (!part.length) continue;
      const placeholders = [];
      const params = [];
      for (const r of part) {
        placeholders.push('(?, ?, ?, ?, ?, ?)');
        params.push(
          Number(r.agentId), r.address.slice(0, 45),
          r.deviceId == null ? null : Number(r.deviceId),
          keepCount ? 0 : Math.max(0, Math.floor(Number(r.interfaces) || 0)),
          at, at,
        );
      }
      // eslint-disable-next-line no-await-in-loop
      const [res] = await pool.query(
        `INSERT INTO sflow_exporters (agent_id, address, device_id, interfaces, first_seen, last_seen)
         VALUES ${placeholders.join(', ')}
         ON DUPLICATE KEY UPDATE
           device_id  = VALUES(device_id),${keepCount ? '' : `
           interfaces = VALUES(interfaces),`}
           last_seen  = VALUES(last_seen)`,
        params,
      );
      affected += Number((res && res.affectedRows) || 0);
    }
    return affected;
  }

  // The exporters heard since `since`, newest first, bounded.
  async function listRecent({ since, limit = 500 } = {}) {
    const n = Math.max(1, Math.min(Math.floor(Number(limit) || 500), 5000));
    const [rows] = await pool.query(
      `SELECT id, agent_id, address, device_id, interfaces, first_seen, last_seen
         FROM sflow_exporters
        WHERE last_seen >= ?
        ORDER BY last_seen DESC, id DESC
        LIMIT ?`,
      [since || new Date(Date.now() - 24 * 3600 * 1000), n],
    );
    return rows.map(mapRow);
  }

  return { recordSeen, listRecent };
}

module.exports = { createSflowExportersRepository };
