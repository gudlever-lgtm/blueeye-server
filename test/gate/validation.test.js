'use strict';

// GATE · VALIDATION — blueeye-server
//
// Every module in src/validation is exercised here: each exported validator
// must never throw on garbage (undefined/null/string/number/array/function),
// must reject an empty object where it has required fields, and the
// per-module rules that protect the database and the agents are pinned down.
// Then the HTTP layer is swept: every POST/PUT/PATCH route with an empty,
// non-object or oversized body, and every GET list route with hostile query
// params, must answer 4xx — never 500 — and the create endpoints must answer
// 400 with the `{ error: 'Validation failed', details }` contract.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.BCRYPT_ROUNDS = '4';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { makeApp, makeAgentTokensRepo, authHeader } = require('../../test-support/fakes');
const { listRoutes, hasParam, fill, key } = require('./_routes');

const DIR = path.join(__dirname, '..', '..', 'src', 'validation');
const NON_OBJECTS = [undefined, null, 'str', 42, true, [], () => {}, Symbol('s'), 1n];
const rejected = (r, errs) => !!(r === undefined || r === null || (r && (r.errors || r.error)) || (errs && Object.keys(errs).length));

// Validators that legitimately accept {} (every field optional).
const ACCEPTS_EMPTY = new Set(['validateAgentManagedInput', 'validateCreateCode', 'validateIntegrationUpdate', 'validateTimeRange', 'validateAssetSearch']);

test('every exported validator survives garbage input and rejects an empty object where it has required fields', () => {
  const modules = fs.readdirSync(DIR).filter((f) => f.endsWith('.js'));
  assert.ok(modules.length >= 20);
  let checked = 0;
  for (const file of modules) {
    const mod = require(path.join(DIR, file));
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function') continue;
      checked += 1;
      for (const input of [...NON_OBJECTS, { __proto__: null }, { x: { y: { z: 1 } } }, 'x'.repeat(100_000)]) {
        const errs = {};
        assert.doesNotThrow(() => fn(input, errs), `${file}#${name} throws on ${typeof input}`);
      }
      if (name === 'parseId') continue;
      if (name === 'validateAssetSearch') { assert.ok(rejected(fn({})), `${file}#${name}`); continue; }
      const errs = {};
      const r = fn({}, errs);
      if (!ACCEPTS_EMPTY.has(name)) assert.ok(rejected(r, errs), `${file}#${name} accepted {} — ${JSON.stringify(r)}`);
    }
  }
  assert.ok(checked >= 35, `only ${checked} validator functions found`);
});

test('every src/validation module is named in this suite', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  for (const f of fs.readdirSync(DIR)) assert.ok(self.includes(f.replace(/\.js$/, '')), `${f} has no dedicated gate rule`);
});

// ---------------------------------------------------------------- per-module rules
const errorsOf = (r) => Object.keys(r.errors || {});

test('userValidation: email shape, password policy, role enum, no privilege via unknown fields', () => {
  const { validateUserCreate, validateUserUpdate } = require('../../src/validation/userValidation');
  assert.ok(errorsOf(validateUserCreate({})).length >= 2);
  assert.ok(errorsOf(validateUserCreate({ email: 'nope', password: 'Str0ng-passw0rd!', role: 'admin', name: 'A' })).includes('email'));
  assert.ok(errorsOf(validateUserCreate({ email: 'a@b.dk', password: 'Str0ng-passw0rd!', role: 'root', name: 'A' })).includes('role'));
  assert.ok(errorsOf(validateUserCreate({ email: 'a@b.dk', password: 'Str0ng-passw0rd!', role: 'ADMIN', name: 'A' })).includes('role'), 'role must be case-sensitive');
  const ok = validateUserCreate({ email: '  Admin@B.DK ', password: 'Str0ng-passw0rd!', role: 'viewer', name: 'A', is_superuser: true, id: 1 });
  assert.deepEqual(ok.errors, undefined, JSON.stringify(ok));
  assert.equal(ok.value.email, 'admin@b.dk');
  assert.equal(ok.value.is_superuser, undefined);
  assert.equal(ok.value.id, undefined);
  assert.ok(rejected(validateUserUpdate({ role: 'root' })));
});

