'use strict';

// Loads configuration from environment variables (and a local .env file in
// development). Keeping all env access in one place makes the rest of the
// codebase easy to test and reason about.
require('dotenv').config();
const path = require('path');
const { resolvePublicKey, publicKeySource } = require('./license/publicKey');
const { resolveServerId } = require('./license/serverIdentity');
const { normalizeFingerprint } = require('./enroll/fingerprint');

// Resolve the license server identity once: LICENSE_SERVER_ID when set, else a
// stable machine-derived id so a customer only needs to configure LICENSE_KEY.
const licenseIdentity = resolveServerId();

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// Bounds an env-configurable interval so it can't be tuned away to defeat
// periodic re-validation (e.g. LICENSE_GRACE_DAYS set absurdly high so one
// long-past successful check keeps the server "licensed" forever while it
// never contacts the license server again).
function clampInt(value, fallback, min, max) {
  const n = toInt(value, fallback);
  return Math.min(max, Math.max(min, n));
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 3000),
  // Canonical URL clients use to reach this server (e.g. https://blueeye.acme.dk).
  // Recommended when running behind a reverse proxy; when unset the enrollment
  // endpoints derive it from the incoming request. No trailing slash.
  publicUrl: (process.env.BLUEEYE_PUBLIC_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'blueeye',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'blueeye',
    connectionLimit: toInt(process.env.DB_CONNECTION_LIMIT, 10),
  },
  // TimescaleDB telemetry store (docs/storage-split-audit.md). Disabled by
  // default: when TSDB_ENABLED is unset the server runs exactly as before with
  // all telemetry in MySQL. When enabled, server.js builds a separate pg pool.
  tsdb: {
    enabled: /^(1|true|yes|on)$/i.test(String(process.env.TSDB_ENABLED || '').trim()),
    host: process.env.TSDB_HOST || '127.0.0.1',
    port: toInt(process.env.TSDB_PORT, 5432),
    user: process.env.TSDB_USER || 'blueeye_tsdb',
    password: process.env.TSDB_PASSWORD || '',
    database: process.env.TSDB_NAME || 'blueeye_telemetry',
    connectionLimit: toInt(process.env.TSDB_CONNECTION_LIMIT, 10),
    connectionTimeoutMs: toInt(process.env.TSDB_CONNECTION_TIMEOUT_MS, 5000),
    // Time window for the latestPerAgent last() query (Punkt 3); must stay
    // small so the query only touches the current chunk.
    latestWindowMinutes: toInt(process.env.TSDB_LATEST_WINDOW_MINUTES, 5),
  },
  auth: {
    // NOTE: the default secret is for development only. server.js refuses to
    // start in production unless JWT_SECRET is set to something else.
    jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
    jwtIssuer: process.env.JWT_ISSUER || 'blueeye-server',
    bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 12),
    // Lifetime of an admin-issued one-time password for local user creation
    // (src/routes/users.js). Clamped to [1, 168] hours; default 48h.
    tempPasswordTtlHours: clampInt(process.env.TEMP_PASSWORD_TTL_HOURS, 48, 1, 168),
  },
  // Symmetric key for encrypting secrets at rest (integration credentials, the
  // LDAP bind password) via src/lib/secretBox.js. Defaults to JWT_SECRET so
  // existing deployments need no new variable — the production guard on
  // JWT_SECRET (server.js) already refuses to boot with the insecure default,
  // which covers this fallback too. Set SECRET_ENCRYPTION_KEY to rotate it
  // independently of the JWT secret.
  security: {
    secretKey: process.env.SECRET_ENCRYPTION_KEY || process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  },
  // External authentication via LDAP/AD (supplements local JWT login). This env
  // flag is the hard gate (default OFF); even when on, login only tries LDAP once
  // an admin has stored and enabled an ldap_config row. Local JWT login always
  // remains as the fallback. See src/auth/ldap.js + docs/ldap-auth.md.
  ldap: {
    authEnabled: /^(1|true|yes|on)$/i.test(String(process.env.LDAP_AUTH_ENABLED || '').trim()),
  },
  // SSO via OpenID Connect (authorization-code + PKCE). Supplements local JWT
  // login behind the licence feature `sso_oidc` (Professional+). The IdP must be
  // EU/self-hosted (Keycloak, Authentik, Zitadel, …) — there is no US SDK; the
  // flow is hand-rolled with Node crypto + `jsonwebtoken`. The env flag is the
  // hard gate (default OFF); even when on, OIDC login is only offered once the
  // issuer/client/redirect are configured and the licence covers it. Group→role
  // mapping is admin-managed (oidc_role_map). See src/auth/oidc.js + docs/sso-oidc.md.
  oidc: {
    authEnabled: /^(1|true|yes|on)$/i.test(String(process.env.OIDC_AUTH_ENABLED || '').trim()),
    issuer: (process.env.OIDC_ISSUER || '').replace(/\/+$/, ''),
    clientId: process.env.OIDC_CLIENT_ID || '',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    redirectUri: process.env.OIDC_REDIRECT_URI || '',
    scopes: process.env.OIDC_SCOPES || 'openid email profile',
    // The id-token/userinfo claim carrying the user's groups/roles. Its values
    // are matched against oidc_role_map to resolve the BlueEye role.
    roleClaim: process.env.OIDC_ROLE_CLAIM || 'groups',
  },
  // SSO via SAML 2.0 (SP-initiated). Supplements local JWT login behind the
  // licence feature `sso_saml` (Professional+). Assertion signatures are verified
  // with a hand-rolled, dependency-free XML-DSig verifier (src/auth/saml.js) —
  // no US SDK. The env flag is the hard gate (default OFF). Attribute→role
  // mapping is admin-managed (saml_role_map). See docs/sso-saml.md.
  saml: {
    authEnabled: /^(1|true|yes|on)$/i.test(String(process.env.SAML_AUTH_ENABLED || '').trim()),
    // IdP single-sign-on URL (HTTP-Redirect binding) the SP sends AuthnRequests to.
    entryPoint: process.env.SAML_ENTRY_POINT || process.env.SAML_IDP_SSO_URL || '',
    // This SP's entityID (issuer of the AuthnRequest) + the Audience the IdP must
    // restrict its assertion to. Audience defaults to the SP entityID.
    spEntityId: process.env.SAML_SP_ENTITY_ID || process.env.SAML_ISSUER || '',
    audience: process.env.SAML_AUDIENCE || process.env.SAML_SP_ENTITY_ID || process.env.SAML_ISSUER || '',
    // The IdP's expected entityID (assertion <Issuer>); blank skips the check.
    idpEntityId: process.env.SAML_IDP_ENTITY_ID || '',
    // The IdP's X.509 signing certificate (PEM or bare base64) used to verify the
    // assertion signature. REQUIRED — an unsigned/forged assertion is rejected.
    idpCert: process.env.SAML_IDP_CERT || '',
    // Where the IdP POSTs the SAMLResponse (the SP Assertion Consumer Service).
    callbackUrl: process.env.SAML_CALLBACK_URL || '',
    // The SAML attribute carrying the user's groups/roles, matched against
    // saml_role_map. (NameID is used for the email/identity.)
    roleAttribute: process.env.SAML_ROLE_ATTRIBUTE || 'groups',
  },
  // Initial admin, seeded by the migration runner if no admin exists yet.
  seedAdmin: {
    email: process.env.SEED_ADMIN_EMAIL || 'admin@blueeye.local',
    password: process.env.SEED_ADMIN_PASSWORD || '',
  },
  enrollment: {
    // Default lifetime of a new enrollment code, in minutes.
    defaultTtlMinutes: toInt(process.env.ENROLLMENT_CODE_TTL_MINUTES, 60),
  },
  // Frictionless agent enrollment (download + install-script generation).
  enroll: {
    // Local directory holding the agent binaries served at /enroll/agent/:platform.
    // Files are named blueeye-agent-<platform>[.exe], e.g. blueeye-agent-linux-amd64.
    // LEGACY/optional — the default install flow serves the source bundle instead.
    artifactsDir: process.env.AGENT_ARTIFACTS_DIR || path.join(process.cwd(), 'artifacts'),
    // The agent source tree, packaged + served at /enroll/agent-source.tgz so the
    // one-line installer can build + run it (Docker/Node) without any published
    // binary. Defaults to the sibling checkout (standard deploy layout); the
    // compose file bind-mounts ../blueeye-agent to /agent-src.
    agentSourceDir: process.env.AGENT_SOURCE_DIR || path.join(process.cwd(), '..', 'blueeye-agent'),
    // Where the server caches the @yao-pkg/pkg-built agent binaries across
    // restarts.  On a cache hit (same agent version) the build is skipped.
    // Mount this as a persistent volume in Docker (like /data).
    agentBinaryCacheDir: process.env.AGENT_BINARY_CACHE_DIR || path.join(process.cwd(), 'agent-binaries'),
    // SHA-256 fingerprint of the server's TLS leaf cert (or the terminating
    // reverse proxy's). Embedded into install scripts so the agent can pin it.
    // Leave unset for plain HTTP / development (no pinning).
    certFingerprint: normalizeFingerprint(process.env.AGENT_CERT_FINGERPRINT || process.env.TLS_CERT_FINGERPRINT || ''),
  },
  ws: {
    // Agent live channel.
    path: process.env.WS_AGENT_PATH || '/ws/agent',
    // Browser live channel (analysis findings pushed to the dashboard).
    dashboardPath: process.env.WS_DASHBOARD_PATH || '/ws/dashboard',
    heartbeatIntervalMs: toInt(process.env.WS_HEARTBEAT_MS, 30000),
  },
  // Client-side licensing against blueeye-licens. Set at installation (not CRUD).
  license: {
    key: process.env.LICENSE_KEY || '',
    // Machine-derived when LICENSE_SERVER_ID is unset (see serverIdentity.js), so
    // a customer install only needs LICENSE_KEY. serverIdSource is 'configured' |
    // 'machine-id' | 'host-attributes', logged at boot.
    serverId: licenseIdentity.serverId,
    serverIdSource: licenseIdentity.source,
    // Defaults to the vendor's hosted license server so customers don't set it;
    // the compose demo overrides it to the on-host licens (http://licens:4000).
    serverUrl: process.env.LICENSE_SERVER_URL || 'https://licens.gnf.dk',
    publicKey: resolvePublicKey(),
    // 'embedded' | 'env' | 'blocked' — logged at boot (server.js); never itself
    // a trust decision, resolvePublicKey() above is the single source of truth.
    publicKeySource: publicKeySource(),
    cachePath: process.env.LICENSE_CACHE_PATH || path.join(process.cwd(), '.license-cache.json'),
    // Clamped to [1, 30] days / [1, 24] hours: an operator-set extreme value
    // (e.g. a multi-year grace period) would let one long-past successful
    // validation keep the server "licensed" indefinitely without ever having to
    // reach the license server again — defeating periodic re-validation.
    graceDays: clampInt(process.env.LICENSE_GRACE_DAYS, 14, 1, 30),
    intervalHours: clampInt(process.env.LICENSE_VALIDATE_INTERVAL_HOURS, 6, 1, 24),
    // Locally-configured plan for on-prem installs that set the package without a
    // full signed proof (e.g. pilot evaluations). The signed proof's `plan` field
    // always wins when present. Blank → resolved by the plan service (legacy/
    // unlicensed fallback). See src/license/plans.js for the valid keys.
    plan: process.env.LICENSE_PLAN || '',
  },
  // Storage monitoring: the path to statfs for disk usage. Default the server's
  // data dir; point it at the drive holding the DB/Docker volume if different.
  storage: {
    diskPath: process.env.STORAGE_DISK_PATH || (process.env.LICENSE_CACHE_PATH ? path.dirname(process.env.LICENSE_CACHE_PATH) : process.cwd()),
  },
  // Scheduled active discovery: probe admin-configured CIDR scope for devices
  // passive collection misses. Disabled + scope-empty by default (refuses to run
  // until an admin sets DISCOVERY_CIDRS). Never scans outside scope; the address
  // cap is a hard ceiling on how large a scope may be. See docs/discovery.md.
  discovery: {
    enabled: /^(1|true|yes|on)$/i.test(String(process.env.DISCOVERY_ENABLED || '').trim()),
    cidrs: (process.env.DISCOVERY_CIDRS || '').split(',').map((s) => s.trim()).filter(Boolean),
    ports: (process.env.DISCOVERY_PORTS || '22,80,161,443,3389').split(',').map((s) => toInt(s, 0)).filter((n) => n > 0 && n <= 65535),
    rateLimit: clampInt(process.env.DISCOVERY_RATE_LIMIT, 50, 1, 10000),
    addressCap: clampInt(process.env.DISCOVERY_ADDRESS_CAP, 65536, 1, 16777216),
    intervalMinutes: clampInt(process.env.DISCOVERY_INTERVAL_MINUTES, 360, 1, 10080),
  },
  // Analysis module: where warmed-up baselines are persisted so they survive a
  // restart. The detector's tuning lives in src/analysis/config.js.
  analysis: {
    baselineCachePath: process.env.ANALYSIS_BASELINE_CACHE_PATH || path.join(process.cwd(), '.analysis-baselines.json'),
  },
  // Geo enrichment of flow records. dbPath points at an offline, EU-sourced
  // GeoIP/ASN range CSV (e.g. DB-IP Lite, CC-BY) — see docs/geo.md. When unset
  // or unreadable, flows are still stored but without country/ASN.
  geo: {
    enabled: process.env.GEO_ENABLED !== 'false',
    dbPath: process.env.GEOIP_DB_PATH || '',
    // Where the in-app "Update now" / monthly auto-update writes the built CSV.
    // Defaults to the persistent /data volume so it works in Docker with no host
    // mount; override for bare-node installs.
    buildPath: process.env.GEOIP_BUILD_PATH || '/data/geoip.csv',
    // Base URL for the offline GeoIP source (DB-IP Lite, EU, CC-BY). Point at a
    // self-hosted/EU mirror if preferred; the constraint is EU/self-hosted data.
    sourceUrl: process.env.GEOIP_SOURCE_URL || 'https://download.db-ip.com/free',
    // Map tiles. Served to the frontend via /api/geo/config so the URL is never
    // hardcoded. Default is OpenStreetMap (OSMF, EU); for production point this
    // at self-hosted or another EU tile source — never a US tile server.
    tileUrl: process.env.MAP_TILE_URL || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: process.env.MAP_TILE_ATTRIBUTION || '© OpenStreetMap contributors',
    tileMaxZoom: toInt(process.env.MAP_TILE_MAX_ZOOM, 19),
    // Geocoder for the location address search/picker. Default OpenStreetMap
    // Nominatim (OSMF, EU); point at a self-hosted/EU instance for production.
    geocodeUrl: process.env.MAP_GEOCODE_URL || 'https://nominatim.openstreetmap.org',
  },
};

