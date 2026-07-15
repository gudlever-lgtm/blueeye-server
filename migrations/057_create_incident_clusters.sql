-- 057 — cross-agent incident clusters.
--
-- Groups analysis findings that fired on DIFFERENT agents within a short time
-- window into a single "incident cluster" with a suspected common cause and a
-- confidence tier. This is the cross-agent counterpart to the per-target
-- correlator (src/analysis/correlator.js) and the per-device incident_cases
-- (migration 047): those never look across agents; this one does.
--
-- Confidence (weighted signals, low|medium|high — see src/analysis/crossAgentCorrelator.js):
--   time proximity alone .................. low
--   time + shared site (topology) ......... medium
--   time + shared site + same finding-type  high
-- (Topology = a shared site / location_id — the only cross-agent adjacency BlueEye
--  has today; subnet/VLAN/LLDP are not reported by agents. See docs/cross-agent-correlation.md.)
--
-- member_finding_ids is a JSON array of `findings.id` values (UUID strings). It is
-- kept as JSON (not a join table) to mirror how a finding's own `correlated_with`
-- links are stored — clusters are a lightweight, derived read-model, recomputed
-- from findings, so a join table would add write amplification for no query win.
--
-- `status` starts 'open'; the resolution sweep flips it to 'resolved' once no new
-- member finding has refreshed `detected_at` within the inactivity window (findings
-- carry no explicit "cleared" event, so inactivity is the resolution proxy).
CREATE TABLE IF NOT EXISTS incident_clusters (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  confidence ENUM('low', 'medium', 'high') NOT NULL DEFAULT 'low',
  member_finding_ids JSON NOT NULL,                    -- JSON array of findings.id (UUID strings)
  suspected_common_cause TEXT NULL DEFAULT NULL,       -- explainable hint; NULL until set
  status ENUM('open', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  detected_at DATETIME NOT NULL,                       -- last activity (bumped as members recur)
  resolved_at DATETIME NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_incident_clusters_status_detected (status, detected_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