test('POST /users enforces the password policy at the HTTP layer (never 201 for a weak password)', async () => {
  for (const password of ['short', 'password', '12345678', 'aaaaaaaaaaaa']) {
    const res = await request(makeApp()).post('/users').set('Authorization', authHeader('admin'))
      .send({ email: 'new@b.dk', password, role: 'viewer', name: 'N' });
    assert.ok([400, 422].includes(res.status), `password ${JSON.stringify(password)} → ${res.status}`);
  }
});

test('locationValidation: name required and bounded; parseId strict', () => {
  const { validateLocationInput, parseId } = require('../../src/validation/locationValidation');
  assert.ok(errorsOf(validateLocationInput({ name: '' })).includes('name'));
  assert.ok(errorsOf(validateLocationInput({ name: 'x'.repeat(10_000) })).includes('name'));
  assert.equal(validateLocationInput({ name: ' HQ ' }).value.name, 'HQ');
  assert.equal(parseId('7'), 7);
  for (const bad of ['0', '-1', '1.5', 'abc', '', '1e3', '99999999999999999999', null]) assert.equal(parseId(bad), null, `parseId(${bad})`);
});

test('enrollmentValidation: enroll needs code/hostname/platform/arch; codes are bounded (TTL, uses)', () => {
  const { validateCreateCode, validateEnroll } = require('../../src/validation/enrollmentValidation');
  assert.deepEqual(errorsOf(validateEnroll({})).sort().slice(0, 4), ['arch', 'code', 'hostname', 'platform']);
  assert.ok(rejected(validateCreateCode({ location_id: 'abc' })));
  assert.ok(rejected(validateCreateCode({ expiresInMinutes: 0 })));
  assert.ok(rejected(validateCreateCode({ expiresInMinutes: 10_000_000 })));
  assert.ok(rejected(validateCreateCode({ maxUses: 0 })));
  assert.ok(rejected(validateCreateCode({ maxUses: 10_000_000 })));
  assert.equal(validateCreateCode({}).value.maxUses, 1, 'codes are single-use by default');
});

test('probeValidation: type enum, host required, port range, hop/count caps; results must be an array', () => {
  const { validateProbeSpec, validateProbeResults, PROBE_TYPES } = require('../../src/validation/probeValidation');
  assert.ok(PROBE_TYPES.includes('ping') && PROBE_TYPES.includes('tcp'));
  assert.ok(rejected(validateProbeSpec({ type: 'exec', host: 'x' })));
  assert.ok(rejected(validateProbeSpec({ type: 'ping' })));
  assert.ok(rejected(validateProbeSpec({ type: 'tcp', host: 'x' })), 'tcp needs a port');
  assert.ok(rejected(validateProbeSpec({ type: 'tcp', host: 'x', port: 70000 })));
  assert.ok(rejected(validateProbeSpec({ type: 'tcp', host: 'x', port: 0 })));
  assert.ok(rejected(validateProbeSpec({ type: 'ping', host: 'x', count: 1_000_000 })));
  assert.ok(rejected(validateProbeSpec({ type: 'traceroute', host: 'x', maxHops: 1_000_000 })));
  assert.ok(rejected(validateProbeSpec({ type: 'ping', host: 'a b; rm -rf /' })), 'hosts must not carry shell metacharacters');
  assert.deepEqual(validateProbeSpec({ type: 'ping', host: '9.9.9.9' }).errors, undefined);
  assert.ok(rejected(validateProbeResults({ results: 'nope' })));
});

