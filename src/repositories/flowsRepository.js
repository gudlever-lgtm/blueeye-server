'use strict';

const { WELL_KNOWN } = require('../flows/services');

// How many service ports topologyEdges() keeps per edge — the dominant few are
// what a reader needs ("Modbus/TCP, then HTTPS"); the long tail is noise.
const SERVICES_PER_EDGE = 3;

const COLUMNS = [
  'agent_id', 'ts', 'src_ip', 'dst_ip', 'ext_ip', 'direction', 'proto',
  'src_port', 'dst_port', 'bytes', 'packets', 'flows', 'internal',
  'country', 'asn', 'asn_name',
  // Migration 145: the destination's city, written only where it can be said
  // honestly (src/geo/destinationPlace.js). NULL = draw it on the centroid.
  'city', 'city_lat', 'city_lng',
  // Migration 127: the 802.1Q VLAN and the exporter's in/out ifIndex. NULL
  // whenever the agent did not report them (NetFlow v5, older agents).
  'vlan', 'in_if', 'out_if',
];

// A VLAN id (1..4094) / ifIndex (positive 32-bit) or NULL. The agent already
// validates both; this keeps a bad value from failing a whole bulk insert on a
// column range.
const vlanOrNull = (v) => {
  const n = Number(v);
  return v != null && Number.isInteger(n) && n >= 1 && n <= 4094 ? n : null;
};
const ifOrNull = (v) => {
  const n = Number(v);
  return v != null && Number.isInteger(n) && n > 0 && n <= 0xffffffff ? n : null;
};

