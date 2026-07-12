-- 052 — "bring your own CMDB": add a generic, config-driven CMDB connector.
--   * extend the type enum with 'custom'
--   * add config_json for the custom connector's non-secret settings
--     (search path, query param, result path + field mappings). NULL for the
--     built-in ServiceNow/Nautobot types, which need no extra config.
ALTER TABLE cmdb_config
  MODIFY COLUMN type ENUM('servicenow', 'nautobot', 'custom') NOT NULL;

ALTER TABLE cmdb_config
  ADD COLUMN config_json JSON NULL DEFAULT NULL AFTER auth_type;
