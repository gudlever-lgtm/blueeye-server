'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// 404 and 403 contracts for endpoints the fejlscenarie audit
// (docs/audit/fejlscenarie-audit.md §5.2) found without them.
//
// The gate's 404 sweep covers GET/DELETE routes with an :id. A write route may
// validate the body before it looks the id up, so each one here is asked with a
// body that would otherwise SUCCEED: a 404 is then about the id alone, and a
// route that answered 400 first would fail this file rather than hide.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeSeverityRulesRepo, authHeader,
} = require('../test-support/fakes');

const MISSING = 999999;

const validRisk = {
  title: 'Unpatched VPN gateway', category: 'Vulnerability Management',
  likelihood: 4, impact: 5, owner: 'CISO', status: 'open',
};
const validControl = {
  controlName: 'Quarterly access review', nis2Area: 'Access Control', owner: 'IT',
  frequency: 'quarterly', status: 'OK',
};
const validIncident = { title: 'Phishing wave', severity: 'high', status: 'investigating', nis2Relevant: true };
const validRoleMap = { claimValue: 'blueeye-viewers', role: 'viewer' };

const call = (app, method, path, role, body) => {
  let req = request(app)[method](path);
  if (role) req = req.set('Authorization', authHeader(role));
  return body === undefined ? req : req.send(body);
};

// ============================================================== missing 404
test('POST /agents/:id/run-speedtest: unknown agent is 404 before anything is sent', async () => {
  const sent = [];
  const agentCommander = { sendCommand: (id, cmd) => { sent.push({ id, cmd }); return 1; }, isConnected: () => true };
  const app = makeApp({ agentCommander });
  const res = await call(app, 'post', `/agents/${MISSING}/run-speedtest`, 'operator', {});
  assert.equal(res.status, 404);
  assert.match(res.body.error, /not found/i);
  assert.deepEqual(sent, [], 'no command may reach an agent that does not exist');
  assert.equal((await call(app, 'post', '/agents/abc/run-speedtest', 'operator', {})).status, 400);
  assert.equal((await call(app, 'post', `/agents/${MISSING}/run-speedtest`, 'viewer', {})).status, 403);
  assert.equal((await call(app, 'post', `/agents/${MISSING}/run-speedtest`, null, {})).status, 401);
});

test('POST /agents/:id/run-speedtest: a known agent is dispatched (202) — the 404 is about the id', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async (id) => (id === 7 ? { id: 7, hostname: 'be-7' } : null) });
  const agentCommander = { sendCommand: () => 1, isConnected: () => true };
  const res = await call(makeApp({ agentsRepo, agentCommander }), 'post', '/agents/7/run-speedtest', 'operator', {});
  assert.equal(res.status, 202);
  assert.equal(res.body.agentId, 7);
});

test('POST /api/burst/:id/stop: unknown run is 404', async () => {
  const app = makeApp();
  const res = await call(app, 'post', `/api/burst/${MISSING}/stop`, 'operator', {});
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Burst run not found');
  assert.equal((await call(app, 'post', '/api/burst/abc/stop', 'operator', {})).status, 400);
  assert.equal((await call(app, 'post', `/api/burst/${MISSING}/stop`, 'viewer', {})).status, 403);
});

test('POST /api/diagnose/:id/evaluate: unknown session is 404', async () => {
  const app = makeApp();
  const res = await call(app, 'post', `/api/diagnose/${MISSING}/evaluate`, 'operator', {});
  assert.equal(res.status, 404);
  assert.match(res.body.error, /not found/i);
  assert.equal((await call(app, 'post', '/api/diagnose/abc/evaluate', 'operator', {})).status, 400);
  assert.equal((await call(app, 'post', `/api/diagnose/${MISSING}/evaluate`, 'viewer', {})).status, 403);
});

test('POST /api/discovery/candidates/:id/ignore: unknown candidate is 404 (admin only)', async () => {
  const app = makeApp();
  const res = await call(app, 'post', `/api/discovery/candidates/${MISSING}/ignore`, 'admin', {});
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Candidate not found');
  assert.equal((await call(app, 'post', '/api/discovery/candidates/abc/ignore', 'admin', {})).status, 400);
  assert.equal((await call(app, 'post', `/api/discovery/candidates/${MISSING}/ignore`, 'operator', {})).status, 403);
});