// The default JWT secret must never be used outside development.
const DEFAULT_JWT_SECRET = 'dev-insecure-secret-change-me';
config.auth.usingDefaultSecret = config.auth.jwtSecret === DEFAULT_JWT_SECRET;
// Known-weak/published secrets that must never reach production. Covers the dev
// default, the docker-compose example fallbacks, and the value shipped in
// .env.example. The production guard in server.js also rejects anything shorter
// than the minimum length below.
const WEAK_SECRETS = new Set([
  DEFAULT_JWT_SECRET,
  'change-me-server',
  'change-me-licens',
  // Shipped verbatim in .env.example — 33 chars, so it would otherwise slip past
  // the length gate. A deploy that copies the example and forgets to change it
  // must not boot with a secret published in this repo.
  'change-me-to-a-long-random-string',
]);
const MIN_SECRET_LENGTH = 32;
// Any obvious "change me" placeholder is weak regardless of length, so copy-paste
// variants of the published examples are caught too.
const isPlaceholderSecret = (s) => /change[-_ ]?me/i.test(String(s));
config.auth.weakSecret =
  WEAK_SECRETS.has(config.auth.jwtSecret) ||
  isPlaceholderSecret(config.auth.jwtSecret) ||
  config.auth.jwtSecret.length < MIN_SECRET_LENGTH;

module.exports = { config };
