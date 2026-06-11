'use strict';

// Central plan / pricing / feature catalogue for BlueEye.
//
// This is the single source of truth for what each commercial package
// (Pilot / Starter / Professional / Enterprise / MSP) grants: limits, history
// retention, the feature flags it unlocks, the support level and the reference
// prices. Code MUST NOT hard-code plan names or sprinkle `if plan === 'starter'`
// checks around — instead resolve the active plan via planService and ask the
// feature gate / usage service. Keeping the catalogue here (data, not logic)
// makes it trivially testable and lets a future migration mirror it into the
// `license_plans` table without changing any call site.
//
// `null` for a limit means "unlimited / configurable" (Enterprise & MSP).

// The complete set of license-gateable feature keys, each with a UI label and
// the LOWEST plan that grants it. `minPlan` powers the upgrade hints
// ("This feature requires BlueEye Professional"). The four legacy module keys
// (analysis/assistant/alerting/geo) are intentionally NOT here — those stay
// governed by the signed proof's own `features` map for backward compatibility.
//
// `status` records whether the capability is actually SHIPPED or still on the
// ROADMAP. The matrix endpoint and dashboard surface this so a plan column can
// honestly distinguish "you have it" from "this is planned" (rendered as a
// "Roadmap" badge instead of a tick). `ROADMAP.md` at the repo root tracks the
// same list; keep the two in step. Defaults to 'available' when omitted.
//   available — implemented end-to-end and gated by this key.
//   roadmap   — catalogued + priced, but not built yet (do them one at a time).
const FEATURE_CATALOG = {
  dashboard_basic: { label: 'Basic dashboard', minPlan: 'pilot', status: 'available' },
  dashboard_advanced: { label: 'Advanced dashboard', minPlan: 'professional', status: 'available' },
  alerts_email: { label: 'E-mail alerts', minPlan: 'professional', status: 'available' },
  alerts_webhook: { label: 'Webhook alerts', minPlan: 'professional', status: 'available' },
  reports_basic: { label: 'Basic reports', minPlan: 'pilot', status: 'available' },
  reports_pdf: { label: 'PDF reports', minPlan: 'professional', status: 'available' },
  reports_csv: { label: 'CSV reports', minPlan: 'professional', status: 'available' },
  reports_sla: { label: 'SLA / availability report', minPlan: 'professional', status: 'available' },
  reports_compliance: { label: 'Compliance report pack', minPlan: 'enterprise', status: 'available' },
  rbac: { label: 'Role-based access control', minPlan: 'professional', status: 'available' },
  audit_log: { label: 'Audit log', minPlan: 'professional', status: 'available' },
  api_access: { label: 'API access', minPlan: 'professional', status: 'available' },
  sso_ldap: { label: 'LDAP / Active Directory auth', minPlan: 'enterprise', status: 'available' },
  sso_oidc: { label: 'SSO (OIDC)', minPlan: 'enterprise', status: 'roadmap' },
  sso_saml: { label: 'SSO (SAML)', minPlan: 'enterprise', status: 'roadmap' },
  ha_deployment: { label: 'High-availability deployment', minPlan: 'enterprise', status: 'roadmap' },
  offline_license: { label: 'Offline license validation', minPlan: 'enterprise', status: 'available' },
  msp_multitenant: { label: 'MSP multi-tenancy', minPlan: 'msp', status: 'roadmap' },
  security_pack: { label: 'Security pack', minPlan: 'enterprise', status: 'roadmap' },
  premium_support: { label: 'Premium / priority support', minPlan: 'enterprise', status: 'available' },
};

const ALL_FEATURE_KEYS = Object.keys(FEATURE_CATALOG);

// Display-only tiering for the four LEGACY module keys (analysis/assistant/
// alerting/geo). These stay OUT of FEATURE_CATALOG / allowed_features on purpose:
// a plan key alone must never GRANT them (that would let a bare LICENSE_PLAN env
// unlock a module with no signed proof — a licence bypass). Entitlement keeps
// flowing solely from the signed proof's own `features` map. This map exists ONLY
// so the UI can label a locked module with the package it is sold under
// ("Requires BlueEye Professional"). Adjust the tier here — it has no enforcement
// effect.
const MODULE_PLAN_TIER = {
  analysis: 'professional',
  geo: 'professional',
  alerting: 'professional',
  assistant: 'enterprise',
};
// Convenience splits over FEATURE_CATALOG.status, for the UI legend, the matrix
// and tests. A feature with no explicit status counts as 'available'.
function featureStatus(featureKey) {
  const meta = FEATURE_CATALOG[featureKey];
  return meta && meta.status === 'roadmap' ? 'roadmap' : 'available';
}
const ROADMAP_FEATURE_KEYS = ALL_FEATURE_KEYS.filter((k) => featureStatus(k) === 'roadmap');
const AVAILABLE_FEATURE_KEYS = ALL_FEATURE_KEYS.filter((k) => featureStatus(k) === 'available');

// Shared feature bundles, composed below so each tier visibly extends the prior.
const PRO_FEATURES = [
  'dashboard_basic',
  'dashboard_advanced',
  'reports_basic',
  'reports_pdf',
  'reports_csv',
  'reports_sla',
  'rbac',
  'audit_log',
  'api_access',
  'alerts_email',
  'alerts_webhook',
];
const ENTERPRISE_FEATURES = [
  ...PRO_FEATURES,
  'reports_compliance',
  'sso_ldap',
  'sso_oidc',
  'sso_saml',
  'ha_deployment',
  'offline_license',
  'security_pack',
  'premium_support',
];

