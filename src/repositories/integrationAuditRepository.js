'use strict';

// Data-access for `integration_audit` — one row per outbound integration fire
// (an event trigger or a manual test). Snapshots the integration name/type so
// the trail survives the integration being deleted. Never writes secrets.
function createIntegrationAuditRepository(db) {
  const { pool } = db;

  // Records a single fire's outcome. detail is truncated to the column width.
  async function record({
    integrationId = null, integrationName = null, integrationType = null,
    event, correlationId = null, ok = false, statusCode = null, attempts = 1,
    detail = null, actorUserId = null, actorEmail = null, actorRole = null,
  }) {
    const trimmed = detail == null ? null : String(detail).slice(0, 512);
    const [res] = await pool.query(
      `INSERT INTO integration_audit
         (integration_id, integration_name, integration_type, event, correlation_id,
          ok, status_code, attempts, detail, actor_user_id, actor_email, actor_role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [integrationId, integrationName, integrationType, event, correlationId,
        ok ? 1 : 0, statusCode, attempts, trimmed, actorUserId, actorEmail, actorRole]
    );
    return res.insertId;
  }

  async function findByIntegration(integrationId, { limit = 100 } = {}) {
    const [rows] = await pool.query(
      'SELECT * FROM integration_audit WHERE integration_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      [integrationId, limit]
    );
    return rows;
  }

  async function findAll({ limit = 100 } = {}) {
    const [rows] = await pool.query(
      'SELECT * FROM integration_audit ORDER BY created_at DESC, id DESC LIMIT ?',
      [limit]
    );
    return rows;
  }

  return { record, findByIntegration, findAll };
}

module.exports = { createIntegrationAuditRepository };
