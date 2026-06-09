-- 032 — add the LDAP/AD packaged feature (sso_ldap) to the Enterprise & MSP
-- plan catalogue, mirroring src/license/plans.js where it was added to the
-- Enterprise feature bundle (label "LDAP / Active Directory auth").
--
-- The runtime feature gate reads plans.js directly, so this does NOT change
-- access — it keeps the MIRRORED `license_plans` table (seeded once by migration
-- 023, for the admin UI / offline catalogue) in sync. 023 only runs on a fresh
-- database, so this forward migration brings already-initialised installs in
-- line. Idempotent: it re-sets the full array to a fixed value, so a re-run is a
-- no-op and the ordering matches the 023 seed regardless of install path.

UPDATE license_plans
   SET allowed_features = JSON_ARRAY('dashboard_basic', 'dashboard_advanced', 'reports_basic', 'reports_pdf',
              'reports_csv', 'reports_sla', 'rbac', 'audit_log', 'api_access',
              'alerts_email', 'alerts_webhook', 'reports_compliance', 'sso_ldap',
              'sso_oidc', 'sso_saml', 'ha_deployment', 'offline_license', 'security_pack',
              'premium_support')
 WHERE plan_key = 'enterprise';

UPDATE license_plans
   SET allowed_features = JSON_ARRAY('dashboard_basic', 'dashboard_advanced', 'reports_basic', 'reports_pdf',
              'reports_csv', 'reports_sla', 'rbac', 'audit_log', 'api_access',
              'alerts_email', 'alerts_webhook', 'reports_compliance', 'sso_ldap',
              'sso_oidc', 'sso_saml', 'ha_deployment', 'offline_license', 'security_pack',
              'premium_support', 'msp_multitenant')
 WHERE plan_key = 'msp';
