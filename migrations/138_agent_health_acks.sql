-- 138 — acknowledging an agent's health verdict on Fleet.
--
-- The Fleet verdict (CRIT/WARN) is DERIVED on every request from probe rows,
-- interface counters and the connection state — it exists in no table, so an
-- acknowledgement cannot be written back to "the event". It is stored here
-- instead, against the agent, with a signature of the verdict that was
-- acknowledged.
--
-- SHARED, not per-user (unlike the Changes acks in 115): Fleet is the NOC
-- screen a shift reads together. "Somebody has this" is the answer the next
-- person needs, and an acknowledgement only one account can see would tell
-- them nothing.
--
-- A CHANGED VERDICT RE-OPENS THE ROW: `signature` is a hash of the status and
-- the reason that was acknowledged (healthSignature in src/health/healthAck.js).
-- When the agent's verdict moves — a second target drops, a link starts
-- discarding, the reason text changes — the signature no longer matches and the
-- row reads unacknowledged again. Acknowledging never suppresses alerting:
-- severity_rules and alert_rules are untouched by this table.
--
-- ONE ROW PER AGENT: the agent id is the primary key, so acknowledging again
-- replaces the previous acknowledgement rather than accumulating history. The
-- audit trail is where "who cleared what, when" is kept.
CREATE TABLE IF NOT EXISTS `agent_health_acks` (
  `agent_id` INT UNSIGNED NOT NULL,
  `signature` CHAR(64) NOT NULL,
  `status` VARCHAR(16) NOT NULL,
  `note` VARCHAR(255) NULL DEFAULT NULL,
  `acked_by` INT UNSIGNED NULL DEFAULT NULL,
  `acked_email` VARCHAR(255) NULL DEFAULT NULL,
  `acked_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`agent_id`),
  CONSTRAINT `fk_agent_health_acks_agent` FOREIGN KEY (`agent_id`)
    REFERENCES `agents` (`id`) ON DELETE CASCADE,
  -- The acknowledger survives the user row being deleted as an email snapshot,
  -- the same way event notes keep theirs.
  KEY `idx_agent_health_acks_user` (`acked_by`),
  CONSTRAINT `fk_agent_health_acks_user` FOREIGN KEY (`acked_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
