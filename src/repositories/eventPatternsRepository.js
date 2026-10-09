'use strict';

const { numOrNull } = require('../lib/num');

// Data-access for `event_patterns` + `alert_routes` (migration 146), plus the
// short-TTL cache the alerting write path reads through.
//
// Every finding that reaches the dispatcher asks "which pattern is this, and
// where does it go", so a query per finding would put two round trips in front
// of every alert. Patterns and routes are a handful of rows that change when a
// person edits them — the same shape, and the same reason, as
// severityRulesRepository's cache.
function createEventPatternsRepository({ db, now = () => new Date(), ttlMs = 30000 }) {
  const { pool } = db;

  const P_COLS = `id, tenant_id, name, source, match_metric, match_kind, match_host_id,
    match_application_id, reason, attack_technique, attack_tactic, enabled,
    created_by, created_at, updated_at`;
  const R_COLS = `id, pattern_id, channels, min_severity, cooldown_ms, reason, enabled,
    matched_count, last_matched_at, created_by, created_at, updated_at`;

  let cache = null;
  let cachedAt = 0;

  function shapePattern(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      name: row.name,
      source: row.source,
      match_metric: row.match_metric,
      match_kind: row.match_kind,
      match_host_id: row.match_host_id,
      match_application_id: row.match_application_id,
      reason: row.reason,
      // The operator's own ATT&CK mapping (migration 147). Null is both the
      // default and the honest answer for a match that maps to no technique.
      attack_technique: row.attack_technique ?? null,
      attack_tactic: row.attack_tactic ?? null,
      enabled: row.enabled === 1 || row.enabled === true,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function shapeRoute(row) {
    if (!row) return null;
    return {
      id: row.id,
      pattern_id: row.pattern_id,
      channels: row.channels,
      min_severity: row.min_severity,
      cooldown_ms: row.cooldown_ms,
      reason: row.reason,
      enabled: row.enabled === 1 || row.enabled === true,
      matched_count: row.matched_count,
      last_matched_at: row.last_matched_at,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function invalidate() { cache = null; cachedAt = 0; }

  // The ENABLED patterns and their routes, cached. Read by the dispatcher.
  //
  // A read failure returns the LAST KNOWN set rather than an empty one, and an
  // empty one rather than throwing: a database hiccup must not silently
  // re-route every alert, and must never stop one being sent. Same posture as
  // the severity rules' cache, for the same reason.
  async function active() {
    if (cache && Date.now() - cachedAt < ttlMs) return cache;
    try {
      const [patterns] = await pool.query(`SELECT ${P_COLS} FROM event_patterns WHERE enabled = 1`);
      const [routes] = await pool.query(
        `SELECT r.*
           FROM alert_routes r
           JOIN event_patterns p ON p.id = r.pattern_id
          WHERE r.enabled = 1 AND p.enabled = 1`
      );
      cache = { patterns: patterns.map(shapePattern), routes: routes.map(shapeRoute) };
      cachedAt = Date.now();
    } catch {
      if (!cache) cache = { patterns: [], routes: [] };
    }
    return cache;
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${P_COLS} FROM event_patterns WHERE id = ? LIMIT 1`, [id]);
    return shapePattern(rows[0]);
  }

  async function findByName(name) {
    const [rows] = await pool.query(`SELECT ${P_COLS} FROM event_patterns WHERE name = ? LIMIT 1`, [name]);
    return shapePattern(rows[0]);
  }

  // Every pattern, each with its route (or null) and how many severity rules
  // point at it. The counts are what make the screen honest: a pattern with
  // three rules and a route is a pattern you cannot delete casually, and the
  // dashboard says so before the button is pressed.
  async function list({ source = null } = {}) {
    const where = [];
    const params = [];
    if (source) { where.push('p.source = ?'); params.push(source); }
    const [rows] = await pool.query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM event_severity_rules s WHERE s.pattern_id = p.id) AS rule_count
         FROM event_patterns p
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY p.source, p.name`,
      params
    );
    const [routes] = await pool.query(
      'SELECT * FROM alert_routes'
    );
    const byPattern = new Map(routes.map((r) => [Number(r.pattern_id), shapeRoute(r)]));
    return rows.map((row) => ({
      ...shapePattern(row),
      rule_count: Number(row.rule_count || 0),
      route: byPattern.get(Number(row.id)) || null,
    }));
  }

  async function create(input) {
    const [res] = await pool.query(
      `INSERT INTO event_patterns
         (name, source, match_metric, match_kind, match_host_id, match_application_id,
          reason, attack_technique, attack_tactic, enabled, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.name, input.source, input.match_metric ?? null, input.match_kind ?? null,
        input.match_host_id ?? null, numOrNull(input.match_application_id),
        input.reason ?? null, input.attack_technique ?? null, input.attack_tactic ?? null,
        input.enabled === false ? 0 : 1, numOrNull(input.created_by)]
    );
    invalidate();
    return findById(res.insertId);
  }

  async function save(id, input) {
    const sets = [];
    const params = [];
    for (const f of ['name', 'match_metric', 'match_kind', 'match_host_id', 'reason',
      'attack_technique', 'attack_tactic']) {
      if (input[f] !== undefined) { sets.push(`${f} = ?`); params.push(input[f]); }
    }
    if (input.match_application_id !== undefined) {
      sets.push('match_application_id = ?');
      params.push(numOrNull(input.match_application_id));
    }
    if (input.enabled !== undefined) { sets.push('enabled = ?'); params.push(input.enabled ? 1 : 0); }
    if (!sets.length) return findById(id);
    params.push(id);
    const [res] = await pool.query(`UPDATE event_patterns SET ${sets.join(', ')} WHERE id = ?`, params);
    invalidate();
    if (!res.affectedRows) return null;
    return findById(id);
  }

  // Deleting a pattern takes its severity rules and its route with it — the
  // foreign keys are ON DELETE CASCADE. That is deliberate: a pattern-backed
  // rule left behind would have no match fields of its own, and a rule with
  // nothing pinned down governs every event from its source.
  async function remove(id) {
    const [res] = await pool.query('DELETE FROM event_patterns WHERE id = ?', [id]);
    invalidate();
    return (res.affectedRows || 0) > 0;
  }

  async function findRoute(patternId) {
    const [rows] = await pool.query(
      `SELECT ${R_COLS} FROM alert_routes WHERE pattern_id = ? LIMIT 1`, [patternId]
    );
    return shapeRoute(rows[0]);
  }

  // One route per pattern, so this is an upsert rather than a create: the
  // screen has one "where do these go" form, not a list that can grow a second
  // contradictory answer.
  async function saveRoute(patternId, input) {
    await pool.query(
      `INSERT INTO alert_routes
         (pattern_id, channels, min_severity, cooldown_ms, reason, enabled, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         channels = VALUES(channels), min_severity = VALUES(min_severity),
         cooldown_ms = VALUES(cooldown_ms), reason = VALUES(reason), enabled = VALUES(enabled)`,
      [patternId, input.channels, input.min_severity ?? null, numOrNull(input.cooldown_ms),
        input.reason ?? null, input.enabled === false ? 0 : 1, numOrNull(input.created_by)]
    );
    invalidate();
    return findRoute(patternId);
  }

  async function removeRoute(patternId) {
    const [res] = await pool.query('DELETE FROM alert_routes WHERE pattern_id = ?', [patternId]);
    invalidate();
    return (res.affectedRows || 0) > 0;
  }

  // Counts a route deciding an alert, so a route that has never fired is
  // visible. Best-effort and never awaited by the dispatcher: a statistic is
  // not worth delaying — or failing — an alert for.
  async function recordRouted(routeId) {
    try {
      await pool.query(
        'UPDATE alert_routes SET matched_count = matched_count + 1, last_matched_at = ? WHERE id = ?',
        [now(), routeId]
      );
    } catch { /* a statistic is not worth failing an alert for */ }
  }

  return {
    active, findById, findByName, list, create, save, remove,
    findRoute, saveRoute, removeRoute, recordRouted, invalidate,
  };
}

module.exports = { createEventPatternsRepository };
