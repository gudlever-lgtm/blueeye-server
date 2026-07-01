# Licensing, plans & feature gating

BlueEye is sold in packages. This document describes the plan model, the
features and limits per plan, how a license is activated/changed, how the
offline (signed) license model fits in, and how support levels map to plans.

> **Where the code lives**
> - `src/license/plans.js` — the plan + feature **catalogue** (single source of truth).
> - `src/license/planService.js` — resolves the **active** plan and answers
>   limit/feature questions.
> - `src/license/features.js` — the **feature gate** (`isFeatureEnabled`,
>   `requireFeature`, `requirePlanFeature`).
> - `src/services/usageService.js` — counts agents / active test paths and
>   enforces limits.
> - `src/license/licenseManager.js` — validates the signed proof (online today,
>   offline-ready).
> - `migrations/023_create_license_plans.sql` — mirrors the catalogue into
>   `license_plans` + a `licenses` table for the admin UI and offline model.

## Plans

| Plan | Max agents | Max active test paths | History | Support | Trial | Price (EUR) | Price (DKK) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pilot | 5 | 10 | 60 days | basic | 60-day trial | 2 500 | 18 500 |
| Starter | 5 | 25 | 90 days | basic | – | 4 000 | 30 000 |
| Professional | 25 | 150 | 365 days | standard | – | 12 000 | 90 000 |
| Enterprise | unlimited¹ | unlimited¹ | 1 095 days | premium | – | from 25 000 | from 187 000 |

¹ "Unlimited" means configurable per contract; a signed proof may still set a
per-customer `max_agents` which always wins over the plan default.

Prices are **reference figures** for the admin UI only — they are never an
enforcement input.

## Features per plan

The full list of gateable feature keys is in `FEATURE_CATALOG`
(`src/license/plans.js`). Each grants from a minimum plan:

| Feature key | Label | From plan |
| --- | --- | --- |
| `dashboard_basic` | Basic dashboard | Pilot |
| `reports_basic` | Basic reports | Pilot |
| `dashboard_advanced` | Advanced dashboard | Professional |
| `reports_pdf` / `reports_csv` | PDF / CSV reports | Professional |
| `reports_sla` | SLA / availability report | Professional |
| `rbac` | Role-based access control | Professional |
| `audit_log` | Audit log | Professional |
| `api_access` | API access | Professional |
| `alerts_email` / `alerts_webhook` | E-mail / webhook alerts | Professional |
| `reports_compliance` | Compliance report pack | Enterprise |
| `sso_oidc` / `sso_saml` | SSO (OIDC / SAML) | Enterprise |
| `ha_deployment` | High-availability deployment | Enterprise |
| `offline_license` | Offline license validation | Enterprise |
| `premium_support` | Premium / priority support | Enterprise |

> The four **legacy module** keys (`analysis`, `assistant`, `alerting`, `geo`)
> are intentionally **not** part of the plan catalogue. They remain governed by
> the signed proof's own `features` map for full backward compatibility. The
> feature gate ORs the two together, so the plan layer never removes existing
> access.

## Limits

Limits are enforced at the point of creation/activation, returning a graceful
HTTP 403 (never a stack trace):

```json
{
  "success": false,
  "error": "plan_limit_reached",
  "resource": "agents",
  "limit": 5,
  "used": 5,
  "message": "Your current BlueEye Starter licence allows up to 5 agents. Contact your administrator or upgrade the licence to add more."
}
```

- **Agents** — `max_agents`. New agent WebSocket connections are also gated by
  the signed proof (`licenseManager.canAcceptNewConnection`).
- **Active test paths** — `max_test_paths`. An *enabled* test package counts as
  one active test path; disabled packages never count. Enforced on create and on
  the disabled→enabled transition (`src/routes/testPackages.js`).
- **History** — `history_days` (see *History retention* below).

A `null` limit means unlimited (Enterprise).

## Feature gating — how to use it

Resolve nothing by hand; ask the gate / services (no scattered `if plan === …`):

```js
// In a route module wired with { featureGate, planService, usageService }:
const { requirePlanFeature } = require('../license/features');

// Gate a whole endpoint on a packaged feature (403 with an upgrade hint):
router.post('/api/reports/compliance',
  requireAuth, requireRole(ROLES.ADMIN),
  requirePlanFeature({ featureGate, planService }, 'reports_compliance'),
  handler);

// Inline check:
if (!featureGate.isFeatureEnabled('api_access')) { /* … */ }

// Enforce a resource limit before creating something:
const check = await usageService.assertWithinLimit('test_paths');
if (!check.ok) return res.status(403).json(check.body);
```

Denial for a packaged feature returns the documented contract:

```json
{ "success": false, "error": "feature_not_available", "message": "This feature requires BlueEye Enterprise." }
```

### Read-only endpoints for the UI

- `GET /license/status` — signed-proof status (unchanged).
- `GET /license/features` — the four legacy module booleans (unchanged).
- `GET /license/plan` — active plan summary (name, support, limits, features).
- `GET /license/usage` — current usage vs. plan limits.
- `GET /license/matrix` — full plan × feature grid + the active plan, for the
  feature matrix and upgrade hints.

The dashboard **Settings → License** tab renders the plan overview, usage bars
and the feature matrix from these.

## Activating a license

The active plan is resolved (in priority order):

1. The `plan` field on the **signature-verified** license proof
   (`licenseManager.getPlan()`).
2. A locally configured plan: `LICENSE_PLAN` (→ `config.license.plan`), for
   on-prem installs that set the package without a full proof (e.g. pilots).
3. Safe fallback: `licensed` when a valid proof exists but carries no plan
   (legacy behaviour — unlimited plan limits, no new features), otherwise
   `unlicensed` (locked down — zero limits, no features).

To activate online: set `LICENSE_KEY` / `LICENSE_SERVER_ID` / `LICENSE_SERVER_URL`
and the `LICENSE_PUBLIC_KEY`, then the manager validates every 6 hours (or press
**Re-validate now** in the UI). To run a pilot without the license server, set
`LICENSE_PLAN=pilot`.

## Changing plan

- **Online proof:** change the plan with the provider; the next validation (or
  **Re-validate now**) picks up the new `plan`/`limits`/`features`.
- **Local override:** change `LICENSE_PLAN` and restart.
- The catalogue itself (limits, features, prices) is edited in
  `src/license/plans.js`; re-running migration `023` re-seeds `license_plans`.

## The public key trust anchor

`src/license/publicKey.js` embeds the Ed25519 public key used to verify every
proof (online or offline) — this repo being public does not weaken it, since a
public key is not secret. What *would* weaken it is letting the same operator
who runs the server also choose which public key gets trusted: they could then
point verification at a key of their own and self-sign an arbitrary license,
entirely without touching the tracked source.

So `LICENSE_PUBLIC_KEY` (env override, handy for dev/tests) is only honoured in
production when `TRUST_ANCHOR_OVERRIDE_ACK=i-accept-the-risk` is also set (see
`src/license/trustAnchorGuard.js`); otherwise production always falls back to
the embedded constant, and the blocked override is logged loudly at boot. **For
a real production install, embed the real key directly in `publicKey.js`**
instead of relying on the env var. `scripts/dev-bootstrap.js` sets the ack flag
because it generates a fresh, self-consistent key pair for the local demo
stack — that's the one legitimate case for it.

The same reasoning does **not** apply to `AGENT_RELEASE_PUBLIC_KEY`
(`src/license/releaseKey.js`): that trust anchor asserts "this server approved
these agent updates," which the server's own operator is expected to control
(see the managed key in `src/enroll/releaseKeyService.js`), so there's no
equivalent env override to guard there.

Relatedly, `LICENSE_GRACE_DAYS` (max 30) and `LICENSE_VALIDATE_INTERVAL_HOURS`
(max 24) are clamped in `src/config.js` — an operator can shorten them but not
extend them past the cap, so periodic re-validation can't be defeated by
setting an extreme grace period once and then never letting the server reach
the license server (or re-read the offline file) again.

## Offline license (implemented)

The server can validate a **local signed license file** entirely on-box, with no
contact to any external license server. Set `LICENSE_FILE` (which implies
`LICENSE_MODE=offline`) and point it at a signed license:

```
LICENSE_FILE=/etc/blueeye/license.json
LICENSE_PUBLIC_KEY=...        # the blueeye-licens PUBLIC key (PEM or base64)
LICENSE_SERVER_ID=<server id> # optional binding; a bound licence must match
```

The license file is a signed proof — the canonical payload plus an Ed25519
signature over it (same primitive and canonical bytes as the online proof):

```json
{
  "payload": {
    "organization_id": "org-42",
    "plan_key": "professional",
    "serverId": "<LICENSE_SERVER_ID>",
    "valid_from": "2026-01-01T00:00:00Z",
    "valid_until": "2027-01-01T00:00:00Z",
    "max_agents_override": 50,
    "max_test_paths_override": 300,
    "enabled_features_override": ["rbac", "sso_oidc"]
  },
  "signature": "<base64 Ed25519 signature over canonicalize(payload)>"
}
```

How it works:

- `src/license/licenseVerifier.js` (**LicenseVerifier**) reads the file, verifies
  the signature with the public key (`verifyProof` / `src/license/verify.js`),
  checks the optional server binding and the `valid_from`/`valid_until` window,
  and maps the payload to `{ plan, limits, features }`.