// A latitude/longitude in range, or NULL. A city without a point is drawn on
// the centroid, which is the honest fallback; 0,0 is a place in the Atlantic.
const coordOrNull = (v, max) => {
  const n = Number(v);
  return v != null && Number.isFinite(n) && Math.abs(n) <= max ? n : null;
};

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
    r.city ?? null,
    coordOrNull(r.cityLat, 90),
    coordOrNull(r.cityLng, 180),
    vlanOrNull(r.vlan),
    ifOrNull(r.inIf),
    ifOrNull(r.outIf),
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

  // The newest raw flow record per agent — the coverage report's "has this
  // agent produced flows lately" (src/coverage/). GROUP BY agent_id with
  // MAX(ts) is answered from idx_flows_agent_ts as a loose index scan (one
  // probe per agent, not a scan of the window), and the result is one row per
  // agent that has EVER had a raw record, so it is bounded by the fleet.
  async function lastFlowAtByAgent() {
    const rows = await q(
      'SELECT agent_id, MAX(ts) AS last_ts FROM flow_records GROUP BY agent_id',
      [],
    );
    return rows.map((r) => ({
      agentId: Number(r.agent_id),
      lastFlowAt: r.last_ts == null ? null : new Date(r.last_ts).toISOString(),
    }));
  }

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

    // The city widens the key for raw rows only: flow_rollup has no city
    // column (and no ext_ip to recover one from), so a period reaching past
    // raw retention contributes one city-less row per (country, ASN) that the
    // map draws on the centroid. Same totals either way — a window that spans
    // the horizon just shows the older half at country level.
    const [raw, roll] = await Promise.all([
      q(`SELECT country, asn, city, MAX(asn_name) AS asnName,
                MAX(city_lat) AS cityLat, MAX(city_lng) AS cityLng,
                SUM(bytes) AS bytes, SUM(flows) AS flowCount
         FROM flow_records WHERE ${rawWhere.join(' AND ')} GROUP BY country, asn, city`, rawParams),
      q(`SELECT country, asn, MAX(asn_name) AS asnName, SUM(bytes) AS bytes, SUM(flow_count) AS flowCount
         FROM flow_rollup WHERE ${rollWhere.join(' AND ')} GROUP BY country, asn`, rollParams),
    ]);

    // Normalise asn (NULL in raw, 0 in rollup) before keying so "unknown ASN"
    // collapses to a single row per country.
    return mergeRows(
      [...raw, ...roll].map((r) => ({ ...r, asn: normAsn(r.asn), city: r.city || null })),
      (r) => `${r.country}|${r.asn ?? ''}|${r.city ?? ''}`,
      (r) => ({
        country: r.country,
        asn: r.asn,
        city: r.city ?? null,
        cityLat: r.cityLat ?? null,
        cityLng: r.cityLng ?? null,
      }),
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
    const key = (r) => `${r.country}|${r.asn ?? ''}|${r.city ?? ''}`;
    const prevMap = new Map(prev.map((r) => [key(r), Number(r.bytes) || 0]));
    return cur.map((r) => {
      const bytes = Number(r.bytes) || 0;
      const pb = prevMap.get(key(r)) || 0;
      const deviation = pb > 0 ? (bytes - pb) / pb : (bytes > 0 ? 1 : 0);
      return {
        country: r.country,
        asn: r.asn ?? null,
        asnName: r.asnName ?? null,
        city: r.city ?? null,
        cityLat: r.cityLat != null ? Number(r.cityLat) : null,
        cityLng: r.cityLng != null ? Number(r.cityLng) : null,
        bytes,
        flowCount: Number(r.flowCount) || 0,
        deviation,
      };
    });
  }

  // WHERE clause + params for the public flows matching a destination selection.
  // The raw and rollup tables differ only in how "public" is expressed
  // (internal=0 vs a non-empty country) and in their timestamp column.
  function destFilter({ publicPredicate, tsCol, hasCity = false }, { country, asn, city, since, until }) {
    const where = [publicPredicate, `${tsCol} >= ?`, `${tsCol} < ?`];
    const params = [since, until];
    if (country) { where.push('country = ?'); params.push(country); }
    if (asn !== null && asn !== undefined && asn !== '') { where.push('asn = ?'); params.push(Number(asn)); }
    // A city narrows the selection to the circle that was clicked, but only on
    // the raw table — flow_rollup has no city, so an unqualified rollup would
    // quietly fold the rest of the country back in. A city selection is
    // therefore raw-only, which is also the only window the city exists in.
    if (city !== null && city !== undefined && city !== '') {
      if (!hasCity) return { clause: where.join(' AND '), params, excluded: true };
      where.push('city = ?'); params.push(String(city));
    }
    return { clause: where.join(' AND '), params, excluded: false };
  }
  const rawDestFilter = (sel) => destFilter({ publicPredicate: 'internal = 0', tsCol: 'ts', hasCity: true }, sel);
  const rollDestFilter = (sel) => destFilter({ publicPredicate: "country <> ''", tsCol: 'bucket' }, sel);

  // True if any public flow exists (raw OR rollup) for the selection.
  async function destinationExists({ country = null, asn = null, city = null, since, until }) {
    const raw = rawDestFilter({ country, asn, city, since, until });
    const roll = rollDestFilter({ country, asn, city, since, until });
    const [a, b] = await Promise.all([
      q(`SELECT 1 FROM flow_records WHERE ${raw.clause} LIMIT 1`, raw.params),
      roll.excluded ? [] : q(`SELECT 1 FROM flow_rollup WHERE ${roll.clause} LIMIT 1`, roll.params),
    ]);
    return a.length > 0 || b.length > 0;
  }

  // Distinct agent ids that talked to the selection (raw + rollup).
  async function agentIdsForDestination({ country = null, asn = null, city = null, since, until }) {
    const raw = rawDestFilter({ country, asn, city, since, until });
    const roll = rollDestFilter({ country, asn, city, since, until });
    const [a, b] = await Promise.all([
      q(`SELECT DISTINCT agent_id FROM flow_records WHERE ${raw.clause}`, raw.params),
      roll.excluded ? [] : q(`SELECT DISTINCT agent_id FROM flow_rollup WHERE ${roll.clause}`, roll.params),
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
  async function selectFlows({ country = null, asn = null, city = null, since, until }) {
    const raw = rawDestFilter({ country, asn, city, since, until });
    const roll = rollDestFilter({ country, asn, city, since, until });
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
    // A city selection has no rollup half (flow_rollup has no city column), so
    // the detail covers the raw window only rather than silently widening to
    // the whole country.
    const empty = { byAsn: [], byDir: [], series: [], totals: [] };
    const rollAgg = roll.excluded
      ? empty
      : aggregates({ table: 'flow_rollup', flowCol: 'flow_count', tsCol: 'bucket' }, roll);
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
    const edges = rows.map((r) => ({
      srcIp: r.src_ip, dstIp: r.dst_ip, extIp: r.ext_ip, internal: !!r.internal,
      asn: normAsn(r.asn), asnName: r.asnName ?? null, country: r.country ?? null,
      bytes: numOf(r.bytes), packets: numOf(r.packets), flowCount: numOf(r.flowCount),
      services: [],
    }));
    if (!edges.length) return edges;

    // WHAT each edge carries: the dominant service ports per (src, dst), so a
    // PLC<->SCADA edge reads "Modbus/TCP" and not just "10.1.1.5 -> 10.1.1.9".
    // A second query, restricted to exactly the edges above (row-constructor
    // IN), so it is bounded by the edges returned (20 rows each at most) rather
    // than by the window. The
    // service end is chosen in SQL by the same rule as services.servicePortOf:
    // a named dst_port, else a named src_port, else the lower port. The named
    // list is bound as parameters, never interpolated. Top SERVICES_PER_EDGE per
    // edge are kept; the rest of an edge's bytes stay in its total only.
    const named = [...WELL_KNOWN.keys()];
    const pairs = [...new Set(edges.map((e) => `${e.srcIp}\0${e.dstIp}`))].map((k) => k.split('\0'));
    const svcRows = await q(
      `SELECT src_ip, dst_ip, proto,
              (CASE WHEN dst_port IS NULL THEN src_port
                    WHEN src_port IS NULL THEN dst_port
                    WHEN dst_port IN (?) THEN dst_port
                    WHEN src_port IN (?) THEN src_port
                    ELSE LEAST(src_port, dst_port) END) AS svc_port,
              SUM(bytes) AS bytes
       FROM flow_records WHERE ${where.join(' AND ')} AND (src_ip, dst_ip) IN (?)
       GROUP BY src_ip, dst_ip, proto, svc_port ORDER BY bytes DESC LIMIT ?`,
      [named, named, ...params, pairs, Math.min(pairs.length * 20, 20000)]
    );
    const byPair = new Map();
    for (const r of svcRows) {
      const port = r.svc_port == null ? null : Number(r.svc_port);
      if (!Number.isInteger(port) || port < 1) continue;
      const key = `${r.src_ip}\0${r.dst_ip}`;
      const list = byPair.get(key) || [];
      if (list.length < SERVICES_PER_EDGE) list.push({ port, proto: r.proto ?? null, bytes: numOf(r.bytes) });
      byPair.set(key, list);
    }
    for (const e of edges) e.services = byPair.get(`${e.srcIp}\0${e.dstIp}`) || [];
    return edges;
  }

  // Service-dependency input: TCP conversations aggregated by (src_ip, dst_ip,
  // dst_port) over [from, to). Metadata only (5-tuple), TCP only, with a real
  // dst_port — the raw material the service-dependency job resolves to
  // host↔host edges. `flows` (per-row flow count) sums to conn_count; MIN/MAX ts
  // bound the observation window. Raw flow_records only (rollups drop ports).
  async function tcpServiceFlows({ from, to, limit = 100000 }) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500000 ? limit : 100000;
    const rows = await q(
      `SELECT src_ip, dst_ip, dst_port,
              SUM(bytes) AS bytes, SUM(packets) AS packets, SUM(flows) AS connCount,
              MIN(ts) AS firstSeen, MAX(ts) AS lastSeen
       FROM flow_records
       WHERE ts >= ? AND ts < ? AND LOWER(proto) = 'tcp'
         AND src_ip IS NOT NULL AND dst_ip IS NOT NULL AND dst_port IS NOT NULL
       GROUP BY src_ip, dst_ip, dst_port
       ORDER BY bytes DESC LIMIT ?`,
      [from, to, lim],
    );
    return rows.map((r) => ({
      srcIp: r.src_ip, dstIp: r.dst_ip, dstPort: Number(r.dst_port),
      bytes: numOf(r.bytes), packets: numOf(r.packets), connCount: numOf(r.connCount),
      firstSeen: r.firstSeen, lastSeen: r.lastSeen,
    }));
  }

  // Traffic-map input: public flows grouped by (agent, country, asn, direction,
  // service port) over [from, to). The service port is the well-known end of
  // the conversation — dst_port for outbound, src_port for inbound (the remote
  // server's port) — so the caller can classify each group into a traffic-type
  // category (port kind) or organisation (asn kind). Raw flow_records only,
  // external destinations only (internal RFC1918 traffic is never geolocated).
  // All filters are bound parameters; capped + ordered by bytes.
  async function mapFlows({ agentId = null, locationId = null, from, to, limit = 2000 }) {
    const where = ['internal = 0', 'country IS NOT NULL', 'ts >= ?', 'ts < ?'];
    const params = [from, to];
    if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
    else if (locationId) { where.push('agent_id IN (SELECT id FROM agents WHERE location_id = ?)'); params.push(locationId); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 10000 ? limit : 2000;
    const rows = await q(
      `SELECT agent_id, country, asn, MAX(asn_name) AS asnName, direction,
              (CASE WHEN direction = 'in' THEN src_port ELSE dst_port END) AS port,
              SUM(bytes) AS bytes, SUM(flows) AS flowCount
       FROM flow_records WHERE ${where.join(' AND ')}
       GROUP BY agent_id, country, asn, direction, port
       ORDER BY bytes DESC LIMIT ?`,
      [...params, lim]
    );
    return rows.map((r) => ({
      agentId: r.agent_id, country: r.country, asn: normAsn(r.asn), asnName: r.asnName ?? null,
      direction: r.direction ?? null, port: r.port != null ? Number(r.port) : null,
      bytes: numOf(r.bytes), flowCount: numOf(r.flowCount),
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

  // FLEET-WIDE scan / fan-out candidates over [from, to): one row per
  // (agent, source address) that touched at least `portThreshold` distinct
  // destination ports or `hostThreshold` distinct destination hosts.
  //
  // The same shape exploreFlows() returns in its `scans` array, and
  // deliberately the same SQL — but across every agent, and without the
  // conversation filters, because the detector asks a different question. The
  // explorer answers "show me what this agent saw", on demand, for a technician
  // who is already looking. This answers "did anything sweep the network in the
  // last quarter of an hour", unprompted, for a technician who is not.
  //
  // Raw flow_records only: the rollups keep no per-port detail, which is the
  // whole signal here. Windowed and capped, and the (agent_id, ts) index serves
  // the window; a scan detector that can table-scan the flow table on a busy
  // fleet is a denial of service on its own server.
  //
  // `firstSeen` / `lastSeen` are what the finding's window is built from, so a
  // three-second burst is not reported as a fifteen-minute one.
  async function scanCandidates({
    from, to, agentId = null, portThreshold = 50, hostThreshold = 50, limit = 100,
  }) {
    const where = ['ts >= ?', 'ts < ?', 'src_ip IS NOT NULL'];
    const params = [from, to];
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 100;
    const rows = await q(
      `SELECT agent_id, src_ip,
              COUNT(DISTINCT dst_port) AS ports, COUNT(DISTINCT dst_ip) AS hosts,
              SUM(bytes) AS bytes, SUM(packets) AS packets, SUM(flows) AS flowCount,
              MIN(ts) AS firstSeen, MAX(ts) AS lastSeen,
              MAX(internal) AS internal
       FROM flow_records WHERE ${where.join(' AND ')}
       GROUP BY agent_id, src_ip
       HAVING ports >= ? OR hosts >= ?
       ORDER BY ports DESC, hosts DESC LIMIT ?`,
      [...params, portThreshold, hostThreshold, lim],
    );
    return rows.map((r) => ({
      agentId: Number(r.agent_id),
      srcIp: r.src_ip,
      distinctPorts: numOf(r.ports),
      distinctHosts: numOf(r.hosts),
      bytes: numOf(r.bytes),
      packets: numOf(r.packets),
      flowCount: numOf(r.flowCount),
      firstSeen: r.firstSeen ? new Date(r.firstSeen) : null,
      lastSeen: r.lastSeen ? new Date(r.lastSeen) : null,
      internal: !!r.internal,
    }));
  }

  // The EXTERNAL networks each agent talked to over [from, to): one row per
  // (agent, ASN, country), with the heaviest conversation's addresses as
  // evidence. Feeds the new-peer memory (known_peers, migration 142).
  //
  // internal = 0 only, so RFC1918 conversations never appear — they are never
  // geolocated (docs/geo.md) and have no ASN to be new.
  //
  // NOT Top-N: a first sighting is usually a handful of packets, and ordering
  // by volume would hide exactly the row this exists to find. Capped instead,
  // which the GROUP BY makes safe — there are ~75 000 routed ASNs in total and
  // one agent reaches a few hundred in an hour.
  async function externalPeersSince({ from, to, agentId = null, limit = 5000 }) {
    const where = ['ts >= ?', 'ts < ?', 'internal = 0', '(asn IS NOT NULL OR country IS NOT NULL)'];
    const params = [from, to];
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 20000 ? limit : 5000;
    const rows = await q(
      `SELECT agent_id, asn, MAX(asn_name) AS asnName, country,
              SUM(bytes) AS bytes, SUM(flows) AS flowCount,
              MIN(ts) AS firstSeen, MAX(ts) AS lastSeen,
              MAX(src_ip) AS srcIp, MAX(ext_ip) AS extIp
       FROM flow_records WHERE ${where.join(' AND ')}
       GROUP BY agent_id, asn, country
       ORDER BY agent_id ASC LIMIT ?`,
      [...params, lim],
    );
    return rows.map((r) => ({
      agentId: Number(r.agent_id),
      asn: r.asn == null ? null : Number(r.asn),
      asnName: r.asnName ?? null,
      country: r.country ?? null,
      bytes: numOf(r.bytes),
      flowCount: numOf(r.flowCount),
      firstSeen: r.firstSeen ? new Date(r.firstSeen) : null,
      lastSeen: r.lastSeen ? new Date(r.lastSeen) : null,
      srcIp: r.srcIp ?? null,
      extIp: r.extIp ?? null,
    }));
  }

  // How often each agent REPORTS flows over [from, to) — the grid every
  // observation below is quantised to.
  //
  // WHY THE BEACON DETECTOR CANNOT WORK WITHOUT THIS. An agent sends a flow
  // snapshot on its own cadence (BLUEEYE_REPORT_INTERVAL_MS, 60 s by default),
  // so one row per 5-tuple per interval it was active in. A conversation that
  // never stops — an SSH session left open, a replication link — therefore
  // appears in EVERY interval, at a perfectly regular spacing, which is the
  // exact shape a beacon has. The only thing that separates them is the
  // cadence: a beacon skips intervals, a stream does not. A hard-coded 60 s
  // would call every long-lived session on a five-minute agent a beacon.
  //
  // Mean rather than median spacing: one grouped read instead of pulling every
  // distinct timestamp, and the value is a scale (is this 60 s or 300 s), not a
  // measurement. `null` for an agent with fewer than two reports — nothing to
  // derive a cadence from, and the detector skips it rather than guessing.
  async function reportCadence({ from, to, agentId = null }) {
    const where = ['ts >= ?', 'ts < ?'];
    const params = [from, to];
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    const rows = await q(
      `SELECT agent_id, COUNT(DISTINCT ts) AS reports, MIN(ts) AS firstTs, MAX(ts) AS lastTs
       FROM flow_records WHERE ${where.join(' AND ')} GROUP BY agent_id`,
      params,
    );
    const out = new Map();
    for (const r of rows) {
      const reports = numOf(r.reports);
      if (reports < 2 || !r.firstTs || !r.lastTs) { out.set(Number(r.agent_id), null); continue; }
      const spanSec = (new Date(r.lastTs).getTime() - new Date(r.firstTs).getTime()) / 1000;
      out.set(Number(r.agent_id), spanSec > 0 ? spanSec / (reports - 1) : null);
    }
    return out;
  }

  // OUTBOUND conversations that were seen often enough over [from, to) to be
  // worth testing for regularity: one row per (agent, internal source, external
  // peer, destination port, protocol) with at least `minObservations` distinct
  // report timestamps.
  //
  // `ext_ip <> src_ip` is what makes it outbound: ext_ip is the public endpoint
  // the enrichment resolved, so when it is not the source, the source is the
  // internal host and the peer is outside. An inbound conversation is somebody
  // else's beacon, not this network's.
  //
  // This is only the CANDIDATE list — a count, not a verdict. The regularity
  // test needs the timestamps themselves (beaconTimestamps below), which is the
  // expensive half, so it runs on this short list rather than on the table.
  async function beaconCandidates({
    from, to, agentId = null, minObservations = 12, ignorePorts = [], limit = 100,
  }) {
    const where = [
      'ts >= ?', 'ts < ?', 'internal = 0',
      'src_ip IS NOT NULL', 'ext_ip IS NOT NULL', 'ext_ip <> src_ip', 'dst_port IS NOT NULL',
    ];
    const params = [from, to];
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    // Excluded in SQL rather than after the read: NTP is the loudest legitimate
    // beacon on any network, and pulling its timestamps only to drop it wastes
    // the expensive half of the job.
    const ports = [...new Set((Array.isArray(ignorePorts) ? ignorePorts : [])
      .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0 && n <= 65535))];
    if (ports.length) { where.push('dst_port NOT IN (?)'); params.push(ports); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 1000 ? limit : 100;
    const min = Number.isInteger(minObservations) && minObservations > 1 ? minObservations : 12;
    const rows = await q(
      `SELECT agent_id, src_ip, ext_ip, dst_port, proto,
              COUNT(DISTINCT ts) AS observations,
              MIN(ts) AS firstSeen, MAX(ts) AS lastSeen,
              SUM(bytes) AS bytes, SUM(packets) AS packets, SUM(flows) AS flowCount,
              MAX(asn) AS asn, MAX(asn_name) AS asnName, MAX(country) AS country
       FROM flow_records WHERE ${where.join(' AND ')}
       GROUP BY agent_id, src_ip, ext_ip, dst_port, proto
       HAVING observations >= ?
       ORDER BY observations DESC LIMIT ?`,
      [...params, min, lim],
    );
    return rows.map((r) => ({
      agentId: Number(r.agent_id),
      srcIp: r.src_ip,
      extIp: r.ext_ip,
      dstPort: r.dst_port == null ? null : Number(r.dst_port),
      proto: r.proto ?? null,
      observations: numOf(r.observations),
      firstSeen: r.firstSeen ? new Date(r.firstSeen) : null,
      lastSeen: r.lastSeen ? new Date(r.lastSeen) : null,
      bytes: numOf(r.bytes),
      packets: numOf(r.packets),
      flowCount: numOf(r.flowCount),
      asn: r.asn == null ? null : Number(r.asn),
      asnName: r.asnName ?? null,
      country: r.country ?? null,
    }));
  }

  // The distinct report timestamps of ONE candidate conversation, oldest first.
  // The gaps between them are the whole signal: regular gaps are a beacon,
  // ragged ones are a person. Served by idx_flows_agent_ts and bounded, so a
  // conversation seen in every interval of a long window cannot pull an
  // unbounded list into memory.
  async function beaconTimestamps({ agentId, srcIp, extIp, dstPort, proto, from, to, limit = 5000 }) {
    const where = ['agent_id = ?', 'ts >= ?', 'ts < ?', 'src_ip = ?', 'ext_ip = ?', 'dst_port = ?'];
    const params = [agentId, from, to, srcIp, extIp, dstPort];
    // A NULL proto is a real stored value (an exporter that did not say), and
    // `proto = NULL` never matches — so it is asked for as IS NULL.
    if (proto == null) where.push('proto IS NULL');
    else { where.push('proto = ?'); params.push(proto); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 20000 ? limit : 5000;
    const rows = await q(
      `SELECT DISTINCT ts FROM flow_records WHERE ${where.join(' AND ')} ORDER BY ts ASC LIMIT ?`,
      [...params, lim],
    );
    return rows.map((r) => new Date(r.ts));
  }

  return { insertMany, aggregateExternalDestinations, destinationExists, agentIdsForDestination, selectFlows, exploreFlows, scanCandidates, externalPeersSince, reportCadence, beaconCandidates, beaconTimestamps, mapFlows, topologyEdges, tcpServiceFlows, agentIdsForIp, agentIdsForPort, asnSeries, lastFlowAtByAgent };
}

module.exports = { createFlowsRepository, toRow, COLUMNS };
