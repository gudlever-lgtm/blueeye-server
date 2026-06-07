-- 023 — incident thresholds. Per-metric cut-offs used to derive incidents from
-- active-probe results (probe_results). A row with location_id = NULL is the
-- GLOBAL default for that metric; a row with a concrete location_id overrides
-- the global for that one site. Lookup: location-specific row wins, else fall
-- back to the global (location_id IS NULL).
--
-- warning_value / critical_value are interpreted per metric:
--   reachability — a failed probe (ok = 0) is always critical; the value
--                  columns are unused (NULL) and kept only for a uniform shape.
--   latency      — rtt_ms >= warning_value => warning, >= critical_value => critical (ms).
--   packet_loss  — loss_pct >= warning_value => warning, >= critical_value => critical (%).
--
-- debounce_count = how many CONSECUTIVE failing results (per agent/metric/target)
-- are required before an incident is opened (default 3), to ride out blips.
CREATE TABLE IF NOT EXISTS incident_thresholds (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_id INT UNSIGNED NULL DEFAULT NULL,
  metric ENUM('reachability', 'latency', 'packet_loss') NOT NULL,
  warning_value DOUBLE NULL DEFAULT NULL,
  critical_value DOUBLE NULL DEFAULT NULL,
  debounce_count INT UNSIGNED NOT NULL DEFAULT 3,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_incident_thresholds_location_metric (location_id, metric),
  CONSTRAINT fk_incident_thresholds_location FOREIGN KEY (location_id)
    REFERENCES locations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the global defaults (location_id IS NULL). reachability is critical on any
-- failure; latency warns at 150 ms / criticals at 300 ms; packet loss warns at
-- 2% / criticals at 5%.
INSERT INTO incident_thresholds (location_id, metric, warning_value, critical_value, debounce_count)
VALUES
  (NULL, 'reachability', NULL, NULL, 3),
  (NULL, 'latency', 150, 300, 3),
  (NULL, 'packet_loss', 2, 5, 3);
