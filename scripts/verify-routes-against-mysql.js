'use strict';

// Boots the REAL server against a REAL MySQL and proves two things the gate
// cannot:
//
//   1. No API route answers 500 — or leaks a stack trace, SQL, an errno code, a
//      file path or an internal host — for any role, with a real id, a missing
//      id, a malformed id, an empty body or a garbage body.
//   2. Agent ingest actually LANDS: every table each /agents/* ingest path
//      should write has rows after a realistic agent has reported.
//
// The unit and gate suites wire fakes (test-support/fakes.js). A fake cannot
// say whether a statement is valid SQL, whether a column exists, whether two
// repositories agree on a table, or whether server.js passes a dependency the
// router needs — and every one of those is a 500 in production, or worse, a 201
// for a write that went nowhere. scripts/verify-repositories-against-mysql.js
// runs individual repositories; this runs the whole wired app.
//
//   DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD=secret \
//     node scripts/verify-routes-against-mysql.js
//
// How it works (docs/tests.md has the long form):
//
//   * a scratch database is created and migrated with src/migrate.js, the same
//     way scripts/verify-schema-against-mysql.js does it, with a known seeded
//     admin password;
//   * a local stand-in for blueeye-licens signs a `valid:true` proof with every
//     feature on, so the real licence manager unlocks every route;
//   * `node src/server.js` is spawned exactly as production runs it
//     (NODE_ENV=production, so error bodies are the production ones), from a
//     scratch working directory, with a preload that dumps the live app's route
//     table the moment it listens (scripts/verify-routes/route-dump-preload.js);
//   * data is seeded through the public API (users, locations, enrollment,
//     SNMP devices, NIS2, Service Assurance, …) and an enrolled agent posts
//     realistic payloads to every ingest endpoint (and one WebSocket frame);
//   * the scratch database is queried directly for the rows each ingest path
//     should have written;
//   * every registered route is swept for every role (admin, operator, viewer,
//     no auth, agent token);
//   * the server's own log is scanned for errors;
//   * the database and the process are torn down — on success or failure.
//
// Exit codes: 0 all green, 1 a failure was found, 2 the run could not start.
//
// Env knobs: VERIFY_ROUTES_KEEP=1 keeps the scratch DB + work dir for debugging;
// VERIFY_ROUTES_ONLY=<substring> sweeps only routes whose path contains it;
// VERIFY_ROUTES_VERBOSE=1 prints every failing call as it happens.

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const { startFakeLicens, prepareWorkDir, payloads: P, iso } = require('./verify-routes/fixtures');
const { ALL_FEATURE_KEYS } = require(path.join(ROOT, 'src', 'license', 'plans'));
const { KNOWN_FEATURES } = require(path.join(ROOT, 'src', 'license', 'features'));

