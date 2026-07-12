-- 054 — give Starter a real mid-tier feature segment.
--
-- Starter used to grant exactly the same features as Pilot (differing only in
-- limits). It now adds a mid-tier bundle over Pilot's basics — e-mail alerts
-- (`alerts_email`) and PDF/CSV report exports (`reports_pdf` / `reports_csv`) —
-- so the three tiers are properly segmented (Pilot < Starter < Professional).
--
-- `license_plans` is a SHARED mirror of src/license/plans.js (no runtime code
-- reads it); this migration only re-aligns the Starter row.

UPDATE license_plans
   SET allowed_features = JSON_ARRAY(
         'dashboard_basic', 'reports_basic',
         'alerts_email', 'reports_pdf', 'reports_csv')
 WHERE plan_key = 'starter';