- `src/license/offlineLicenseManager.js` wraps the verifier behind the **same
  interface** as the online manager (`isLicensed` / `getMaxAgents` /
  `getMaxTestPaths` / `getPlan` / `getFeatures` / `canAcceptNewConnection` /
  `getStatus` / `start` / `stop` / `validateOnce`). `src/server.js` selects it
  when `LICENSE_MODE=offline`, so the plan service, feature gate, WS connection
  guard and routes are all unchanged.
- It re-reads the file periodically (`LICENSE_VALIDATE_INTERVAL_HOURS`) to catch
  `valid_until` crossing, and **Re-validate now** re-reads it immediately — both
  without any network.

**Restricted mode:** if the file is missing, malformed, not yet valid, expired
or its signature does not verify, the manager reports *not licensed*. The plan
service then falls back to the locked-down `unlicensed` plan (zero limits, no
features) and new agent connections are refused — the server still boots and
runs, just restricted. `GET /license/status` reports `mode: "offline"` with the
reason and `validUntil`.

### Issuing an offline license

Signing uses the **private** key (kept in blueeye-licens, never on this server).
The operator helper produces a signed file:

```
node scripts/sign-offline-license.js \
  --key ./license-signing-private.pem --out ./license.json \
  --org org-42 --plan professional --server <LICENSE_SERVER_ID> \
  --from 2026-01-01 --until 2027-01-01 \
  --max-agents 50 --max-test-paths 300 \
  --feature rbac --feature sso_oidc
```

The optional `licenses` table (migration 023) mirrors `signed_payload` +
`signature` for installs that prefer to store the license in the database.

The signed payload is **only ever evidence of license status — never an access
token.** Agent tokens stay entirely local to the server.

## Support levels

Each plan carries a `support_level`, surfaced in `GET /license/plan` and the UI:

| Plan | `support_level` |
| --- | --- |
| Pilot / Starter | `basic` |
| Professional | `standard` |
| Enterprise | `premium` |

## Feature status & roadmap

Each feature in `FEATURE_CATALOG` carries a `status` (`available` | `roadmap`),
surfaced in `GET /license/matrix` and rendered as a **Roadmap** badge in the
Settings → License matrix. The human checklist is **[ROADMAP.md](../ROADMAP.md)**
at the repo root — keep it and the `status` field in step.

**Now implemented & gated** (were partial/ungated before):

- **API access** (`api_access`) — programmatic API tokens: `GET/POST/DELETE
  /api/api-tokens` (admin), token hashed at rest and shown once; tokens
  authenticate API calls via `Authorization: Bearer <token>` or `X-API-Key`
  (`src/auth/apiTokenAuth.js`). Table `api_tokens` (migration 034).
- **Audit log** (`audit_log`) — unified who-did-what trail: `GET /api/audit-log`
  (admin), recording auth login success/failure, user create/update/delete,
  licence re-validation, report generation and API-token management. Table
  `audit_log` (migration 033), recorder `src/services/auditLogger.js`.
- **PDF / CSV reports** (`reports_pdf` / `reports_csv`) — `GET
  /api/reports/{availability,incidents}.{csv,html}`; the print-ready HTML is
  Print→PDF client-side (no PDF library). JSON reads stay ungated (Basic reports).
- **Compliance report pack** (`reports_compliance`) — NIS2 report
  generation/approval and all `/api/nis2/export/*` artifacts are gated; the
  registers + readiness dashboard stay open.
- **Role-based access control** (`rbac`) — user administration (`/users`) is
  gated; the seeded super-admin always works so a server without `rbac` can
  still log in.
- **E-mail / webhook alerts** (`alerts_email` / `alerts_webhook`) — the
  dispatcher now gates per channel, OR-ed with the legacy `alerting` module so
  plan-based installs alert without a legacy proof feature map.

**Roadmap (not built yet)** — catalogued + priced, `status: 'roadmap'`, tackled
one at a time (see ROADMAP.md):

- **Advanced dashboard** (`dashboard_advanced`).
- **SSO (OIDC)** (`sso_oidc`) and **SSO (SAML)** (`sso_saml`).
- **High-availability deployment** (`ha_deployment`).

A **retention cleanup job** keyed on `history_days` also remains deferred (the
limit is surfaced and can hide out-of-window data in views).

> **Security is baseline, not a pack.** Security response headers (HSTS/CSP/
> X-Frame-Options/nosniff/Referrer-Policy), brute-force login lockout (429) and
> an enforced password policy (422) are always on, on every deployment,
> independent of plan or licence. They are deliberately **not** feature keys and
> cannot be switched off. See ROADMAP.md → *Baseline security*.