const env = process.env;
const HOST = env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(env.DB_PORT || 3306);
const USER = env.DB_USER || 'root';
const PASSWORD = env.DB_PASSWORD || '';
const DB = `be_routes_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const KEEP = /^(1|true|yes)$/i.test(env.VERIFY_ROUTES_KEEP || '');
const ONLY = env.VERIFY_ROUTES_ONLY || '';
const VERBOSE = /^(1|true|yes)$/i.test(env.VERIFY_ROUTES_VERBOSE || '');
const TRACE = env.VERIFY_ROUTES_TRACE || '';

const ADMIN_EMAIL = 'admin@blueeye.local';
const ADMIN_PASSWORD = `Vr-${crypto.randomBytes(9).toString('base64url')}-9a!`;
const USER_PASSWORD = `Vr-${crypto.randomBytes(9).toString('base64url')}-7b!`;
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

// ============================================================ the policy
// Routes the sweep does NOT call, and why. Each one reaches something outside
// this process — a mail server, an LLM, an IdP, a geocoder, a crawler — or
// would take the run's own sessions away. Anything added here should say which.
const SKIP = {
  'POST /api/alerting/test': 'sends a test notification through every configured alert channel (outbound)',
  'POST /api/integrations/:id/test': 'calls the integration target (outbound HTTP)',
  'POST /api/settings/cmdb/test': 'connects to the configured CMDB (outbound HTTP)',
  'GET /api/cmdb/assets/search': 'searches the configured CMDB (outbound HTTP)',
  'POST /api/ldap/test': 'binds against the LDAP directory (outbound)',
  'POST /api/oidc/test': 'fetches the OIDC discovery document (outbound)',
  'GET /api/geocode/search': 'queries the geocoder (outbound, Nominatim by default)',
  'GET /api/geocode/reverse': 'queries the geocoder (outbound, Nominatim by default)',
  'POST /api/settings/geoip/update': 'downloads the GeoIP database (outbound)',
  'POST /api/report-schedules/:id/send-now': 'emails a report (outbound SMTP)',
  'POST /users/local': 'emails a one-time password (outbound SMTP)',
  'POST /users/:id/resend-temp-password': 'emails a one-time password (outbound SMTP)',
  'POST /api/diagnostics/run': 'runs reachability checks against the IdP/assistant (outbound)',
  'POST /api/service-tests/monitors/:id/check': 'performs a live mail/HTTP/TCP check from the server (outbound)',
  'POST /api/service-tests/assurance/certificates/check': 'opens TLS connections to every application host (outbound)',
  'POST /api/service-tests/discovery/': 'crawls the application site (outbound)',
  'POST /system/server-update': 'runs the host update command (SERVER_UPDATE_COMMAND) — never from a test',
  'GET /speedtest/download': 'streams up to 200 MB; exercised once with a small size during ingest',
};

// Bodies the sweep may send beyond {} and {x:{y:1}} — "a minimal valid body"
// — keyed by route. A factory gets the seeded ids. Only routes whose effect is
// local and non-destructive are listed; the seed step already exercises every
// create with a valid body once.
function validBodies(S) {
  const n = () => `vr-${crypto.randomBytes(3).toString('hex')}`;
  return {
    'POST /locations/': () => ({ name: `Sweep ${n()}`, description: 'created by the sweep' }),
    'PUT /locations/:id': () => ({ name: `Sweep ${n()}`, latitude: 55.67, longitude: 12.56 }),
    'PUT /agents/:id': () => ({ display_name: `sweep ${n()}`, location_id: S.locations[0], notes: 'swept' }),
    'POST /enrollment-codes/': () => ({ location_id: S.locations[0], expiresInMinutes: 30, maxUses: 1 }),
    'POST /api/severity-rules/preview': () => ({ rule: S.bodies.severityRule(), event: { kind: 'probe', severity: 'warn', metric: 'loss', agentId: S.agents[0] } }),
    'POST /api/changes/seen': () => ({}),
    'POST /api/changes/ack': () => ({ key: S.changeKey || '0'.repeat(64) }),
    'PUT /me/preferences': () => ({ locale: 'da' }),
    'POST /api/logs/client': () => ({ level: 'error', msg: 'sweep client error' }),
    'POST /api/forecast/': () => ({ agentId: S.agents[0], metric: 'rx', horizonHours: 24 }),
    'POST /api/nis2/custom-reports/preview': () => ({ sources: ['risks', 'controls'], title: 'Sweep' }),
    'POST /api/diagnose': () => ({ description: 'Printeren på 2. sal kan ikke nås fra kontoret', agentId: S.agents[0] }),
    'PUT /api/thresholds/:location_id': () => S.bodies.threshold(),
    'PUT /api/thresholds/': () => S.bodies.threshold(),
    'POST /api/severity-rules/': () => S.bodies.severityRule(),
    'PUT /api/severity-rules/:id': () => S.bodies.severityRule(),
    'POST /api/nis2/risks': () => S.bodies.nis2Risk(),
    'PUT /api/nis2/risks/:id': () => S.bodies.nis2Risk(),
    'POST /api/nis2/controls': () => S.bodies.nis2Control(),
    'PUT /api/nis2/controls/:id': () => S.bodies.nis2Control(),
    'POST /api/nis2/incidents': () => S.bodies.nis2Incident(),
    'PUT /api/nis2/incidents/:id': () => S.bodies.nis2Incident(),
    'POST /api/runbooks/': () => S.bodies.runbook(),
    'PUT /api/runbooks/:id': () => S.bodies.runbook(),
    'POST /api/test-packages/': () => S.bodies.testPackage(),
    'PUT /api/test-packages/:id': () => S.bodies.testPackage(),
    'POST /api/transactions/': () => S.bodies.transaction(),
    'PUT /api/transactions/:id': () => S.bodies.transaction(),
    'PUT /api/transactions/:id/agents': () => ({ agent_ids: [S.agents[0]] }),
    'POST /api/snmp-profiles/': () => S.bodies.snmpProfile(),
    'PATCH /api/snmp-profiles/:id': () => ({ name: `sweep ${n()}` }),
    'PATCH /api/snmp-devices/:id': () => ({ displayName: `sweep ${n()}`, intervalSec: 300 }),
    'POST /api/report-schedules/': () => S.bodies.reportSchedule(),
    'PUT /api/report-schedules/:id': () => S.bodies.reportSchedule(),
    'POST /api/api-tokens/': () => ({ name: `sweep ${n()}` }),
    'POST /api/ldap/role-map': () => S.bodies.ldapRoleMap(),
    'POST /api/oidc/role-map': () => S.bodies.claimRoleMap(),
    'POST /api/saml/role-map': () => S.bodies.claimRoleMap(),
    'POST /api/events/:id/notes': () => ({ body: 'sweep note' }),
    'PATCH /api/events/:id': () => ({ status: 'acknowledged' }),
    'POST /api/findings/:id/ack': () => ({}),
    'POST /api/devices/:id/config-snapshots': () => S.bodies.configSnapshot(),
    'POST /api/service-tests/applications/': () => S.bodies.stApplication(),
    'PUT /api/service-tests/applications/:id': () => S.bodies.stApplication(),
    'PUT /users/:id': () => ({ role: 'viewer', name: `Sweep ${n()}` }),
    'POST /users/': () => ({ email: `sweep-${n()}@kunde.dk`, password: USER_PASSWORD, role: 'viewer' }),
    'PUT /api/ldap/role-map/:id': () => S.bodies.ldapRoleMap(),
    'PUT /api/oidc/role-map/:id': () => S.bodies.claimRoleMap(),
    'PUT /api/saml/role-map/:id': () => S.bodies.claimRoleMap(),
    'POST /api/integrations/': () => S.bodies.integration(),
    'PUT /api/integrations/:id': () => S.bodies.integration(),
    'POST /api/events/:id/notes': () => ({ text: 'Uplink genstartet, tab forsvandt', kind: 'action' }),
    'PATCH /api/events/:id': () => ({ status: 'investigating', comment: 'kigger på det' }),
    'POST /api/events/bulk-status': () => ({ ids: S.eventIds.slice(0, 2), status: 'investigating' }),
    'POST /api/events/:id/ask': () => ({ question: 'Hvad er sket?' }),
    'POST /api/findings/ack': () => ({ ids: S.findingIds.slice(0, 2) }),
    'POST /api/event-clusters/:id/resolve': () => ({ note: 'uplink skiftet' }),
    'POST /api/event-clusters/:id/ack': () => ({}),
    'POST /api/event-clusters/bulk-resolve': () => ({ ids: S.clusterIds.slice(0, 1), note: 'bulk' }),
    'POST /api/event-clusters/:id/evidence': () => ({}),
    'POST /api/investigation/run': () => ({ locationRef: { type: 'agent', value: String(S.agents[0]) }, windowMinutes: 60 }),
    'POST /api/investigation/from-event': () => ({ eventId: S.eventIds[0] }),
    'POST /api/forecast/': () => ({ points: Array.from({ length: 24 }, (_, i) => ({ t: Date.now() - (24 - i) * 3600000, v: 100 + i * 3 })), capacity: 1000, horizonDays: 30 }),
    'POST /api/nis2/custom-reports/preview': () => ({ title: 'Sweep', format: 'json', sections: [{ source: S.nis2Source, filters: {}, columns: [] }] }),
    'POST /api/nis2/custom-reports/export': () => ({ title: 'Sweep', format: 'csv', sections: [{ source: S.nis2Source, filters: {}, columns: [] }] }),
    'POST /api/nis2/reports': () => S.bodies.nis2Report(),
    'POST /api/nis2/evidence': () => ({ title: `Bevis ${n()}`, description: 'sweep', fileUrl: 'https://docs.kunde.invalid/x.pdf' }),
    'POST /api/devices/:id/config-snapshots': () => ({ configText: `hostname sw-core-1\ninterface Gi0/1\n description uplink ${n()}\n`, capturedVia: 'manual' }),
    'POST /api/snmp-devices/': () => S.bodies.snmpDevice(`10.20.${1 + Math.floor(Math.random() * 200)}.${1 + Math.floor(Math.random() * 250)}`, S.agents[0]),
    'PUT /api/snmp-profiles/order/:locationId': () => ({ profileIds: S.profileIds }),
    'POST /api/connection-test/run': () => ({ agentId: S.agents[S.agents.length - 1], host: '10.20.0.1', checks: ['ping', 'dns', 'tcp443'] }),
    'POST /api/burst/': () => ({ agentId: S.agents[S.agents.length - 1], target: '10.20.0.1', seconds: 5 }),
    'POST /agents/:id/probe': () => ({ type: 'ping', host: '10.20.0.1', count: 2 }),
    'POST /agents/:id/install-tool': () => ({ tool: 'traceroute' }),
    'POST /agents/:id/run-test': () => ({ intervalMs: 1000 }),
    'POST /api/service-tests/credentials/': () => ({ application_id: S.apps[0], label: `login-${n()}`, username: 'robot', secret: 'S3cret!pass' }),
    'POST /api/service-tests/environments/': () => ({ application_id: S.apps[0], name: `env-${n()}`, base_url: 'https://env.portal.kunde.invalid' }),
    'POST /api/service-tests/journeys/': () => ({ application_id: S.apps[0], name: `Journey ${n()}` }),
    'PUT /api/service-tests/journeys/:id/steps': () => ({ steps: S.stTestIds.slice(0, 2).map((id) => ({ test_id: id })) }),
    'POST /api/service-tests/monitors/': () => ({ name: `TCP ${n()}`, type: 'tcp_port', config: { host: '192.0.2.10', port: 443 } }),
    'POST /api/service-tests/tests/': () => ({ application_id: S.apps[0], name: `Test ${n()}`, definition: { version: 1, name: 'x', steps: [{ type: 'open', url: '/' }] }, enabled: true }),
    'POST /api/service-tests/schedules/': () => ({ test_id: S.stTestIds[0], interval_sec: 3600, enabled: false }),
    'POST /api/service-tests/recordings/': () => ({ application_id: S.apps[0], name: `Optagelse ${n()}` }),
    'POST /api/service-tests/applications/:id/allowed-hosts': () => ({ value: `h${n()}.kunde.invalid` }),
    'POST /api/service-tests/assurance/incidents/:id/status': () => ({ status: 'investigating' }),
    'POST /api/service-tests/healing/:id/reject': () => ({}),
    'POST /api/service-tests/suggestions/:id/dismiss': () => ({}),
    'POST /api/service-tests/tests/:id/run': () => ({}),
  };
}

// 5xx a route may legitimately answer, and why. Everything else in the 5xx
// range is a failure. Keys are route keys; the value is the documented reason.
const ALLOWED_5XX = {
  // (filled deliberately — see docs/tests.md)
};

// Routes that do not answer JSON when they succeed.
const NON_JSON = [
  /\.(csv|html|sh|ps1|tgz)$/,
  /^GET \/,\/index\.html$/,
  /^GET \/enroll\/agent\/:platform$/,
  /^GET \/enroll\/agent-binary\/:arch$/,
  /^GET \/enroll\/agent-release-key$/,
  /^GET \/auth\/saml\/metadata$/,
  /^GET \/auth\/(oidc|saml)\/login$/,
  /^GET \/auth\/oidc\/callback$/,
  /^POST \/auth\/saml\/callback$/,
  /^GET \/auth\/sso$/,
  /^GET \/api\/export\/:resource$/,
  /^GET \/api\/service-tests\/runs\/:id\/screenshot$/,
  /^GET \/api\/service-tests\/baselines\/:id\/image$/,
  /^GET \/speedtest\/download$/,
  /^POST \/api\/nis2\/custom-reports\/export$/,
];

// Where an id for a path parameter comes from: the path up to the parameter →
// the table that holds it. Anything not listed is resolved by name
// (resolveTableByName) so a route added tomorrow still gets a real id.
const PARAM_TABLES = [
  [/^\/(api\/)?agents$/, 'agents'],
  [/^\/api\/fleet\/agent$/, 'agents'],
  [/^\/api\/targets$/, 'agents'],
  [/^\/locations$/, 'locations'],
  [/^\/api\/thresholds$/, 'locations'],
  [/^\/api\/snmp-profiles\/order$/, 'locations'],
  [/^\/users$/, 'users'],
  [/^\/enrollment-codes$/, 'enrollment_codes'],
  [/^\/api\/(snmp-)?devices$/, 'snmp_devices'],
  [/^\/api\/snmp-devices\/[^/]+\/interfaces$/, 'device_interfaces'],
  [/^\/api\/events$/, 'event_cases'],
  [/^\/api\/nis2\/incidents\/from-event-case$/, 'event_cases'],
  [/^\/api\/transactions$/, 'transaction_tests'],
  [/^\/api\/burst$/, 'burst_runs'],
  [/^\/api\/diagnose$/, 'diagnose_sessions'],
  [/^\/api\/investigation$/, 'investigations'],
  [/^\/api\/discovery\/candidates$/, 'discovered_devices'],
  [/^\/api\/service-tests\/discovery$/, 'service_test_discoveries'],
  [/^\/api\/snmp-profiles$/, 'snmp_credential_profiles'],
  [/^\/api\/reports\/nis2-draft$/, 'probe_outages'],
  [/^\/api\/event-clusters\/[^/]+\/evidence$/, 'cluster_evidence_snapshots'],
  [/^\/api\/service-tests\/applications\/[^/]+\/allowed-hosts$/, 'service_test_allowed_hosts'],
  [/^\/api\/playbooks$/, 'remediation_playbooks'],
  [/^\/api\/service-tests\/monitors$/, 'service_monitors'],
  [/^\/api\/service-tests\/(assurance|analysis)\/incidents$/, 'service_test_incidents'],
  [/^\/api\/service-tests\/analysis\/applications$/, 'service_test_applications'],
  [/^\/api\/service-tests\/(analysis\/)?runs$/, 'service_test_runs'],
  [/^\/api\/service-tests\/(analysis\/)?tests$/, 'service_test_tests'],
  [/^\/api\/nis2\/(risks|controls|incidents|reports|evidence)$/, (m) => `blueeye_nis2_${m[1]}`],
];

// Default query for the "with query" GET variant; a route's own entry wins.
function defaultQuery(S) {
  return {
    agentId: S.agents[0], locationId: S.locations[0], deviceId: S.devices[0],
    limit: 10, from: iso(24 * 3600000), to: iso(0),
  };
}
function queryOverrides(S) {
  return {
    'GET /speedtest/download': { bytes: 2048 },
    'GET /api/baselines/flow-pair': { host: S.agents[0] },
    'GET /api/topology/flow-baselines': { host: S.agents[0] },
    'GET /api/devices/locate': { q: '10.20.0.10' },
    'GET /api/topology/l2-path/': { from: '10.20.0.84', to: '10.20.0.10' },
    'GET /api/search/': { q: '10.20.0.10' },
    // `since` is a DATE here (parseWindow), not a duration like elsewhere.
    'GET /api/geo/select/findings': { country: 'NL', since: new Date(Date.now() - 86400000).toISOString() },
    'GET /api/geo/select/flows': { country: 'NL', since: new Date(Date.now() - 86400000).toISOString() },
    'GET /api/service-tests/baselines/': { test_id: S.stTestIds[0] },
    'GET /api/service-tests/map/': { application_id: S.apps[0] },
    'GET /api/transactions/:id/trend': { agent_id: S.agents[0] },
    'GET /api/probes/path': { agentId: S.agents[0], target: '185.15.58.224' },
    'GET /api/probes/path/metrics': { agentId: S.agents[0], target: '185.15.58.224' },
    'GET /api/probes/path/timeseries': { agentId: S.agents[0], target: '185.15.58.224' },
  };
}

// ============================================================ small helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 220) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const routeKey = (r) => `${r.method.toUpperCase()} ${r.path}`;

// A port for the server. Picked BELOW the kernel's ephemeral range (usually
// 32768+): the server opens MySQL connections before it listens, and one of
// them can be handed the very port a "listen on 0, close, reuse" probe found —
// the listen then dies with EADDRINUSE.
function freePort() {
  const tryPort = (port) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve(true)));
  });
  return (async () => {
    for (let i = 0; i < 50; i += 1) {
      const port = 20000 + Math.floor(Math.random() * 10000);
      if (await tryPort(port)) return port;
    }
    throw new Error('no free port found in 20000-29999');
  })();
}

// ============================================================ state
const failures = []; // { phase, kind, key, method, path, role, status, detail }
const warnings = []; // non-fatal notes
const skipped = []; // { key, reason }
const stats = { calls: 0, byPhase: {}, byStatus: {}, routesSwept: 0 };
let baseUrl = '';
let child = null;
let childExited = null;
const serverLog = []; // { line, stream, during }
const routeStatuses = new Map(); // route key → Set of statuses (authenticated callers)
let routeMatchers = []; // [{ key, method, re }] from the live route table

// Coverage: which statuses each route answered. A route that only ever said
// 400/404 never ran its SQL, so "no 500" says little about it — the summary
// lists those as coverage gaps. Seed and ingest calls count too.
function noteCoverage(key, role, status) {
  if (!key) return;
  const seen = routeStatuses.get(key) || new Set();
  seen.add(status);
  routeStatuses.set(key, seen);
}

// The route pattern a concrete call hit ("POST /users" → "POST /users/").
function routeKeyFor(method, urlPath) {
  const m = method.toLowerCase();
  const p = urlPath.split('?')[0];
  const hit = routeMatchers.find((r) => r.method === m && r.re.test(p));
  return hit ? hit.key : `${method.toUpperCase()} ${urlPath}`;
}
function buildMatchers(routes) {
  routeMatchers = [];
  for (const r of routes) {
    for (const one of r.path.split(',')) {
      const src = one.replace(/\/+$/, '').replace(/[.+*?^${}()|[\]\\]/g, (c) => (c === '?' ? c : `\\${c}`))
        .replace(/\/:([A-Za-z_]+)\?/g, '(?:/[^/]+)?').replace(/:([A-Za-z_]+)/g, '[^/]+');
      routeMatchers.push({ key: routeKey(r), method: r.method, re: new RegExp(`^${src || ''}/?$`) });
    }
  }
  // Literal segments before parameters: "/api/findings/summary" must not be
  // read as "/api/findings/:id".
  routeMatchers.sort((a, b) => (b.key.match(/\/[^/:]+/g) || []).length - (a.key.match(/\/[^/:]+/g) || []).length || a.key.split(':').length - b.key.split(':').length);
}
let currentLabel = 'boot';

function fail(entry) {
  failures.push(entry);
  if (VERBOSE) console.error(`  FAIL [${entry.phase}] ${entry.kind} ${entry.method || ''} ${entry.path || entry.key || ''} ${entry.role || ''} ${entry.status || ''} ${clip(entry.detail, 300)}`);
}

// ============================================================ HTTP
// Every request carries its own X-Request-Id (src/middleware/requestLogger.js
// honours a supplied one), so a server log line can be traced back to the exact
// call — route, role and variant — that caused it.
const requestLabels = new Map();
let requestSeq = 0;

async function call(method, urlPath, { token, body, query, headers = {}, timeoutMs = 20000, rawBody, label } = {}) {
  const url = new URL(urlPath, baseUrl);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  requestSeq += 1;
  const reqId = `vr${requestSeq}`;
  requestLabels.set(reqId, `${label || currentLabel} — ${method.toUpperCase()} ${url.pathname}${url.search}`);
  const h = { 'X-Request-Id': reqId, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (rawBody !== undefined) payload = rawBody;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const started = Date.now();
  stats.calls += 1;
  try {
    const res = await fetch(url, { method: method.toUpperCase(), headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    const isBinary = /octet-stream|gzip|image\/|application\/x-tar/.test(ct);
    const text = isBinary ? '' : buf.toString('utf8');
    let json;
    if (/json/.test(ct)) { try { json = JSON.parse(text); } catch { json = undefined; } }
    stats.byStatus[res.status] = (stats.byStatus[res.status] || 0) + 1;
    return { status: res.status, ct, text, json, bytes: buf.length, ms: Date.now() - started, reqId };
  } catch (err) {
    return { status: 0, ct: '', text: '', json: undefined, error: (err && (err.cause && err.cause.code)) || (err && err.name) || String(err), ms: Date.now() - started, reqId };
  }
}

// ============================================================ response checks
function leakChecks() {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    ['stack trace', /\bat (?:async )?[\w$.<>[\] ]+ \((?:\/|[A-Za-z]:\\|node:)[^)]*:\d+:\d+\)|\n\s+at \S+ \(/],
    ['MySQL error code', /\bER_[A-Z][A-Z_]{3,}\b|\bER_\w+\b|errno\W+\d{4}\b|sqlState|sqlMessage/],
    ['SQL text', /\bSELECT\s[\s\S]{0,200}?\sFROM\s+[`\w]|\bINSERT\s+INTO\s+[`\w]|\bUPDATE\s+`?\w+`?\s+SET\s|\bDELETE\s+FROM\s+[`\w]|\bALTER\s+TABLE\s/],
    ['server file path', new RegExp(`${esc(ROOT)}|/node_modules/|\\bsrc/[\\w/]+\\.js\\b`)],
    ['internal database name / address', new RegExp(`${esc(DB)}|${esc(`${HOST}:${DB_PORT}`)}`)],
  ];
}
// A socket error in an ERROR answer is the server describing its own
// plumbing. In a 2xx it is product data — a probe's errorCode, a certificate
// check that could not resolve its host — and is not scanned for.
const ERROR_ONLY_LEAKS = [
  ['network error from the server itself', /\bECONNREFUSED\b|\bETIMEDOUT\b|\bgetaddrinfo\b|\bEHOSTUNREACH\b|connect ECONN/],
];

