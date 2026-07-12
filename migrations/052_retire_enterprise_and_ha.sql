-- 052 — retire the Enterprise tier and the HA / offline-license capabilities.
--
-- Product simplification: the sellable tiers are now Pilot / Starter /
-- Professional (Professional is the top tier). The SSO (LDAP/OIDC/SAML),
-- compliance-report and premium-support functions that used to be
-- Enterprise-only have moved down into Professional. High-availability
-- (`ha_deployment`) and offline/air-gap license validation (`offline_license`)
-- have been removed from the product entirely.
--
-- `license_plans` is a SHARED mirror of src/license/plans.js (no runtime code
-- reads it); this migration re-aligns it and drops the now-defunct `ha_nodes`
-- cluster registry that backed the removed HA coordinator.

-- Remove the retired Enterprise package row (idempotent — no-op if absent).
DELETE FROM license_plans WHERE plan_key = 'enterprise';

-- Re-align Professional's allowed_features: fold in the former Enterprise SSO /
-- compliance / premium-support keys; it stays the top tier. `ha_deployment` and
-- `offline_license` are dropped from the catalogue entirely.
UPDATE license_plans
   SET support_level = 'premium',
       allowed_features = JSON_ARRAY(
         'dashboard_basic', 'dashboard_advanced', 'reports_basic', 'reports_pdf',
         'reports_csv', 'reports_sla', 'reports_compliance', 'rbac', 'audit_log',
         'api_access', 'alerts_email', 'alerts_webhook', 'sso_ldap', 'sso_oidc',
         'sso_saml', 'premium_support')
 WHERE plan_key = 'professional';

-- Drop the high-availability cluster registry (the HA coordinator is gone).
DROP TABLE IF EXISTS ha_nodes;
