-- 022 — persistent audit trail for server-initiated agent actions (upgrade /
-- delete). One row per action, carrying TWO states on the SAME record:
-- 'requested' when the server sent the command, then 'completed'/'failed' when
-- the agent reports back (with completed_at + result_detail). Agent identity is
-- SNAPSHOTTED (hostname/location) so the trail survives the agent being deleted
-- (agent_id then FK-nulls but the row remains). Searchable per agent and per
-- actor. Holds NO secrets — tokens/signatures are never written here.
CREATE TABLE IF NOT EXISTS agent_action_audit (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NULL DEFAULT NULL,
  agent_hostname VARCHAR(255) NULL DEFAULT NULL,
  location_id INT UNSIGNED NULL DEFAULT NULL,
  -- Who triggered it (from the JWT) — snapshotted so it survives user changes.
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,
  actor_email VARCHAR(255) NULL DEFAULT NULL,
  actor_role VARCHAR(32) NULL DEFAULT NULL,
  action ENUM('upgrade', 'delete') NOT NULL,
  target_version VARCHAR(64) NULL DEFAULT NULL,
  state ENUM('requested', 'completed', 'failed') NOT NULL DEFAULT 'requested',
  result_detail VARCHAR(512) NULL DEFAULT NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_audit_agent (agent_id, requested_at),
  KEY idx_audit_actor (actor_user_id, requested_at),
  CONSTRAINT fk_audit_agent FOREIGN KEY (agent_id)
    REFERENCES agents (id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