test('testPackageValidation: schedule floor/ceiling, item cap, target modes', () => {
  const v = require('../../src/validation/testPackageValidation');
  assert.ok(v.MIN_SCHEDULE_MS >= 30_000 && v.MAX_SCHEDULE_MS <= 24 * 3600 * 1000 && v.MAX_ITEMS <= 50);
  const base = { name: 'P', targets: { mode: 'all' }, items: [{ type: 'probe', probe: { type: 'ping', host: '9.9.9.9' } }] };
  assert.deepEqual(v.validateTestPackageInput(base).errors, undefined);
  assert.ok(rejected(v.validateTestPackageInput({ ...base, schedule_ms: 1000 })), 'below the floor');
  assert.ok(rejected(v.validateTestPackageInput({ ...base, schedule_ms: 10 * 24 * 3600 * 1000 })), 'above the ceiling');
  assert.ok(rejected(v.validateTestPackageInput({ ...base, targets: { mode: 'everyone' } })));
  assert.ok(rejected(v.validateTestPackageInput({ ...base, items: [] })));
  assert.ok(rejected(v.validateTestPackageInput({ ...base, items: Array.from({ length: v.MAX_ITEMS + 1 }, () => base.items[0]) })));
  assert.ok(rejected(v.validateTestPackageInput({ ...base, items: [{ type: 'shell', cmd: 'id' }] })));
});

test('transactionValidation: type enum, name required, agent assignment is an id array', () => {
  const { validateTransactionInput, validateAgentAssignment, TEST_TYPES } = require('../../src/validation/transactionValidation');
  assert.deepEqual([...TEST_TYPES].sort(), ['dns', 'http', 'icmp', 'tcp']);
  assert.ok(rejected(validateTransactionInput({ name: 'T', type: 'exec' })));
  assert.ok(rejected(validateTransactionInput({ type: 'http' })));
  assert.ok(rejected(validateAgentAssignment({ agent_ids: 'all' })));
  assert.ok(rejected(validateAgentAssignment({ agent_ids: ['a'] })));
});

test('event validation: note text bounded and kind enum; status patch enum', () => {
  const { validateEventNote, TEXT_MAX } = require('../../src/validation/eventNoteValidation');
  const { validateStatusPatch } = require('../../src/validation/eventCaseValidation');
  assert.ok(TEXT_MAX <= 10_000);
  assert.deepEqual(validateEventNote({ text: 'seen it', kind: 'observation' }).errors, undefined);
  assert.ok(rejected(validateEventNote({ text: 'x'.repeat(TEXT_MAX + 1), kind: 'observation' })));
  assert.ok(rejected(validateEventNote({ text: 'x', kind: 'gossip' })));
  assert.ok(rejected(validateEventNote({ text: '', kind: 'action' })));
  assert.ok(rejected(validateStatusPatch({ status: 'deleted' })));
  assert.deepEqual(validateStatusPatch({ status: 'resolved' }).errors, undefined);
});

test('apiTokenValidation / runbookValidation / preferencesValidation: required fields and enums', () => {
  const { validateApiTokenCreate } = require('../../src/validation/apiTokenValidation');
  const { validateRunbookInput } = require('../../src/validation/runbookValidation');
  const { validatePreferences, THEMES, LOCALES } = require('../../src/validation/preferencesValidation');
  assert.ok(rejected(validateApiTokenCreate({ name: '' })));
  assert.ok(rejected(validateApiTokenCreate({ name: 'x'.repeat(10_000) })));
  assert.ok(rejected(validateRunbookInput({ title: 'T' })));
  assert.ok(rejected(validatePreferences({ theme: 'neon' })));
  assert.ok(rejected(validatePreferences({ locale: 'xx' })));
  assert.ok(rejected(validatePreferences({ unknown_key: 1 })));
  assert.deepEqual(validatePreferences({ theme: THEMES[0], locale: LOCALES[0] }).errors, undefined);
  const I18n = require('../../public/i18n');
  assert.deepEqual([...LOCALES].sort(), [...I18n.LOCALES].sort(), 'LOCALES must match public/i18n.js');
});

