'use strict';

// Data-access for remediation playbooks (migration 055) and their per-incident
// run history. A playbook is a pre-defined response keyed to an anomaly-type:
// `trigger_condition` is matched EXACTLY against the incident's primary finding
// metric — local + explainable, no regex/DSL, consistent with the rest of the
// analysis stack. `incident_playbook_runs` records that a playbook was executed
// against a specific incident and the outcome, so the recommendation endpoint
// (GET /api/incidents/:id/recommendation) can surface the result instead of
// re-suggesting the same playbook. Pure data-access — no policy here.

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapPlaybook(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    triggerCondition: row.trigger_condition,
    actionType: row.action_type,
    autoTrigger: !!row.auto_trigger,
    manualActionText: row.manual_action_text ?? null,
    enabled: !!row.enabled,
    createdAt: toIso(row.created_at),
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    incidentCaseId: Number(row.incident_case_id),
    playbookId: Number(row.playbook_id),
    status: row.status,
    resultText: row.result_text ?? null,
    ranBy: row.ran_by ?? null,
    ranAt: toIso(row.ran_at),
    // Joined from remediation_playbooks (LEFT JOIN) when available.
    playbookName: row.playbook_name ?? null,
    playbookActionType: row.playbook_action_type ?? null,
  };
}

const PB_COLS = 'id, name, trigger_condition, action_type, auto_trigger, manual_action_text, enabled, created_at';

function createRemediationPlaybooksRepository(db) {
  const { pool } = db;

  // The enabled playbook whose trigger_condition matches an anomaly-type exactly.
  // Newest first when several match; null when none. A null/empty anomaly-type
  // never matches (an incident with no primary anomaly-type has no playbook).
  async function matchByAnomalyType(anomalyType) {
    if (anomalyType == null || anomalyType === '') return null;
    const [rows] = await pool.query(
      `SELECT ${PB_COLS} FROM remediation_playbooks
       WHERE enabled = 1 AND trigger_condition = ?
       ORDER BY id DESC LIMIT 1`,
      [anomalyType]
    );
    return mapPlaybook(rows[0]) ?? null;
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${PB_COLS} FROM remediation_playbooks WHERE id = ?`, [id]);
    return mapPlaybook(rows[0]) ?? null;
  }

  async function list() {
    const [rows] = await pool.query(`SELECT ${PB_COLS} FROM remediation_playbooks ORDER BY id DESC`);
    return rows.map(mapPlaybook);
  }

  // All runs recorded against an incident, newest first, joined with the
  // playbook's name + action_type for display. Bounded.
  async function listRunsForIncident(incidentCaseId, { limit = 50 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 50;
    const [rows] = await pool.query(
      `SELECT r.id, r.incident_case_id, r.playbook_id, r.status, r.result_text, r.ran_by, r.ran_at,
              p.name AS playbook_name, p.action_type AS playbook_action_type
       FROM incident_playbook_runs r
       LEFT JOIN remediation_playbooks p ON p.id = r.playbook_id
       WHERE r.incident_case_id = ?
       ORDER BY r.ran_at DESC, r.id DESC
       LIMIT ?`,
      [incidentCaseId, lim]
    );
    return rows.map(mapRun);
  }

  // All playbook runs for a HOST within [from, to], newest-first. Playbook runs
  // are not host-keyed directly — they hang off incident_cases (host_id) — so
  // this joins through incident_cases in ONE query. Used by the per-target
  // timeline (avoids an N+1 over the host's incident cases) and keeps the
  // (fragile, string-vs-int) host_id join in a single auditable place.
  async function listRunsForHost(hostId, { from = null, to = null, limit = 500 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 500;
    const where = ['ic.host_id = ?'];
    const params = [String(hostId)];
    if (from) { where.push('r.ran_at >= ?'); params.push(from); }
    if (to) { where.push('r.ran_at <= ?'); params.push(to); }
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT r.id, r.incident_case_id, r.playbook_id, r.status, r.result_text, r.ran_by, r.ran_at,
              p.name AS playbook_name, p.action_type AS playbook_action_type
       FROM incident_playbook_runs r
       JOIN incident_cases ic ON ic.id = r.incident_case_id
       LEFT JOIN remediation_playbooks p ON p.id = r.playbook_id
       WHERE ${where.join(' AND ')}
       ORDER BY r.ran_at DESC, r.id DESC
       LIMIT ?`,
      params
    );
    return rows.map(mapRun);
  }

  // Records a playbook run against an incident and returns the new run id.
  // Playbook execution is not exposed over HTTP yet (a later phase) — this exists
  // so runs can be seeded/recorded and read back by the recommendation path.
  async function recordRun({ incidentCaseId, playbookId, status = 'pending', resultText = null, ranBy = null }) {
    const [res] = await pool.query(
      `INSERT INTO incident_playbook_runs (incident_case_id, playbook_id, status, result_text, ran_by)
       VALUES (?, ?, ?, ?, ?)`,
      [incidentCaseId, playbookId, status, resultText, ranBy]
    );
    return Number(res.insertId);
  }

  return { matchByAnomalyType, findById, list, listRunsForIncident, listRunsForHost, recordRun };
}

module.exports = { createRemediationPlaybooksRepository, mapPlaybook, mapRun };
