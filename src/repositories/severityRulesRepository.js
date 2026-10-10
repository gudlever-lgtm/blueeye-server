'use strict';

const { numOrNull } = require('../lib/num');

// Data-access for `event_severity_rules` (migration 086), plus the small cache
// that makes it usable from the write path.
//
// Every finding BlueEyes stores goes through the rule set, so a query per
// finding would put a round trip in front of every anomaly the analyser
// produces. The rules are a handful of rows that change when a person edits
// them, so they are cached with a short TTL — the same shape the Service Tests
// settings service uses, for the same reason.
function createSeverityRulesRepository({ db, now = () => new Date(), ttlMs = 30000 }) {
  const { pool } = db;

  const COLS = `id, tenant_id, source, pattern_id, match_metric, match_kind, match_host_id,
    match_application_id, severity, reason, enabled, applied_count,
    last_applied_at, created_by, created_at, updated_at`;

  // A rule may take its match from a named PATTERN (migration 146) instead of
  // carrying its own fields. Resolved here, in SQL, so everything downstream —
  // the pure matcher, the backfill, the preview — keeps seeing a plain rule with
  // match_* columns and never has to know a pattern exists.
  //
  // IF rather than COALESCE: a pattern that leaves a field blank means "any",
  // and COALESCE would let the rule's own stale column leak back in and narrow
  // the match to something nobody wrote. A pattern-backed rule whose pattern is
  // DISABLED is left out entirely, because its own columns are blank and a rule
  // with nothing pinned down governs every event from its source.
  const RESOLVED = `r.id, r.tenant_id, r.source, r.pattern_id,
    IF(r.pattern_id IS NULL, r.match_metric, p.match_metric) AS match_metric,
    IF(r.pattern_id IS NULL, r.match_kind, p.match_kind) AS match_kind,
    IF(r.pattern_id IS NULL, r.match_host_id, p.match_host_id) AS match_host_id,
    IF(r.pattern_id IS NULL, r.match_application_id, p.match_application_id) AS match_application_id,
    r.severity, r.reason, r.enabled, r.applied_count, r.last_applied_at,
    r.created_by, r.created_at, r.updated_at, p.name AS pattern_name`;

  let cache = null;
  let cachedAt = 0;

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      source: row.source,
      pattern_id: row.pattern_id ?? null,
      pattern_name: row.pattern_name ?? null,
      match_metric: row.match_metric,
      match_kind: row.match_kind,
      match_host_id: row.match_host_id,
      match_application_id: row.match_application_id,
      severity: row.severity,
      reason: row.reason,
      enabled: row.enabled === 1 || row.enabled === true,
      applied_count: row.applied_count,
      last_applied_at: row.last_applied_at,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function invalidate() { cache = null; cachedAt = 0; }

  // The ENABLED rules, cached. Used by the write path.
  //
  // A read failure returns the LAST KNOWN set rather than an empty one, and an
  // empty one rather than throwing: a database hiccup must not silently turn
  // every rule off and start paging on everything the operator muted, and it
  // must not stop a finding being stored at all.
  async function active() {
    if (cache && Date.now() - cachedAt < ttlMs) return cache;
    try {
      const [rows] = await pool.query(
        `SELECT ${RESOLVED}
           FROM event_severity_rules r
           LEFT JOIN event_patterns p ON p.id = r.pattern_id
          WHERE r.enabled = 1 AND (r.pattern_id IS NULL OR p.enabled = 1)`
      );
      cache = rows.map(shape);
      cachedAt = Date.now();
    } catch {
      if (!cache) cache = [];
    }
    return cache;
  }

  // The rule AS STORED, plus its pattern's name — not the resolved match. The
  // editor has to show what the person wrote, and the API has to say which
  // pattern a rule follows rather than silently presenting the pattern's fields
  // as the rule's own.
  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${COLS.split(',').map((c) => c.trim()).map((c) => `r.${c}`).join(', ')}, p.name AS pattern_name
         FROM event_severity_rules r
         LEFT JOIN event_patterns p ON p.id = r.pattern_id
        WHERE r.id = ? LIMIT 1`, [id]
    );
    return shape(rows[0]);
  }

  async function list({ source = null, enabledOnly = false, patternId = null } = {}) {
    const where = [];
    const params = [];
    if (source) { where.push('r.source = ?'); params.push(source); }
    if (enabledOnly) where.push('r.enabled = 1');
    if (patternId !== null && patternId !== undefined) { where.push('r.pattern_id = ?'); params.push(patternId); }
    const [rows] = await pool.query(
      `SELECT ${COLS.split(',').map((c) => c.trim()).map((c) => `r.${c}`).join(', ')}, p.name AS pattern_name
         FROM event_severity_rules r
         LEFT JOIN event_patterns p ON p.id = r.pattern_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.source, r.id DESC`,
      params
    );
    return rows.map(shape);
  }

  async function create(input) {
    const [res] = await pool.query(
      `INSERT INTO event_severity_rules
         (source, pattern_id, match_metric, match_kind, match_host_id, match_application_id,
          severity, reason, enabled, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.source, numOrNull(input.pattern_id), input.match_metric ?? null, input.match_kind ?? null,
        input.match_host_id ?? null, numOrNull(input.match_application_id),
        input.severity, input.reason ?? null,
        input.enabled === false ? 0 : 1, numOrNull(input.created_by)]
    );
    invalidate();
    return findById(res.insertId);
  }

  async function save(id, input) {
    const sets = [];
    const params = [];
    for (const f of ['match_metric', 'match_kind', 'match_host_id', 'severity', 'reason']) {
      if (input[f] !== undefined) { sets.push(`${f} = ?`); params.push(input[f]); }
    }
    if (input.match_application_id !== undefined) {
      sets.push('match_application_id = ?');
      params.push(numOrNull(input.match_application_id));
    }
    if (input.pattern_id !== undefined) {
      sets.push('pattern_id = ?');
      params.push(numOrNull(input.pattern_id));
    }
    if (input.enabled !== undefined) { sets.push('enabled = ?'); params.push(input.enabled ? 1 : 0); }
    if (!sets.length) return findById(id);
    params.push(id);
    const [res] = await pool.query(`UPDATE event_severity_rules SET ${sets.join(', ')} WHERE id = ?`, params);
    invalidate();
    if (!res.affectedRows) return null;
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM event_severity_rules WHERE id = ?', [id]);
    invalidate();
    return (res.affectedRows || 0) > 0;
  }

  // Counts a rule firing, so a rule that has never matched is visible. A rule
  // nobody can tell is dead is one nobody dares delete.
  //
  // Best-effort and deliberately not awaited by the write path: a counter that
  // fails must never stop a finding being stored.
  async function recordApplied(id) {
    try {
      await pool.query(
        'UPDATE event_severity_rules SET applied_count = applied_count + 1, last_applied_at = ? WHERE id = ?',
        [now(), id]
      );
    } catch { /* a statistic is not worth failing a write for */ }
  }

  return { active, findById, list, create, save, remove, recordApplied, invalidate };
}

module.exports = { createSeverityRulesRepository };