// The customer-facing packages, in ascending order of capability. `price_from`
// marks "from" pricing (Enterprise / MSP are quoted). Prices are REFERENCE
// figures for the admin UI only — never an enforcement input.
const PLANS = {
  pilot: {
    plan_key: 'pilot',
    plan_name: 'Pilot',
    max_agents: 5,
    max_test_paths: 10,
    history_days: 60,
    allowed_features: ['dashboard_basic', 'reports_basic'],
    support_level: 'basic',
    is_trial: true,
    trial_days: 60,
    is_msp: false,
    is_enterprise: false,
    price_reference_eur: 2500,
    price_reference_dkk: 18500,
    price_from: false,
  },
  starter: {
    plan_key: 'starter',
    plan_name: 'Starter',
    max_agents: 5,
    max_test_paths: 25,
    history_days: 90,
    allowed_features: ['dashboard_basic', 'reports_basic'],
    support_level: 'basic',
    is_trial: false,
    trial_days: 0,
    is_msp: false,
    is_enterprise: false,
    price_reference_eur: 4000,
    price_reference_dkk: 30000,
    price_from: false,
  },
  professional: {
    plan_key: 'professional',
    plan_name: 'Professional',
    max_agents: 25,
    max_test_paths: 150,
    history_days: 365,
    allowed_features: [...PRO_FEATURES],
    support_level: 'standard',
    is_trial: false,
    trial_days: 0,
    is_msp: false,
    is_enterprise: false,
    price_reference_eur: 12000,
    price_reference_dkk: 90000,
    price_from: false,
  },
  enterprise: {
    plan_key: 'enterprise',
    plan_name: 'Enterprise',
    max_agents: null, // configurable / unlimited
    max_test_paths: null,
    history_days: 1095,
    allowed_features: [...ENTERPRISE_FEATURES],
    support_level: 'premium',
    is_trial: false,
    trial_days: 0,
    is_msp: false,
    is_enterprise: true,
    price_reference_eur: 25000,
    price_reference_dkk: 187000,
    price_from: true,
  },
  msp: {
    plan_key: 'msp',
    plan_name: 'MSP',
    max_agents: null,
    max_test_paths: null,
    history_days: 1095,
    allowed_features: [...ENTERPRISE_FEATURES, 'msp_multitenant'],
    support_level: 'partner',
    is_trial: false,
    trial_days: 0,
    is_msp: true,
    is_enterprise: true,
    price_reference_eur: 15000,
    price_reference_dkk: 112000,
    price_from: true,
  },
};

// Display order for the UI feature matrix (low → high).
const PLAN_ORDER = ['pilot', 'starter', 'professional', 'enterprise', 'msp'];

// Internal fallback plans — never sold, never in PLAN_ORDER:
//
//   'licensed'   — a VALID signed proof that predates the plan model (no `plan`
//                  field). Preserves today's behaviour exactly: unlimited plan
//                  limits (the proof's own max_agents still applies via the
//                  license manager) and no NEW feature keys (the legacy
//                  analysis/assistant/alerting/geo map still governs those).
//
//   'unlicensed' — no usable license at all. Safe, locked-down default: zero
//                  limits, no features. Matches the spec's "pilot_expired"
//                  posture — only minimal read functionality remains.
const FALLBACK_PLANS = {
  licensed: {
    plan_key: 'licensed',
    plan_name: 'Licensed',
    max_agents: null,
    max_test_paths: null,
    history_days: null,
    allowed_features: [],
    support_level: 'standard',
    is_trial: false,
    trial_days: 0,
    is_msp: false,
    is_enterprise: false,
    price_reference_eur: null,
    price_reference_dkk: null,
    price_from: false,
    internal: true,
  },
  unlicensed: {
    plan_key: 'unlicensed',
    plan_name: 'Unlicensed',
    max_agents: 0,
    max_test_paths: 0,
    history_days: 0,
    allowed_features: [],
    support_level: 'none',
    is_trial: false,
    trial_days: 0,
    is_msp: false,
    is_enterprise: false,
    price_reference_eur: null,
    price_reference_dkk: null,
    price_from: false,
    internal: true,
  },
};

// Resolves any known plan key (sellable or internal). Returns null when unknown.
function getPlan(planKey) {
  if (!planKey || typeof planKey !== 'string') return null;
  return PLANS[planKey] || FALLBACK_PLANS[planKey] || null;
}

// The human BlueEye name for a plan key ("BlueEye Professional"), used in
// upgrade hints. Falls back to a generic label for unknown keys.
function planDisplayName(planKey) {
  const p = getPlan(planKey);
  return p ? `BlueEye ${p.plan_name}` : 'a higher BlueEye plan';
}

// Whether `planKey` is at least as capable as the plan that first grants
// `featureKey` — used to phrase upgrade hints. Compares by PLAN_ORDER position.
function meetsFeatureTier(planKey, featureKey) {
  const meta = FEATURE_CATALOG[featureKey];
  if (!meta) return false;
  const have = PLAN_ORDER.indexOf(planKey);
  const need = PLAN_ORDER.indexOf(meta.minPlan);
  if (have === -1 || need === -1) return false;
  return have >= need;
}

module.exports = {
  PLANS,
  FALLBACK_PLANS,
  PLAN_ORDER,
  FEATURE_CATALOG,
  ALL_FEATURE_KEYS,
  MODULE_PLAN_TIER,
  ROADMAP_FEATURE_KEYS,
  AVAILABLE_FEATURE_KEYS,
  featureStatus,
  getPlan,
  planDisplayName,
  meetsFeatureTier,
};