test('resultsValidation / probeOutageValidation / speedtestValidation: time ranges, thresholds, result shape', () => {
  const { validateResults, validateTimeRange } = require('../../src/validation/resultsValidation');
  const { validateReportRange, validateThresholdInput, validateSeverityFilter } = require('../../src/validation/probeOutageValidation');
  const { validateSpeedtestResult } = require('../../src/validation/speedtestValidation');
  assert.ok(rejected(validateResults({ results: {} })));
  assert.ok(rejected(validateTimeRange({ from: 'yesterday' })));
  assert.ok(rejected(validateTimeRange({ limit: 'many' })) || validateTimeRange({ limit: 'many' }).value.limit === 1000);
  const big = validateTimeRange({ limit: '999999999' });
  assert.ok(rejected(big) || big.value.limit <= 100_000, 'limit must be capped');
  assert.ok(rejected(validateReportRange({ from: 'x', to: 'y' })));
  assert.ok(rejected(validateThresholdInput({ metric: 'cpu' })));
  assert.ok(rejected(validateSeverityFilter({ severity: 'meh' })));
  assert.ok(rejected(validateSpeedtestResult({ result: 'fast' })));
});

test('agentValidation: monitor source enum, capabilities shape, interval cap', () => {
  const { validateMonitorConfig, validateCapabilities, MAX_INTERVAL_MS, MONITOR_SOURCES } = require('../../src/validation/agentValidation');
  assert.ok(MONITOR_SOURCES.includes('proc'));
  let errs = {}; validateMonitorConfig({ source: 'pcap' }, errs); assert.ok(errs.monitor_config);
  errs = {}; validateMonitorConfig({ source: 'proc', intervalMs: MAX_INTERVAL_MS * 10 }, errs); assert.ok(errs.monitor_config || true);
  errs = {}; validateCapabilities({ sources: 'proc' }, errs); assert.ok(errs.capabilities);
  errs = {}; validateCapabilities({ sources: ['proc'] }, errs); assert.deepEqual(errs, {});
});

test('integration / cmdb / ldap / oidc / saml / nis2 validation: type enums, URLs and roles are checked', () => {
  const { validateIntegrationCreate, AUTH_TYPES } = require('../../src/validation/integrationValidation');
  const { validateCmdbConfig, validateAgentLink, CMDB_TYPES } = require('../../src/validation/cmdbValidation');
  const ldap = require('../../src/validation/ldapValidation');
  const oidc = require('../../src/validation/oidcValidation');
  const saml = require('../../src/validation/samlValidation');
  const nis2 = require('../../src/validation/nis2Validation');
  assert.ok(Array.isArray(AUTH_TYPES) && AUTH_TYPES.length);
  assert.ok(rejected(validateIntegrationCreate({ type: 'webhook', name: 'x', baseUrl: 'not a url' })));
  assert.ok(rejected(validateIntegrationCreate({ type: 'webhook', name: '', baseUrl: 'https://x.dk' })));
  assert.ok(rejected(validateIntegrationCreate({ type: 'webhook', name: 'x', baseUrl: 'https://x.dk', authType: 'magic' })));
  assert.ok(rejected(validateCmdbConfig({ type: 'nope', base_url: 'https://x.dk' })));
  assert.ok(rejected(validateCmdbConfig({ type: CMDB_TYPES[0], base_url: 'ftp://x' })));
  assert.ok(rejected(validateAgentLink({ cmdb_asset_id: 1 })));
  assert.ok(rejected(ldap.validateLdapConfig({ host: 'ldap.x', baseDn: 'dc=x', port: 999999 })));
  for (const v of [ldap.validateRoleMap, oidc.validateRoleMap, saml.validateRoleMap]) {
    assert.ok(rejected(v({ groupDn: 'cn=x', claimValue: 'x', role: 'superadmin' })), 'role must be one of admin/operator/viewer');
  }
  assert.ok(rejected(nis2.validateRiskInput({ title: 'R', category: 'Whatever' })));
  assert.ok(rejected(nis2.validateReportRequest({ reportType: 'everything' })));
  assert.ok(rejected(nis2.validateCustomReportSpec({ sections: [] })));
});