// Where a path or the database name in an answer IS the point of the screen.
// Keyed by route: which roles may see it, which kinds, and why. Everything not
// listed here is a failure. These are listed in the run summary so they stay a
// decision somebody made rather than a blind spot.
const DISCLOSURE_ALLOWED = {
  'GET /api/settings/': { roles: ['admin'], kinds: ['server working directory'], reason: 'the admin Settings screen shows the configured GeoIP file' },
  'PUT /api/settings/geoip': { roles: ['admin'], kinds: ['server working directory'], reason: 'echoes the admin GeoIP settings, which include the file path' },
  'GET /api/settings/geoip/update': { roles: ['admin'], kinds: ['server working directory'], reason: 'the admin GeoIP update panel shows where the build is written' },
  'GET /system/server-update': { roles: ['admin'], kinds: ['server working directory'], reason: 'the admin update panel tails the update log it names' },
  'GET /system/version': { roles: ['admin'], kinds: ['server working directory'], reason: 'Settings → Updates shows the admin where the update log is written' },
  'GET /system/storage': { roles: ['admin'], kinds: ['server working directory', 'internal database name / address'], reason: 'the storage counter names the disk path and the database it measures' },
};
let LEAKS = null;
let WORK_DIR_RE = null;

function isJsonRoute(key) {
  return !NON_JSON.some((re) => re.test(key) || re.test(key.split(' ')[1] || ''));
}

// Checks one response; records failures. Returns true when it is clean.
function checkResponse({ phase, key, method, urlPath, role, res, variant }) {
  const base = { phase, key, method: method.toUpperCase(), path: urlPath, role, status: res.status, variant, reqId: res.reqId };
  let clean = true;
  if (res.status === 0) {
    fail({ ...base, kind: 'no response', detail: `request failed: ${res.error}` });
    return false;
  }
  if (res.status === 500) {
    fail({ ...base, kind: '500', detail: res.text });
    clean = false;
  } else if (res.status >= 501) {
    const allowed = ALLOWED_5XX[key];
    if (!allowed || !allowed.statuses.includes(res.status)) {
      fail({ ...base, kind: `${res.status} (not allow-listed)`, detail: res.text });
      clean = false;
    }
  }
  const hasBody = res.bytes > 0 && ![204, 304].includes(res.status) && !(res.status >= 300 && res.status < 400);
  if (hasBody && isJsonRoute(key) && !/application\/json/.test(res.ct)) {
    fail({ ...base, kind: 'not JSON', detail: `content-type "${res.ct}": ${res.text}` });
    clean = false;
  }
  // Leak scan: every JSON answer, and every error answer whatever its type.
  // A 2xx script/CSV/HTML download legitimately contains paths and SQL-looking
  // words (install scripts, NIS2 report prose), so it is not scanned.
  if (res.text && (/json/.test(res.ct) || res.status >= 400)) {
    const allowed = DISCLOSURE_ALLOWED[key] && DISCLOSURE_ALLOWED[key].roles.includes(role) ? DISCLOSURE_ALLOWED[key].kinds : [];
    for (const [what, re] of LEAKS) {
      if (allowed.includes(what)) continue;
      const m = res.text.match(re);
      if (m) {
        fail({ ...base, kind: `leak: ${what}`, detail: `…${clip(res.text.slice(Math.max(0, m.index - 80), m.index + 120), 260)}` });
        clean = false;
      }
    }
    if (res.status >= 400) {
      for (const [what, re] of ERROR_ONLY_LEAKS) {
        const m = res.text.match(re);
        if (m) {
          fail({ ...base, kind: `leak: ${what}`, detail: `…${clip(res.text.slice(Math.max(0, m.index - 80), m.index + 120), 260)}` });
          clean = false;
        }
      }
    }
    const w = !allowed.includes('server working directory') && WORK_DIR_RE && res.text.match(WORK_DIR_RE);
    if (w) {
      fail({ ...base, kind: 'leak: server working directory', detail: `…${clip(res.text.slice(Math.max(0, w.index - 80), w.index + 120), 260)}` });
      clean = false;
    }
  }
  return clean;
}

// ============================================================ boot
async function createAndMigrate(admin) {
  await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  console.info(`Migrating ${DB} …`);
  execFileSync(process.execPath, [path.join(ROOT, 'src', 'migrate.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...env, DB_HOST: HOST, DB_PORT: String(DB_PORT), DB_USER: USER, DB_PASSWORD: PASSWORD, DB_NAME: DB,
      SEED_ADMIN_EMAIL: ADMIN_EMAIL, SEED_ADMIN_PASSWORD: ADMIN_PASSWORD, JWT_SECRET,
    },
  });
}

async function bootServer({ work, agentDir, licens, port }) {
  const routesFile = path.join(work, 'routes.json');
  // A minimal, explicit environment: nothing from the caller's shell (an SMTP
  // host, a webhook URL, an LLM key) can leak into the run and make it send
  // something. Every outbound URL the server could default to is pointed at a
  // closed local port, so an accidental call fails fast instead of reaching the
  // internet.
  const childEnv = {
    PATH: env.PATH, HOME: env.HOME || work, TMPDIR: env.TMPDIR || '/tmp', LANG: env.LANG || 'C.UTF-8', TZ: env.TZ || 'UTC',
    NODE_ENV: 'production',
    PORT: String(port),
    BLUEEYE_PUBLIC_URL: `http://127.0.0.1:${port}`,
    DB_HOST: HOST, DB_PORT: String(DB_PORT), DB_USER: USER, DB_PASSWORD: PASSWORD, DB_NAME: DB,
    JWT_SECRET,
    LICENSE_KEY: 'verify-routes-licence',
    LICENSE_SERVER_ID: 'verify-routes-server',
    LICENSE_SERVER_URL: licens.url,
    LICENSE_PUBLIC_KEY: licens.publicKeyB64,
    TRUST_ANCHOR_OVERRIDE_ACK: 'i-accept-the-risk',
    LICENSE_CACHE_PATH: path.join(work, 'license-cache.json'),
    ANALYSIS_ENABLED: 'true',
    ANALYSIS_ASSISTANT_ENABLED: 'false',
    ANALYSIS_ASSISTANT_URL: 'http://127.0.0.1:9/v1/chat/completions',
    ANALYSIS_BASELINE_CACHE_PATH: path.join(work, 'baselines.json'),
    ALERTING_ENABLED: 'true', // no channel is configured, so nothing is sent
    GEO_ENABLED: 'true',
    GEOIP_DB_PATH: path.join(work, 'geoip.csv'),
    GEOIP_BUILD_PATH: path.join(work, 'geoip-build.csv'),
    GEOIP_SOURCE_URL: 'http://127.0.0.1:9',
    MAP_GEOCODE_URL: 'http://127.0.0.1:9',
    MAP_TILE_URL: 'http://127.0.0.1:9/{z}/{x}/{y}.png',
    DISCOVERY_ENABLED: 'false', // an active sweep would scan a real LAN
    NEW_DEVICE_ALERTS_ENABLED: 'true',
    AGENT_SOURCE_DIR: agentDir,
    AGENT_BINARY_CACHE_DIR: path.join(work, 'agent-binaries'),
    AGENT_RELEASE_DIR: path.join(work, 'agent-releases'),
    AGENT_ARTIFACTS_DIR: path.join(work, 'artifacts'),
    SERVER_UPDATE_LOG: path.join(work, 'server-update.log'),
    SERVER_UPDATE_STATE: path.join(work, 'server-update-state.json'),
    STORAGE_DISK_PATH: work,
    SERVICE_TEST_ARTIFACT_ROOT: path.join(work, 'service-test-artifacts'),
    // Retention runs once shortly after boot, so its SQL runs against the real
    // schema while the sweep is going.
    RETENTION_STARTUP_DELAY_SECONDS: '5',
    LOG_LEVEL: 'info',
    VERIFY_ROUTES_DUMP: routesFile,
  };
  child = spawn(process.execPath, ['-r', path.join(__dirname, 'verify-routes', 'route-dump-preload.js'), path.join(ROOT, 'src', 'server.js')], {
    cwd: work, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  childExited = null;
  child.on('exit', (code, signal) => { childExited = { code, signal }; });
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const text = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const prev = serverLog[serverLog.length - 1];
        // A stack frame continues the record above it (the logger prints an
        // error's stack on the lines after its message).
        if (prev && prev.stream === name && /^\s+(at |\.\.\.|\{|\}|code:|errno:|sql)/.test(text)) {
          (prev.stack || (prev.stack = [])).push(text.trim());
          continue;
        }
        serverLog.push({ line: text, stream: name, during: currentLabel });
      }
    });
    stream.on('end', () => { if (buf) serverLog.push({ line: buf, stream: name, during: currentLabel }); });
  }

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (childExited) break;
    const res = await call('get', '/health', { timeoutMs: 2000 });
    if (res.status === 200) break;
    await sleep(300);
  }
  if (childExited || !fs.existsSync(routesFile)) {
    const tail = serverLog.slice(-40).map((l) => `    ${l.line}`).join('\n');
    throw new Error(`the server did not come up (${childExited ? `exited ${JSON.stringify(childExited)}` : 'no /health within 90 s'}). Last log lines:\n${tail}`);
  }
  return JSON.parse(fs.readFileSync(routesFile, 'utf8'));
}

async function stopServer() {
  if (!child || childExited) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 12000;
  while (!childExited && Date.now() < deadline) await sleep(100);
  if (!childExited) child.kill('SIGKILL');
}

