-- 136 — commands waiting for an agent that is not connected right now.
--
-- Every privileged push (update, install-tool, run-test …) went out over the
-- live socket or not at all: `sendCommand` returned 0 and the route answered
-- `409 Agent not connected`. That is right for anything an operator is watching
-- the answer to — a ping, a diagnose, a speedtest — and wrong for the one thing
-- a fleet actually depends on, which is being UPDATED. An agent on a laptop that
-- is online for ten minutes a day could not be updated at all: the click had to
-- coincide with the connection.
--
-- So an update can be left here instead, and the socket delivers it the moment
-- that agent next dials in.
--
-- Three things this table deliberately does NOT hold:
--
--   * a SIGNED command. A signature carries `issuedAt` and the agent refuses one
--     more than five minutes off its clock, so a command signed at enqueue time
--     would be dead on arrival. The payload is stored unsigned and signed at
--     delivery, which also means a queued command cannot be replayed out of the
--     database later — it is only ever as fresh as its delivery.
--   * anything without an expiry. `expires_at` is always set: an update for a
--     version that has since been superseded must not be delivered to a host
--     that comes back next month.
--   * more than one entry of a kind per agent. The unique key makes queueing
--     idempotent — clicking Update three times on an offline agent leaves one
--     command, not three — and a delivered row is DELETED rather than flagged,
--     so "what is waiting" is simply what is in the table.
CREATE TABLE IF NOT EXISTS `agent_command_queue` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agent_id` INT UNSIGNED NOT NULL,
  -- The command's `name` ('update'), used for the idempotency key and so a
  -- caller can ask what is waiting without decoding the payload.
  `kind` VARCHAR(40) NOT NULL,
  -- The command object, unsigned, as JSON. Signed at delivery (see above).
  `payload` JSON NOT NULL,
  -- The audit row this queued command belongs to, so the eventual outcome lands
  -- on the request that asked for it rather than looking unattributed.
  `audit_id` INT UNSIGNED NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_agent_command_kind` (`agent_id`, `kind`),
  KEY `idx_agent_command_expiry` (`expires_at`),
  CONSTRAINT `fk_agent_command_agent` FOREIGN KEY (`agent_id`)
    REFERENCES `agents` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
