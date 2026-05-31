-- 006 — per-agent monitoring source.
-- capabilities: agent-reported (what the agent CAN do, e.g. {"sources":["proc","snmp"]}).
-- monitor_config: server-managed (what the agent SHOULD do, e.g. {"source":"snmp",...}).
ALTER TABLE agents
  ADD COLUMN capabilities JSON NULL DEFAULT NULL AFTER status,
  ADD COLUMN monitor_config JSON NULL DEFAULT NULL AFTER meta;