// ============================================================ seeding
// Seeds go through the public API with the same response checks as the sweep:
// a create that answers 500 is a finding like any other. A create that answers
// 4xx is recorded as a warning (usually this script's body is out of date with
// a validator — the message says which field).
async function seedCall(S, label, role, method, urlPath, body, { expect = [200, 201, 202, 204], query } = {}) {
  currentLabel = `seed: ${label}`;
  const res = await call(method, urlPath, { token: S.tokens[role], body, query, label: `seed: ${label} as ${role}` });
  const key = routeKeyFor(method, urlPath);
  noteCoverage(key, role, res.status);
  checkResponse({ phase: 'seed', key, method, urlPath, role, res, variant: label });
  if (!expect.includes(res.status)) {
    warnings.push(`seed "${label}": ${method.toUpperCase()} ${urlPath} as ${role} answered ${res.status} — ${clip(res.text, 300)}`);
    return null;
  }
  return res.json === undefined ? {} : res.json;
}

async function login(email, password) {
  const res = await call('post', '/auth/login', { body: { email, password } });
  if (res.status !== 200 || !res.json || !res.json.token) throw new Error(`login ${email} failed: ${res.status} ${clip(res.text)}`);
  return res.json.token;
}

function seedBodies(S) {
  const n = () => crypto.randomBytes(3).toString('hex');
  return {
    threshold: () => ({ metric: 'packet_loss', warning_value: 5, critical_value: 20, debounce_count: 2 }),
    severityRule: () => ({ source: 'finding', severity: 'CRIT', match_metric: 'probe.loss', match_kind: `kind-${n()}`, reason: 'Tab på gatewayen er altid kritisk her', enabled: true }),
    nis2Risk: () => ({ title: `Risiko ${n()}`, description: 'Udfald af kerneswitch', category: 'Network Security', affectedAsset: 'sw-core-1', likelihood: 3, impact: 4, owner: 'IT-drift', status: 'open', dueDate: '2026-12-31' }),
    nis2Control: () => ({ controlName: `Kontrol ${n()}`, nis2Area: 'Network Security', description: 'Netværkssegmentering', owner: 'IT-drift', frequency: 'quarterly', status: 'Partial' }),
    nis2Incident: () => ({ title: `Hændelse ${n()}`, severity: 'high', status: 'open', detectedAt: iso(3600000), affectedSystems: 'sw-core-1', businessImpact: 'Kontoret offline i 12 min', nis2Relevant: true }),
    nis2Report: () => ({ reportType: 'readiness', title: `Rapport ${n()}`, periodStart: '2026-01-01', periodEnd: '2026-06-30' }),
    runbook: () => ({ findingType: 'probe.loss', title: `Runbook ${n()}`, bodyMarkdown: '# Tjek uplink\n1. Se porten\n2. Genstart' }),
    testPackage: () => ({ name: `Pakke ${n()}`, enabled: true, schedule_ms: 0, targets: { mode: 'agents', agentIds: [S.agents[0]] }, items: [{ type: 'probe', probe: { type: 'ping', host: '10.20.0.1', count: 3 } }, { type: 'run-test' }] }),
    transaction: () => ({ name: `Portal ${n()}`, type: 'http', config: { steps: [{ url: 'https://portal.kunde.invalid/login', method: 'GET', expect_status: 200 }], thresholds: { consecutive_fails: 2, latency_ms: 2000 } }, interval_sec: 60, enabled: true }),
    snmpProfile: () => ({ name: `Profil ${n()}`, version: '2c', community: `c-${n()}` }),
    snmpDevice: (host, agentId) => ({ host, port: 161, version: '2c', community: 'public-ro', agentId, locationId: S.locations[0], displayName: `sw ${host}`, collect: ['if', 'fdb', 'lldp', 'vlan', 'ifcounters', 'cdp', 'arp', 'entity'], intervalSec: 300, counterIntervalSec: 60, enabled: true }),
    reportSchedule: () => ({ name: `Rapport ${n()}`, report: 'availability', format: 'csv', window_days: 7, recipients: ['noc@kunde.dk'], schedule_spec: { period: 'weekly', every: 1, at: '07:30', weekday: 1 }, enabled: false }),
    integration: () => ({ type: 'webhook', name: `Hook ${n()}`, baseUrl: 'https://itsm.kunde.invalid/api', enabled: false, events: ['event.opened'] }),
    ldapRoleMap: () => ({ groupDn: `CN=NOC-${n()},OU=Groups,DC=kunde,DC=dk`, role: 'operator' }),
    claimRoleMap: () => ({ claimValue: `noc-${n()}`, role: 'viewer' }),
    configSnapshot: () => ({ source: 'manual', config: `hostname sw-core-1\ninterface Gi0/1\n description uplink ${n()}\n` }),
    stApplication: () => ({ name: `Portal ${n()}`, base_url: 'https://portal.kunde.invalid', description: 'Kundeportal', enabled: true }),
  };
}

