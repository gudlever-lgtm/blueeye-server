# CMDB integration (single source of truth)

BlueEye links agents to assets in **one** external CMDB — **ServiceNow**,
**Nautobot**, or a **Custom** HTTP/JSON CMDB you describe yourself. An admin
configures the single source; operators link an agent to an asset via a searchable
lookup. Linking also **syncs the agent's site** from the asset's CMDB location.

Only ONE source is supported by design (single source of truth). Multi-source,
bulk import/sync are out of scope.

## Data model (migration `051_create_cmdb.sql`)

- **`cmdb_config`** — a singleton connection config: `type`
  (`servicenow`|`nautobot`|`custom`), `base_url`, `auth_type`, `config_json` (the
  custom connector's settings; empty for the built-ins), `credentials_encrypted`,
  `enabled`, `verified_at`, `updated_by`. Credentials are encrypted at rest
  (AES‑256‑GCM via `src/lib/secretBox.js`) and are **never** returned by the API.
  Editing any field clears `verified_at` (the connection must be re‑tested).
  (Migration `052` adds the `custom` type + `config_json`.)
- **`agent_cmdb_links`** — one asset per agent (`agent_id` PK, FK **cascade on
  agent delete**): `cmdb_asset_id`, `cmdb_asset_name`, `cmdb_asset_location`
  (the asset's CMDB location label), `linked_at`, `linked_by`.

## Connectors

The CMDB feature has its **own** connector registry (`src/cmdb/connectors.js`),
separate from the outbound-integrations registry — CMDB connectors *read*
(`testConnection` + `search`) rather than *push* (`send` + events). It holds three:

- **`servicenow`** / **`nautobot`** — reuse the same factory functions the
  integrations feature uses (under `src/integrations/connectors/`), which gained two
  CMDB methods while leaving their existing `send()`/`test()` untouched.
- **`custom`** (`src/integrations/connectors/customCmdb.js`) — a **config-driven**
  connector for any HTTP/JSON asset API. Everything is supplied in the config's
  `config` block, so no code change is needed to onboard a new CMDB:

  | key | meaning | default |
  | --- | --- | --- |
  | `searchPath` | path appended to `base_url` for search (**required**) | — |
  | `queryParam` | query-string param carrying the search text | `q` |
  | `testPath` | path for the connection test | `searchPath` |
  | `resultsPath` | dot-path to the results array (blank = body is the array) | `''` |
  | `idField` / `nameField` | dot-path to the id / display name in a result | `id` / `name` |
  | `typeField` / `locationField` | optional dot-paths to type / location | — |
  | `tokenScheme` | Authorization scheme word for token auth | `Bearer` |

`GET /api/settings/cmdb/meta` returns the three types + their auth types + whether
each needs the `config` block (only `custom` does), which drives the Settings form.

The built-in ServiceNow/Nautobot methods:

- `testConnection(integration)` → `{ ok, status, detail }`. A bounded read of the
  asset surface (ServiceNow `cmdb_ci`, Nautobot `dcim/devices`), so a service
  account scoped to the CMDB (but not to incidents) still passes.
- `search(integration, query)` → `{ ok, status, assets }`, normalizing each source
  to `{ id, name, type, location }[]` (ServiceNow `nameLIKE` on the CI table;
  Nautobot `?q=` over devices).

## HTTP API

Settings — **admin only** (`src/routes/cmdb.js`, `createCmdbSettingsRouter`):

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/settings/cmdb` | Config **without** credentials; `credentialsSet` boolean. Returns `{}` (200) when unconfigured. |
| PUT | `/api/settings/cmdb` | Validates `type`/`base_url` (http(s)+SSRF) / `auth_type` (must suit the connector); encrypts credentials. `clearCredentials:true` wipes them. |
| POST | `/api/settings/cmdb/test` | Decrypts stored credentials, calls `testConnection()`. **200** (+ stamps `verified_at`) / **401** (auth) / **500** (connector/network). |

Asset search — **operator+** (`createCmdbAssetsRouter`):

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/cmdb/assets/search?q=` | `q` min 2 chars. `{ assets }`. **400** (bad `q`) / **404** (no CMDB configured/enabled) / **500** (connector down). Capped at 20 results. |

Agent link — read **viewer+**, write **operator+** (`createAgentCmdbLinkRouter`):

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/agents/:id/cmdb-link` | Current link, or **404**. |
| PUT | `/api/agents/:id/cmdb-link` | Body `{ cmdb_asset_id, cmdb_asset_name, cmdb_asset_location? }`. **404** if the agent doesn't exist. Returns the link + `synced_location`. |
| DELETE | `/api/agents/:id/cmdb-link` | **404** if no link exists. |

### Location sync

When a linked asset carries a location, the PUT reconciles the agent's BlueEye
site with it, matching a `locations` row **by name (case‑insensitive)**:

- **Agent has no site** → auto‑sync: match the location (or **create** it, name
  only, no coordinates) and set `agents.location_id`. The response carries
  `synced_location`.
- **Agent already sits on the matching site** → no‑op (already correct).
- **Agent already has a *different* (manual) site** → **do not overwrite.** The
  response carries `location_suggestion { current, proposed }` and the site is left
  as‑is. The dashboard shows a confirm; on **Overwrite** it re‑links with
  `overwrite_location: true`, which applies the match‑or‑create and sets the site.

Two agents whose assets share a location converge on one site. A created site has
no coordinates, so it won't plot on the map until an admin adds them. The reconcile
is best‑effort: a location failure never fails the link.
(`agentsRepository.setLocation` touches only `location_id`, leaving other managed
fields intact.)

## Test area

The one configured CMDB appears as a target in **Test area** (`/api/diagnostics`),
screened like any outbound integration: `screening.screenCmdb` (transport / auth /
verified posture) plus a live connectivity test via the connector's
`testConnection()`.

## Dashboard

- **Settings → CMDB** (`settingsCmdbView` in `public/app.js`): type/base_url/auth
  form, write‑only credentials, an **Enabled** toggle and a **Test connection**
  button that shows the real 200/401/500 result inline. (The test uses a raw
  `fetch`, not `api()`, so an upstream 401 shows inline instead of logging the
  admin out.)
- **Agent detail** (`loadAgentCmdbLink`): a debounced (min 2 chars) asset search;
  selecting an asset links it and shows a removable chip with the asset name +
  location. Viewers see the chip read‑only.

## Security notes

- Credentials are encrypted at rest and never returned; the audit trail redacts
  them, and CMDB link mutations record as `agent.cmdb-link` (keeping the agent id).
- `base_url` is SSRF‑guarded at both validation and send time.
