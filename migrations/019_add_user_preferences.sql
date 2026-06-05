-- 019 — per-user UI preferences (e.g. the dashboard colour theme). Stored as a
-- small JSON blob so new personal settings can be added without a schema change.
-- NULL means "no preferences set yet" (the dashboard falls back to its defaults).
ALTER TABLE users
  ADD COLUMN preferences JSON DEFAULT NULL AFTER protected;