async function seed(S) {
  // --- users + sessions
  S.tokens.admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const mkUser = async (role, tag) => seedCall(S, `user ${tag}`, 'admin', 'post', '/users', { email: `${tag}@kunde.dk`, password: USER_PASSWORD, role, name: `Verify ${tag}` });
  const adminId = await pool1(S, 'SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
  await mkUser('operator', 'operator');
  await mkUser('viewer', 'viewer');
  const throwaway = await mkUser('viewer', 'throwaway');
  // Reads use the admin row; writes (role changes, deletes) the throwaway.
  S.userIds = [adminId, throwaway && throwaway.id].filter(Boolean);
  S.tokens.operator = await login('operator@kunde.dk', USER_PASSWORD);
  S.tokens.viewer = await login('viewer@kunde.dk', USER_PASSWORD);
  S.tokens.anon = null;

  // --- licence must be valid before anything licence-gated is seeded
  const lic = await waitFor(async () => {
    const r = await call('get', '/license/status', { token: S.tokens.admin });
    return r.json && r.json.licensed ? r.json : null;
  }, 20000);
  if (!lic) warnings.push('the licence never became valid — licence-gated routes will answer 403 and their data paths go unexercised');

  // --- the server's signing key: evidence export, signed releases and signed
  // agent commands all take their real path only once one exists.
  await seedCall(S, 'agent-release signing key', 'admin', 'post', '/api/settings/agent-release-key', {});

  // --- locations
  for (const [i, name] of ['Hovedkontor', 'Lager (throwaway)'].entries()) {
    const loc = await seedCall(S, `location ${i}`, 'admin', 'post', '/locations', { name, description: 'verify-routes', address: 'Vesterbrogade 1, København', latitude: 55.67 + i / 100, longitude: 12.56 });
    if (loc && loc.id) S.locations.push(loc.id);
  }

  // --- enrollment: two agents (primary + throwaway) and one spare code
  const codes = [];
  for (let i = 0; i < 3; i += 1) {
    const c = await seedCall(S, `enrollment code ${i}`, 'operator', 'post', '/enrollment-codes', { location_id: S.locations[0] || null, expiresInMinutes: 120, maxUses: 1 });
    if (c && c.code) codes.push(c);
  }
  S.spareCode = codes[2] ? codes[2].code : null;
  for (let i = 0; i < 2 && codes[i]; i += 1) {
    const en = await seedCall(S, `enroll agent ${i}`, 'anon', 'post', '/agents/enroll', { code: codes[i].code, hostname: i ? 'throwaway-host' : 'noc-probe-1', platform: 'linux', arch: 'x64' });
    if (en && en.agentId) { S.agents.push(en.agentId); S.agentTokens.push(en.token); }
  }
  if (!S.agents.length) throw new Error('could not enroll an agent — nothing to ingest as');
  S.tokens.agent = S.agentTokens[0];
  await seedCall(S, 'agent metadata', 'admin', 'put', `/agents/${S.agents[0]}`, { display_name: 'NOC probe 1', location_id: S.locations[0], notes: 'verify-routes', monitor_config: { source: 'sflow', sflow: { port: 6343 } } });

  // --- SNMP inventory
  await seedCall(S, 'snmp profile', 'admin', 'post', '/api/snmp-profiles', S.bodies.snmpProfile());
  await seedCall(S, 'snmp profile 2', 'admin', 'post', '/api/snmp-profiles', S.bodies.snmpProfile());
  for (const host of ['10.20.0.2', '10.20.0.3']) {
    const d = await seedCall(S, `snmp device ${host}`, 'admin', 'post', '/api/snmp-devices', S.bodies.snmpDevice(host, S.agents[0]));
    const dev = d && (d.device || d);
    if (dev && dev.id) S.devices.push(dev.id);
  }

  // --- thresholds, severity rules, runbooks, packages, transactions
  await seedCall(S, 'global thresholds', 'admin', 'put', '/api/thresholds', S.bodies.threshold());
  if (S.locations[0]) await seedCall(S, 'location thresholds', 'admin', 'put', `/api/thresholds/${S.locations[0]}`, S.bodies.threshold());
  for (let i = 0; i < 2; i += 1) {
    await seedCall(S, `severity rule ${i}`, 'admin', 'post', '/api/severity-rules', S.bodies.severityRule());
    await seedCall(S, `runbook ${i}`, 'admin', 'post', '/api/runbooks', S.bodies.runbook());
    await seedCall(S, `test package ${i}`, 'admin', 'post', '/api/test-packages', S.bodies.testPackage());
    const t = await seedCall(S, `transaction ${i}`, 'admin', 'post', '/api/transactions', S.bodies.transaction());
    const tid = t && (t.id || (t.test && t.test.id));
    if (tid) S.transactions.push(tid);
    await seedCall(S, `report schedule ${i}`, 'admin', 'post', '/api/report-schedules', S.bodies.reportSchedule());
    await seedCall(S, `integration ${i}`, 'admin', 'post', '/api/integrations', S.bodies.integration());
    await seedCall(S, `api token ${i}`, 'admin', 'post', '/api/api-tokens', { name: `token ${i}` });
    await seedCall(S, `ldap role map ${i}`, 'admin', 'post', '/api/ldap/role-map', S.bodies.ldapRoleMap());
    await seedCall(S, `oidc role map ${i}`, 'admin', 'post', '/api/oidc/role-map', S.bodies.claimRoleMap());
    await seedCall(S, `saml role map ${i}`, 'admin', 'post', '/api/saml/role-map', S.bodies.claimRoleMap());
  }
  if (S.transactions[0]) await seedCall(S, 'assign transaction', 'admin', 'put', `/api/transactions/${S.transactions[0]}/agents`, { agent_ids: [S.agents[0]] });

  // --- NIS2
  await seedCall(S, 'nis2 seed', 'admin', 'post', '/api/nis2/seed', {});
  const incidents = [];
  for (let i = 0; i < 2; i += 1) {
    await seedCall(S, `nis2 risk ${i}`, 'admin', 'post', '/api/nis2/risks', S.bodies.nis2Risk());
    await seedCall(S, `nis2 control ${i}`, 'admin', 'post', '/api/nis2/controls', S.bodies.nis2Control());
    const inc = await seedCall(S, `nis2 incident ${i}`, 'admin', 'post', '/api/nis2/incidents', S.bodies.nis2Incident());
    if (inc && (inc.id || (inc.incident && inc.incident.id))) incidents.push(inc.id || inc.incident.id);
  }
  for (let i = 0; i < 2 && incidents[0]; i += 1) {
    await seedCall(S, `nis2 report ${i}`, 'admin', 'post', '/api/nis2/reports', S.bodies.nis2Report());
    await seedCall(S, `nis2 evidence ${i}`, 'admin', 'post', '/api/nis2/evidence', { title: `Bevis ${i}`, description: 'Log fra switch', fileUrl: 'https://docs.kunde.invalid/log.txt', entityType: 'incident', entityId: incidents[0] });
  }

  // --- Service Assurance
  const apps = [];
  for (let i = 0; i < 2; i += 1) {
    const a = await seedCall(S, `st application ${i}`, 'admin', 'post', '/api/service-tests/applications', S.bodies.stApplication());
    const app = a && (a.application || a);
    if (app && app.id) apps.push(app.id);
  }
  S.apps = apps;
  if (apps[0]) {
    await seedCall(S, 'st allowed host', 'admin', 'post', `/api/service-tests/applications/${apps[0]}/allowed-hosts`, { value: 'cdn.kunde.invalid', note: 'assets' });
    await seedCall(S, 'st allowed host 2', 'admin', 'post', `/api/service-tests/applications/${apps[0]}/allowed-hosts`, { value: '10.20.0.0/24', note: 'lan' });
    for (let i = 0; i < 2; i += 1) {
      await seedCall(S, `st environment ${i}`, 'admin', 'post', '/api/service-tests/environments', { application_id: apps[0], name: `env-${i}`, base_url: `https://test${i}.portal.kunde.invalid` });
      await seedCall(S, `st credential ${i}`, 'admin', 'post', '/api/service-tests/credentials', { application_id: apps[0], label: `login-${i}`, username: 'robot', secret: 'S3cret!pass' });
      const t = await seedCall(S, `st test ${i}`, 'admin', 'post', '/api/service-tests/tests', { application_id: apps[0], name: `Forside ${i}`, definition: { version: 1, name: `Forside ${i}`, steps: [{ type: 'open', url: '/' }, { type: 'assert_visible', target: { text: 'Velkommen' } }] }, enabled: true });
      const test = t && (t.test || t);
      await seedCall(S, `st journey ${i}`, 'admin', 'post', '/api/service-tests/journeys', { application_id: apps[0], name: `Login ${i}` });
      await seedCall(S, `st monitor ${i}`, 'admin', 'post', '/api/service-tests/monitors', { name: `TCP ${i}`, type: 'tcp_port', config: { host: '192.0.2.10', port: 443 } });
      if (test && test.id) await seedCall(S, `st schedule ${i}`, 'admin', 'post', '/api/service-tests/schedules', { test_id: test.id, interval_sec: 3600, enabled: false });
      await seedCall(S, `st recording ${i}`, 'admin', 'post', '/api/service-tests/recordings', { application_id: apps[0], name: `Optagelse ${i}` });
    }
  }

  // --- diagnose, investigation, burst, a queued Service Assurance run
  await seedCall(S, 'diagnose', 'viewer', 'post', '/api/diagnose', { description: 'Kontoret kan ikke nå portalen', agentId: S.agents[0] });
  await seedCall(S, 'investigation', 'operator', 'post', '/api/investigation/run', { locationRef: { type: 'agent', value: String(S.agents[0]) }, windowMinutes: 60 });
  // The agent is not connected, so the run is recorded and the answer is 409.
  await seedCall(S, 'burst run', 'operator', 'post', '/api/burst', { agentId: S.agents[0], target: '10.20.0.1', seconds: 10 }, { expect: [202, 409] });
  const firstTest = await pool1(S, 'SELECT MIN(id) AS id FROM service_test_tests');
  if (firstTest) await seedCall(S, 'st run', 'operator', 'post', `/api/service-tests/tests/${firstTest}/run`, {}, { expect: [200, 201, 202] });
  await seedCall(S, 'client log', 'viewer', 'post', '/api/logs/client', { level: 'error', msg: 'verify-routes client error' });
}

async function pool1(S, sql, params = []) {
  try {
    const [[r]] = await S.pool.query(sql, params);
    return r ? Object.values(r)[0] : null;
  } catch { return null; }
}

// Rows no public endpoint creates on demand: a cross-agent cluster needs two
// agents failing together over the job's window, a playbook ships as data, and
// Service Assurance's healing/suggestions/baselines come from the browser
// worker, which is a separate process this run does not start. They are
// written straight into the scratch database so the routes that READ them get
// a real id. Each insert is best-effort: a schema that moved on only costs a
// warning (and those routes fall back to the missing/malformed variants).
async function directSeeds(S) {
  const q = async (label, sql, params) => {
    try { const [r] = await S.pool.query(sql, params); return r.insertId; } catch (err) { warnings.push(`direct seed "${label}" failed: ${err.code || err.message}`); return null; }
  };
  const [findings] = await S.pool.query('SELECT id FROM findings ORDER BY created_at LIMIT 2').catch(() => [[]]);
  const ids = findings.map((f) => f.id);
  for (let i = 0; i < 2; i += 1) {
    const cid = await q('event cluster', "INSERT INTO event_clusters (confidence, member_finding_ids, suspected_common_cause, grouping_basis, advisory, status, detected_at) VALUES ('medium', ?, 'Fælles uplink på sw-core-1', ?, 'Tjek uplinket', 'open', NOW())",
      [JSON.stringify(ids), JSON.stringify({ basis: 'shared-hop', hop: '80.62.10.1' })]);
    if (cid) await q('cluster evidence snapshot', "INSERT INTO cluster_evidence_snapshots (cluster_id, target, command_set_version, status, items, captured_at, `trigger`) VALUES (?, ?, '1', 'complete', ?, NOW(), 'manual')",
      [cid, `agent:${S.agents[0]}`, JSON.stringify([{ id: 'iface.counters', ok: true }])]);
    await q('remediation playbook', "INSERT INTO remediation_playbooks (name, trigger_condition, action_type, auto_trigger, manual_action_text, enabled) VALUES (?, 'probe.loss', 'manual', 0, 'Genstart uplinket', 1)", [`Playbook ${i}`]);
  }
  const app = S.apps[0];
  const test = await pool1(S, 'SELECT MIN(id) AS id FROM service_test_tests');
  if (app && test) {
    for (let i = 0; i < 2; i += 1) {
      const did = await q('st discovery', "INSERT INTO service_test_discoveries (application_id, status, scope_url, budgets, page_count, created_at, updated_at) VALUES (?, 'complete', 'https://portal.kunde.invalid/', ?, 3, NOW(), NOW())", [app, JSON.stringify({ pages: 10 })]);
      if (did) await q('st suggestion', "INSERT INTO service_test_suggestions (discovery_id, application_id, kind, name, confidence, reason, proposed_steps, status, created_at, updated_at) VALUES (?, ?, 'test', ?, 'medium', 'found a login form', ?, 'proposed', NOW(), NOW())",
        [did, app, `Forslag ${i}`, JSON.stringify([{ type: 'open', url: '/' }])]);
      await q('st healing', "INSERT INTO service_test_healing (test_id, step_path, step_type, original_target, proposed_target, confidence, reason, score, status, created_at, updated_at) VALUES (?, '1', 'assert_visible', ?, ?, 'high', 'text moved', 90, 'proposed', NOW(), NOW())",
        [test, JSON.stringify({ text: 'Velkommen' }), JSON.stringify({ role: 'heading', name: 'Velkommen' })]);
      await q('st baseline', "INSERT INTO service_test_baselines (test_id, step_index, step_label, image_path, width, height, tolerance, threshold_pct, enabled) VALUES (?, ?, 'forside', 'baselines/verify.png', 1280, 800, 10, 0.5, 1)", [test, i]);
    }
  }
}

async function waitFor(fn, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

// ============================================================ ingest
async function ingestCall(S, label, method, urlPath, body, expect, { token, rawBody, headers, query } = {}) {
  currentLabel = `ingest: ${label}`;
  const res = await call(method, urlPath, { token: token || S.tokens.agent, body, rawBody, headers, query, label: `ingest: ${label}` });
  const key = routeKeyFor(method, urlPath);
  noteCoverage(key, 'agent', res.status);
  checkResponse({ phase: 'ingest', key, method, urlPath, role: 'agent', res, variant: label });
  if (!expect.includes(res.status)) {
    fail({ phase: 'ingest', kind: `unexpected ${res.status}`, method: method.toUpperCase(), path: urlPath, role: 'agent', status: res.status, detail: `${label}: ${res.text}` });
    return null;
  }
  return res.json || {};
}

async function ingest(S) {
  const [dev, devErr] = S.devices;
  const got = {};
  got.caps1 = await ingestCall(S, 'capabilities #1 (lldp/arp/connections/nic/ips)', 'post', '/agents/me/capabilities', P.capabilities({ round: 1 }), [200]);
  got.config = await ingestCall(S, 'agent config', 'get', '/agents/me/config', undefined, [200]);
  if (got.config && dev && !(got.config.snmpTargets || []).some((t) => t.deviceId === dev)) {
    fail({ phase: 'ingest', kind: 'wiring', method: 'GET', path: '/agents/me/config', role: 'agent', status: 200, detail: `snmp device ${dev} is assigned to agent ${S.agents[0]} but is not in snmpTargets` });
  }
  got.results1 = await ingestCall(S, 'results #1 (proc traffic, eth0 up)', 'post', '/agents/results', { results: [P.resultEnvelope(P.procTraffic({ ethStatus: 'up' }), { msAgo: 120000 })] }, [201]);
  got.results2 = await ingestCall(S, 'results #2 (sflow flows)', 'post', '/agents/results', { results: [P.resultEnvelope(P.sflowTraffic(), { msAgo: 60000 })] }, [201]);
  got.results3 = await ingestCall(S, 'results #3 (proc traffic, eth0 down)', 'post', '/agents/results', { results: [P.resultEnvelope(P.procTraffic({ ethStatus: 'down', errors: 40 }), { msAgo: 0 })] }, [201]);
  got.probes = await ingestCall(S, 'probe-results (every probe type)', 'post', '/agents/probe-results', P.probeResults(), [201]);
  got.caps2 = await ingestCall(S, 'capabilities #2 (lldp neighbour changed)', 'post', '/agents/me/capabilities', P.capabilities({ round: 2 }), [200]);
  if (dev) {
    got.topo1 = await ingestCall(S, 'snmp-topology #1', 'post', '/agents/me/snmp-topology', P.snmpTopology({ deviceId: dev, errorDeviceId: devErr, round: 1 }), [202]);
    if (got.topo1 && (got.topo1.stored !== 1 || got.topo1.refused)) {
      fail({ phase: 'ingest', kind: 'ingest dropped', method: 'POST', path: '/agents/me/snmp-topology', role: 'agent', status: 202, detail: `expected the assigned device to be stored, got ${JSON.stringify(got.topo1)}` });
    }
    await sleep(1100); // the transition diff keys on detection time
    got.topo2 = await ingestCall(S, 'snmp-topology #2 (port down, MAC moved, neighbour swapped)', 'post', '/agents/me/snmp-topology', P.snmpTopology({ deviceId: dev, round: 2 }), [202]);
    got.ctr1 = await ingestCall(S, 'snmp-counters #1', 'post', '/agents/me/snmp-counters', P.snmpCounters({ deviceId: dev, round: 1 }), [202]);
    got.ctr2 = await ingestCall(S, 'snmp-counters #2', 'post', '/agents/me/snmp-counters', P.snmpCounters({ deviceId: dev, round: 2 }), [202]);
    if (got.ctr2 && (got.ctr2.stored < 1 || got.ctr2.refused)) {
      fail({ phase: 'ingest', kind: 'ingest dropped', method: 'POST', path: '/agents/me/snmp-counters', role: 'agent', status: 202, detail: `expected the assigned device to be stored, got ${JSON.stringify(got.ctr2)}` });
    }
  }
  got.events = await ingestCall(S, 'device-events (syslog + trap)', 'post', '/agents/me/device-events', P.deviceEvents({ sourceIp: '10.20.0.2' }), [202]);
  if (got.events && !(got.events.inserted > 0)) {
    fail({ phase: 'ingest', kind: 'ingest dropped', method: 'POST', path: '/agents/me/device-events', role: 'agent', status: 202, detail: `no event inserted: ${JSON.stringify(got.events)}` });
  }
  got.discovery = await ingestCall(S, 'discovery-results', 'post', '/agents/discovery-results', P.discoveryResults(), [202]);
  got.speed = await ingestCall(S, 'speedtest results', 'post', '/speedtest/results', P.speedtestResult(), [201]);
  await ingestCall(S, 'speedtest download (2 KiB)', 'get', '/speedtest/download', undefined, [200], { query: { bytes: 2048 } });
  await ingestCall(S, 'speedtest upload (4 KiB)', 'post', '/speedtest/upload', undefined, [200], { rawBody: Buffer.alloc(4096), headers: { 'Content-Type': 'application/octet-stream' } });

  // --- the WebSocket: transaction results, sflow status, an agent error
  await wsIngest(S);

  // Background pipelines (analysis, event derivation, clustering) are
  // fire-and-forget after the response; give them a moment.
  currentLabel = 'ingest: settle';
  await sleep(3000);
  return got;
}

async function wsIngest(S) {
  let WebSocket;
  try { WebSocket = require(require.resolve('ws', { paths: [ROOT] })); } catch { warnings.push('ws module not found — WebSocket ingest skipped'); return; }
  currentLabel = 'ingest: websocket';
  const url = baseUrl.replace(/^http/, 'ws') + '/ws/agent';
  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${S.tokens.agent}`, 'X-BlueEye-Protocol': '1' } });
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* */ } resolve({ ok: false, why: 'timeout waiting for the connected frame' }); }, 10000);
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type !== 'connected') return;
      const send = (o) => ws.send(JSON.stringify(o));
      send({ type: 'heartbeat', ts: Date.now() });
      send({ type: 'sflow.status', state: 'active', detail: null });
      send({ type: 'agent.error', category: 'snmp-topology', code: 'ETIMEDOUT', message: 'verify-routes: switch 10.20.0.3 did not answer' });
      if (S.transactions[0]) {
        send({ type: 'transaction_result', results: [
          { test_id: S.transactions[0], status: 'ok', latency_ms: 412, time: iso(60000), step_timings: [{ step: 0, name: 'login', ms: 412, status: 200 }], step_failed: null, detail: null },
          { test_id: S.transactions[0], status: 'fail', latency_ms: 5000, time: iso(0), step_timings: [{ step: 0, name: 'login', ms: 5000, status: 503 }], step_failed: 0, detail: 'HTTP 503' },
        ] });
      }
      setTimeout(() => { clearTimeout(timer); ws.close(); resolve({ ok: true }); }, 1500);
    });
    ws.on('unexpected-response', (req, res) => { clearTimeout(timer); resolve({ ok: false, why: `upgrade refused: HTTP ${res.statusCode}` }); });
    ws.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, why: err.message }); });
  });
  if (!outcome.ok) fail({ phase: 'ingest', kind: 'websocket', method: 'WS', path: '/ws/agent', role: 'agent', status: 0, detail: outcome.why });
  await sleep(1000); // the close handler marks the agent offline
}

// ============================================================ data check
// ingest path → table → why. `required: false` rows are reported but only
// warn when empty (analysis output depends on thresholds a single run may not
// cross); `where` narrows the count when the table has rows from elsewhere.
const EXPECTED_ROWS = [
  { path: 'POST /agents/results', table: 'results', required: true },
  { path: 'POST /agents/results (sflow)', table: 'flow_records', required: true },
  { path: 'POST /agents/results (proc)', table: 'interface_states', required: true },
  { path: 'POST /agents/results (eth0 up→down)', table: 'interface_state_transitions', where: 'device_id IS NULL', required: true },
  { path: 'POST /agents/probe-results', table: 'probe_results', required: true },
  { path: 'POST /agents/probe-results (dhcp)', table: 'probe_results', where: "type = 'dhcp'", required: true },
  { path: 'POST /agents/probe-results (traceroute hops)', table: 'probe_results', where: "type = 'traceroute' AND hops IS NOT NULL", required: true },
  { path: 'POST /agents/probe-results (dns errorCode)', table: 'probe_results', where: "type = 'dns' AND error_code IS NOT NULL", required: true },
  { path: 'POST /agents/probe-results (tcp failure)', table: 'probe_results', where: "type = 'tcp' AND failure IS NOT NULL", required: true },
  { path: 'POST /agents/probe-results → findings (cert expiry)', table: 'findings', required: true },
  { path: 'POST /agents/probe-results → probe outages', table: 'probe_outages', required: false },
  { path: 'POST /agents/probe-results → event cases', table: 'event_cases', required: false },
  { path: 'POST /agents/me/capabilities (arp)', table: 'arp_entries', required: true },
  { path: 'POST /agents/me/capabilities (connections)', table: 'host_connections', required: true },
  { path: 'POST /agents/me/capabilities (lldp)', table: 'lldp_neighbors', required: true },
  { path: 'POST /agents/me/capabilities (lldp changed)', table: 'topology_changes', where: 'device_id IS NULL', required: true },
  { path: 'POST /agents/me/capabilities (arp) → new devices', table: 'known_devices', required: false },
  { path: 'POST /agents/me/snmp-topology (poll ok)', table: 'snmp_devices', where: 'last_ok_at IS NOT NULL AND sys_descr IS NOT NULL', required: true },
  { path: 'POST /agents/me/snmp-topology (poll error)', table: 'snmp_devices', where: 'last_error IS NOT NULL', required: true },
  { path: 'POST /agents/me/snmp-topology (entity)', table: 'snmp_devices', where: 'hw_model IS NOT NULL', required: true },
  { path: 'POST /agents/me/snmp-topology', table: 'device_interfaces', required: true },
  { path: 'POST /agents/me/snmp-topology', table: 'fdb_entries', required: true },
  { path: 'POST /agents/me/snmp-topology (MAC moved)', table: 'fdb_mac_moves', required: false },
  { path: 'POST /agents/me/snmp-topology', table: 'snmp_neighbors', required: true },
  { path: 'POST /agents/me/snmp-topology (cdp)', table: 'snmp_neighbors', where: "protocol = 'cdp'", required: true },
  { path: 'POST /agents/me/snmp-topology', table: 'device_vlans', required: true },
  { path: 'POST /agents/me/snmp-topology (arp)', table: 'device_arp_entries', required: true },
  { path: 'POST /agents/me/snmp-topology (entity)', table: 'device_inventory', required: true },
  { path: 'POST /agents/me/snmp-topology (port down)', table: 'interface_state_transitions', where: 'device_id IS NOT NULL', required: true },
  { path: 'POST /agents/me/snmp-topology (neighbour swapped)', table: 'topology_changes', where: 'device_id IS NOT NULL', required: true },
  { path: 'POST /agents/me/snmp-counters', table: 'device_counter_samples', required: true },
  { path: 'POST /agents/me/snmp-counters (duplex)', table: 'device_counter_samples', where: 'duplex IS NOT NULL', required: true },
  { path: 'POST /agents/me/device-events', table: 'device_events', required: true },
  { path: 'POST /agents/me/device-events (trap)', table: 'device_events', where: "transport = 'trap'", required: true },
  { path: 'POST /agents/discovery-results', table: 'discovered_devices', required: true },
  { path: 'POST /speedtest/results', table: 'speedtest_results', required: true },
  { path: 'WS transaction_result', table: 'transaction_results', required: true },
  { path: 'agent activity (audit)', table: 'audit_events', where: "actor_type = 'agent'", required: true },
];

async function dataCheck(pool) {
  currentLabel = 'data check';
  const [tables] = await pool.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [DB]);
  const have = new Set(tables.map((r) => r.t));
  const rows = [];
  for (const e of EXPECTED_ROWS) {
    if (!have.has(e.table)) { rows.push({ ...e, count: null, note: 'table does not exist (yet) — skipped' }); continue; }
    try {
      const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${e.table}\`${e.where ? ` WHERE ${e.where}` : ''}`);
      rows.push({ ...e, count: Number(r.n) });
    } catch (err) {
      rows.push({ ...e, count: null, note: `could not count (${err.code || err.message}) — the column this check reads may have moved` });
    }
  }
  console.info('\nData collection check (ingest path → table → rows):');
  const w1 = Math.max(...rows.map((r) => r.path.length));
  const w2 = Math.max(...rows.map((r) => (r.table + (r.where ? ` [${r.where}]` : '')).length));
  for (const r of rows) {
    const tbl = r.table + (r.where ? ` [${r.where}]` : '');
    let verdict;
    if (r.count === null) verdict = `SKIP  ${r.note}`;
    else if (r.count > 0) verdict = 'ok';
    else if (r.required) verdict = 'EMPTY — FAIL';
    else verdict = 'empty (not required)';
    console.info(`  ${r.path.padEnd(w1)}  ${tbl.padEnd(w2)}  ${String(r.count === null ? '-' : r.count).padStart(5)}  ${verdict}`);
    if (r.count === 0 && r.required) {
      fail({ phase: 'data', kind: 'empty table', key: r.path, path: r.table, detail: `${r.path} should have written ${tbl}, but it has no rows` });
    } else if (r.count === 0) {
      warnings.push(`data: ${tbl} is empty after ${r.path} (not required)`);
    } else if (r.count === null && r.note && r.note.startsWith('could not')) {
      warnings.push(`data: ${tbl}: ${r.note}`);
    }
  }
}

