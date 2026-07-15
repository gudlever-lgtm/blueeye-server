-- 058 — cluster-level AI advisory (Step 2).
--
-- Stores the opt-in Mistral advisory (likely common root cause + troubleshooting)
-- generated for a cross-agent cluster once it reaches medium/high confidence. NULL
-- until generated (and stays NULL when the assistant is off, the model returns
-- "insufficient", or the provider call fails). The advisory is always paired with
-- the cluster's member_finding_ids — the underlying evidence — so advice is never
-- surfaced without its evidence list.
ALTER TABLE incident_clusters
  ADD COLUMN advisory TEXT NULL DEFAULT NULL AFTER suspected_common_cause;
