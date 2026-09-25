'use strict';

// Probe types that measure the PATH rather than the target's availability.
// `path_mtu` is a diagnostic somebody runs on purpose, in the middle of an
// outage, against whatever they are chasing — often a host that is already
// down. The probe itself reports ok:true even when it finds a blackhole (the
// finding is about the path, not the agent), so nothing else stops it counting
// as a reachability sample. Counting it would let an investigation move the SLA
// number it is investigating, so uptime and fleet health leave it out. It is
// still stored, still read, still charted; it just does not vote on "is this
// agent healthy".
// `tls` and `rdns` (migration 101) join it for the same reason, arrived at from
// the other side: a certificate that expired yesterday and an address with no
// PTR are both real faults and neither is a REACHABILITY fault — the host
// answers. Counting them would put a perfectly reachable service in the outage
// numbers and drag an SLA figure down for something no network change can fix.
// `dhcp` (migration 132) likewise: "no DHCP server answered" and "two DHCP
// servers answered" are findings of their own (probeFindings.js), but the agent
// that measured them is reachable, and a broadcast test of the segment must not
// be read as an outage of the host running it.
const DIAGNOSTIC_TYPES = ['path_mtu', 'tls', 'rdns', 'dhcp'];

const COLUMNS = ['agent_id', 'ts', 'type', 'target', 'ok', 'rtt_ms', 'min_ms', 'max_ms', 'jitter_ms', 'loss_pct', 'status', 'cert_expiry_days', 'bytes', 'content_type', 'elements', 'hops', 'mtu', 'sizes', 'tls', 'rdns', 'error_code', 'failure', 'resolver', 'dhcp', 'detail'];

function toRow(agentId, r) {
  const ts = r.ts instanceof Date ? r.ts : (r.ts ? new Date(r.ts) : new Date());
  return [
    agentId,
    ts,
    String(r.type),
    String(r.target),
    r.ok ? 1 : 0,
    r.rttMs ?? null,
    r.minMs ?? null,
    r.maxMs ?? null,
    r.jitterMs ?? null,
    r.lossPct ?? null,
    r.status ?? null,
    r.certExpiryDays ?? null,
    r.bytes ?? null,
    r.contentType != null ? String(r.contentType).slice(0, 120) : null,
    Array.isArray(r.elements) ? JSON.stringify(r.elements) : null,
    Array.isArray(r.hops) ? JSON.stringify(r.hops) : null,
    // The path-MTU verdict, written whole (migration 096). Only `path_mtu` rows
    // carry one; every other probe type stores null here.
    r.mtu && typeof r.mtu === 'object' ? JSON.stringify(r.mtu) : null,
    Array.isArray(r.sizes) ? JSON.stringify(r.sizes) : null,
    // The certificate and the reverse-DNS answer (migration 101), each written
    // whole by the one probe type that produces it.
    r.tls && typeof r.tls === 'object' ? JSON.stringify(r.tls) : null,
    r.rdns && typeof r.rdns === 'object' ? JSON.stringify(r.rdns) : null,
    // Why a dns/tcp probe failed (migration 121). Bounded again here because
    // the repository is the last thing between a caller and the column width.
    r.errorCode != null ? String(r.errorCode).slice(0, 32) : null,
    r.failure != null ? String(r.failure).slice(0, 16) : null,
    r.resolver != null ? String(r.resolver).slice(0, 64) : null,
    // The DHCP offers (migration 132), written whole by the dhcp probe only.
    r.dhcp && typeof r.dhcp === 'object' ? JSON.stringify(r.dhcp) : null,
    r.detail != null ? String(r.detail).slice(0, 255) : null,
  ];
}

// mysql2 hands back JSON columns already parsed on some driver versions and as a
// string on others, so both are accepted. A column that will not parse reads as
// absent rather than taking the whole query down.
function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
}

// Maps a DB row to the camelCase shape the API/UI use.
function fromRow(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
    type: row.type,
    target: row.target,
    ok: !!row.ok,
    rttMs: row.rtt_ms,
    minMs: row.min_ms,
    maxMs: row.max_ms,
    jitterMs: row.jitter_ms,
    lossPct: row.loss_pct,
    status: row.status ?? null,
    certExpiryDays: row.cert_expiry_days ?? null,
    bytes: row.bytes ?? null,
    contentType: row.content_type ?? null,
    elements: parseJson(row.elements),
    hops: parseJson(row.hops),
    mtu: parseJson(row.mtu),
    // The ping don't-fragment size sweep (migration 097). NULL on every row an
    // agent older than 0.25 wrote, which is normal while a fleet is still
    // updating — a reader must treat absent as "not measured", never as
    // "no problem".
    sizes: parseJson(row.sizes),
    // The certificate verdict and the reverse-DNS answer (migration 101). NULL
    // on every row written before the fleet reached agent 0.27 — absent means
    // "not measured", never "nothing wrong".
    tls: parseJson(row.tls),
    rdns: parseJson(row.rdns),
    // Why a dns/tcp probe failed (migration 121). NULL on successful rows and
    // on every row an agent that did not report it wrote — "not reported",
    // never "no fault".
    errorCode: row.error_code ?? null,
    failure: row.failure ?? null,
    resolver: row.resolver ?? null,
    // What the DHCP test heard (migration 132). NULL on every other type, on
    // rows before the migration, and on a test that could not run — "not
    // measured"; an empty `offers` list is the measurement "nobody answered".
    dhcp: parseJson(row.dhcp),
    detail: row.detail,
  };
}