// ============================================================ param values
function makeResolver(pool, S) {
  let tables = null;
  const cache = new Map();

  async function allTables() {
    if (!tables) {
      const [rows] = await pool.query(
        "SELECT c.TABLE_NAME AS t FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = ? AND c.COLUMN_NAME = 'id'", [DB]);
      tables = rows.map((r) => r.t);
    }
    return tables;
  }

  const singular = (s) => s.replace(/ies$/, 'y').replace(/s$/, '');
  // A table for a path by name: /api/service-tests/credentials → the table
  // that ends in `credentials` and shares the most words with the path.
  async function tableByName(prefix) {
    const segs = prefix.split('/').filter((s) => s && s !== 'api' && !s.startsWith(':'));
    if (!segs.length) return null;
    const last = segs[segs.length - 1].replace(/-/g, '_');
    const words = new Set(segs.slice(0, -1).flatMap((s) => s.split('-')).map(singular));
    const cands = (await allTables()).filter((t) => t === last || t.endsWith(`_${last}`) || t === singular(last) || t.endsWith(`_${singular(last)}`));
    if (!cands.length) return null;
    cands.sort((a, b) => score(b) - score(a) || a.length - b.length);
    return cands[0];
    function score(t) { return t.split('_').map(singular).filter((w) => words.has(w)).length; }
  }

  // The rows this run seeded ON PURPOSE as primary + throwaway. MIN/MAX would
  // drift as the sweep itself creates rows (promoting a discovery candidate
  // creates an agent, for one), and the throwaway agent is the one connected.
  const seeded = () => ({
    agents: S.agents, locations: S.locations, snmp_devices: S.devices, users: S.userIds,
    transaction_tests: S.transactions,
  });
  async function idsFrom(table, where = '') {
    const k = `${table}|${where}`;
    if (cache.has(k)) return cache.get(k);
    const mine = !where && seeded()[table];
    if (mine && mine.length) {
      const v = { real: String(mine[0]), throwaway: String(mine[mine.length - 1]) };
      cache.set(k, v);
      return v;
    }
    let out = null;
    try {
      const [[r]] = await pool.query(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM \`${table}\`${where ? ` WHERE ${where}` : ''}`);
      if (r && r.lo != null) out = { real: String(r.lo), throwaway: String(r.hi) };
    } catch { out = null; }
    cache.set(k, out);
    return out;
  }

  // Returns { real, throwaway } or null for the parameter at `index` in `routePath`.
  async function resolve(routePath, name) {
    const i = routePath.indexOf(`:${name}`);
    const prefix = routePath.slice(0, i).replace(/\/$/, '');
    switch (name) {
      case 'code': return S.spareCode ? { real: S.spareCode, throwaway: S.spareCode } : null;
      case 'platform': return { real: 'linux-amd64', throwaway: 'linux-amd64' };
      case 'arch': return { real: 'linux-x64', throwaway: 'linux-x64' };
      case 'resource': return { real: 'findings', throwaway: 'findings' };
      case 'section': return S.settingsSection ? { real: S.settingsSection, throwaway: S.settingsSection } : null;
      case 'node': return { real: String(S.agents[0]), throwaway: String(S.agents[S.agents.length - 1]) };
      case 'key': return S.changeKey ? { real: S.changeKey, throwaway: S.changeKey } : null;
      case 'interfaceId': return S.devices[0] ? idsFrom('device_interfaces', `device_id = ${Number(S.devices[0])}`) : null;
      case 'id':
        if (prefix === '/api/playbooks') return S.playbookId ? { real: S.playbookId, throwaway: S.playbookId } : null;
        break;
      default: break;
    }
    for (const [re, table] of PARAM_TABLES) {
      const m = prefix.match(re);
      if (m) return idsFrom(typeof table === 'function' ? table(m) : table);
    }
    const t = await tableByName(prefix);
    return t ? idsFrom(t) : null;
  }

  return { resolve, reset: () => cache.clear() };
}

