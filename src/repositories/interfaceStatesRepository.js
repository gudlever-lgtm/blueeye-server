'use strict';

// Data-access for `interface_states` + `interface_state_transitions`
// (migration 075) — the snapshot we diff against, and the history the changes
// feed reads.

// `virtual` is backticked everywhere it appears as an IDENTIFIER: it is a
// reserved word in MySQL (generated columns), so an unquoted use is a syntax error.
const STATE_COLS = 'id, agent_id, iface, status, oper_status, `virtual`, first_seen, last_seen';
const TRANS_COLS = `id, agent_id, iface, from_status, to_status, oper_status, severity,
  summary, flap_count, flapping, detected_at`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapState(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    iface: row.iface,
    status: row.status,
    // snake_case is kept on this one because the pure differ reads stored rows
    // directly and compares them against its own output.
    oper_status: row.oper_status ?? null,
    virtual: !!row.virtual,
    firstSeen: toIso(row.first_seen),
    lastSeen: toIso(row.last_seen),
  };
}

function mapTransition(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    iface: row.iface,
    fromStatus: row.from_status ?? null,
    toStatus: row.to_status,
    operStatus: row.oper_status ?? null,
    severity: row.severity,
    summary: row.summary,
    flapCount: Number(row.flap_count || 1),
    flapping: !!row.flapping,
    detectedAt: toIso(row.detected_at),
  };
}

function createInterfaceStatesRepository(db) {
  const { pool } = db;

  async function statesForAgent(agentId) {
    const [rows] = await pool.query(
      `SELECT ${STATE_COLS} FROM interface_states WHERE agent_id = ?`,
      [agentId]
    );
    return rows.map(mapState);
  }

  // Upserts the current state of every interface in one statement. `first_seen`
  // is preserved on an existing row; `last_seen` always moves, which is what
  // lets retention age out an interface that stopped being reported.
  async function upsertStates(agentId, states, { at = new Date() } = {}) {
    const rows = Array.isArray(states) ? states : [];
    if (!rows.length) return 0;
    const values = [];
    const params = [];
    for (const s of rows) {
      values.push('(?, ?, ?, ?, ?, ?, ?)');
      params.push(agentId, s.iface, s.status, s.operStatus || null, s.virtual ? 1 : 0, at, at);
    }
    const [res] = await pool.query(
      `INSERT INTO interface_states (agent_id, iface, status, oper_status, \`virtual\`, first_seen, last_seen)
       VALUES ${values.join(', ')}
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         oper_status = VALUES(oper_status),
         \`virtual\` = VALUES(\`virtual\`),
         last_seen = VALUES(last_seen)`,
      params
    );
    return res.affectedRows || 0;
  }

  async function insertTransition(agentId, t) {
    const [res] = await pool.query(
      `INSERT INTO interface_state_transitions
         (agent_id, iface, from_status, to_status, oper_status, severity, summary, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, t.iface, t.fromStatus, t.toStatus, t.operStatus || null, t.severity, t.summary, t.detectedAt]
    );
    return Number(res.insertId);
  }

  // The most recent transition for one interface, used to decide whether a new
  // one reverses it (a flap) rather than being a fresh change.
  async function latestForIface({ agentId, iface, since = null }) {
    const params = [agentId, iface];
    let clause = '';
    if (since) { clause = ' AND detected_at >= ?'; params.push(since); }
    const [rows] = await pool.query(
      `SELECT ${TRANS_COLS} FROM interface_state_transitions
        WHERE agent_id = ? AND iface = ?${clause}
        ORDER BY detected_at DESC, id DESC LIMIT 1`,
      params
    );
    return rows[0] ? mapTransition(rows[0]) : null;
  }

  // Collapses a reversing transition onto the existing row instead of adding a
  // second one: an interface bouncing every 20 seconds is ONE finding
  // ("flapping 14 times"), not 14 unreadable rows.
  async function markFlapping(id, { at }) {
    const [res] = await pool.query(
      `UPDATE interface_state_transitions
          SET flapping = 1, flap_count = flap_count + 1, detected_at = ?,
              severity = 'WARN',
              summary = CONCAT(SUBSTRING_INDEX(summary, ' (flapping', 1), ' (flapping ', flap_count + 1, '×)')
        WHERE id = ?`,
      [at, id]
    );
    return res.affectedRows > 0;
  }

  // Fleet-wide transitions in a window — what the changes feed reads.
  async function list({ from = null, to = null, agentId = null, limit = 200 } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 2000 ? limit : 200;
    const where = [];
    const params = [];
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    if (from) { where.push('detected_at >= ?'); params.push(from); }
    if (to) { where.push('detected_at <= ?'); params.push(to); }
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT ${TRANS_COLS} FROM interface_state_transitions
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY detected_at DESC, id DESC LIMIT ?`,
      params
    );
    return rows.map(mapTransition);
  }

  // Retention. Transitions are history and age out on their own timer; states
  // are current and age out when an interface stops being reported at all.
  async function purgeTransitionsBefore(cutoff) {
    const [res] = await pool.query('DELETE FROM interface_state_transitions WHERE detected_at < ?', [cutoff]);
    return res.affectedRows || 0;
  }
  async function purgeStatesBefore(cutoff) {
    const [res] = await pool.query('DELETE FROM interface_states WHERE last_seen < ?', [cutoff]);
    return res.affectedRows || 0;
  }

  return {
    statesForAgent,
    upsertStates,
    insertTransition,
    latestForIface,
    markFlapping,
    list,
    purgeTransitionsBefore,
    purgeStatesBefore,
  };
}

module.exports = { createInterfaceStatesRepository };
