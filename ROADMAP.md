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
- [x] **Advanced dashboard** (`dashboard_advanced`) — drill-down widget panels (`views.advanced` + `GET /api/dashboard/advanced`, `src/dashboard/advancedDashboard.js`), gated.
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
- [x] **SSO (OIDC)** (`sso_oidc`) — OpenID Connect (authorization-code + PKCE, EU/self-hosted IdP), claim→role mapping; `src/auth/oidc.js` + `src/routes/oidc.js`, gated.
- [x] **SSO (SAML)** (`sso_saml`) — SAML 2.0 SP-initiated login, hand-rolled signature/assertion verification, attribute→role mapping; `src/auth/saml.js` + `src/routes/saml.js`, gated.
- [x] **Offline license validation** (`offline_license`) — `src/license/licenseVerifier.js` + `offlineLicenseManager.js`.
- [x] **Premium / priority support** (`premium_support`) — `support_level` carried by the plan (not a software module).

### 🔒 Baseline security (always on — not a pack, not licence-gated)

Security is a fixed part of the product, enforced on every deployment regardless
of plan or licence. It is intentionally **not** a sold feature key.

- [x] **Security response headers** — HSTS, CSP, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy` on every response
  (`src/middleware/securityHeaders.js`, mounted in `src/app.js`).
- [x] **Brute-force login lockout** — per-user + per-IP failed-attempt counting
  with exponential backoff; a locked login is refused with **429** (distinct
  from a 401 bad password) so the audit log can tell them apart
  (`src/auth/loginThrottle.js`, wired in `src/routes/auth.js`).
- [x] **Enforced password policy** — minimum length + character-class
  complexity; a violation is rejected with **422**
  (`src/auth/password.js` `checkPasswordPolicy`, enforced in `src/routes/users.js`).

## 🛣️ Roadmap (not built yet — do one at a time)

- [ ] **High-availability deployment** (`ha_deployment`, Enterprise) — active/standby or clustered server, shared state, health/failover docs.

## How to mark a roadmap item done

1. Build it behind its feature key; gate the routes with `requirePlanFeature`.
2. Flip `status: 'roadmap'` → `'available'` for that key in `src/license/plans.js`.
3. Move its line from the Roadmap list to the Available list here and tick it.
4. Add tests + a fake-gate default; bump `package.json` version (and the agent in
   lockstep if its code changes).
