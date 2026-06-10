-- 034 — let the server→agent action audit trail also record 'install-tool'
-- (operator- or auto-triggered request that an agent install a missing
-- diagnostic tool, e.g. traceroute). Same request→complete lifecycle as
-- upgrade/delete: the row is 'requested' when the command is sent and flips to
-- 'completed'/'failed' when the agent reports back. The tool name is carried in
-- target_version (the generic "what" column). NULL actor when auto-triggered.
ALTER TABLE agent_action_audit
  MODIFY action ENUM('upgrade', 'delete', 'install-tool') NOT NULL;
