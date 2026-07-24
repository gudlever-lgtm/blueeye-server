'use strict';

// Data-access for `topology_changes` (migration 067). Stores the discrete
// topology change records emitted by the diff at LLDP ingest. Pure data-access;
// the diff, flap-collapse and audit-write logic live in
// src/topology/topologyChangeService.js.

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    changeType: row.change_type,
    localPort: row.local_port ?? null,
    remoteChassisId: row.remote_chassis_id ?? null,
    remotePort: row.remote_port ?? null,
    fromLocalPort: row.from_local_port ?? null,
    linkStateFrom: row.link_state_from ?? null,
    linkStateTo: row.link_state_to ?? null,
    severity: row.severity,
    summary: row.summary,
    detectedAt: toIso(row.detected_at),
    auditLogId: row.audit_log_id == null ? null : Number(row.audit_log_id),
  };
}

const COLS =
  'id, agent_id, change_type, local_port, remote_chassis_id, remote_port, from_local_port, ' +
  'link_state_from, link_state_to, severity, summary, detected_at, audit_log_id';

function createTopologyChangesRepository(db) {
  const { pool } = db;

  async function insert(c) {
    const [res] = await pool.query(
      `INSERT INTO topology_changes
         (agent_id, change_type, local_port, remote_chassis_id, remote_port, from_local_port,
          link_state_from, link_state_to, severity, summary, detected_at, audit_log_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.agentId, c.changeType, c.localPort ?? null, c.remoteChassisId ?? null, c.remotePort ?? null,
        c.fromLocalPort ?? null, c.linkStateFrom ?? null, c.linkStateTo ?? null,
        c.severity || 'INFO', c.summary, c.detectedAt || new Date(), c.auditLogId ?? null,
      ],
    );
    return res.insertId;
  }

  // Collapse a prior discrete change into a single 'flapping' record (used when a
  // change reverts within the flap window). Rewrites the existing row in place so
  // the changes view shows ONE flapping record, not the discrete pair.
  async function markFlapping(id, { summary, detectedAt = null, auditLogId = null }) {
    const [res] = await pool.query(
      `UPDATE topology_changes
         SET change_type = 'flapping', severity = 'WARN', summary = ?,
             detected_at = COALESCE(?, detected_at),
             audit_log_id = COALESCE(?, audit_log_id)
       WHERE id = ?`,
      [summary, detectedAt, auditLogId, id],
    );
    return res.affectedRows || 0;
  }

  // Recent changes for an agent since `since` (newest first) — the flap-detection
  // lookup input. Bounded.
  async function recentForAgent({ agentId, since, limit = 500 }) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM topology_changes
       WHERE agent_id = ? AND detected_at >= ?
       ORDER BY detected_at DESC, id DESC LIMIT ?`,
      [agentId, since, lim],
    );
    return rows.map(mapRow);
  }

  // Changes for one agent over an optional [from, to) window (newest first).
  async function listForAgent({ agentId, from = null, to = null, limit = 200 }) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 2000 ? limit : 200;
    const where = ['agent_id = ?'];
    const params = [agentId];
    if (from) { where.push('detected_at >= ?'); params.push(from); }
    if (to) { where.push('detected_at < ?'); params.push(to); }
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM topology_changes WHERE ${where.join(' AND ')}
       ORDER BY detected_at DESC, id DESC LIMIT ?`,
      [...params, lim],
    );
    return rows.map(mapRow);
  }

  // Fleet-wide changes (newest first), for the changes endpoint without a host.
  async function list({ from = null, to = null, limit = 200 }) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 2000 ? limit : 200;
    const where = [];
    const params = [];
    if (from) { where.push('detected_at >= ?'); params.push(from); }
    if (to) { where.push('detected_at < ?'); params.push(to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM topology_changes ${clause} ORDER BY detected_at DESC, id DESC LIMIT ?`,
      [...params, lim],
    );
    return rows.map(mapRow);
  }

  return { insert, markFlapping, recentForAgent, listForAgent, list, mapRow };
}

module.exports = { createTopologyChangesRepository, mapRow };
