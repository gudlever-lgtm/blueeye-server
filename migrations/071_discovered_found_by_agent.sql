-- 071 — record which agent found a discovered candidate (agent-executed sweep).
--
-- Discovery can now run FROM an agent (it sweeps the segment it sits on) as well
-- as from the server. `found_by_agent_id` records the agent that observed the
-- candidate, so the UI can show "found by <agent>" and an operator can tell an
-- agent-vantage find from a server-vantage one. Nullable (server-run sweeps and
-- pre-existing rows leave it NULL); ON DELETE SET NULL so removing the finder
-- agent doesn't delete the discovery record.
ALTER TABLE discovered_devices
  ADD COLUMN found_by_agent_id INT UNSIGNED NULL DEFAULT NULL AFTER icmp,
  ADD CONSTRAINT fk_discovered_found_by_agent FOREIGN KEY (found_by_agent_id)
    REFERENCES agents (id) ON DELETE SET NULL;
