-- 049 — raw device-config snapshots (Fase 3). BlueEye does not capture device
-- running-config today, so this is genuinely new storage. One row per captured
-- config for a device (a device = an agent). Diff-generation between consecutive
-- rows and correlation to incidents build on top of this table.
--
-- config_text is RAW and may contain secrets — reads are operator/admin only
-- (never viewer) and secret-masked at the API layer. captured_via records how the
-- snapshot arrived: manual (pushed by an operator/integration), agent_poll (an
-- agent periodically reporting device config) or change_detected. Only `manual`
-- has a producer today; the others are wired in a later phase.
CREATE TABLE IF NOT EXISTS config_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id INT UNSIGNED NOT NULL,
  config_text MEDIUMTEXT NOT NULL,
  captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  captured_via ENUM('manual', 'agent_poll', 'change_detected') NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_config_snapshots_device_captured (device_id, captured_at),
  CONSTRAINT fk_config_snapshots_device FOREIGN KEY (device_id)
    REFERENCES agents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
