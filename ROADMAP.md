# BlueEye feature roadmap & status

This is the single human-readable checklist for the commercial **feature matrix**
shown in **Settings → License**. It mirrors the machine source of truth,
`src/license/plans.js` → `FEATURE_CATALOG[*].status` (`available` | `roadmap`),
which drives the matrix endpoint (`GET /license/matrix`) and the **Roadmap**
badge in the dashboard. **Keep this file and that `status` field in step.**

- **Available** = implemented end-to-end and gated by its license feature key.
- **Roadmap** = catalogued and priced into a plan, but not built yet. These are
  rendered with a `Roadmap` badge in the matrix and are tackled one at a time.

Entitlement is always **based on the signed licence** issued by the license
server (`blueeye-licens`): the proof carries the `plan` tier, the on-prem server
resolves that tier → limits + feature keys (`src/license/planService.js`), and
the feature gate (`src/license/features.js`) enforces it. Nothing here is
unlocked by editing local config — the Ed25519 signature would stop matching.

## ✅ Available (shipped)

- [x] **Basic dashboard** (`dashboard_basic`) — `public/app.js` SPA.
- [x] **Basic reports** (`reports_basic`) — `src/routes/reports.js` (availability + incidents).
- [x] **SLA / availability report** (`reports_sla`) — `src/routes/reports.js` `/availability`.
- [x] **CSV reports** (`reports_csv`) — `src/routes/reports.js` `*.csv` + `src/routes/export.js`, gated.
- [x] **PDF reports** (`reports_pdf`) — print-ready HTML report export (`*.html`), gated; print→PDF client-side.
- [x] **E-mail alerts** (`alerts_email`) — `src/analysis/alerting/channels/email.js`, gated per-channel.
- [x] **Webhook alerts** (`alerts_webhook`) — `src/analysis/alerting/channels/webhook.js`, gated per-channel.
- [x] **Compliance report pack** (`reports_compliance`) — NIS2 report generation/export, gated (`src/routes/nis2.js`).
- [x] **Role-based access control** (`rbac`) — admin/operator/viewer; user management gated (`src/routes/users.js`).
- [x] **Audit log** (`audit_log`) — unified change/security trail (`src/routes/auditLog.js`, `audit_log` table), gated.
- [x] **API access** (`api_access`) — programmatic API tokens (`src/routes/apiTokens.js`, `api_tokens` table), gated.
- [x] **LDAP / Active Directory auth** (`sso_ldap`) — `src/auth/ldap.js` + `src/routes/ldap.js`, gated.
- [x] **Offline license validation** (`offline_license`) — `src/license/licenseVerifier.js` + `offlineLicenseManager.js`.
- [x] **High-availability deployment** (`ha_deployment`) — multiple replicas behind a load balancer; one elected leader runs the singleton jobs (retention / test-packages / GeoIP) via a MySQL advisory lock (`src/ha/leaderLock.js` + `src/ha/coordinator.js`), request handling stays stateless; status/admin API `src/routes/ha.js` (`/api/ha/*`), gated; cluster registry `ha_nodes` (migration 037). See docs/ha-deployment.md.
- [x] **Premium / priority support** (`premium_support`) — `support_level` carried by the plan (not a software module).

## 🛣️ Roadmap (not built yet — do one at a time)

- [ ] **Advanced dashboard** (`dashboard_advanced`, Professional) — richer drill-downs / custom widgets beyond the basic dashboard.
- [ ] **SSO (OIDC)** (`sso_oidc`, Enterprise) — OpenID Connect login (EU/self-hosted IdP), group→role mapping.
- [ ] **SSO (SAML)** (`sso_saml`, Enterprise) — SAML 2.0 SP login, group→role mapping.
- [ ] **MSP multi-tenancy** (`msp_multitenant`, MSP) — `tenant_id` on agents/test-paths/reports/users + tenant-scoped UI/API.
- [ ] **Security pack** (`security_pack`, Enterprise) — scope TBD (e.g. hardening checks, expanded threat findings, signed audit export).

## How to mark a roadmap item done

1. Build it behind its feature key; gate the routes with `requirePlanFeature`.
2. Flip `status: 'roadmap'` → `'available'` for that key in `src/license/plans.js`.
3. Move its line from the Roadmap list to the Available list here and tick it.
4. Add tests + a fake-gate default; bump `package.json` version (and the agent in
   lockstep if its code changes).
