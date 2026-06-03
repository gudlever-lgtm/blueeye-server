-- Bulk / multi-use enrollment codes. A code may now be redeemed up to
-- `max_uses` times within its TTL window (default 1 = the previous single-use
-- behaviour). `uses_remaining` is decremented on each successful enrollment;
-- `used_at` keeps its meaning (set when the code is fully consumed).
ALTER TABLE enrollment_codes
  ADD COLUMN max_uses INT UNSIGNED NOT NULL DEFAULT 1 AFTER expires_at,
  ADD COLUMN uses_remaining INT UNSIGNED NOT NULL DEFAULT 1 AFTER max_uses;

-- Existing codes that were already redeemed have no uses left.
UPDATE enrollment_codes SET uses_remaining = 0 WHERE used_at IS NOT NULL;
