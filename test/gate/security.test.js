'use strict';

// GATE · SECURITY — blueeye-server
//
// Runs before every branch build (scripts/gate.sh). Instead of testing one
// router at a time it enumerates EVERY registered route (test/gate/_routes.js)
// and sweeps the whole surface: the public allowlist is exact, everything else
// must be 401 without a token and for tampered tokens, viewers may write only
// to an explicit allowlist, no route may 500 on a bad/missing id, and the
// 404/500 bodies, headers, body limits, lockout and static serving all keep
// their contract.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.BCRYPT_ROUNDS = '4';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { makeApp, makeUsersRepo, makeAgentsRepo, makeLocationsRepo, authHeader, throwingAsync } = require('../../test-support/fakes');
const { listRoutes, hasParam, fill, key } = require('./_routes');
const { buildCsp } = require('../../src/middleware/securityHeaders');

const ROOT = path.join(__dirname, '..', '..');

// The ONLY routes that may answer without a user JWT / agent token. Anything
// new must be added here deliberately — the sweep below fails otherwise.
const PUBLIC_ROUTES = new Set([
  'GET /,/index.html',
  'GET /health/',
  'GET /auth/sso',
  'POST /auth/login',
  'GET /auth/oidc/login',
  'GET /auth/oidc/callback',
  'GET /auth/saml/login',
  'POST /auth/saml/callback',
  'GET /auth/saml/metadata',
  'GET /enroll/config',
  'GET /enroll/agent-release-key',
  'GET /enroll/agent-source.tgz',
  'GET /enroll/agent-release',
  'GET /enroll/agent-release.tgz',
  'GET /enroll/uninstall.sh',
  'GET /enroll/agent-binary/:arch',
  'GET /enroll/agent-binary-status',
  'GET /enroll/agent/:platform',
  'GET /enroll/:code/install.sh',
  'GET /enroll/:code/install.ps1',
  'GET /enroll/update.ps1',
  'GET /enroll/uninstall.ps1',
  'POST /agents/enroll',
]);

// Write routes a VIEWER may call (own preferences/password, read-model
// helpers that only compute, liveness pings). Everything else must be 403.
const VIEWER_WRITE_ALLOWED = new Set([
  'POST /auth/change-password',
  'PUT /me/preferences',
  'POST /api/assistant/explain',
  'POST /api/assistant/diagnose-explain',
  'POST /api/assistant/location-summary',
  'POST /api/forecast/',
  'POST /api/changes/seen',
  'POST /api/nis2/custom-reports/preview',
  'POST /api/nis2/custom-reports/export',
  'POST /api/logs/client',
  'POST /agents/:id/ping',
  'POST /agents/:id/diagnose',
]);

const WRITE = new Set(['post', 'put', 'patch', 'delete']);
const app = makeApp();
const routes = listRoutes(app);
const send = (method, p, header, body) => {
  let req = request(app)[method](p);
  if (header) req = req.set('Authorization', header);
  return body === undefined ? req : req.send(body);
};

test('the route inventory is complete enough to trust the sweep', () => {
  assert.ok(routes.length >= 250, `only ${routes.length} routes enumerated`);
  for (const pub of PUBLIC_ROUTES) assert.ok(routes.some((r) => key(r) === pub), `${pub} is listed public but no longer exists`);
  for (const w of VIEWER_WRITE_ALLOWED) assert.ok(routes.some((r) => key(r) === w), `${w} is allowlisted but no longer exists`);
});

// ---------------------------------------------------------------- headers
test('security headers on API, 404 and static responses; CSP keeps the strict directives', async () => {
  for (const p of ['/health', '/nope', '/', '/app.js', '/styles.css', '/api/nope']) {
    const res = await request(app).get(p);
    assert.equal(res.headers['x-frame-options'], 'DENY', p);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(res.headers['referrer-policy'], 'no-referrer', p);
    assert.match(res.headers['strict-transport-security'] || '', /max-age=\d+/, p);
    assert.equal(res.headers['content-security-policy'], buildCsp(), p);
    assert.equal(res.headers['x-powered-by'], undefined, p);
  }
  const csp = buildCsp();
  for (const directive of ["default-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"]) {
    assert.ok(csp.includes(directive), `CSP lost ${directive}`);
  }
  assert.ok(!/script-src[^;]*unsafe-(inline|eval)/.test(csp), 'CSP allows inline/eval scripts');
  assert.ok(!/script-src[^;]*http:/.test(csp), 'CSP allows plain-http scripts');
});

