-- 060 — cross-agent incident-cluster lifecycle (operator ack + resolve-with-note).
--
-- The clustering engine (migration 057) creates/updates/auto-resolves clusters
-- automatically. This adds the OPERATOR lifecycle on top, so a cross-agent
-- incident can be acknowledged and resolved from the API with an audit trail:
--
--   * a new 'acknowledged' status between 'open' and 'resolved' — an operator has
--     seen the cluster and owns it, but it is not yet resolved. Findings carry no
--     "cleared" event, so acknowledgement is a human signal, not an automatic one.
--   * acknowledged_by / acknowledged_at — WHO acknowledged it and WHEN.
--   * resolved_by + resolution_note — a manual resolve REQUIRES a free-text note
--     (the API rejects an empty note); the auto-resolve sweep sets neither.
--
-- acknowledged_by / resolved_by reference users(id) (INT UNSIGNED) and are set to
-- NULL if the user is later deleted — the cluster's history survives the account.
--
-- Retention interaction: the auto-resolve sweep (crossAgentClusterService) now
-- NEVER auto-closes a cluster that still contains an unacknowledged CRIT finding;
-- acknowledging it (this lifecycle) is what lets inactivity resolve it again.
ALTER TABLE incident_clusters
  MODIFY COLUMN status ENUM('open', 'acknowledged', 'resolved', 'closed') NOT NULL DEFAULT 'open';

ALTER TABLE incident_clusters
  ADD COLUMN acknowledged_at DATETIME NULL DEFAULT NULL AFTER detected_at,
  ADD COLUMN acknowledged_by INT UNSIGNED NULL DEFAULT NULL AFTER acknowledged_at,
  ADD COLUMN resolved_by INT UNSIGNED NULL DEFAULT NULL AFTER resolved_at,
  ADD COLUMN resolution_note TEXT NULL DEFAULT NULL AFTER resolved_by,
  ADD CONSTRAINT fk_incident_clusters_ack_by
    FOREIGN KEY (acknowledged_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_incident_clusters_resolved_by
    FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;