test('PUT /api/nis2/{risks,controls,incidents}/:id: an unknown id is 404 even with a valid body', async () => {
  const app = makeApp();
  for (const [kind, body, label] of [
    ['risks', validRisk, 'Risk'], ['controls', validControl, 'Control'], ['incidents', validIncident, 'Incident'],
  ]) {
    const res = await call(app, 'put', `/api/nis2/${kind}/${MISSING}`, 'operator', body);
    assert.equal(res.status, 404, `${kind} → ${res.status}`);
    assert.equal(res.body.error, `${label} not found`);
    assert.equal((await call(app, 'put', `/api/nis2/${kind}/abc`, 'operator', body)).status, 400, `${kind} bad id`);
    assert.equal((await call(app, 'put', `/api/nis2/${kind}/${MISSING}`, 'viewer', body)).status, 403, `${kind} viewer`);
  }
});

test('POST /api/nis2/reports/:id/approve: an unknown report is 404 (admin), 403 below admin', async () => {
  const app = makeApp();
  const res = await call(app, 'post', `/api/nis2/reports/${MISSING}/approve`, 'admin', {});
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Report not found');
  assert.equal((await call(app, 'post', '/api/nis2/reports/abc/approve', 'admin', {})).status, 400);
  assert.equal((await call(app, 'post', `/api/nis2/reports/${MISSING}/approve`, 'operator', {})).status, 403);
});

test('PUT /api/{oidc,saml}/role-map/:id: an unknown mapping is 404 with a valid body', async () => {
  const app = makeApp();
  for (const p of ['oidc', 'saml']) {
    const res = await call(app, 'put', `/api/${p}/role-map/${MISSING}`, 'admin', validRoleMap);
    assert.equal(res.status, 404, `${p} → ${res.status}`);
    assert.equal(res.body.error, 'Role mapping not found');
    assert.equal((await call(app, 'put', `/api/${p}/role-map/abc`, 'admin', validRoleMap)).status, 400, `${p} bad id`);
    assert.equal((await call(app, 'put', `/api/${p}/role-map/${MISSING}`, 'operator', validRoleMap)).status, 403, `${p} operator`);
    // …and an existing one updates, so the 404 above is about the id alone.
    const created = await call(app, 'post', `/api/${p}/role-map`, 'admin', validRoleMap);
    assert.equal(created.status, 201, `${p} create`);
    const ok = await call(app, 'put', `/api/${p}/role-map/${created.body.id}`, 'admin', { claimValue: 'blueeye-ops', role: 'operator' });
    assert.equal(ok.status, 200, `${p} update`);
  }
});

test('POST /api/severity-rules/:id/apply-to-open: an unknown rule is exactly 404', async () => {
  const app = makeApp({ severityRulesRepo: makeSeverityRulesRepo() });
  const res = await call(app, 'post', `/api/severity-rules/${MISSING}/apply-to-open`, 'admin', { confirm: true });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Rule not found');
  assert.equal((await call(app, 'post', `/api/severity-rules/${MISSING}/apply-to-open`, 'operator', {})).status, 403);
});

// ------------------------------------------------ public agent-binary routes
// A tiny in-memory binary store with the real store's surface (get/status).
function makeBinaryStore(dir, { ready = {}, building = [] } = {}) {
  const fs = require('fs');
  const path = require('path');
  const entries = {};
  for (const [arch, content] of Object.entries(ready)) {
    const p = path.join(dir, `blueeye-agent-${arch}`);
    fs.writeFileSync(p, content);
    entries[arch] = {
      status: 'ready', path: p, size: Buffer.byteLength(content), sha256: 'ab'.repeat(32),
      filename: `blueeye-agent-${arch}`, contentType: 'application/octet-stream',
    };
  }
  return {
    get: (arch) => (Object.prototype.hasOwnProperty.call(entries, arch) ? entries[arch] : null),
    status: () => {
      const arches = {};
      for (const a of ['linux-x64', 'linux-arm64']) {
        arches[a] = entries[a] ? { built: true, sizeMb: 0, sha256: entries[a].sha256 }
          : { built: false, status: building.includes(a) ? 'building' : 'pending', error: null };
      }
      return { ready: building.length === 0, topError: null, arches };
    },
  };
}