// ---------------------------------------------------------------- auth sweep
test('every route outside the public allowlist answers 401 without credentials', async () => {
  const leaks = [];
  for (const r of routes) {
    const res = await send(r.method, fill(r.path, '1'));
    const isPublic = PUBLIC_ROUTES.has(key(r));
    if (!isPublic && res.status !== 401) leaks.push(`${key(r)} → ${res.status}`);
    if (isPublic && res.status === 401) leaks.push(`${key(r)} is listed public but answers 401`);
  }
  assert.deepEqual(leaks, []);
});

test('tampered tokens (foreign secret, alg=none, expired, garbage, agent token on user routes) are 401 everywhere', async () => {
  const claims = { email: 'admin@blueeye.local', role: 'admin' };
  const forged = {
    foreignSecret: `Bearer ${jwt.sign(claims, 'not-the-secret', { subject: '1', algorithm: 'HS256' })}`,
    algNone: `Bearer ${jwt.sign(claims, '', { subject: '1', algorithm: 'none' })}`,
    expired: `Bearer ${jwt.sign(claims, process.env.JWT_SECRET, { subject: '1', algorithm: 'HS256', expiresIn: -60 })}`,
    garbage: 'Bearer eyJhbGciOiJIUzI1NiJ9.garbage.garbage',
    basic: 'Basic YWRtaW46YWRtaW4=',
  };
  const protectedRoutes = routes.filter((r) => !PUBLIC_ROUTES.has(key(r)));
  for (const [kind, header] of Object.entries(forged)) {
    const bad = [];
    for (const r of protectedRoutes) {
      const res = await send(r.method, fill(r.path, '1'), header);
      if (res.status !== 401) bad.push(`${key(r)} → ${res.status}`);
    }
    assert.deepEqual(bad, [], `${kind} accepted somewhere`);
  }
});

test('a user JWT is not an agent credential: agent-token routes refuse it', async () => {
  for (const [method, p] of [['post', '/agents/results'], ['post', '/agents/probe-results'], ['post', '/agents/me/capabilities'], ['get', '/agents/me/config'], ['post', '/speedtest/results']]) {
    const res = await send(method, p, authHeader('admin'), {});
    assert.equal(res.status, 401, `${method.toUpperCase()} ${p} accepted a user JWT → ${res.status}`);
  }
});

test('viewers can only write where the allowlist says so (403 everywhere else)', async () => {
  const bad = [];
  for (const r of routes) {
    if (!WRITE.has(r.method) || PUBLIC_ROUTES.has(key(r))) continue;
    const res = await send(r.method, fill(r.path, '1'), authHeader('viewer'), {});
    const allowed = VIEWER_WRITE_ALLOWED.has(key(r));
    // 401 = an agent-token route that does not accept user JWTs at all — fine.
    if (!allowed && res.status !== 403 && res.status !== 401) bad.push(`${key(r)} → ${res.status} (viewer should get 403)`);
    if (allowed && res.status === 403) bad.push(`${key(r)} is allowlisted for viewers but answers 403`);
  }
  assert.deepEqual(bad, []);
});

test('operators never reach admin-only administration routes', async () => {
  const adminOnly = ['/users', '/api/api-tokens', '/api/audit-log', '/api/integrations', '/api/ldap', '/api/oidc', '/api/saml', '/api/settings/cmdb', '/api/discovery', '/api/logs', '/api/diagnostics'];
  const bad = [];
  for (const r of routes) {
    if (!adminOnly.some((p) => r.path === p || r.path.startsWith(`${p}/`))) continue;
    if (key(r) === 'POST /api/logs/client') continue; // client-side error reporting is open to every signed-in user
    const res = await send(r.method, fill(r.path, '1'), authHeader('operator'), {});
    if (res.status !== 403) bad.push(`${key(r)} → ${res.status}`);
  }
  assert.deepEqual(bad, []);
});

