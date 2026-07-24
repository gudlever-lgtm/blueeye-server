'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeDiscoveredDevicesRepo, makeAgentsRepo, authHeader } = require('../test-support/fakes');

async function seededRepo() {
  const repo = makeDiscoveredDevicesRepo();
  await repo.upsertCandidate({ ip: '10.0.0.2', hostname: 'printer.lan', openPorts: [80, 443], icmp: true, seenAt: new Date('2026-07-24T10:00:00Z') });
  return repo;
}

test('GET /api/discovery/candidates lists candidates (admin)', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  const res = await request(app).get('/api/discovery/candidates').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.candidates.length, 1);
  assert.equal(res.body.candidates[0].ip, '10.0.0.2');
  assert.equal(res.body.candidates[0].status, 'discovered');
});

test('discovery endpoints require auth → 401', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  assert.equal((await request(app).get('/api/discovery/candidates')).status, 401);
});

test('discovery endpoints are ADMIN-only — viewer AND operator get 403 on every path', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  const paths = [
    ['get', '/api/discovery/candidates'],
    ['get', '/api/discovery/config'],
    ['post', '/api/discovery/scan'],
    ['post', '/api/discovery/candidates/1/promote'],
    ['post', '/api/discovery/candidates/1/ignore'],
  ];
  for (const role of ['viewer', 'operator']) {
    for (const [method, path] of paths) {
      const res = await request(app)[method](path).set('Authorization', authHeader(role)); // eslint-disable-line no-await-in-loop
      assert.equal(res.status, 403, `${role} ${method} ${path} should be 403, got ${res.status}`);
    }
  }
});

test('GET /api/discovery/candidates/:id unknown → 404', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  assert.equal((await request(app).get('/api/discovery/candidates/999').set('Authorization', authHeader('admin'))).status, 404);
});

test('promote unknown candidate → 404', async () => {
  const app = makeApp({ discoveredDevicesRepo: await seededRepo() });
  assert.equal((await request(app).post('/api/discovery/candidates/999/promote').set('Authorization', authHeader('admin'))).status, 404);
});

test('GET /api/discovery/candidates → 500 on store failure', async () => {
  const discoveredDevicesRepo = makeDiscoveredDevicesRepo({ list: async () => { throw new Error('DB down'); } });
  const app = makeApp({ discoveredDevicesRepo });
  assert.equal((await request(app).get('/api/discovery/candidates').set('Authorization', authHeader('admin'))).status, 500);
});

test('a candidate is NOT a monitored device until an admin promotes it', async () => {
  const discoveredDevicesRepo = await seededRepo();
  const created = [];
  const agentsRepo = makeAgentsRepo({
    findById: async () => null,
    insertSnmpDevice: async ({ hostname, host }) => { created.push({ hostname, host }); return 4242; },
  });
  const app = makeApp({ discoveredDevicesRepo, agentsRepo });

  // Before promotion: the candidate exists but NO agent was created for it.
  assert.equal(created.length, 0);
  const cand = discoveredDevicesRepo.rows[0];
  assert.equal(cand.status, 'discovered');
  assert.equal(cand.promoted_agent_id, null);

  // Promote (admin) → creates exactly one SNMP device and flips the candidate.
  const res = await request(app).post(`/api/discovery/candidates/${cand.id}/promote`).set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.agentId, 4242);
  assert.deepEqual(created, [{ hostname: 'printer.lan', host: '10.0.0.2' }]);
  assert.equal(cand.status, 'promoted');
  assert.equal(cand.promoted_agent_id, 4242);

  // Promoting again is idempotent (no second device).
  const again = await request(app).post(`/api/discovery/candidates/${cand.id}/promote`).set('Authorization', authHeader('admin'));
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyPromoted, true);
  assert.equal(created.length, 1);
});

test('ignore marks a candidate ignored (admin)', async () => {
  const discoveredDevicesRepo = await seededRepo();
  const app = makeApp({ discoveredDevicesRepo });
  const id = discoveredDevicesRepo.rows[0].id;
  const res = await request(app).post(`/api/discovery/candidates/${id}/ignore`).set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(discoveredDevicesRepo.rows[0].status, 'ignored');
});