test('GET /enroll/agent-binary/:arch is public; with no store it is a JSON 404, and status says unconfigured', async () => {
  const app = makeApp();
  const res = await request(app).get('/enroll/agent-binary/linux-x64');
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.match(res.body.error, /not configured/);
  const st = await request(app).get('/enroll/agent-binary-status');
  assert.equal(st.status, 200);
  assert.deepEqual(st.body, { configured: false });
});

test('GET /enroll/agent-binary/:arch: unknown arch 404, building 503, ready streams the file', async (t) => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = makeApp({ agentBinaryStore: makeBinaryStore(dir, { ready: { 'linux-x64': 'BINARY' }, building: ['linux-arm64'] }) });

  for (const arch of ['win-x64', '..%2F..%2Fetc%2Fpasswd', 'constructor', '__proto__']) {
    const res = await request(app).get(`/enroll/agent-binary/${arch}`);
    assert.equal(res.status, 404, `${arch} → ${res.status}`);
    assert.equal(res.body.error, 'No binary available for this arch');
  }

  const building = await request(app).get('/enroll/agent-binary/linux-arm64');
  assert.equal(building.status, 503);
  assert.equal(building.body.status, 'building');

  const ok = await request(app).get('/enroll/agent-binary/linux-x64').buffer(true).parse((r, cb) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'application/octet-stream');
  assert.equal(ok.headers['x-content-sha256'], 'ab'.repeat(32));
  assert.match(ok.headers['content-disposition'], /blueeye-agent-linux-x64/);
  assert.equal(ok.body.toString(), 'BINARY');

  const st = await request(app).get('/enroll/agent-binary-status');
  assert.equal(st.status, 200);
  assert.equal(st.body.configured, true);
  assert.equal(st.body.arches['linux-x64'].built, true);
  assert.equal(st.body.arches['linux-arm64'].status, 'building');
  assert.equal(st.body.arches['linux-x64'].path, undefined, 'the status never exposes the on-disk path');
});

// ============================================================== missing 403
test('GET /api/audit/actions and /api/audit/export.csv are admin-only (403 for viewer/operator)', async () => {
  const app = makeApp();
  for (const p of ['/api/audit/actions', '/api/audit/export.csv']) {
    assert.equal((await call(app, 'get', p)).status, 401, `${p} anon`);
    for (const role of ['viewer', 'operator']) {
      assert.equal((await call(app, 'get', p, role)).status, 403, `${p} ${role}`);
    }
    assert.equal((await call(app, 'get', p, 'admin')).status, 200, `${p} admin`);
  }
  const csv = await call(app, 'get', '/api/audit/export.csv', 'admin');
  assert.match(csv.headers['content-type'], /text\/csv/);
});

test('GET /api/runbooks/playbooks is admin-only (403 for viewer/operator)', async () => {
  const app = makeApp();
  for (const role of ['viewer', 'operator']) {
    assert.equal((await call(app, 'get', '/api/runbooks/playbooks', role)).status, 403, role);
  }
  assert.equal((await call(app, 'get', '/api/runbooks/playbooks', 'admin')).status, 200);
});

test('GET /api/snmp-profiles/meta and /api/snmp-profiles/:id are admin-only (403 for viewer/operator)', async () => {
  const app = makeApp();
  const created = await call(app, 'post', '/api/snmp-profiles', 'admin', { name: 'Core v2c', version: '2c', community: 'not-public' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  for (const p of ['/api/snmp-profiles/meta', `/api/snmp-profiles/${created.body.profile.id}`]) {
    for (const role of ['viewer', 'operator']) {
      const res = await call(app, 'get', p, role);
      assert.equal(res.status, 403, `${p} ${role}`);
      assert.ok(!JSON.stringify(res.body).includes('not-public'), `${p} ${role} leaks the secret`);
    }
    assert.equal((await call(app, 'get', p, 'admin')).status, 200, `${p} admin`);
  }
});
