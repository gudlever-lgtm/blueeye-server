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
    // Raw and rollup share four aggregate shapes; only the table, the flow-count
    // column (flows vs flow_count) and the series timestamp column (ts vs bucket)
    // differ. All come from fixed constants — no user input is interpolated.
    const aggregates = ({ table, flowCol, tsCol }, where) => ({
      byAsn: q(`SELECT asn, MAX(asn_name) AS asnName, SUM(bytes) AS bytes, SUM(${flowCol}) AS flowCount FROM ${table} WHERE ${where.clause} GROUP BY asn`, where.params),
      byDir: q(`SELECT direction, SUM(bytes) AS bytes, SUM(${flowCol}) AS flowCount FROM ${table} WHERE ${where.clause} GROUP BY direction`, where.params),
      series: q(`SELECT DATE_FORMAT(${tsCol}, '%Y-%m-%d %H:00:00') AS bucket, SUM(bytes) AS bytes, SUM(${flowCol}) AS flowCount FROM ${table} WHERE ${where.clause} GROUP BY bucket`, where.params),
      totals: q(`SELECT SUM(bytes) AS bytes, SUM(${flowCol}) AS flowCount FROM ${table} WHERE ${where.clause}`, where.params),
    });
    const rawAgg = aggregates({ table: 'flow_records', flowCol: 'flows', tsCol: 'ts' }, raw);
    const rollAgg = aggregates({ table: 'flow_rollup', flowCol: 'flow_count', tsCol: 'bucket' }, roll);
    // Protocol breakdown is raw-only (rollups don't retain per-protocol detail).
    const byProtoQ = q(`SELECT proto, SUM(bytes) AS bytes, SUM(flows) AS flowCount FROM flow_records WHERE ${raw.clause} GROUP BY proto ORDER BY bytes DESC LIMIT 20`, raw.params);

    const [rAsn, rDir, rSeries, rawTot, kAsn, kDir, kSeries, rollTot, byProtoRaw] = await Promise.all([
      rawAgg.byAsn, rawAgg.byDir, rawAgg.series, rawAgg.totals,
      rollAgg.byAsn, rollAgg.byDir, rollAgg.series, rollAgg.totals,
      byProtoQ,
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

  // Conversation/flow explorer for ONE agent: top talkers (src↔dst), top
  // destination ports + protocols, a byte time-series, and port-scan / fan-out
  // candidates (a source touching many distinct dst ports or hosts). Raw
  // flow_records only (5-tuple metadata, never payload). Unlike the geo queries
  // this INCLUDES internal (RFC1918↔RFC1918) conversations — a LAN
  // troubleshooting tool must see them; they are simply never geolocated. All
  // user-supplied filters are bound parameters (no interpolation).
  async function exploreFlows({
    agentId, from, to, proto = null, port = null, peer = null, direction = null,
    internal = null, bucketSec = 300, limit = 50, scanPortThreshold = 50, scanHostThreshold = 50,
  }) {
    const win = (extra = []) => {
      const where = ['agent_id = ?', 'ts >= ?', 'ts < ?'];
      const params = [agentId, from, to];
      if (proto) { where.push('proto = ?'); params.push(String(proto).toLowerCase()); }
      if (direction === 'in' || direction === 'out') { where.push('direction = ?'); params.push(direction); }
      if (internal === true) where.push('internal = 1');
      else if (internal === false) where.push('internal = 0');
      for (const e of extra) { where.push(e.clause); params.push(...e.params); }
      return { clause: where.join(' AND '), params };
    };
    // Main filter (talkers/ports/protos/series/totals) adds the conversation
    // narrowing (port/peer); scan detection deliberately omits those.
    const extra = [];
    if (port != null) extra.push({ clause: '(src_port = ? OR dst_port = ?)', params: [port, port] });
    if (peer) extra.push({ clause: '(src_ip = ? OR dst_ip = ? OR ext_ip = ?)', params: [peer, peer, peer] });
    const m = win(extra);
    const s = win(); // scan window: agent+time(+proto/dir/internal) only
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;
    const bsec = Number.isInteger(bucketSec) && bucketSec > 0 ? bucketSec : 300;

    const [talkers, byPort, byProto, series, totals, scans] = await Promise.all([
      q(`SELECT src_ip, dst_ip, ext_ip, MAX(asn_name) AS asnName, MAX(country) AS country, MAX(internal) AS internal,
                SUM(bytes) AS bytes, SUM(packets) AS packets, SUM(flows) AS flowCount
         FROM flow_records WHERE ${m.clause} GROUP BY src_ip, dst_ip, ext_ip ORDER BY bytes DESC LIMIT ?`, [...m.params, lim]),
      q(`SELECT dst_port AS port, proto, SUM(bytes) AS bytes, SUM(flows) AS flowCount
         FROM flow_records WHERE ${m.clause} AND dst_port IS NOT NULL GROUP BY dst_port, proto ORDER BY bytes DESC LIMIT 20`, m.params),
      q(`SELECT proto, SUM(bytes) AS bytes, SUM(flows) AS flowCount
         FROM flow_records WHERE ${m.clause} GROUP BY proto ORDER BY bytes DESC LIMIT 20`, m.params),
      q(`SELECT FLOOR(UNIX_TIMESTAMP(ts) / ?) AS b, SUM(bytes) AS bytes, SUM(flows) AS flowCount
         FROM flow_records WHERE ${m.clause} GROUP BY b ORDER BY b ASC`, [bsec, ...m.params]),
      q(`SELECT SUM(bytes) AS bytes, SUM(packets) AS packets, SUM(flows) AS flowCount, COUNT(*) AS records
         FROM flow_records WHERE ${m.clause}`, m.params),
      q(`SELECT src_ip, COUNT(DISTINCT dst_port) AS ports, COUNT(DISTINCT dst_ip) AS hosts,
                SUM(bytes) AS bytes, SUM(flows) AS flowCount
         FROM flow_records WHERE ${s.clause} AND src_ip IS NOT NULL
         GROUP BY src_ip HAVING ports >= ? OR hosts >= ? ORDER BY ports DESC, hosts DESC LIMIT 20`,
      [...s.params, scanPortThreshold, scanHostThreshold]),
    ]);

    const t = totals[0] || {};
    return {
      topTalkers: talkers.map((r) => ({
        srcIp: r.src_ip, dstIp: r.dst_ip, extIp: r.ext_ip, asnName: r.asnName ?? null, country: r.country ?? null,
        internal: !!r.internal, bytes: numOf(r.bytes), packets: numOf(r.packets), flowCount: numOf(r.flowCount),
      })),
      byPort: byPort.map((r) => ({ port: r.port, proto: r.proto, bytes: numOf(r.bytes), flowCount: numOf(r.flowCount) })),
      byProto: byProto.map((r) => ({ proto: r.proto, bytes: numOf(r.bytes), flowCount: numOf(r.flowCount) })),
      series: series.map((r) => ({ at: new Date(numOf(r.b) * bsec * 1000).toISOString(), bytes: numOf(r.bytes), flowCount: numOf(r.flowCount) })),
      scans: scans.map((r) => ({
        srcIp: r.src_ip, distinctPorts: numOf(r.ports), distinctHosts: numOf(r.hosts),
        bytes: numOf(r.bytes), flowCount: numOf(r.flowCount),
        kind: numOf(r.ports) >= scanPortThreshold ? 'port-scan' : 'fan-out',
      })),
      totals: { bytes: numOf(t.bytes), packets: numOf(t.packets), flowCount: numOf(t.flowCount), records: numOf(t.records) },
    };
  }

  // Flow-derived dependency/topology edges: who-talks-to-whom, aggregated by the
  // (src_ip, dst_ip) conversation across the fleet (or one agent) over [from, to).
  // Raw flow_records only (5-tuple metadata, never payload); INCLUDES internal
  // RFC1918↔RFC1918 conversations so the graph shows the LAN, and carries the
  // external endpoint's asn/country for classifying public peers. All filters are
  // bound parameters. Capped + ordered by bytes so the heaviest edges win.
  async function topologyEdges({ agentId = null, locationId = null, from, to, limit = 300 }) {
    const where = ['ts >= ?', 'ts < ?', 'src_ip IS NOT NULL', 'dst_ip IS NOT NULL'];
    const params = [from, to];
    if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
    else if (locationId) { where.push('agent_id IN (SELECT id FROM agents WHERE location_id = ?)'); params.push(locationId); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 2000 ? limit : 300;
    const rows = await q(
      `SELECT src_ip, dst_ip, ext_ip, MAX(internal) AS internal, MAX(asn) AS asn,
              MAX(asn_name) AS asnName, MAX(country) AS country,
              SUM(bytes) AS bytes, SUM(packets) AS packets, SUM(flows) AS flowCount
       FROM flow_records WHERE ${where.join(' AND ')}
       GROUP BY src_ip, dst_ip, ext_ip ORDER BY bytes DESC LIMIT ?`,
      [...params, lim]
    );
    return rows.map((r) => ({
      srcIp: r.src_ip, dstIp: r.dst_ip, extIp: r.ext_ip, internal: !!r.internal,
      asn: normAsn(r.asn), asnName: r.asnName ?? null, country: r.country ?? null,
      bytes: numOf(r.bytes), packets: numOf(r.packets), flowCount: numOf(r.flowCount),
    }));
  }

  // Global-search helpers: which agents have recently seen a given IP / port?
  // Raw flow_records only (the rollup keeps no per-IP/port detail), windowed.
  async function agentIdsForIp({ ip, since, until }) {
    const rows = await q(
      `SELECT DISTINCT agent_id FROM flow_records
       WHERE (src_ip = ? OR dst_ip = ? OR ext_ip = ?) AND ts >= ? AND ts < ? LIMIT 200`,
      [ip, ip, ip, since, until]
    );
    return [...new Set(rows.map((r) => r.agent_id))];
  }

  async function agentIdsForPort({ port, since, until }) {
    const rows = await q(
      `SELECT DISTINCT agent_id FROM flow_records
       WHERE (src_port = ? OR dst_port = ?) AND ts >= ? AND ts < ? LIMIT 200`,
      [port, port, since, until]
    );
    return [...new Set(rows.map((r) => r.agent_id))];
  }

  return { insertMany, aggregateExternalDestinations, destinationExists, agentIdsForDestination, selectFlows, exploreFlows, topologyEdges, agentIdsForIp, agentIdsForPort, asnSeries };
}

module.exports = { createFlowsRepository, toRow };
