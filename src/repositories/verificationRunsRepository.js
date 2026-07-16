'use strict';

// Data-access for `verification_runs` (migration 062) — the post-remediation
// "did the symptoms clear?" cycle. Pure data-access; the re-check policy lives in
// src/remediation/verificationService.js and the sweep in verificationJob.js.

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function parseJson(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (value == null) return fallback;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return fallback; } }
  return fallback;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    clusterId: Number(row.cluster_id),
    playbookId: row.playbook_id == null ? null : Number(row.playbook_id),
    runbookId: row.runbook_id == null ? null : Number(row.runbook_id),
    triggeredBy: row.triggered_by ?? null,
    affectedTargets: parseJson(row.affected_targets, []),
    findingTypes: parseJson(row.finding_types, []),
    settleSeconds: Number(row.settle_seconds),
    executedAt: toIso(row.executed_at),
    dueAt: toIso(row.due_at),
    status: row.status,
    readings: parseJson(row.readings, null),
    completedAt: toIso(row.completed_at),
    createdAt: toIso(row.created_at),
  };
}

const COLS = `id, cluster_id, playbook_id, runbook_id, triggered_by, affected_targets, finding_types,
  settle_seconds, executed_at, due_at, status, readings, completed_at, created_at`;

function createVerificationRunsRepository(db) {
  const { pool } = db;

  async function create({
    clusterId, playbookId = null, runbookId = null, triggeredBy = null,
    affectedTargets = [], findingTypes = [], settleSeconds, executedAt, dueAt,
  }) {
    const [res] = await pool.query(
      `INSERT INTO verification_runs
         (cluster_id, playbook_id, runbook_id, triggered_by, affected_targets, finding_types,
          settle_seconds, executed_at, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [clusterId, playbookId, runbookId, triggeredBy,
        JSON.stringify(affectedTargets || []), JSON.stringify(findingTypes || []),
        settleSeconds, executedAt, dueAt],
    );
    return Number(res.insertId);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM verification_runs WHERE id = ?`, [id]);
    return mapRow(rows[0]) ?? null;
  }

  // Pending runs whose settle window has elapsed (due_at <= now) — the sweep's
  // work list, oldest-due first.
  async function listDuePending(now, limit = 200) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 2000 ? limit : 200;
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM verification_runs
       WHERE status = 'pending' AND due_at <= ?
       ORDER BY due_at ASC, id ASC LIMIT ?`,
      [now, lim],
    );
    return rows.map(mapRow);
  }

  // Completes a pending run (guarded on status='pending' so a concurrent sweep
  // completes it at most once). Returns true if a row changed.
  async function complete(id, { status, readings = null, completedAt }) {
    const [res] = await pool.query(
      `UPDATE verification_runs
          SET status = ?, readings = ?, completed_at = ?
        WHERE id = ? AND status = 'pending'`,
      [status, readings == null ? null : JSON.stringify(readings), completedAt, id],
    );
    return res.affectedRows > 0;
  }

  // All verification runs for a cluster, newest-first — the timeline source.
  async function listForCluster(clusterId, { limit = 200 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 2000 ? limit : 200;
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM verification_runs
       WHERE cluster_id = ? ORDER BY executed_at DESC, id DESC LIMIT ?`,
      [clusterId, lim],
    );
    return rows.map(mapRow);
  }

  return { create, findById, listDuePending, complete, listForCluster };
}

module.exports = { createVerificationRunsRepository, mapRow, COLS };
