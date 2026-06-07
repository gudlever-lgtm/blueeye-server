'use strict';

const COLUMNS = ['agent_id', 'ts', 'type', 'target', 'ok', 'rtt_ms', 'min_ms', 'max_ms', 'jitter_ms', 'loss_pct', 'status', 'cert_expiry_days', 'hops', 'detail'];

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
    Array.isArray(r.hops) ? JSON.stringify(r.hops) : null,
    r.detail != null ? String(r.detail).slice(0, 255) : null,
  ];
}

function parseHops(v) {
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
    hops: parseHops(row.hops),
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
       FROM probe_results WHERE ts >= ? ORDER BY ts DESC LIMIT ?`,
      [since, lim]
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
    const where = ['pr.ts >= ?', 'pr.ts <= ?'];
    const params = [from, to];
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

  return { createMany, findByAgent, latestByAgent, fleetHealth, availability };
}

module.exports = { createProbeResultsRepository, toRow, fromRow };
