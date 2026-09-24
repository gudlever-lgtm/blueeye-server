-- 128 — the sFlow exporters each agent hears from, and whether each one is a
-- device the product knows.
--
-- An sFlow exporter pushes its interface counters (generic + Ethernet error
-- counters) every polling interval, unasked. When its address is a registered
-- SNMP device those counters become device_counter_samples through the same
-- counter path an SNMP poll takes — which is what gives a switch nobody polls
-- over SNMP its per-port errors and duplex. When it is NOT registered, the
-- counters have nowhere to go, and the coverage report has to be able to say
-- so ("sFlow exporter not registered as a device"). That needs a record of who
-- was heard, which is this table.
--
-- ONE ROW PER (agent, exporter address), upserted by the ingest: bounded by the
-- number of exporters, not by traffic, so it needs no purge.
--
-- `device_id`   the snmp_devices row the address matched at the last sighting,
--               NULL when it matched none. SET NULL when the device is deleted:
--               the exporter is still out there, now unregistered.
-- `interfaces`  distinct ifIndexes in the last batch — "a 48-port switch", as
--               evidence in the gap, not a count to add up.

CREATE TABLE IF NOT EXISTS sflow_exporters (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_id INT UNSIGNED NOT NULL,
  address VARCHAR(45) NOT NULL,
  device_id INT UNSIGNED NULL DEFAULT NULL,
  interfaces INT UNSIGNED NOT NULL DEFAULT 0,
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sflow_exporter (agent_id, address),
  KEY idx_sflow_exporter_last_seen (last_seen),
  CONSTRAINT fk_sflow_exporter_agent FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE,
  CONSTRAINT fk_sflow_exporter_device FOREIGN KEY (device_id) REFERENCES snmp_devices (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
