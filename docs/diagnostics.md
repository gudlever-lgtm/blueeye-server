# Test area — connectivity & security screening

The **Test area** (dashboard tab, admin-only) is a single place to verify every
*outbound* integration the server depends on, and to screen each one's security
posture. It does not add any new way to *configure* those integrations — it reuses
each subsystem's existing test primitive and layers an explainable security check
on top.

> UI: nav **Diagnostics → Test area** (`data-min-role="admin"`), `views.screening`
> in `public/app.js`, help in `PAGE_INFO.screening`.
> API: `GET/POST /api/diagnostics/*` (admin), `src/routes/diagnostics.js`.

Each row carries a **"Set up →"** link (`screenSetupLink` → `settingsLink`) that deep-links to
where the target is configured: alert channels → **Settings → Alerting**, SSO → **Settings →
Authentication**, AI → **Settings → Analysis**, map → **Settings → Map**, licence → **Settings →
License**, and ITSM/IPAM receivers → **Settings → Integrations** (`settingsIntegrationsView` —
the CRUD page for ServiceNow/Nautobot/webhook connectors, with a per-row test; credentials are
write-only).

## What it screens

| Group | Targets | Connectivity test (reused) |
| --- | --- | --- |
| Email & alert channels | Email (SMTP), Webhook, Syslog | `alertingDispatcher.test(channel)` (same as `POST /api/alerting/test`) |
| Remote API receivers (ITSM/IPAM) | each configured ServiceNow / Nautobot / generic-webhook integration | `integrationsDispatcher.testFire(id, actor)` (same as `POST /api/integrations/:id/test`) |
| Authentication (SSO) | LDAP/AD, OIDC, SAML | `ldapAuth.testConnection()`, `oidcAuth.testDiscovery()`, reachability probe of the SAML IdP SSO URL |
| Other outbound services | AI assistant, map tiles / geocoder, licence server | reachability probe (assistant), posture-only (map, licence — derived from `licenseManager.getStatus()`) |

## Two verdicts per target

1. **Connectivity** — a live test. Reachable ⇒ `ok`, failed ⇒ `bad`. Targets with
   no live test (map, licence) report posture only.
2. **Security posture** — pure, explainable checks in `src/diagnostics/screening.js`
   (HTTPS vs plaintext, SMTP TLS, signed webhooks, authentication, plaintext LDAP,
   IdP signing cert, EU/self-hosted provider, licence state, private-address targets).
   Each check carries a `status` (`ok`/`info`/`warn`/`bad`) and a plain-language note.

The row's overall severity is the **worse** of the two, so a target that is
reachable but insecurely configured (e.g. plaintext HTTP) is still flagged.

## API

- `GET /api/diagnostics/targets` → `{ groups, targets[], summary }`. The catalogue
  with posture, **no live tests run**. Each target: `{ id, category, group, name,
  detail, configured, enabled, licensed, runnable, security[], posture }`.
- `POST /api/diagnostics/run` body `{ targets?: string[] }` → runs the connectivity
  test for the requested ids (omit/empty = screen everything) and returns each
  target plus `result: { ran, ok, severity, detail, durationMs }` + a `summary`.

Target ids: `alert:email` · `alert:webhook` · `alert:syslog` · `integration:<id>`
· `ldap` · `oidc` · `saml` · `assistant` · `map` · `license`.

## Safety & secrets

- **Side effects:** the email/webhook/syslog tests deliver a real test message; an
  ITSM/IPAM test makes a real *read-only* call (the connectors' own `test()`); SSO
  and other services are probed for reachability only. The UI says so up front.
- **No SSRF surface:** the request carries only target *ids*; every URL comes from
  server-side config, never request input. Integration tests keep the integrations
  SSRF guard; the infra reachability probe (`src/diagnostics/reach.js`) deliberately
  allows private/self-hosted hosts (EU/self-hosted policy) since the URL is admin
  config, not user input.
- **No secrets** are ever returned — the catalogue is built from already-redacted
  config (`settingsService.getAlertingSafe`, integration safe rows, the auth
  services' `status()`), and connector test results are themselves secret-free.
- **Licensing:** SSO targets show `licensed:false` and are skipped when the plan
  does not include the feature (`sso_ldap`/`sso_oidc`/`sso_saml`).
- `POST /api/diagnostics/run` is recorded by the server-wide audit middleware;
  integration tests additionally write an `integration_audit` row.

## Files

- `src/routes/diagnostics.js` — the router (orchestration + connectivity runners).
- `src/diagnostics/screening.js` — pure security-posture checks (unit-tested).
- `src/diagnostics/reach.js` — injected-fetch reachability probe (no SSRF block).
- `public/app.js` `views.screening` + `public/styles.css` `.screen-*` — the UI.
- Tests: `test/diagnosticsApi.test.js`, `src/diagnostics/__tests__/screening.test.js`.