const NUMERIC_PARAM = /^(id|sid|entryId|caseId|interfaceId|locationId|location_id|probe_outage_id)$/;

// The path variants for one route: a real id (primary for reads, the
// throwaway row for writes), a missing one and a malformed one. A string
// parameter also gets a traversal-shaped value.
async function pathVariants(route, resolver, { forWrite }) {
  const p = route.path;
  if (p.includes(',')) return p.split(',').map((x) => ({ label: 'static', path: x }));
  const names = [...p.matchAll(/:([A-Za-z_]+)\??/g)].map((m) => m[1]);
  if (!names.length) return [{ label: 'static', path: p }];
  const fillWith = (fn) => names.reduce((acc, nm) => acc.replace(new RegExp(`:${nm}\\??`), fn(nm)), p);
  const out = [];
  const reals = {};
  let allReal = true;
  for (const nm of names) {
    const v = await resolver.resolve(p, nm);
    if (!v) { allReal = false; break; }
    reals[nm] = forWrite ? v.throwaway : v.real;
  }
  if (allReal) out.push({ label: 'real', path: fillWith((nm) => encodeURIComponent(reals[nm])) });
  else out.push({ label: 'real-unavailable', path: null });
  out.push({ label: 'missing', path: fillWith((nm) => (NUMERIC_PARAM.test(nm) ? '999999' : 'doesnotexist')) });
  out.push({ label: 'malformed', path: fillWith(() => 'abc') });
  if (names.some((nm) => !NUMERIC_PARAM.test(nm))) out.push({ label: 'traversal', path: fillWith((nm) => (NUMERIC_PARAM.test(nm) ? '1' : '..%2F..%2Fpackage.json')) });
  return out;
}

// ============================================================ sweep
const ROLES = ['admin', 'operator', 'viewer', 'anon', 'agent'];
const USER_ROLES = new Set(['admin', 'operator', 'viewer']);
const CREDENTIALS = { admin: [ADMIN_EMAIL, ADMIN_PASSWORD], operator: ['operator@kunde.dk', USER_PASSWORD], viewer: ['viewer@kunde.dk', USER_PASSWORD] };

async function sweep(routes, S, resolver) {
  const valid = validBodies(S);
  const dq = defaultQuery(S);
  const qo = queryOverrides(S);
  const sessionNotes = [];
  const deadRoles = new Set();
  const realMissing = new Set();

  const selected = routes.filter((r) => !ONLY || r.path.includes(ONLY));
  for (const r of selected) {
    if (SKIP[routeKey(r)]) skipped.push({ key: routeKey(r), reason: SKIP[routeKey(r)] });
  }
  const live = selected.filter((r) => !SKIP[routeKey(r)]);
  stats.routesSwept = live.length;

  // Re-establishes a user session the sweep itself took away (a password or
  // role change, a revocation). Returns false when the role cannot come back.
  async function ensureSession(role, afterLabel) {
    if (!USER_ROLES.has(role) || deadRoles.has(role)) return !deadRoles.has(role);
    const probe = await call('get', '/me', { token: S.tokens[role] });
    if (probe.status === 200) return true;
    sessionNotes.push(`${role} session invalidated after ${afterLabel} (GET /me → ${probe.status}); logging in again`);
    try {
      S.tokens[role] = await login(...CREDENTIALS[role]);
      return true;
    } catch (err) {
      deadRoles.add(role);
      fail({ phase: 'sweep', kind: 'lost session', key: afterLabel, role, detail: `${role} could not log in again after ${afterLabel}: ${err.message}` });
      return false;
    }
  }

  async function one(phase, r, role, v, { query, body, bodyLabel }) {
    if (deadRoles.has(role)) return null;
    const key = routeKey(r);
    const label = `${key} [${role} ${v.label}${bodyLabel ? ` ${bodyLabel}` : ''}${query ? ' +query' : ''}]`;
    currentLabel = label;
    const res = await call(r.method, v.path, { token: S.tokens[role], body, query, label });
    stats.byPhase[phase] = (stats.byPhase[phase] || 0) + 1;
    noteCoverage(key, role, res.status);
    if (TRACE && label.includes(TRACE)) console.info(`  trace ${res.status} ${label}${res.status >= 400 ? ` ${clip(res.text, 120)}` : ''}`);
    checkResponse({ phase, key, method: r.method, urlPath: v.path + (query ? '?…' : ''), role, res, variant: `${v.label}${bodyLabel ? `/${bodyLabel}` : ''}${query ? '/query' : ''}` });
    if (res.status === 0 && childExited) throw new Error(`the server exited during ${label}: ${JSON.stringify(childExited)}`);
    return res;
  }

  // ---- phase 1: reads, a few in flight at once
  resolver.reset();
  const gets = live.filter((r) => r.method === 'get');
  const jobs = [];
  for (const r of gets) {
    const vars = await pathVariants(r, resolver, { forWrite: false });
    if (vars[0].label === 'real-unavailable') realMissing.add(routeKey(r));
    for (const role of ROLES) {
      for (const v of vars) {
        if (!v.path) continue;
        jobs.push(() => one('GET', r, role, v, {}));
        const q = { ...dq, ...(qo[routeKey(r)] || {}) };
        jobs.push(() => one('GET', r, role, v, { query: q }));
      }
    }
  }
  let next = 0;
  const workers = Array.from({ length: 6 }, async () => {
    while (next < jobs.length) {
      const j = jobs[next]; next += 1;
      await j();
    }
  });
  await Promise.all(workers);
  for (const role of USER_ROLES) await ensureSession(role, 'the read sweep');

  // ---- phase 2: creates/updates/actions, then 3: deletes — one at a time so
  // a session a request invalidates is noticed straight after that request.
  for (const [phase, filter] of [['WRITE', (r) => ['post', 'put', 'patch'].includes(r.method)], ['DELETE', (r) => r.method === 'delete']]) {
    resolver.reset();
    for (const r of live.filter(filter)) {
      const key = routeKey(r);
      const vars = await pathVariants(r, resolver, { forWrite: true });
      if (vars[0].label === 'real-unavailable') realMissing.add(key);
      for (const role of ROLES) {
        for (const v of vars) {
          if (!v.path) continue;
          const bodies = [{ bodyLabel: 'empty', body: {} }, { bodyLabel: 'garbage', body: { x: { y: 1 } } }];
          if (valid[key] && ['real', 'static'].includes(v.label) && role !== 'anon' && role !== 'agent') {
            bodies.push({ bodyLabel: 'valid', body: valid[key]() });
          }
          for (const b of bodies) {
            const res = await one(phase, r, role, v, b);
            if (res && res.status >= 200 && res.status < 300 && USER_ROLES.has(role)) {
              for (const rr of USER_ROLES) await ensureSession(rr, `${key} [${role} ${v.label} ${b.bodyLabel}]`);
            }
          }
        }
      }
    }
  }

  for (const k of realMissing) warnings.push(`sweep: no real id could be found for ${k} — only the missing/malformed variants ran`);
  for (const n of sessionNotes) warnings.push(`sweep: ${n}`);
}

// ============================================================ log scan
// Lines that are expected in a sandboxed run and say nothing about the code:
// the outbound calls this run deliberately points at a closed port, the
// optional services it does not configure.
const BENIGN_LOG = [
  /enroll: /,
  /License: serverId/,
  /WARNING: JWT_SECRET/,
  /LICENSE_PUBLIC_KEY from the environment/,
  /discovery: disabled/,
  /geoip/i,
  /agent release key/i,
  /\bSMTP\b|mailer|e-?mail is not configured/i,
  /assistant/i,
  /could not reach .*127\.0\.0\.1:9/,
  /transaction_result from agent \d+ rejected/,
  /device-events: skipped \d+ malformed/,
  /reported a result for unassigned test/,
];
const ERROR_LOG = /\bERROR\b|ER_[A-Z_]+|Unhandled|TypeError|ReferenceError|SyntaxError|RangeError|\bError\b|uncaught/i;

// MySQL's own error texts: whatever level they were logged at, a statement the
// server rejected is a bug in the statement.
const MYSQL_ERROR = /error in your SQL syntax|Unknown column|Table '[^']+' doesn't exist|Incorrect \w+ value|Data too long|cannot be null|Duplicate entry|foreign key constraint fails|Out of range value|Truncated incorrect|Illegal mix of collations|Operand should contain|Column count doesn't match/i;
const ACCESS_LINE = /reqId=\S+ [A-Z]+ \S+ \d{3} [\d.]+ms\s*$/;

function scanLog() {
  const hits = new Map();
  for (const entry of serverLog) {
    const { line } = entry;
    // The per-request access line ("GET /x 503 2.1ms") restates a status the
    // sweep already judged against its own policy; it is not a separate error.
    if (ACCESS_LINE.test(line)) continue;
    if (!ERROR_LOG.test(line)) continue;
    const id = (line.match(/reqId=(vr\d+)/) || [])[1];
    const during = id && requestLabels.has(id) ? requestLabels.get(id) : `${entry.during} (approximate — a background job, or a line without a request id)`;
    const benign = BENIGN_LOG.some((re) => re.test(line)) && !/ER_[A-Z_]+|TypeError|ReferenceError|Unhandled|SyntaxError/.test(line);
    const norm = line.replace(/^\S+Z\s+/, '').replace(/\d+/g, 'N').slice(0, 300);
    const h = hits.get(norm) || { line, count: 0, during, benign, severity: null, stack: entry.stack };
    h.count += 1;
    hits.set(norm, h);
  }
  const all = [...hits.values()];
  for (const h of all) {
    if (/ER_[A-Z_]+|TypeError|ReferenceError|Unhandled|SyntaxError|RangeError/.test(h.line) || MYSQL_ERROR.test(h.line)) h.severity = 'bug';
    else if (/\bERROR\b/.test(h.line) && !h.benign) h.severity = 'error';
    else h.severity = h.benign ? 'benign' : 'warn';
  }
  return all;
}

// ============================================================ main
// Ids the sweep's valid bodies refer to, read once after seeding + ingest.
async function preSweep(S) {
  const col = async (sql) => { try { const [r] = await S.pool.query(sql); return r.map((x) => Object.values(x)[0]); } catch { return []; } };
  S.eventIds = await col('SELECT id FROM event_cases ORDER BY id');
  S.clusterIds = await col('SELECT id FROM event_clusters ORDER BY id');
  S.findingIds = await col('SELECT id FROM findings ORDER BY created_at');
  S.stTestIds = await col('SELECT id FROM service_test_tests ORDER BY id');
  S.profileIds = await col('SELECT id FROM snmp_credential_profiles ORDER BY id');
  const pb = await call('get', '/api/playbooks', { token: S.tokens.admin, label: 'resolve a playbook id' });
  const list = pb.json && (pb.json.playbooks || pb.json);
  S.playbookId = Array.isArray(list) && list[0] ? list[0].id : null;
  const src = await call('get', '/api/nis2/custom-reports/sources', { token: S.tokens.admin, label: 'resolve a NIS2 report source' });
  const sources = src.json && src.json.sources;
  const first = Array.isArray(sources) ? sources[0] : (sources && typeof sources === 'object' ? Object.keys(sources)[0] : null);
  S.nis2Source = first && typeof first === 'object' ? (first.key || first.id || first.source) : first;
  // The throwaway switch is polled by the throwaway agent from here on, so
  // "poll now" reaches a connected agent.
  if (S.devices[1] && S.agents[1]) {
    await seedCall(S, 'reassign throwaway switch', 'admin', 'patch', `/api/snmp-devices/${S.devices[1]}`, { agentId: S.agents[1] });
  }
}