// Data-access for `probe_results`.
function createProbeResultsRepository(db) {
  const { pool } = db;

  async function createMany(agentId, results) {
    if (!Array.isArray(results) || results.length === 0) return 0;
    const values = results.map((r) => toRow(agentId, r));
    const [res] = await pool.query(`INSERT INTO probe_results (${COLUMNS.join(', ')}) VALUES ?`, [values]);
    return res.affectedRows;
  }

  // Probe results for one agent in [from, to], optionally a single type. Selects
  // the most-recent N (so the window isn't frozen on ancient rows once the table
  // grows past the limit), then returns them oldest-first for a left-to-right
  // time series.
  async function findByAgent({ agentId, from = null, to = null, type = null, limit = 2000 }) {
    const where = ['agent_id = ?'];
    const params = [agentId];
    if (from) { where.push('ts >= ?'); params.push(from); }
    if (to) { where.push('ts <= ?'); params.push(to); }
    if (type) { where.push('type = ?'); params.push(type); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 2000;
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT * FROM probe_results WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`,
      params
    );
    return rows.map(fromRow).reverse();
  }

  // Recent probe rows across the WHOLE fleet, newest-first, within a time window
  // and capped — for the fleet-health overview, which groups them by agent and
  // derives a verdict in JS (median+MAD baseline). One query, not N. Only the
  // columns the health computation needs.
  async function fleetHealth({ windowMs = 6 * 3600 * 1000, limit = 20000 } = {}) {
    const win = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 6 * 3600 * 1000;
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 50000 ? limit : 20000;
    const since = new Date(Date.now() - win);
    const [rows] = await pool.query(
      `SELECT agent_id, ts, type, target, ok, rtt_ms, jitter_ms, loss_pct
       FROM probe_results WHERE ts >= ? AND type NOT IN (?) ORDER BY ts DESC LIMIT ?`,
      [since, DIAGNOSTIC_TYPES, lim]
    );
    return rows.map((row) => ({
      agentId: row.agent_id,
      ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
      type: row.type,
      target: row.target,
      ok: !!row.ok,
      rttMs: row.rtt_ms,
      jitterMs: row.jitter_ms,
      lossPct: row.loss_pct,
    }));
  }

  // Availability (uptime %) per agent over [from, to], computed from the
  // reachability of every probe in the window (ok / total). Grouped by agent and
  // carrying its location, optionally filtered to one location. Agents with no
  // probes in the window are omitted (no data ⇒ no uptime to report).
  async function availability({ from, to, locationId = null }) {
    const where = ['pr.ts >= ?', 'pr.ts <= ?', 'pr.type NOT IN (?)'];
    const params = [from, to, DIAGNOSTIC_TYPES];
    if (locationId != null) { where.push('a.location_id = ?'); params.push(locationId); }
    const [rows] = await pool.query(
      `SELECT a.location_id, l.name AS location_name, a.id AS agent_id,
              COALESCE(a.display_name, a.hostname) AS agent_name,
              COUNT(*) AS total, SUM(pr.ok = 1) AS up
       FROM probe_results pr
       JOIN agents a ON a.id = pr.agent_id
       LEFT JOIN locations l ON l.id = a.location_id
       WHERE ${where.join(' AND ')}
       GROUP BY a.id, a.location_id, l.name, agent_name
       ORDER BY a.location_id IS NULL, a.location_id, a.id`,
      params
    );
    return rows.map((row) => {
      const total = Number(row.total);
      const up = Number(row.up);
      return {
        locationId: row.location_id == null ? null : Number(row.location_id),
        locationName: row.location_name ?? null,
        agentId: Number(row.agent_id),
        agentName: row.agent_name ?? null,
        total,
        up,
        down: total - up,
        uptimePct: total > 0 ? Math.round((up / total) * 10000) / 100 : null,
      };
    });
  }

  // Rows to ONE target for the path-visualisation metric timeline. `agentId` is
  // optional: pass it for the single-agent series, omit it for the per-agent
  // overlay (every agent probing that target). Only the metric columns are
  // selected, newest-first then reversed to oldest-first. Carries the agent's
  // display name so the overlay legend needs no extra query.
  async function metricRows({ target, agentId = null, from = null, to = null, limit = 5000 }) {
    const where = ['pr.target = ?'];
    const params = [target];
    if (agentId != null) { where.push('pr.agent_id = ?'); params.push(agentId); }
    if (from) { where.push('pr.ts >= ?'); params.push(from); }
    if (to) { where.push('pr.ts <= ?'); params.push(to); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 20000 ? limit : 5000;
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT pr.agent_id, pr.ts, pr.ok, pr.rtt_ms, pr.jitter_ms, pr.loss_pct, pr.bytes,
              COALESCE(a.display_name, a.hostname) AS agent_name
       FROM probe_results pr
       LEFT JOIN agents a ON a.id = pr.agent_id
       WHERE ${where.join(' AND ')}
       ORDER BY pr.ts DESC LIMIT ?`,
      params
    );
    return rows.map((row) => ({
      agentId: row.agent_id,
      agentName: row.agent_name ?? null,
      ts: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
      ok: !!row.ok,
      rttMs: row.rtt_ms,
      jitterMs: row.jitter_ms,
      lossPct: row.loss_pct,
      bytes: row.bytes ?? null,
    })).reverse();
  }

  // The most recent result per (type, target) for an agent — the "current state".
  async function latestByAgent(agentId, limit = 50) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 50;
    const [rows] = await pool.query(
      `SELECT pr.* FROM probe_results pr
       JOIN (SELECT type, target, MAX(id) AS max_id FROM probe_results WHERE agent_id = ? GROUP BY type, target) last
         ON pr.id = last.max_id
       ORDER BY pr.ts DESC LIMIT ?`,
      [agentId, lim]
    );
    return rows.map(fromRow);
  }

  // The recent runs of ONE probe (agent, type, target), newest-first, strictly
  // before `before` when given and no older than `from`. For the diagnose ECMP
  // check, which compares a fresh trace with the ones before it; bounded on
  // both ends so it stays an index range scan (idx_probe_agent_type_target_id).
  async function recentRuns({ agentId, type, target, before = null, from = null, limit = 20 }) {
    const where = ['agent_id = ?', 'type = ?', 'target = ?'];
    const params = [agentId, type, target];
    if (before) { where.push('ts < ?'); params.push(before); }
    if (from) { where.push('ts >= ?'); params.push(from); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 20;
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT * FROM probe_results WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      params
    );
    return rows.map(fromRow);
  }

  // Every run of ONE probe (agent, type, target), newest-first, for the run
  // list. Paged rather than capped: a trace on a five-minute schedule is nearly
  // 900 runs a month, and "the newest 50" is a list, not a history.
  //
  // The rows carry their hops — the caller needs them to tell one route from
  // another — but the list endpoint drops them again before answering, so the
  // hop arrays never leave the server for a list.
  async function listRuns({ agentId, type, target, from = null, to = null, limit = 50, offset = 0 }) {
    const where = ['agent_id = ?', 'type = ?', 'target = ?'];
    const params = [agentId, type, target];
    if (from) { where.push('ts >= ?'); params.push(from); }
    if (to) { where.push('ts <= ?'); params.push(to); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;
    const off = Number.isInteger(offset) && offset > 0 ? Math.min(offset, 100000) : 0;
    params.push(lim, off);
    const [rows] = await pool.query(
      `SELECT * FROM probe_results WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
      params
    );
    return rows.map(fromRow);
  }

  // How many runs that list has in total, so the UI can page without guessing.
  async function countRuns({ agentId, type, target, from = null, to = null }) {
    const where = ['agent_id = ?', 'type = ?', 'target = ?'];
    const params = [agentId, type, target];
    if (from) { where.push('ts >= ?'); params.push(from); }
    if (to) { where.push('ts <= ?'); params.push(to); }
    const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM probe_results WHERE ${where.join(' AND ')}`, params);
    return Number(rows[0] && rows[0].n) || 0;
  }

  // One stored run, with its hops. `agentId` scopes it: a run id from another
  // agent must read as absent, not as somebody else's path.
  async function findRunById(id, { agentId = null } = {}) {
    const where = ['id = ?'];
    const params = [id];
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    const [rows] = await pool.query(`SELECT * FROM probe_results WHERE ${where.join(' AND ')} LIMIT 1`, params);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  // The run immediately before this one for the same probe — what a comparison
  // defaults to, because "what changed since last time" is the question asked
  // far more often than any particular pair.
  async function previousRun({ agentId, type, target, beforeTs, beforeId }) {
    const [rows] = await pool.query(
      `SELECT * FROM probe_results
        WHERE agent_id = ? AND type = ? AND target = ? AND (ts < ? OR (ts = ? AND id < ?))
        ORDER BY ts DESC, id DESC LIMIT 1`,
      [agentId, type, target, beforeTs, beforeTs, beforeId]
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  return {
    createMany, findByAgent, metricRows, latestByAgent, fleetHealth, availability, recentRuns,
    listRuns, countRuns, findRunById, previousRun,
  };
}

module.exports = { createProbeResultsRepository, DIAGNOSTIC_TYPES, COLUMNS, toRow, fromRow };
