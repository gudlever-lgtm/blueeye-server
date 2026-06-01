-- 008 — geographic coordinates + address for locations, so agents can be shown
-- on a map. Coordinates are entered manually (nullable until set).
ALTER TABLE locations
  ADD COLUMN address VARCHAR(512) NULL DEFAULT NULL AFTER description,
  ADD COLUMN latitude DECIMAL(9,6) NULL DEFAULT NULL AFTER address,
  ADD COLUMN longitude DECIMAL(9,6) NULL DEFAULT NULL AFTER latitude;
