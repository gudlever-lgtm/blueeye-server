# Licensing, plans & feature gating

BlueEye is sold in packages. This document describes the plan model, the
features and limits per plan, how a license is activated/changed, and how
support levels map to plans.

> **Where the code lives**
> - `src/license/plans.js` — the plan + feature **catalogue** (single source of truth).
> - `src/license/planService.js` — resolves the **active** plan and answers
>   limit/feature questions.
> - `src/license/features.js` — the **feature gate** (`isFeatureEnabled`,
>   `requireFeature`, `requirePlanFeature`).
> - `src/services/usageService.js` — counts agents / active test paths and
>   enforces limits.
> - `src/license/licenseManager.js` — validates the signed proof against the
>   online license server (with a network-outage cache + grace window).
> - `migrations/023_create_license_plans.sql` — mirrors the catalogue into
>   `license_plans` + a `licenses` table for the admin UI.

## Plans

| Plan | Max agents | Max active test paths | History | Support | Trial | Price (EUR) | Price (DKK) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pilot | 5 | 10 | 60 days | basic | 60-day trial | 2 500 | 18 500 |
| Starter | 5 | 25 | 90 days | basic | – | 4 000 | 30 000 |
| Professional | 25 | 150 | 365 days | premium | – | 12 000 | 90 000 |

**Professional is the top tier.** A signed proof may still set a per-customer
`max_agents` / `max_test_paths` override, which always wins over the plan default.

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
| `reports_compliance` | Compliance report pack | Professional |
| `sso_ldap` | LDAP / Active Directory auth | Professional |
| `sso_oidc` / `sso_saml` | SSO (OIDC / SAML) | Professional |
| `premium_support` | Premium / priority support | Professional |

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

A `null` limit means unlimited — only ever set by a per-customer override on the
signed proof, never by a stock plan.

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
{ "success": false, "error": "feature_not_available", "message": "This feature requires BlueEye Professional." }
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

To run a pilot without the license server, set `LICENSE_PLAN=pilot`.

### Minimal customer setup — `LICENSE_KEY` only

A customer install needs to configure **just the license key**:

```
LICENSE_KEY=<key issued by the vendor>
```

Everything else resolves on its own:

- **Public key** — embedded in `src/license/publicKey.js` (shipped in the build);
  nothing to set.
- **`LICENSE_SERVER_URL`** — defaults to the vendor's hosted licens; only set it
  to point somewhere else.
- **`LICENSE_SERVER_ID`** — when unset, the server derives a **stable, host-specific**
  id (`src/license/serverIdentity.js`): the host machine-id
  (`/etc/machine-id`), or a hostname+MAC hash if none is present. blueeye-licens
  **binds the licence to the first serverId that validates it** (trust-on-first-use,
  `licenseProof.js`), and every later proof must match — so the key sticks to one
  host with no manual id. The resolved id + its source (`configured` / `machine-id`
  / `host-attributes`) is logged at boot and shown in `GET /license/status`.

> **Docker:** mount the host machine-id read-only so the derived id survives
> container recreation — `-/etc/machine-id:/etc/machine-id:ro` (already in the
> bundled `docker-compose.yml`). Without it the server falls back to the
> container's hostname/MAC, which change on recreate and would force a rebind.
> You can always pin `LICENSE_SERVER_ID` explicitly to opt out of derivation.

After setup the manager validates every 6 hours (or on **Re-validate now**).

### Reinstalls & hardware moves — rebinding a licence

Because the derived id is host-specific, a genuinely new host (or a wipe that
loses the machine-id) produces a new serverId, which licens rejects as
`server_mismatch` against the already-bound licence. To re-claim the key, an
operator clears the binding on the license server:

```
POST /licenses/:id/unbind        # blueeye-licens, operator/admin
```

The next validation from the new host rebinds the licence (trust-on-first-use)
and verification resumes. Pinning `LICENSE_SERVER_ID` to a fixed value avoids
the churn where hosts are expected to change.

## Changing plan

- **Online proof:** change the plan with the provider; the next validation (or
  **Re-validate now**) picks up the new `plan`/`limits`/`features`.
- **Local override:** change `LICENSE_PLAN` and restart.
- The catalogue itself (limits, features, prices) is edited in
  `src/license/plans.js`; re-running migration `023` re-seeds `license_plans`.

## The public key trust anchor

`src/license/publicKey.js` embeds the Ed25519 public key used to verify every
proof — this repo being public does not weaken it, since a
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
the license server again.

