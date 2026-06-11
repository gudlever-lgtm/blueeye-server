-- 037 — performance indexes for hot time-series lookups.
--
-- results: every fleet listing runs a correlated MAX(created_at) per agent, and
-- retention scans/deletes by created_at; the table only had a single-column
-- (agent_id) index, forcing row reads/full scans. The new composite
-- (agent_id, created_at) also backs the FK that idx_results_agent_id covered, so
-- the redundant single-column index is dropped to keep write cost down.
ALTER TABLE results
  ADD KEY idx_results_agent_created (agent_id, created_at),
  ADD KEY idx_results_created (created_at),
  DROP KEY idx_results_agent_id;

-- probe_results: GET /api/probes/latest (polled by the Probes tab) computes
-- MAX(id) GROUP BY (type, target) per agent; no existing index contained target,
-- so it walked the agent's whole probe history. This covering index turns it
-- into an index-only loose scan.
ALTER TABLE probe_results
  ADD KEY idx_probe_agent_type_target_id (agent_id, type, target, id);