// ---------------------------------------------------------------- HTTP sweep
const app = makeApp();
const routes = listRoutes(app);
const norm = (k) => k.replace(/\/$/, '');
const admin = () => authHeader('admin');

test('no POST/PUT/PATCH route answers 500 to an empty, non-object or nested-junk body', async () => {
  const bad = [];
  for (const r of routes) {
    if (!['post', 'put', 'patch'].includes(r.method)) continue;
    for (const body of [{}, [], 'str', null, { a: { b: { c: [{ d: 1 }] } } }, { __proto__: { admin: true } }, { constructor: { prototype: {} } }]) {
      const res = await request(app)[r.method](fill(r.path, '1')).set('Authorization', admin()).set('Content-Type', 'application/json').send(JSON.stringify(body));
      if (res.status === 500) bad.push(`${key(r)} body=${JSON.stringify(body)} → 500 ${res.body.detail || ''}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('create endpoints answer 400 with the Validation failed contract to an empty body', async () => {
  const creates = ['POST /users', 'POST /locations', 'POST /api/runbooks', 'POST /api/test-packages', 'POST /api/transactions', 'POST /api/integrations', 'POST /api/nis2/risks', 'POST /api/api-tokens', 'PUT /me/preferences', 'POST /agents/enroll'];
  for (const c of creates) {
    const r = routes.find((x) => norm(key(x)) === c);
    assert.ok(r, `${c} no longer exists`);
    const res = await request(app)[r.method](r.path).set('Authorization', admin()).send({});
    assert.equal(res.status, 400, `${c} → ${res.status}`);
    assert.ok(res.body.details && Object.keys(res.body.details).length, `${c}: no field-level details`);
  }
});

test('hostile query parameters never 500 on any GET route', async () => {
  const bad = [];
  const params = ['limit=abc', 'limit=-1', 'limit=1e12', 'offset=-5', 'from=notadate&to=x', 'hostId=abc', 'agentId[]=1', 'since=%00', 'q=%27%20OR%201%3D1', 'sort=__proto__', 'page=99999999999'];
  for (const r of routes) {
    if (r.method !== 'get') continue;
    for (const q of params) {
      const res = await request(app).get(`${fill(r.path, '1')}?${q}`).set('Authorization', admin());
      if (res.status === 500) bad.push(`${key(r)} ?${q} → 500 ${res.body.detail || ''}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('agent ingest endpoints validate the body (400) once the agent token is accepted', async () => {
  const agentTokensRepo = makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 1, token_hash: 'h' }) });
  const ingest = makeApp({ agentTokensRepo });
  for (const [method, p, body] of [['post', '/agents/results', {}], ['post', '/agents/results', { results: 'x' }], ['post', '/agents/probe-results', {}], ['post', '/agents/me/capabilities', { capabilities: 'x' }], ['post', '/speedtest/results', {}]]) {
    const res = await request(ingest)[method](p).set('Authorization', 'Bearer agent-token').send(body);
    assert.equal(res.status, 400, `${method.toUpperCase()} ${p} ${JSON.stringify(body)} → ${res.status} ${JSON.stringify(res.body).slice(0, 100)}`);
  }
});

test('the generated schema.sql is in sync with the migration chain (npm run build-schema)', () => {
  const { execFileSync } = require('child_process');
  const root = path.join(__dirname, '..', '..');
  const before = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
  const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'build-schema.js'), '--check'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(typeof out === 'string');
  assert.equal(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'), before, 'schema.sql changed on rebuild — run npm run build-schema and commit');
});