A misconfigured trust anchor (placeholder embedded key, or a blocked
`LICENSE_PUBLIC_KEY` override) makes every proof fail signature verification
the exact same way a genuinely bad proof would — `validateOnce()` falls back
to whatever was last cached and reports `reason: 'invalid_signature'`. Pressing
"Re-validate now" then keeps returning 200 while silently sitting on stale
data, which looks like "revalidation doesn't pick up changes made on the
license server" rather than "verifying against the wrong key". `GET
/license/status` (and the dashboard's License settings page) surfaces this as
`publicKeyTrust: { source, configured }` — check that first when a fresh
license edit isn't showing up after revalidation.

## Environment, secrets & deployment topology (which host holds what)

There are **two different hosts**, and a setting that belongs on one must not be
placed on the other. Confusing them is the most common licensing mistake.

| Host | Repo | Role | Runs |
| --- | --- | --- | --- |
| **Customer server** (on-prem) | `blueeye-server` | Monitors the customer network; *verifies* a license proof | `db` + `server` (+ `agent`) — the customer stack |
| **Vendor license server** | `blueeye-licens` | *Signs* license proofs; vendor-operated only | `licens` (the `licens` compose profile) |

The customer server **only ever needs the public key** (embedded in
`src/license/publicKey.js`) and its own activation identifiers. The **private
signing key lives only on the vendor license server** and must never be copied
to a customer box — anyone holding it can forge a license.

### Which setting belongs where

| Variable | Belongs on | Secret? | Notes |
| --- | --- | --- | --- |
| `LICENSE_KEY` | customer server | no | The license credential this server presents to `/validate`. |
| `LICENSE_SERVER_ID` | customer server | no | Must equal `payload.serverId` on the proof. |
| `LICENSE_SERVER_URL` | customer server | no | The vendor licens URL to validate against. |
| `LICENSE_PUBLIC_KEY` | customer server (dev only) | no | Public key; **not needed in production** — the key is embedded in `src/license/publicKey.js`. |
| `LICENSE_GRACE_DAYS` / `LICENSE_VALIDATE_INTERVAL_HOURS` | customer server | no | Clamped (≤30 / ≤24). |
| `SERVER_JWT_SECRET` → app `JWT_SECRET` | customer server | **yes** | Signs *customer* dashboard sessions. |
| **`LICENSE_SIGNING_KEY`** | **vendor licens only** | **yes** | The Ed25519 **private** key that signs every proof. **Never put this on a customer server.** |
| **`LICENS_JWT_SECRET`** → licens app `JWT_SECRET` | **vendor licens only** | **yes** | Signs *vendor staff* sessions on the license server. Distinct from `SERVER_JWT_SECRET`. |
| `SEED_DEMO_*`, demo `LICENSE_KEY` | wherever seeded | no | Demo-only seeding. Never enable in production. |

### Why one `.env` seems to hold "everything"

`scripts/dev-bootstrap.js` writes a single `.env` for the **all-in-one demo**,
where the customer stack *and* the vendor `licens` service run on one host from
one compose project — so both hosts' settings land in the same file. In a real
deployment they are split across two machines. That single demo file is also why
you see a private key and a public key together: dev-bootstrap generates a
throwaway, self-consistent key pair for the disposable stack (via the
`LICENSE_PUBLIC_KEY` + `TRUST_ANCHOR_OVERRIDE_ACK` override path), **not** the
production pair embedded in source.

### How `.env` is actually read (and the name remap)

Two independent mechanisms consume it — don't conflate them:

1. **The app** (`dotenv`): each service calls `require('dotenv').config()` in its
   own `src/config.js`, so a bare (non-Docker) `node src/server.js` reads a
   `.env` **in that repo's own directory** — `blueeye-server/.env` for the
   server, `blueeye-licens/.env` for licens. They are different files.
2. **Docker Compose**: the single `.env` next to `docker-compose.yml` (in
   `blueeye-server/`) is read by Compose itself to interpolate `${VAR}` into each
   service's `environment:` block. Inside the built containers there is **no**
   `.env` file (it is git-ignored and not copied in), so the container app uses
   the injected `environment:` values, not dotenv.

Because of (2), the compose-level names in that `.env` are **remapped** to the
app's own env names per service. In particular the JWT secrets are split by
service so they can never collide:

| `.env` name (compose) | Maps to app var | In service |
| --- | --- | --- |
| `SERVER_JWT_SECRET` | `JWT_SECRET` | `server` |
| `LICENS_JWT_SECRET` | `JWT_SECRET` | `licens` |
| `LICENSE_SIGNING_KEY` | `LICENSE_SIGNING_KEY` | `licens` only |

### Not admin-settable — by design

None of the keys or secrets above are configurable from the dashboard. The
trust anchor is deliberately kept out of the operator's reach (`publicKeyGuard`
reasoning above), and the signing/JWT secrets are bootstrap credentials that
must exist before the app can sign anything — so they live in the
environment/secret store, never the database or a settings UI. The admin's only
runtime license control is **Re-validate now**; activation identifiers
(`LICENSE_KEY` / `LICENSE_SERVER_ID` / `LICENSE_SERVER_URL` / `LICENSE_PLAN`) are
set once at install time via env.

### How to validate what a running host actually uses

- **Docker — which services run here?** From the `blueeye-server/` dir:
  `docker compose ps`. If a **`licens`** container is listed, this host is (also)
  the vendor license server; if you see only `db` / `server` / `agent`, it's a
  customer-style deployment and the licens-only vars in `.env` are unused.
- **What did each container actually receive?**
  `docker compose exec server printenv | grep -E 'LICENSE|JWT'` versus
  `docker compose exec licens printenv | grep -E 'LICENSE|JWT'` (the latter only
  if `licens` is running). Confirms the remap and that the signing key reached
  **only** licens.
- **Bare (non-Docker)?** Each app reads the `.env` in its own directory. If you
  put licens secrets in `blueeye-server/.env` and run licens from
  `blueeye-licens/`, licens will **not** see them.
- **Boot-time signals.** licens logs `LICENSE_SIGNING_KEY is not set — POST
  /validate will return 500` when it lacks the key; the server logs the trust
  anchor source. At runtime, `GET /license/status` reports
  `publicKeyTrust: { source, configured }` — `configured:false` means the server
  is still on the placeholder anchor.

### Vendor combined-host `.env` — what each variable is (and whether it's required)

The vendor's turnkey stack runs **both** the customer `server` and the `licens`
service from one compose project, so a single `.env` (next to
`docker-compose.yml`) feeds both. This is the checklist for that file. Note the
compose-level names differ from the app-level names (the remap above): the `.env`
holds `SERVER_JWT_SECRET` / `LICENS_JWT_SECRET`, each injected as that service's
`JWT_SECRET`.

| `.env` variable | Required? | Consumed by | Notes |
| --- | --- | --- | --- |
| `SERVER_JWT_SECRET` | **required** | server | Compose `:?` guard — the server container won't start without it. Secret. |
| `LICENS_JWT_SECRET` | **required** | licens | Compose `:?` guard — the licens container won't start without it. Secret. Distinct value from `SERVER_JWT_SECRET`. |
| `LICENSE_SIGNING_KEY` | **required** | licens | The Ed25519 **private** key that signs proofs (base64 of PKCS8 PEM). Secret; never on a customer server. |
| `COMPOSE_PROFILES=licens` | **keep** | compose | Puts the profiled `licens` service into the default project so `docker compose up` includes it. Without it, licens starts only via explicit `--profile licens` (`scripts/deploy-licens.sh`). |
| `LICENSE_SERVER_ID` | **keep as-is** | server | ⚠️ Once a licence is **bound** to this id, changing/removing it makes the server derive a *new* id → `server_mismatch` → licence invalid. Only change it together with `POST /licenses/:id/unbind` on licens. |
| `LICENSE_KEY` | required | server | The licence credential presented to `/validate`. |
| `LICENSE_SERVER_URL` | optional | server | Compose defaults it to the on-host `http://licens:4000`; safe to omit. |
| `LICENSE_PUBLIC_KEY` / `TRUST_ANCHOR_OVERRIDE_ACK` | omit | server | Leave unset in production — the public key is embedded; a set-but-blocked override only produces the "misconfigured" banner. |

The three secrets (`SERVER_JWT_SECRET`, `LICENS_JWT_SECRET`, `LICENSE_SIGNING_KEY`)
must be long, random, and never committed. `scripts/dev-bootstrap.js` generates a
complete demo `.env` with all of the above for the local stack.

## Support levels

Each plan carries a `support_level`, surfaced in `GET /license/plan` and the UI:

| Plan | `support_level` |
| --- | --- |
| Pilot / Starter | `basic` |
| Professional | `premium` |

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
one at a time (see ROADMAP.md). Nothing is currently queued — every catalogued
feature (incl. the advanced dashboard and SSO OIDC/SAML/LDAP, all Professional)
is shipped and gated.

A **retention cleanup job** keyed on `history_days` also remains deferred (the
limit is surfaced and can hide out-of-window data in views).

> **Security is baseline, not a pack.** Security response headers (HSTS/CSP/
> X-Frame-Options/nosniff/Referrer-Policy), brute-force login lockout (429) and
> an enforced password policy (422) are always on, on every deployment,
> independent of plan or licence. They are deliberately **not** feature keys and
> cannot be switched off. See ROADMAP.md → *Baseline security*.
