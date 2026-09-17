-- 102 — let the server→agent action audit trail also record 'rekey'
-- (an admin replacing the release trust anchor an installed agent pins, so the
-- server can sign updates that agent accepts again). Same request→complete
-- lifecycle as upgrade/delete/install-tool: the row is 'requested' when the
-- command is sent and flips to 'completed'/'failed' when the agent reports back.
-- The fingerprint of the key being pinned is carried in target_version (the
-- generic "what" column).
ALTER TABLE agent_action_audit
  MODIFY action ENUM('upgrade', 'delete', 'install-tool', 'rekey') NOT NULL;
