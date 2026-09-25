'use strict';

// Data access for `agent_command_queue` — the commands waiting for an agent that
// is not connected right now (migration 137).
//
// The queue exists for one reason: an update that can only be delivered while the
// operator is watching is an update an intermittently-connected fleet never gets.
// Everything else about it is kept narrow on purpose.
//
//   * One entry per (agent, kind). Queueing is idempotent — clicking Update on an
//     offline agent three times leaves one command — and the newest payload wins,
//     so a re-click after a new release replaces the old target rather than
//     racing it.
//   * Always an expiry. An update queued for a host that comes back next month
//     would be for a version two releases old; it is dropped instead.
//   * Payloads are stored UNSIGNED. The signature carries `issuedAt` and the
//     agent refuses one more than five minutes off its clock, so signing happens
//     at delivery. A queued row is therefore not a replayable credential.
//   * `take` DELETES as it reads, inside one statement's worth of work, so two
//     sockets for the same agent cannot both deliver the same command.
function createAgentCommandQueueRepository(db) {
  const { pool } = db;

  // Queues a command, replacing any undelivered one of the same kind for this
  // agent. Returns the row id.
  async function enqueue(agentId, command, { ttlSec = 86400, auditId = null } = {}) {
    const kind = String((command && command.name) || '').slice(0, 40);
    if (!kind) throw new Error('a queued command needs a name');
    const payload = JSON.stringify(stripTransport(command));
    const ttl = Math.max(60, Math.min(Number(ttlSec) || 86400, 30 * 86400));
    const [res] = await pool.query(
      `INSERT INTO agent_command_queue (agent_id, kind, payload, audit_id, expires_at)
       VALUES (?, ?, CAST(? AS JSON), ?, DATE_ADD(NOW(3), INTERVAL ? SECOND))
       ON DUPLICATE KEY UPDATE
         payload = VALUES(payload),
         audit_id = VALUES(audit_id),
         expires_at = VALUES(expires_at),
         created_at = NOW(3)`,
      [agentId, kind, payload, auditId, ttl]
    );
    return res && res.insertId ? res.insertId : null;
  }

  // Everything still waiting for this agent, oldest first, expired rows skipped.
  // Read-only — `take` is what removes them.
  async function pendingFor(agentId) {
    const [rows] = await pool.query(
      `SELECT id, kind, payload, audit_id AS auditId, expires_at AS expiresAt, created_at AS createdAt
         FROM agent_command_queue
        WHERE agent_id = ? AND expires_at > NOW(3)
        ORDER BY created_at ASC, id ASC`,
      [agentId]
    );
    return rows.map(decode);
  }

  // Claims everything waiting for this agent: returns the rows AND removes them,
  // so a second socket for the same agent gets nothing. Expired rows are removed
  // with them and never returned.
  async function take(agentId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        `SELECT id, kind, payload, audit_id AS auditId, expires_at AS expiresAt, created_at AS createdAt
           FROM agent_command_queue
          WHERE agent_id = ?
          ORDER BY created_at ASC, id ASC
          FOR UPDATE`,
        [agentId]
      );
      if (rows.length) {
        await conn.query('DELETE FROM agent_command_queue WHERE agent_id = ?', [agentId]);
      }
      await conn.commit();
      const now = Date.now();
      return rows
        .map(decode)
        .filter((row) => !row.expiresAt || new Date(row.expiresAt).getTime() > now);
    } catch (err) {
      try { await conn.rollback(); } catch { /* the error below is the one that matters */ }
      throw err;
    } finally {
      conn.release();
    }
  }

  async function remove(agentId, kind) {
    const [res] = await pool.query(
      'DELETE FROM agent_command_queue WHERE agent_id = ? AND kind = ?',
      [agentId, kind]
    );
    return res && res.affectedRows ? res.affectedRows : 0;
  }

  // How many commands are waiting, per agent — for the dashboard, so an operator
  // can see that an update IS queued rather than assuming the click did nothing.
  async function countsByAgent() {
    const [rows] = await pool.query(
      `SELECT agent_id AS agentId, kind, COUNT(*) AS waiting
         FROM agent_command_queue
        WHERE expires_at > NOW(3)
        GROUP BY agent_id, kind`
    );
    return rows.map((r) => ({ agentId: Number(r.agentId), kind: r.kind, waiting: Number(r.waiting) }));
  }

  // Drops what nobody will ever deliver. Called on a cadence; cheap.
  async function purgeExpired() {
    const [res] = await pool.query('DELETE FROM agent_command_queue WHERE expires_at <= NOW(3)');
    return res && res.affectedRows ? res.affectedRows : 0;
  }

  return { enqueue, pendingFor, take, remove, countsByAgent, purgeExpired };
}

// `id` is a per-send correlation token and `commandSignature` is bound to a
// moment; neither survives being stored. Stripping them here rather than at the
// call site means no caller can accidentally persist either.
function stripTransport(command) {
  const out = {};
  for (const [k, v] of Object.entries(command || {})) {
    if (k === 'id' || k === 'commandSignature' || k === 'issuedAt') continue;
    out[k] = v;
  }
  return out;
}

function decode(row) {
  let payload = row.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  return {
    id: Number(row.id),
    kind: row.kind,
    command: payload || null,
    auditId: row.auditId == null ? null : Number(row.auditId),
    expiresAt: row.expiresAt || null,
    createdAt: row.createdAt || null,
  };
}

module.exports = { createAgentCommandQueueRepository, stripTransport };
