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

  const q = (sql, params) => pool.query(sql, params).then(([r]) => r);
  const numOf = (v) => Number(v) || 0;
  const normAsn = (v) => (v ? Number(v) : null);

  // Per-ASN byte time-series for one agent over [from, to], bucketed into
  // `bucketSec`-wide windows on the epoch grid (so bucket * bucketSec is the
  // window start in seconds). Raw flow_records only — used to attribute traffic
  // to organisations (Facebook, Google, ...) in the traffic-type breakdown.
  async function asnSeries({ agentId, from, to, bucketSec }) {
    const sec = Math.max(1, Math.floor(Number(bucketSec) || 60));
    const where = ['asn IS NOT NULL', 'ts >= ?', 'ts <= ?'];
    const params = [sec, from, to];
    if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
    const rows = await q(
      `SELECT FLOOR(UNIX_TIMESTAMP(ts) / ?) AS b, asn, SUM(bytes) AS bytes
       FROM flow_records WHERE ${where.join(' AND ')} GROUP BY b, asn`,
      params
    );
    return rows.map((r) => ({ bucket: numOf(r.b), asn: normAsn(r.asn), bytes: numOf(r.bytes) }));
  }

  // Bytes/flows per external destination (country, asn) in [from, to), read
  // across BOTH raw flow_records and the flow_rollup table — so a window that
  // reaches past the raw-retention horizon still returns complete totals. Only
  // public destinations (internal = 0 / country present) are included;
  // private/RFC1918 endpoints are structurally excluded.
  async function sumByDest({ agentId, from, to }) {
    const rawWhere = ['internal = 0', 'country IS NOT NULL', 'ts >= ?', 'ts < ?'];
    const rawParams = [from, to];
    if (agentId) { rawWhere.push('agent_id = ?'); rawParams.push(agentId); }
    const rollWhere = ["country <> ''", 'bucket >= ?', 'bucket < ?'];
    const rollParams = [from, to];
    if (agentId) { rollWhere.push('agent_id = ?'); rollParams.push(agentId); }

    const [raw, roll] = await Promise.all([
      q(`SELECT country, asn, MAX(asn_name) AS asnName, SUM(bytes) AS bytes, SUM(flows) AS flowCount
         FROM flow_records WHERE ${rawWhere.join(' AND ')} GROUP BY country, asn`, rawParams),
      q(`SELECT country, asn, MAX(asn_name) AS asnName, SUM(bytes) AS bytes, SUM(flow_count) AS flowCount
         FROM flow_rollup WHERE ${rollWhere.join(' AND ')} GROUP BY country, asn`, rollParams),
    ]);

    // Normalise asn (NULL in raw, 0 in rollup) before keying so "unknown ASN"
    // collapses to a single row per country.
    return mergeRows(
      [...raw, ...roll].map((r) => ({ ...r, asn: normAsn(r.asn) })),
      (r) => `${r.country}|${r.asn ?? ''}`,
      (r) => ({ country: r.country, asn: r.asn }),
    );
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

  // WHERE clause + params for the public flows matching a destination selection.
  // The raw and rollup tables differ only in how "public" is expressed
  // (internal=0 vs a non-empty country) and in their timestamp column.
  function destFilter({ publicPredicate, tsCol }, { country, asn, since, until }) {
    const where = [publicPredicate, `${tsCol} >= ?`, `${tsCol} < ?`];
    const params = [since, until];
    if (country) { where.push('country = ?'); params.push(country); }
    if (asn !== null && asn !== undefined && asn !== '') { where.push('asn = ?'); params.push(Number(asn)); }
    return { clause: where.join(' AND '), params };
  }
  const rawDestFilter = (sel) => destFilter({ publicPredicate: 'internal = 0', tsCol: 'ts' }, sel);
  const rollDestFilter = (sel) => destFilter({ publicPredicate: "country <> ''", tsCol: 'bucket' }, sel);

  // True if any public flow exists (raw OR rollup) for the selection.
  async function destinationExists({ country = null, asn = null, since, until }) {
    const raw = rawDestFilter({ country, asn, since, until });
    const roll = rollDestFilter({ country, asn, since, until });
    const [a, b] = await Promise.all([
      q(`SELECT 1 FROM flow_records WHERE ${raw.clause} LIMIT 1`, raw.params),
      q(`SELECT 1 FROM flow_rollup WHERE ${roll.clause} LIMIT 1`, roll.params),
    ]);
    return a.length > 0 || b.length > 0;
  }

  // Distinct agent ids that talked to the selection (raw + rollup).
  async function agentIdsForDestination({ country = null, asn = null, since, until }) {
    const raw = rawDestFilter({ country, asn, since, until });
    const roll = rollDestFilter({ country, asn, since, until });
    const [a, b] = await Promise.all([
      q(`SELECT DISTINCT agent_id FROM flow_records WHERE ${raw.clause}`, raw.params),
      q(`SELECT DISTINCT agent_id FROM flow_rollup WHERE ${roll.clause}`, roll.params),
    ]);
    return [...new Set([...a, ...b].map((r) => r.agent_id))];
  }

  // Merges aggregate rows sharing a key, summing bytes/flowCount and keeping the
  // first non-empty asnName. keyOf(row) is the merge key; idOf(row) is the set
  // of identity fields carried onto the merged row.
  function mergeRows(rows, keyOf, idOf) {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      const cur = m.get(k) || { ...idOf(r), asnName: r.asnName ?? null, bytes: 0, flowCount: 0 };
      cur.bytes += numOf(r.bytes);
      cur.flowCount += numOf(r.flowCount);
      if (!cur.asnName && r.asnName) cur.asnName = r.asnName;
      m.set(k, cur);
    }
    return [...m.values()];
  }

  // Merges two row sets keyed by a single column (asn / direction / bucket).
  function mergeBy(rowsA, rowsB, keyField) {
    return mergeRows([...rowsA, ...rowsB], (r) => r[keyField], (r) => ({ [keyField]: r[keyField] }));
  }

  // Aggregated detail for a selected destination, read across raw + rollup:
  // peers by ASN, by direction, a byte time-series; protocol breakdown is
  // raw-only (rollups don't retain per-protocol detail).
  async function selectFlows({ country = null, asn = null, since, until }) {
    const raw = rawDestFilter({ country, asn, since, until });
    const roll = rollDestFilter({ country, asn, since, until });
    const [rAsn, rDir, byProtoRaw, rSeries, rawTot, kAsn, kDir, kSeries, rollTot] = await Promise.all([
      q(`SELECT asn, MAX(asn_name) AS asnName, SUM(bytes) AS bytes, SUM(flows) AS flowCount FROM flow_records WHERE ${raw.clause} GROUP BY asn`, raw.params),
      q(`SELECT direction, SUM(bytes) AS bytes, SUM(flows) AS flowCount FROM flow_records WHERE ${raw.clause} GROUP BY direction`, raw.params),
      q(`SELECT proto, SUM(bytes) AS bytes, SUM(flows) AS flowCount FROM flow_records WHERE ${raw.clause} GROUP BY proto ORDER BY bytes DESC LIMIT 20`, raw.params),
      q(`SELECT DATE_FORMAT(ts, '%Y-%m-%d %H:00:00') AS bucket, SUM(bytes) AS bytes, SUM(flows) AS flowCount FROM flow_records WHERE ${raw.clause} GROUP BY bucket`, raw.params),
      q(`SELECT SUM(bytes) AS bytes, SUM(flows) AS flowCount FROM flow_records WHERE ${raw.clause}`, raw.params),
      q(`SELECT asn, MAX(asn_name) AS asnName, SUM(bytes) AS bytes, SUM(flow_count) AS flowCount FROM flow_rollup WHERE ${roll.clause} GROUP BY asn`, roll.params),
      q(`SELECT direction, SUM(bytes) AS bytes, SUM(flow_count) AS flowCount FROM flow_rollup WHERE ${roll.clause} GROUP BY direction`, roll.params),
      q(`SELECT DATE_FORMAT(bucket, '%Y-%m-%d %H:00:00') AS bucket, SUM(bytes) AS bytes, SUM(flow_count) AS flowCount FROM flow_rollup WHERE ${roll.clause} GROUP BY bucket`, roll.params),
      q(`SELECT SUM(bytes) AS bytes, SUM(flow_count) AS flowCount FROM flow_rollup WHERE ${roll.clause}`, roll.params),
    ]);

    // Normalise asn BEFORE merging so "unknown ASN" (NULL in raw, 0 in rollup)
    // collapses to a single row instead of two.
    const normAsnRow = (r) => ({ ...r, asn: normAsn(r.asn) });
    const byAsn = mergeBy(rAsn.map(normAsnRow), kAsn.map(normAsnRow), 'asn')
      .map((r) => ({ asn: r.asn, asnName: r.asnName ?? null, bytes: r.bytes, flowCount: r.flowCount }))
      .sort((a, b) => b.bytes - a.bytes).slice(0, 20);
    const byDirection = mergeBy(rDir, kDir, 'direction').map((r) => ({ direction: r.direction, bytes: r.bytes, flowCount: r.flowCount }));
    const series = mergeBy(rSeries, kSeries, 'bucket')
      .map((r) => ({ at: r.bucket, bytes: r.bytes, flowCount: r.flowCount }))
      .sort((a, b) => (a.at < b.at ? -1 : 1));
    const rt = rawTot[0] || {}; const kt = rollTot[0] || {};
    return {
      byAsn,
      byDirection,
      byProto: byProtoRaw.map((r) => ({ proto: r.proto, bytes: numOf(r.bytes), flowCount: numOf(r.flowCount) })),
      series,
      totals: { bytes: numOf(rt.bytes) + numOf(kt.bytes), flowCount: numOf(rt.flowCount) + numOf(kt.flowCount) },
    };
  }

  return { insertMany, aggregateExternalDestinations, destinationExists, agentIdsForDestination, selectFlows, asnSeries };
}

module.exports = { createFlowsRepository, toRow };