// The throwaway agent stays connected over /ws/agent for the whole sweep and
// answers every command the way a Docker-managed agent does — acknowledged,
// and DECLINED for anything that would change its host. That lets the agent
// command routes (ping, diagnose, update, delete, rekey, install-tool, probe,
// run-test, speedtest, reconnect, burst, poll) run their real paths, including
// the signed-command and audit-row writes, with nothing actually executed.
let fakeAgent = null;
function startFakeAgent(token) {
  let WebSocket;
  try { WebSocket = require(require.resolve('ws', { paths: [ROOT] })); } catch { return null; }
  const state = { stopped: false, commands: 0, connects: 0, refused: null, ws: null, closes: [] };
  const connect = () => {
    if (state.stopped) return;
    const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/agent`, { headers: { Authorization: `Bearer ${token}`, 'X-BlueEye-Protocol': '1' } });
    state.ws = ws;
    ws.on('open', () => { state.connects += 1; });
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.type !== 'command') return;
      state.commands += 1;
      const c = msg.command && typeof msg.command === 'object' ? msg.command : { name: String(msg.command || '') };
      const name = c.name || c.action || c.type || c.command;
      const send = (o) => { try { ws.send(JSON.stringify(o)); } catch { /* closed */ } };
      if (c.id != null) {
        send({ type: 'ack', id: c.id, ok: true, accepted: false, runtime: 'docker', reason: 'docker-managed', agentVersion: '0.39.1', sources: ['proc', 'snmp'], managed: 'docker' });
        send({ type: 'command-result', id: c.id, ok: true,
          diagnostic: { agentVersion: '0.39.1', managed: 'docker', source: 'proc', sources: ['proc'], intervalMs: 60000, lastReportAt: null, collector: null, hsflowd: null },
          evidence: { commandSetVersion: c.commandSetVersion || '1', items: [] },
          snmp: { polled: 0 }, stopped: true });
      }
      if (c.auditId != null) {
        send({ type: 'action-result', auditId: c.auditId, action: name === 'update' ? 'upgrade' : name, ok: false, detail: 'declined by the verify-routes stand-in agent' });
      }
    });
    ws.on('unexpected-response', (req, res) => { state.refused = res.statusCode; state.closes.push(`refused ${res.statusCode} during ${currentLabel}`); if (res.statusCode !== 401) setTimeout(connect, 500); });
    ws.on('close', (code) => {
      state.closes.push(`${code} during ${currentLabel}`);
      if (!state.stopped && state.refused !== 401) setTimeout(connect, 300);
    });
    ws.on('error', () => {});
  };
  connect();
  return { stop() { state.stopped = true; try { state.ws && state.ws.close(); } catch { /* */ } }, state };
}

async function main() {
  const admin = await mysql.createConnection({ host: HOST, port: DB_PORT, user: USER, password: PASSWORD });
  let licens = null;
  let workInfo = null;
  let pool = null;
  let fatal = null;
  try {
    await createAndMigrate(admin);
    pool = mysql.createPool({ host: HOST, port: DB_PORT, user: USER, password: PASSWORD, database: DB, connectionLimit: 4 });

    const features = {};
    for (const k of [...KNOWN_FEATURES, ...ALL_FEATURE_KEYS]) features[k] = true;
    licens = await startFakeLicens({ features });
    workInfo = prepareWorkDir();
    WORK_DIR_RE = new RegExp(workInfo.work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    LEAKS = leakChecks();
    let routes;
    for (let attempt = 1; ; attempt += 1) {
      const port = await freePort();
      baseUrl = `http://127.0.0.1:${port}`;
      console.info(`Booting src/server.js on ${baseUrl} (NODE_ENV=production, cwd ${workInfo.work}) …`);
      try {
        routes = await bootServer({ work: workInfo.work, agentDir: workInfo.agentDir, licens, port });
        break;
      } catch (err) {
        if (attempt >= 3 || !/EADDRINUSE/.test(err.message)) throw err;
        console.info('  the port was taken between the probe and the listen; trying another.');
        serverLog.length = 0;
      }
    }
    console.info(`  ${routes.length} routes registered by the live app.`);
    buildMatchers(routes);

    const S = { tokens: {}, agents: [], agentTokens: [], locations: [], devices: [], transactions: [], apps: [], userIds: [], spareCode: null, pool };
    S.bodies = seedBodies(S);
    try {
      const { SECTIONS } = require(path.join(ROOT, 'src', 'serviceTests', 'settings', 'defaults'));
      S.settingsSection = SECTIONS && SECTIONS[0];
    } catch { S.settingsSection = null; }

    console.info('Seeding through the public API …');
    await seed(S);
    console.info(`  agents ${S.agents.join(',')} · locations ${S.locations.join(',')} · snmp devices ${S.devices.join(',')} · transactions ${S.transactions.join(',')}`);

    console.info('Ingesting as the enrolled agent …');
    await ingest(S);
    await dataCheck(pool);

    // A real Changes key, for DELETE /api/changes/ack/:key.
    const ch = await call('get', '/api/changes', { token: S.tokens.admin, label: 'resolve a Changes key' });
    const findKey = (j, depth = 0) => {
      if (!j || typeof j !== 'object' || depth > 4) return null;
      if (!Array.isArray(j) && typeof j.ackKey === 'string') return j.ackKey;
      for (const v of Object.values(j)) { const k = findKey(v, depth + 1); if (k) return k; }
      return null;
    };
    S.changeKey = findKey(ch.json);
    await directSeeds(S);
    await preSweep(S);
    fakeAgent = startFakeAgent(S.agentTokens[S.agentTokens.length - 1]);

    console.info(`\nSweeping ${ONLY ? `routes matching "${ONLY}"` : 'every route'} × ${ROLES.length} roles …`);
    const resolver = makeResolver(pool, S);
    const t0 = Date.now();
    await sweep(routes, S, resolver);
    console.info(`  ${stats.calls} HTTP calls in ${Math.round((Date.now() - t0) / 1000)} s.`);
  } catch (err) {
    fatal = err;
  } finally {
    currentLabel = 'teardown';
    if (fakeAgent) fakeAgent.stop();
    await stopServer();
    if (licens) await licens.close().catch(() => {});
    if (pool) await pool.end().catch(() => {});
    if (!KEEP) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``).catch(() => {});
      if (workInfo) fs.rmSync(workInfo.work, { recursive: true, force: true });
    } else {
      console.info(`\nVERIFY_ROUTES_KEEP: database ${DB} and ${workInfo && workInfo.work} were kept.`);
    }
    await admin.end().catch(() => {});
  }

  const logHits = scanLog();
  report(logHits, fatal);
  if (fatal && !failures.length && !stats.routesSwept) return 2;
  return failures.length || fatal || logHits.some((h) => h.severity === 'bug' || h.severity === 'error') ? 1 : 0;
}

const logByReqId = new Map();

function report(logHits, fatal) {
  for (const e of serverLog) {
    const id = (e.line.match(/reqId=(vr\d+)/) || [])[1];
    if (id && !ACCESS_LINE.test(e.line)) logByReqId.set(id, e);
  }
  const line = '─'.repeat(78);
  console.info(`\n${line}\nSUMMARY`);
  console.info(`  routes swept: ${stats.routesSwept} · skipped: ${skipped.length} · HTTP calls: ${stats.calls}`);
  console.info(`  calls by phase: ${Object.entries(stats.byPhase).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.info(`  status codes: ${Object.entries(stats.byStatus).sort().map(([k, v]) => `${k}×${v}`).join(' ')}`);
  if (fakeAgent) {
    console.info(`  stand-in agent: ${fakeAgent.state.connects} connection(s), ${fakeAgent.state.commands} command(s) answered${fakeAgent.state.refused ? `, last refusal HTTP ${fakeAgent.state.refused}` : ''}`);
    if (VERBOSE || TRACE) for (const c of fakeAgent.state.closes) console.info(`    closed: ${c}`);
  }

  if (skipped.length) {
    console.info(`\nSkipped routes (${skipped.length}):`);
    for (const s of skipped) console.info(`  ${s.key.padEnd(58)} ${s.reason}`);
  }
  const gaps = [...routeStatuses.entries()]
    .filter(([, st]) => ![...st].some((c) => (c >= 200 && c < 400)))
    .map(([k, st]) => `${k}  [${[...st].sort().join(',')}]`);
  if (gaps.length) {
    console.info(`\nCoverage gaps — routes that never answered 2xx/3xx to any role (${gaps.length}); their happy path was not exercised:`);
    for (const g of gaps.sort()) console.info(`  ${g}`);
  }
  if (warnings.length) {
    console.info(`\nWarnings (${warnings.length}):`);
    for (const w of warnings) console.info(`  - ${w}`);
  }

  const bugs = logHits.filter((h) => h.severity === 'bug' || h.severity === 'error');
  const others = logHits.filter((h) => h.severity === 'warn');
  const benign = logHits.filter((h) => h.severity === 'benign');
  console.info(`\nServer log: ${bugs.length} error line(s), ${others.length} other warning line(s) mentioning errors, ${benign.length} expected/benign.`);
  for (const h of bugs) {
    console.info(`  ERROR ×${h.count}  ${clip(h.line, 260)}\n          first seen during: ${clip(h.during, 200)}`);
    for (const fr of (h.stack || []).filter((x) => x.startsWith('at ')).slice(0, 4)) console.info(`            ${fr.replace(ROOT + '/', '')}`);
  }
  for (const h of others) console.info(`  warn  ×${h.count}  ${clip(h.line, 260)}\n          first seen during: ${clip(h.during, 160)}`);
  if (benign.length && VERBOSE) for (const h of benign) console.info(`  benign ×${h.count}  ${clip(h.line, 200)}`);

  if (failures.length) {
    // Group by route + kind so 40 roles × variants of one bug read as one line.
    const groups = new Map();
    for (const f of failures) {
      const g = `${f.phase} · ${f.kind} · ${f.key || f.path}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(f);
    }
    console.error(`\nFAILURES (${failures.length} calls, ${groups.size} distinct):`);
    for (const [g, list] of groups) {
      const f = list[0];
      const roles = [...new Set(list.map((x) => x.role).filter(Boolean))].join(',');
      const variants = [...new Set(list.map((x) => x.variant).filter(Boolean))].slice(0, 6).join(', ');
      console.error(`  ✗ ${g}  (×${list.length}${roles ? `; roles ${roles}` : ''}${variants ? `; variants ${variants}` : ''})`);
      console.error(`      e.g. ${f.method || ''} ${f.path || ''} as ${f.role || '-'} → ${f.status ?? '-'}: ${clip(f.detail, 400)}`);
      const logged = list.map((x) => x.reqId && logByReqId.get(x.reqId)).find(Boolean);
      if (logged) {
        console.error(`      server log: ${clip(logged.line.replace(/^\S+Z\s+/, ''), 300)}`);
        for (const fr of (logged.stack || []).filter((x) => x.startsWith('at ')).slice(0, 4)) console.error(`        ${fr.replace(ROOT + '/', '')}`);
      }
    }
  }
  if (fatal) console.error(`\nThe run stopped early: ${fatal.stack || fatal.message}`);
  console.info(line);
  if (!failures.length && !fatal && !bugs.length) console.info('All routes answered without a 500 or a leak, and every ingest path landed its rows.');
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`\nVerification could not run: ${err && (err.stack || err.message)}\n`);
  console.error('It needs a MySQL it may create and drop databases on. For example:');
  console.error('  DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD=secret \\');
  console.error('    node scripts/verify-routes-against-mysql.js\n');
  process.exit(2);
});
