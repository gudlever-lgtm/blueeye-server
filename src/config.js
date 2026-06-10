'use strict';

// Loads configuration from environment variables (and a local .env file in
// development). Keeping all env access in one place makes the rest of the
// codebase easy to test and reason about.
require('dotenv').config();
const path = require('path');
const { resolvePublicKey } = require('./license/publicKey');
const { normalizeFingerprint } = require('./enroll/fingerprint');

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
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
  auth: {
    // NOTE: the default secret is for development only. server.js refuses to
    // start in production unless JWT_SECRET is set to something else.
    jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
    jwtIssuer: process.env.JWT_ISSUER || 'blueeye-server',
    bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 12),
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
    serverId: process.env.LICENSE_SERVER_ID || '',
    serverUrl: process.env.LICENSE_SERVER_URL || '',
    publicKey: resolvePublicKey(),
    cachePath: process.env.LICENSE_CACHE_PATH || path.join(process.cwd(), '.license-cache.json'),
    graceDays: toInt(process.env.LICENSE_GRACE_DAYS, 14),
    intervalHours: toInt(process.env.LICENSE_VALIDATE_INTERVAL_HOURS, 6),
    // Locally-configured plan for on-prem installs that set the package without a
    // full signed proof (e.g. pilot evaluations). The signed proof's `plan` field
    // always wins when present. Blank → resolved by the plan service (legacy/
    // unlicensed fallback). See src/license/plans.js for the valid keys.
    plan: process.env.LICENSE_PLAN || '',
    // OFFLINE licensing: path to a local signed license file. When set, the
    // server validates this file on-box (Ed25519, no external license server)
    // and runs in restricted mode if it is missing/expired/invalid. Takes
    // precedence over the online validator. See docs/licensing.md.
    file: process.env.LICENSE_FILE || '',
    // 'online' (default) or 'offline'. Auto-selects 'offline' when LICENSE_FILE
    // is set; set explicitly to force a mode.
    mode: process.env.LICENSE_MODE || (process.env.LICENSE_FILE ? 'offline' : 'online'),
    recheckHours: toInt(process.env.LICENSE_VALIDATE_INTERVAL_HOURS, 6),
  },
  // Storage monitoring: the path to statfs for disk usage. Default the server's
  // data dir; point it at the drive holding the DB/Docker volume if different.
  storage: {
    diskPath: process.env.STORAGE_DISK_PATH || (process.env.LICENSE_CACHE_PATH ? path.dirname(process.env.LICENSE_CACHE_PATH) : process.cwd()),
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

module.exports = { config };
