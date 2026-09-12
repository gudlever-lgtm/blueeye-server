'use strict';

const { ACTIVE, STATUS, canTransition } = require('../incidents/lifecycle');
const { intOrNull } = require('./shape');

// Data-access for `service_test_incidents` (migration 080) — the durable record
// of "something is wrong here, and here is since when".
//
// The dedup identity is `subject_key` (`test:<id>`,
// `certificate:<application_id>:<host>:<port>` — two applications on one host
// keep their own certificate row, so they keep their own incident)
// and there is at most ONE open row per subject at a time. A repeat observation
// touches that row instead of writing another, so a service that has been down
// all weekend is one incident with 400 occurrences rather than 400 incidents.
// "Not resolved", spelled once. V2 had five queries testing `status = 'open'`,
// which was the same thing while 'open' was the only active state. Migration 090
// added investigating and identified, and an incident somebody had picked up
// would have disappeared from the dashboard it most needs to be on.
const ACTIVE_SQL = `status IN (${ACTIVE.map(() => '?').join(', ')})`;

function createIncidentsRepository({ db, now = () => new Date() }) {
  const { pool } = db;
  const COLS = `id, application_id, environment_id, test_id, subject_type, subject_key, subject_label,
    kind, severity, original_severity, severity_rule_id,
    status, summary, likely_cause, correlated_layer, confidence,
    impact, impact_reason, affected_journeys, explanation, evidence, occurrences,
    opened_at, last_seen_at, resolved_at, resolved_by, resolution,
    acknowledged_at, acknowledged_by, notified_at, notified_severity`;

  // MySQL returns a JSON column as an object on 8.x and as a string on some
  // configurations; both arrive here and neither should reach the API.
  function parseJson(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return null; }
  }

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      application_id: row.application_id,
      environment_id: row.environment_id,
      test_id: row.test_id,
      subject_type: row.subject_type,
      subject_key: row.subject_key,
      subject_label: row.subject_label,
      kind: row.kind,
      severity: row.severity,
      // Non-null only when a severity rule changed this. It travels with the
      // incident so a downgraded critical says on screen that it was
      // downgraded, and by which rule.
      original_severity: row.original_severity == null ? null : row.original_severity,
      severity_rule_id: row.severity_rule_id == null ? null : Number(row.severity_rule_id),
      status: row.status,
      summary: row.summary,
      likely_cause: row.likely_cause,
      // What the correlation engine concluded, as it stood AT THE TIME. Stored
      // rather than recomputed: recomputing against today's data would quietly
      // rewrite what the operator was told during the outage.
      correlated_layer: row.correlated_layer ?? null,
      confidence: row.confidence == null ? null : Number(row.confidence),
      // Service impact, which is not the same as technical failure. Null means
      // nobody has assessed it — never "no impact".
      impact: row.impact ?? null,
      impact_reason: row.impact_reason ?? null,
      affected_journeys: parseJson(row.affected_journeys) || [],
      explanation: row.explanation,
      evidence: parseJson(row.evidence) || [],
      occurrences: row.occurrences,
      opened_at: row.opened_at,
      last_seen_at: row.last_seen_at,
      resolved_at: row.resolved_at,
      resolved_by: row.resolved_by,
      resolution: row.resolution,
      acknowledged_at: row.acknowledged_at ?? null,
      acknowledged_by: row.acknowledged_by ?? null,
      notified_at: row.notified_at,
      notified_severity: row.notified_severity,
    };
  }

  const cut = (v, max) => (v === null || v === undefined ? null : String(v).slice(0, max));

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_incidents WHERE id = ? LIMIT 1`, [id]);
    return shape(rows[0]);
  }

  async function findOpen(subjectKey) {
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_incidents WHERE subject_key = ? AND ${ACTIVE_SQL} ORDER BY id DESC LIMIT 1`,
      [String(subjectKey || '').slice(0, 190), ...ACTIVE]
    );
    return shape(rows[0]);
  }

  async function open(input) {
    const at = input.at || now();
    const [res] = await pool.query(
      `INSERT INTO service_test_incidents
         (application_id, environment_id, test_id, subject_type, subject_key, subject_label,
          kind, severity, status, summary, likely_cause, correlated_layer, confidence,
          impact, impact_reason, affected_journeys, explanation, evidence, occurrences,
          opened_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.application_id || null,
        input.environment_id || null,
        input.test_id || null,
        input.subject_type,
        cut(input.subject_key, 190),
        cut(input.subject_label, 255),
        cut(input.kind, 60),
        input.severity || 'WARN',
        cut(input.summary, 4000),
        cut(input.likely_cause, 255),
        cut(input.correlated_layer, 32),
        // 0-100, or null. `Number(null)` is 0, and a confidence of 0 would read
        // as "certainly not" where the truth is "nobody worked one out".
        input.confidence === null || input.confidence === undefined ? null
          : Math.max(0, Math.min(100, Math.round(Number(input.confidence) || 0))),
        input.impact || null,
        cut(input.impact_reason, 512),
        input.affected_journeys ? JSON.stringify(input.affected_journeys) : null,
        cut(input.explanation, 4000),
        JSON.stringify(input.evidence || []),
        1,
        at,
        at,
      ]
    );
    return findById(res.insertId);
  }

  // A repeat observation of an already-open incident. Severity only ever moves
  // UP while an incident is open: a service that flaps between 503 and a timeout
  // must not quietly downgrade itself out of someone's alert threshold.
  async function touch(id, { severity = null, summary = null, evidence = null, kind = null, at = null } = {}) {
    const seen = at || now();
    const sets = ['occurrences = occurrences + 1', 'last_seen_at = ?'];
    const params = [seen];
    if (severity) {
      sets.push("severity = CASE WHEN FIELD(?, 'INFO','WARN','CRIT') > FIELD(severity, 'INFO','WARN','CRIT') THEN ? ELSE severity END");
      params.push(severity, severity);
    }
    if (kind) { sets.push('kind = ?'); params.push(cut(kind, 60)); }
    if (summary !== null) { sets.push('summary = ?'); params.push(cut(summary, 4000)); }
    if (evidence !== null) { sets.push('evidence = ?'); params.push(JSON.stringify(evidence)); }
    params.push(id);
    await pool.query(`UPDATE service_test_incidents SET ${sets.join(', ')} WHERE id = ?`, params);
    return findById(id);
  }

  async function resolve(id, { resolution = 'The next check was healthy', resolvedBy = null, at = null } = {}) {
    await pool.query(
      `UPDATE service_test_incidents SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ?
       WHERE id = ? AND ${ACTIVE_SQL}`,
      [at || now(), resolvedBy, cut(resolution, 255), id, ...ACTIVE]
    );
    return findById(id);
  }

  // Stamps what was actually sent, so the reactor notifies once per state change
  // rather than once per observation — and so a restart does not re-send.
  async function markNotified(id, severity, at = null) {
    await pool.query(
      'UPDATE service_test_incidents SET notified_at = ?, notified_severity = ? WHERE id = ?',
      [at || now(), severity, id]
    );
    return findById(id);
  }

  async function list({ status = null, applicationId = null, subjectType = null, severity = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (applicationId) { where.push('application_id = ?'); params.push(applicationId); }
    if (subjectType) { where.push('subject_type = ?'); params.push(subjectType); }
    if (severity) { where.push('severity = ?'); params.push(severity); }
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_incidents
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY (${ACTIVE_SQL}) DESC, FIELD(severity, 'CRIT','WARN','INFO'), last_seen_at DESC
       LIMIT ${n}`,
      // The ORDER BY carries its own placeholders, and they bind AFTER the
      // WHERE ones because that is the order they appear in the statement.
      [...params, ...ACTIVE]
    );
    return rows.map(shape);
  }

  // Incidents that OPENED or RESOLVED inside a window — the Changes feed's
  // question ("what happened while I was away"), which is not the same as the
  // list's ("what is wrong now"). An incident opened before the window and still
  // open is deliberately absent: it did not happen during the shift being
  // reviewed, and the Health tab is where standing problems live.
  async function listBetween({ from, to = new Date(), limit = 500 } = {}) {
    const start = from ? new Date(from) : new Date(0);
    const end = to ? new Date(to) : new Date();
    const n = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_incidents
       WHERE (opened_at BETWEEN ? AND ?) OR (resolved_at IS NOT NULL AND resolved_at BETWEEN ? AND ?)
       ORDER BY last_seen_at DESC LIMIT ${n}`,
      [start, end, start, end]
    );
    return rows.map(shape);
  }

  // Which applications had the most incidents of a given severity in a window —
  // the Health page's ranking.
  //
  // Counted by the incident's OPENED time, not by whether it is still open: the
  // question is "which services gave us trouble last month", and an incident
  // that was opened and fixed in March is part of March's answer.
  //
  // Applications are joined in so the answer carries a name; an incident whose
  // application was deleted is dropped rather than charted as "null", because a
  // bar nobody can act on is worse than a shorter chart.
  async function countByApplication({ from, to = new Date(), severity = 'CRIT', applicationIds = null, limit = 10 } = {}) {
    const start = from ? new Date(from) : new Date(0);
    const end = to ? new Date(to) : new Date();
    const n = Math.min(Math.max(Number(limit) || 10, 1), 50);

    const where = ['i.opened_at BETWEEN ? AND ?', 'i.application_id IS NOT NULL'];
    const params = [start, end];
    if (severity) { where.push('i.severity = ?'); params.push(severity); }
    // An explicit, non-empty selection narrows it. An EMPTY selection is not the
    // same as no selection — "show me none of them" is a legitimate thing for a
    // multi-select to say, and answering it with everything would be a lie.
    if (Array.isArray(applicationIds)) {
      if (!applicationIds.length) return [];
      where.push(`i.application_id IN (${applicationIds.map(() => '?').join(',')})`);
      params.push(...applicationIds);
    }

    const [rows] = await pool.query(
      `SELECT i.application_id, a.name AS application_name, COUNT(*) AS incidents,
              MAX(i.last_seen_at) AS last_seen_at
       FROM service_test_incidents i
       JOIN service_test_applications a ON a.id = i.application_id
       WHERE ${where.join(' AND ')}
       GROUP BY i.application_id, a.name
       ORDER BY incidents DESC, a.name ASC
       LIMIT ${n}`,
      params
    );
    return rows.map((r) => ({
      application_id: r.application_id,
      application_name: r.application_name,
      incidents: Number(r.incidents) || 0,
      last_seen_at: r.last_seen_at,
    }));
  }

  // The same ranking, but over TIME: one row per (bucket, application), so the
  // Health chart can draw a line per application instead of a single total.
  //
  // The bucket expression matches runs.stats() exactly — same DATE_FORMAT, same
  // offset placeholder order (the SELECT list binds before the WHERE) — so the
  // two charts on the page cut their buckets identically. Two charts that
  // disagree about where Tuesday starts is a bug nobody ever reports and
  // everybody notices.
  async function seriesByApplication({
    from, to = new Date(), sqlFormat, offsetMinutes = 0, severity = 'CRIT', applicationIds = null,
  } = {}) {
    if (Array.isArray(applicationIds) && !applicationIds.length) return [];
    const start = from ? new Date(from) : new Date(0);
    const end = to ? new Date(to) : new Date();

    const params = [Number(offsetMinutes) || 0, String(sqlFormat), start, end];
    const where = ['i.opened_at >= ?', 'i.opened_at < ?', 'i.application_id IS NOT NULL'];
    if (severity) { where.push('i.severity = ?'); params.push(severity); }
    if (Array.isArray(applicationIds)) {
      where.push(`i.application_id IN (${applicationIds.map(() => '?').join(',')})`);
      params.push(...applicationIds);
    }

    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(DATE_SUB(i.opened_at, INTERVAL ? MINUTE), ?) AS bucket,
              i.application_id, a.name AS application_name, COUNT(*) AS incidents
       FROM service_test_incidents i
       JOIN service_test_applications a ON a.id = i.application_id
       WHERE ${where.join(' AND ')}
       GROUP BY bucket, i.application_id, a.name
       ORDER BY bucket`,
      params
    );
    return rows.map((r) => ({
      bucket: r.bucket,
      application_id: r.application_id,
      application_name: r.application_name,
      incidents: Number(r.incidents) || 0,
    }));
  }

  // Open incidents by severity — the badge on the nav entry, in one query.
  async function openCounts() {
    const [rows] = await pool.query(
      `SELECT severity, COUNT(*) AS n FROM service_test_incidents WHERE ${ACTIVE_SQL} GROUP BY severity`, ACTIVE
    );
    const out = { CRIT: 0, WARN: 0, INFO: 0, total: 0 };
    for (const row of rows) {
      const n = Number(row.n) || 0;
      if (out[row.severity] !== undefined) out[row.severity] = n;
      out.total += n;
    }
    return out;
  }

  // Resolved incidents older than the window. History is worth keeping, but not
  // forever — same reasoning as the artefact retention job.
  async function purgeResolvedOlderThan(days) {
    // A window that is missing, negative or not a number falls back to the
    // shipped 90 days. Flooring it at 1 instead would turn a bad value into
    // "delete yesterday's history", which is the one outcome worth guarding.
    const asked = Number(days);
    const window = Number.isFinite(asked) && asked > 0 ? asked : 90;
    const cutoff = new Date(now().getTime() - window * 86400000);
    const [res] = await pool.query(
      "DELETE FROM service_test_incidents WHERE status = 'resolved' AND resolved_at < ?",
      [cutoff]
    );
    return res.affectedRows || 0;
  }

  // The explicit backfill for open incidents. Same posture as findings: only
  // OPEN ones, because a resolved incident is a record of what was decided at
  // the time, and rewriting it would make history a function of today's config.
  async function applySeverityRule(rule, { dryRun = true } = {}) {
    const where = [ACTIVE_SQL, 'severity <> ?'];
    const params = [...ACTIVE, rule.severity];
    if (rule.match_kind) { where.push('kind = ?'); params.push(rule.match_kind); }
    if (rule.match_application_id) { where.push('application_id = ?'); params.push(rule.match_application_id); }

    const [counted] = await pool.query(
      `SELECT COUNT(*) AS n FROM service_test_incidents WHERE ${where.join(' AND ')}`,
      params
    );
    const matched = Number(counted[0] ? counted[0].n : 0);
    if (dryRun) return { matched, changed: matched };

    const [res] = await pool.query(
      `UPDATE service_test_incidents
          SET original_severity = COALESCE(original_severity, severity),
              severity = ?,
              severity_rule_id = ?
        WHERE ${where.join(' AND ')}`,
      [rule.severity, rule.id, ...params]
    );
    return { matched, changed: res.affectedRows || 0 };
  }

  // ------------------------------------------------------------- lifecycle
  //
  // The states beyond open/resolved that migration 090 added. Guarded by the
  // pure `canTransition`, so the rules live in one place and this only writes.
  //
  // The transition is CONDITIONAL on the status it was told about: two people
  // looking at the same incident in two browsers would otherwise both succeed,
  // and the second would silently undo the first. A refused move returns the row
  // unchanged and says so, rather than throwing at somebody who clicked a button.
  async function transition(id, to, { by = null, at = null, note = null } = {}) {
    const current = await findById(id);
    if (!current) return { ok: false, reason: 'that incident no longer exists', incident: null };
    if (current.status === to) return { ok: true, reason: null, incident: current, unchanged: true };
    // `canTransition` answers with a reason, not a boolean — an object, which is
    // always truthy, so `if (!canTransition(...))` silently allowed every move.
    const allowed = canTransition(current.status, to);
    if (!allowed || !allowed.ok) {
      // The pure module's own sentence, not a second one written here. Two
      // modules explaining the same refusal differently is how a screen and an
      // API end up disagreeing about the rules.
      return { ok: false, reason: (allowed && allowed.reason) || `an incident cannot go from ${current.status} to ${to}`, incident: current };
    }

    const when = at || now();
    const sets = ['status = ?'];
    const params = [to];
    // Resolving and closing are the only states that stamp a time, because they
    // are the only ones anybody measures to.
    if (to === STATUS.RESOLVED) {
      sets.push('resolved_at = ?', 'resolved_by = ?');
      params.push(when, by);
      if (note !== null) { sets.push('resolution = ?'); params.push(cut(note, 255)); }
    }
    // Picking an incident up is an acknowledgement, and the alerting path reads
    // it: an incident somebody is working on should stop escalating.
    if (to === STATUS.INVESTIGATING && !current.acknowledged_at) {
      sets.push('acknowledged_at = ?', 'acknowledged_by = ?');
      params.push(when, by);
    }
    params.push(id, current.status);

    const [res] = await pool.query(
      `UPDATE service_test_incidents SET ${sets.join(', ')} WHERE id = ? AND status = ?`, params
    );
    if (!res.affectedRows) {
      return { ok: false, reason: 'somebody else changed this incident first', incident: await findById(id) };
    }
    return { ok: true, reason: null, incident: await findById(id) };
  }

  // What the correlation engine concluded, and what it costs the service.
  // Written when it is worked out, which is usually after the incident opened.
  async function recordAssessment(id, { correlatedLayer = null, confidence = null,
    impact = null, impactReason = null, affectedJourneys = null, likelyCause = null } = {}) {
    const sets = [];
    const params = [];
    if (correlatedLayer !== null) { sets.push('correlated_layer = ?'); params.push(cut(correlatedLayer, 32)); }
    if (confidence !== null) {
      sets.push('confidence = ?');
      params.push(Math.max(0, Math.min(100, Math.round(Number(confidence) || 0))));
    }
    if (impact !== null) { sets.push('impact = ?'); params.push(impact); }
    if (impactReason !== null) { sets.push('impact_reason = ?'); params.push(cut(impactReason, 512)); }
    if (affectedJourneys !== null) { sets.push('affected_journeys = ?'); params.push(JSON.stringify(affectedJourneys)); }
    if (likelyCause !== null) { sets.push('likely_cause = ?'); params.push(cut(likelyCause, 255)); }
    if (!sets.length) return findById(id);
    params.push(id);
    await pool.query(`UPDATE service_test_incidents SET ${sets.join(', ')} WHERE id = ?`, params);
    return findById(id);
  }

  // -------------------------------------------------------------- timeline
  //
  // `service_incident_events` (migration 090). Built from actual events, never
  // written after the fact as a narrative — which is why `occurred_at` is
  // supplied by the caller and defaults to the clock only when it has nothing
  // better. A run that took four minutes produced events across four minutes.
  const EVENT_COLS = 'id, incident_id, kind, summary, detail, source, actor_id, occurred_at, created_at';
  const SOURCES = ['run', 'sweep', 'correlation', 'rule', 'person', 'notification'];

  function shapeEvent(row) {
    if (!row) return null;
    return {
      id: row.id,
      incident_id: row.incident_id,
      kind: row.kind,
      summary: row.summary,
      detail: parseJson(row.detail),
      source: row.source,
      actor_id: row.actor_id,
      occurred_at: row.occurred_at,
      created_at: row.created_at,
    };
  }

  // Several events in one statement. A run that opens an incident produces the
  // failure, the correlation and the impact together, and three round trips per
  // run is three too many on the path that is already the slow one.
  async function addEvents(incidentId, events) {
    const list = (Array.isArray(events) ? events : []).filter((e) => e && typeof e === 'object');
    if (!list.length) return 0;
    const at = now();
    const rows = [];
    const params = [];
    for (const e of list) {
      rows.push('(?, ?, ?, ?, ?, ?, ?)');
      params.push(
        intOrNull(incidentId),
        cut(e.kind || 'note', 64),
        cut(e.summary || '', 512),
        e.detail ? JSON.stringify(e.detail) : null,
        SOURCES.includes(e.source) ? e.source : 'run',
        intOrNull(e.actor_id ?? e.actorId),
        e.occurred_at instanceof Date ? e.occurred_at : (e.at instanceof Date ? e.at : at),
      );
    }
    const [res] = await pool.query(
      `INSERT INTO service_incident_events (incident_id, kind, summary, detail, source, actor_id, occurred_at)
       VALUES ${rows.join(', ')}`,
      params
    );
    return res.affectedRows;
  }

  async function addEvent(incidentId, event) {
    return addEvents(incidentId, [event]);
  }

  // One incident's events, oldest first — a timeline is read forwards.
  //
  // Ordered by id as well as time, because several events of one run share a
  // timestamp to the millisecond and "the incident opened" must not appear
  // after "the correlation concluded".
  async function timeline(incidentId, { limit = 500 } = {}) {
    const capped = Math.min(2000, Math.max(1, Number(limit) || 500));
    const [rows] = await pool.query(
      `SELECT ${EVENT_COLS} FROM service_incident_events WHERE incident_id = ?
        ORDER BY occurred_at, id LIMIT ${capped}`,
      [intOrNull(incidentId)]
    );
    return rows.map(shapeEvent);
  }

  return {
    findById, findOpen, open, touch, resolve, markNotified, list, listBetween,
    countByApplication, seriesByApplication, openCounts, purgeResolvedOlderThan,
    applySeverityRule,
    transition, recordAssessment, addEvent, addEvents, timeline,
  };
}

module.exports = { createIncidentsRepository };
