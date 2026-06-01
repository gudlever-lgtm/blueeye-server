'use strict';

const COLUMNS = [
  'agent_id', 'ts', 'src_ip', 'dst_ip', 'ext_ip', 'direction', 'proto',
  'src_port', 'dst_port', 'bytes', 'packets', 'flows', 'internal',
  'country', 'asn', 'asn_name',
];

// Maps a geo-enriched flow record (camelCase) to a positional row for INSERT.
function toRow(r) {
  const ts = r.ts instanceof Date ? r.ts : (r.ts ? new Date(r.ts) : new Date());
  return [
    r.agentId ?? null,
    ts,
    r.srcIp ?? null,
    r.dstIp ?? null,
    r.extIp ?? null,
    r.direction ?? null,
    r.proto ?? null,
    r.srcPort ?? null,
    r.dstPort ?? null,
    Number(r.bytes) || 0,
    Number(r.packets) || 0,
    Number(r.flows) || 0,
    r.internal ? 1 : 0,
    r.country ?? null,
    r.asn ?? null,
    r.asnName ?? null,
  ];
}

// Data-access for the `flow_records` table (geo-enriched flows).
function createFlowsRepository(db) {
  const { pool } = db;

  // Bulk-inserts geo-enriched flow records. Returns the number of rows inserted.
  async function insertMany(records) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    const values = records.map(toRow);
    const [result] = await pool.query(
      `INSERT INTO flow_records (${COLUMNS.join(', ')}) VALUES ?`,
      [values]
    );
    return result.affectedRows;
  }

  // Bytes/flows per external destination (country, asn) in [from, to). Only
  // public destinations (internal = 0 AND country IS NOT NULL) — private/RFC1918
  // endpoints are structurally excluded here.
  async function sumByDest({ agentId, from, to }) {
    const where = ['internal = 0', 'country IS NOT NULL', 'ts >= ?', 'ts < ?'];
    const params = [from, to];
    if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
    const [rows] = await pool.query(
      `SELECT country, asn, MAX(asn_name) AS asnName, SUM(bytes) AS bytes, SUM(flows) AS flowCount
       FROM flow_records WHERE ${where.join(' AND ')} GROUP BY country, asn`,
      params
    );
    return rows;
  }

  // Aggregated external destinations with a deviation = relative change vs the
  // immediately-preceding equal-length window (e.g. +1.0 = doubled; a brand-new
  // destination = 1.0). Used by the map overview.
  async function aggregateExternalDestinations({ agentId = null, since, until }) {
    const len = until.getTime() - since.getTime();
    const [cur, prev] = await Promise.all([
      sumByDest({ agentId, from: since, to: until }),
      sumByDest({ agentId, from: new Date(since.getTime() - len), to: since }),
    ]);
    const prevMap = new Map(prev.map((r) => [`${r.country}|${r.asn ?? ''}`, Number(r.bytes) || 0]));
    return cur.map((r) => {
      const bytes = Number(r.bytes) || 0;
      const pb = prevMap.get(`${r.country}|${r.asn ?? ''}`) || 0;
      const deviation = pb > 0 ? (bytes - pb) / pb : (bytes > 0 ? 1 : 0);
      return { country: r.country, asn: r.asn ?? null, asnName: r.asnName ?? null, bytes, flowCount: Number(r.flowCount) || 0, deviation };
    });
  }

  function destFilter({ country, asn, since, until }) {
    const where = ['internal = 0', 'ts >= ?', 'ts < ?'];
    const params = [since, until];
    if (country) { where.push('country = ?'); params.push(country); }
    if (asn !== null && asn !== undefined && asn !== '') { where.push('asn = ?'); params.push(Number(asn)); }
    return { clause: where.join(' AND '), params };
  }

  // True if any public flow exists for the selected country/asn in the window.
  async function destinationExists({ country = null, asn = null, since, until }) {
    const { clause, params } = destFilter({ country, asn, since, until });
    const [rows] = await pool.query(`SELECT 1 FROM flow_records WHERE ${clause} LIMIT 1`, params);
    return rows.length > 0;
  }

  // Distinct agent ids that talked to the selected destination in the window.
  async function agentIdsForDestination({ country = null, asn = null, since, until }) {
    const { clause, params } = destFilter({ country, asn, since, until });
    const [rows] = await pool.query(`SELECT DISTINCT agent_id FROM flow_records WHERE ${clause}`, params);
    return rows.map((r) => r.agent_id);
  }

  // Aggregated detail for a selected destination: peers by ASN, by direction,
  // by protocol, and a byte time-series (hourly).
  async function selectFlows({ country = null, asn = null, since, until }) {
    const { clause, params } = destFilter({ country, asn, since, until });
    const run = (sql) => pool.query(sql, params).then(([r]) => r);
    const [byAsn, byDirection, byProto, series, totalsRows] = await Promise.all([
      run(`SELECT asn, MAX(asn_name) AS asnName, SUM(bytes) AS bytes, SUM(flows) AS flowCount FROM flow_records WHERE ${clause} GROUP BY asn ORDER BY bytes DESC LIMIT 20`),
      run(`SELECT direction, SUM(bytes) AS bytes, SUM(flows) AS flowCount FROM flow_records WHERE ${clause} GROUP BY direction`),
      run(`SELECT proto, SUM(bytes) AS bytes, SUM(flows) AS flowCount FROM flow_records WHERE ${clause} GROUP BY proto ORDER BY bytes DESC LIMIT 20`),
      run(`SELECT DATE_FORMAT(ts, '%Y-%m-%d %H:00:00') AS bucket, SUM(bytes) AS bytes, SUM(flows) AS flowCount FROM flow_records WHERE ${clause} GROUP BY bucket ORDER BY bucket ASC`),
      run(`SELECT SUM(bytes) AS bytes, SUM(flows) AS flowCount, COUNT(*) AS records FROM flow_records WHERE ${clause}`),
    ]);
    const t = totalsRows[0] || {};
    const num = (v) => Number(v) || 0;
    return {
      byAsn: byAsn.map((r) => ({ asn: r.asn ?? null, asnName: r.asnName ?? null, bytes: num(r.bytes), flowCount: num(r.flowCount) })),
      byDirection: byDirection.map((r) => ({ direction: r.direction, bytes: num(r.bytes), flowCount: num(r.flowCount) })),
      byProto: byProto.map((r) => ({ proto: r.proto, bytes: num(r.bytes), flowCount: num(r.flowCount) })),
      series: series.map((r) => ({ at: r.bucket, bytes: num(r.bytes), flowCount: num(r.flowCount) })),
      totals: { bytes: num(t.bytes), flowCount: num(t.flowCount), records: num(t.records) },
    };
  }

  return { insertMany, aggregateExternalDestinations, destinationExists, agentIdsForDestination, selectFlows };
}

module.exports = { createFlowsRepository, toRow };
