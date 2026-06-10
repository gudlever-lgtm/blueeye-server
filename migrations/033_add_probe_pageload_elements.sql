-- 033 — page-load probe waterfall. The agent's `pageload` probe fetches a page
-- and its sub-resources (scripts/styles/images) and reports a per-element
-- waterfall: [{ url, kind, status, bytes, ms }]. Stored as JSON alongside the
-- existing rtt_ms (= total load time) and bytes (= total page weight). Nullable +
-- backward-compatible: every other probe type leaves it NULL. Metadata only —
-- resource URLs, status, size and timing, never response bodies.
ALTER TABLE probe_results
  ADD COLUMN elements JSON NULL DEFAULT NULL AFTER content_type;
