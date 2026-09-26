-- 140 — remembering WHICH keys this server has been running with.
--
-- Two Ed25519 public keys decide whether an agent will ever accept anything from
-- this server again:
--
--   'license'       the vendor root from blueeye-licens, embedded in
--                   src/license/publicKey.js. Every licence proof — and with it
--                   the authorisation naming which key this server may sign
--                   with — is verified against it. The agent embeds the same
--                   constant (blueeye-agent/src/license/vendorRoot.js).
--   'agent_release' the agent-release signing key held in `agent_release_key`.
--                   Every installed agent PINS its fingerprint and refuses an
--                   update or a privileged command signed by anything else.
--
-- Neither is meant to change, ever. When one does, nothing fails loudly on its
-- own: the server keeps running, keeps serving the dashboard, and the fleet
-- simply stops accepting updates — one host at a time, as each is next asked to
-- take one. That is the failure this table exists to convert into a warning on
-- the day it happens rather than a mystery weeks later.
--
-- One row per kind. `fingerprint` is what the server saw on THIS boot;
-- `previous_fingerprint` is what it saw before, kept so the warning can name
-- both. `change_count` never resets — a key that has moved twice is a different
-- story from one that moved once.
--
-- ACKNOWLEDGEMENT IS PER FINGERPRINT, not a boolean: `acknowledged_fingerprint`
-- records which value an admin signed off on, so dismissing the warning for
-- today's change cannot silence tomorrow's.
CREATE TABLE IF NOT EXISTS `trust_key_identity` (
  `kind` VARCHAR(32) NOT NULL,
  `fingerprint` CHAR(64) NOT NULL,
  `previous_fingerprint` CHAR(64) NULL DEFAULT NULL,
  `first_seen_at` DATETIME(3) NOT NULL,
  `changed_at` DATETIME(3) NULL DEFAULT NULL,
  `change_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `acknowledged_fingerprint` CHAR(64) NULL DEFAULT NULL,
  `acknowledged_at` DATETIME(3) NULL DEFAULT NULL,
  `acknowledged_by` INT UNSIGNED NULL DEFAULT NULL,
  PRIMARY KEY (`kind`),
  KEY `idx_trust_key_identity_ack_user` (`acknowledged_by`),
  CONSTRAINT `fk_trust_key_identity_ack_user` FOREIGN KEY (`acknowledged_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