test('a mustChangePassword token is locked to the password-change routes', async () => {
  const header = authHeader('admin', { id: 5, email: 'newuser@acme.dk', mustChangePassword: true });
  const bad = [];
  for (const r of routes) {
    if (PUBLIC_ROUTES.has(key(r)) || /^\/(me|auth\/change-password|health)/.test(r.path)) continue;
    const res = await send(r.method, fill(r.path, '1'), header, {});
    // 401 = agent-token route (user JWTs are not accepted there at all).
    if (res.status !== 403 && res.status !== 401) bad.push(`${key(r)} → ${res.status}`);
    else if (res.status === 403 && res.body.error !== 'password_change_required') bad.push(`${key(r)} → 403 but not the password gate`);
  }
  assert.deepEqual(bad, []);
  assert.notEqual((await send('get', '/me', header)).status, 403, '/me must stay reachable to finish the password change');
});

// ---------------------------------------------------------------- 404 / 500
test('404 is JSON and identical for unknown API paths and unknown static paths', async () => {
  for (const p of ['/nope', '/api/nope', '/api/agents/1/nope', '/nope/<script>x</script>']) {
    const res = await request(app).get(p);
    assert.equal(res.status, 404, p);
    assert.match(res.headers['content-type'], /application\/json/, p);
    assert.equal(res.body.error, 'Not Found');
  }
});

test('a missing id is 404 on every GET/DELETE route with an id (never 200, never 500)', async () => {
  const bad = [];
  for (const r of routes) {
    if (!hasParam(r.path) || !['get', 'delete'].includes(r.method) || PUBLIC_ROUTES.has(key(r))) continue;
    const res = await send(r.method, fill(r.path, '999999'), authHeader('admin'));
    if (res.status !== 404) bad.push(`${key(r)} → ${res.status}`);
  }
  assert.deepEqual(bad, []);
});

