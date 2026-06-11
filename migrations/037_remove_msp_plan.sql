-- 037 — drop the MSP multi-tenancy package. Multi-tenancy (`msp_multitenant`)
-- has been removed from the product, and with it the MSP plan, whose only
-- distinguishing feature it was. Security is now an always-on baseline rather
-- than a sold pack, so the roadmap `security_pack` key is dropped from the
-- Enterprise feature set too.
--
-- The `license_plans` table itself is a SHARED mirror of src/license/plans.js
-- (no runtime code reads it); the `is_msp` column is kept (harmless, defaults
-- to 0) so this migration does not alter shared table structure — it only
-- removes the now-defunct MSP row and re-aligns the Enterprise feature list.

-- Remove the MSP package row (idempotent — no-op if already absent).
DELETE FROM license_plans WHERE plan_key = 'msp';

-- Re-align Enterprise allowed_features: drop the retired `security_pack` key.
UPDATE license_plans
   SET allowed_features = JSON_ARRAY(
         'dashboard_basic', 'dashboard_advanced', 'reports_basic', 'reports_pdf',
         'reports_csv', 'reports_sla', 'rbac', 'audit_log', 'api_access',
         'alerts_email', 'alerts_webhook', 'reports_compliance', 'sso_oidc',
         'sso_saml', 'ha_deployment', 'offline_license', 'premium_support')
 WHERE plan_key = 'enterprise';