test('a non-numeric id never produces a 500 on any route', async () => {
  const bad = [];
  for (const r of routes) {
    if (!hasParam(r.path)) continue;
    for (const id of ['abc', '1;DROP', '../..', '%00', '-1', '1e309']) {
      const res = await send(r.method, fill(r.path, id), authHeader('admin'), {});
      if (res.status >= 500 && res.status !== 503) bad.push(`${key(r)} id=${id} → ${res.status}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('a repository failure is a generic 500 with no detail in production', async () => {
  const boom = throwingAsync('SELECT * FROM users failed: ECONNREFUSED 10.0.0.5:3306');
  const failing = makeApp({
    usersRepo: makeUsersRepo({ list: boom, findAll: boom }),
    agentsRepo: makeAgentsRepo({ list: boom, findAll: boom }),
    locationsRepo: makeLocationsRepo({ list: boom, findAll: boom }),
  });
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    for (const p of ['/users', '/agents', '/locations']) {
      const res = await request(failing).get(p).set('Authorization', authHeader('admin'));
      assert.equal(res.status, 500, `${p} → ${res.status}`);
      assert.deepEqual(res.body, { error: 'Internal Server Error' }, `${p} leaks detail`);
      assert.ok(!res.text.includes('ECONNREFUSED') && !res.text.includes('10.0.0.5'), `${p} leaks infrastructure detail`);
    }
  } finally {
    process.env.NODE_ENV = prev;
  }
});

// ---------------------------------------------------------------- body parsing
test('malformed JSON → 400, oversized JSON → 413, non-object JSON → 400 (never 500)', async () => {
  const admin = authHeader('admin');
  const malformed = await request(app).post('/locations').set('Authorization', admin).set('Content-Type', 'application/json').send('{"name": ');
  assert.equal(malformed.status, 400);
  assert.ok(!/position \d+|Unexpected token/.test(malformed.text), 'parser internals leaked');

  const huge = await request(app).post('/locations').set('Authorization', admin).set('Content-Type', 'application/json').send(JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 100) }));
  assert.equal(huge.status, 413);

  for (const r of routes) {
    if (!['post', 'put', 'patch'].includes(r.method) || PUBLIC_ROUTES.has(key(r))) continue;
    for (const body of ['[]', '"str"', 'null', '123']) {
      const res = await request(app)[r.method](fill(r.path, '1')).set('Authorization', admin).set('Content-Type', 'application/json').send(body);
      assert.ok(res.status !== 500, `${key(r)} body ${body} → 500`);
    }
  }
});

// ---------------------------------------------------------------- login
test('login: 400 on missing fields, indistinguishable 401s, lockout 429 after 5 failures, no hash in the response', async () => {
  const { hashPassword } = require('../../src/auth/password');
  const hash = await hashPassword('Correct-horse-1');
  const user = { id: 1, email: 'admin@blueeye.local', role: 'admin', password_hash: hash, name: 'A' };
  const login = makeApp({ usersRepo: makeUsersRepo({ findByEmailWithHash: async (email) => (email === user.email ? user : null) }) });
  assert.equal((await request(login).post('/auth/login').send({})).status, 400);
  const unknown = await request(login).post('/auth/login').send({ email: 'nobody@x.dk', password: 'x' });
  const wrong = await request(login).post('/auth/login').send({ email: user.email, password: 'wrong' });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(unknown.body, wrong.body, 'account enumeration via body');
  const ok = await request(login).post('/auth/login').send({ email: user.email, password: 'Correct-horse-1' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.ok(!ok.text.includes(hash), 'hash leaked');
  // A success resets the counter; five fresh failures then lock the account.
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await request(login).post('/auth/login').send({ email: user.email, password: 'wrong' })).status, 401);
  }
  const locked = await request(login).post('/auth/login').send({ email: user.email, password: 'Correct-horse-1' });
  assert.equal(locked.status, 429, 'correct password must still be refused while locked');
  assert.ok(locked.headers['retry-after']);
});

// ---------------------------------------------------------------- static files
test('static serving never escapes public/ and never serves dotfiles, schema or config', async () => {
  for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/schema.sql', '/..%5c..%5c.env', '/.env', '/.git/config', '/package.json', '/schema.sql', '/src/config.js', '/test-support/fakes.js']) {
    const res = await request(app).get(p);
    assert.ok([400, 403, 404].includes(res.status), `${p} → ${res.status}`);
    assert.ok(!res.text.includes('"name": "blueeye-server"') && !res.text.includes('CREATE TABLE'), `${p} served repository content`);
  }
});

// ---------------------------------------------------------------- secrets
test('weak or placeholder JWT secrets are flagged and production refuses them', () => {
  const CONFIG_PATH = require.resolve('../../src/config');
  const load = (secret) => {
    const prev = process.env.JWT_SECRET;
    if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
    delete require.cache[CONFIG_PATH];
    try { return require('../../src/config').config; } finally { process.env.JWT_SECRET = prev; delete require.cache[CONFIG_PATH]; }
  };
  for (const weak of [undefined, 'short', 'change-me-to-a-long-random-string', process.env.JWT_SECRET]) {
    assert.equal(load(weak).auth.weakSecret, true, `expected weak: ${weak}`);
  }
  assert.equal(load('q9Zr7X2vK4nB8wL0tY3cH5jD1gU6eA2sPqWkRfM').auth.weakSecret, false);
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  assert.match(serverSrc, /weakSecret[\s\S]{0,600}process\.exit\(1\)/, 'server.js no longer refuses a weak secret');
});

test('no private keys or vendor tokens are committed in tracked source', () => {
  let files;
  try { files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return; }
  const offenders = [];
  for (const f of files) {
    if (!/\.(js|json|sql|md|sh|ps1|yml|yaml|env|example|txt)$/.test(f) && !path.basename(f).startsWith('.env')) continue;
    if (/vector\.json$/.test(f) || /^(test|test-support)\//.test(f)) continue; // test fixtures carry throwaway keys
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text)) offenders.push(`${f}: private key`);
    if (/(ghp|github_pat)_[A-Za-z0-9_]{20,}/.test(text)) offenders.push(`${f}: GitHub token`);
    if (/AKIA[0-9A-Z]{16}/.test(text)) offenders.push(`${f}: AWS key`);
    if (/xox[bp]-[0-9A-Za-z-]{20,}/.test(text)) offenders.push(`${f}: Slack token`);
  }
  assert.deepEqual(offenders, []);
});

test('.env.example carries placeholders only, and .env is git-ignored', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.env$/m);
  const example = path.join(ROOT, '.env.example');
  if (!fs.existsSync(example)) return;
  const text = fs.readFileSync(example, 'utf8');
  const secretLines = text.split('\n').filter((l) => /^(JWT_SECRET|DB_PASSWORD|SMTP_PASSWORD|LICENSE_KEY)=/.test(l));
  for (const l of secretLines) {
    const value = l.split('=').slice(1).join('=').trim();
    assert.ok(value === '' || /change|example|placeholder|your|xxx|<|>/i.test(value), `.env.example ships a real-looking value: ${l}`);
  }
});
