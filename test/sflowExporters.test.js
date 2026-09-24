'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// sflow_exporters (migration 128): the repository's statements against a
// scripted pool (scripts/verify-repositories-against-mysql.js checks the SQL
// itself), and the coverage service reading it as the `sflowExporters` source.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { createSflowExportersRepository } = require('../src/repositories/sflowExportersRepository');
const { createCoverageService, SFLOW_EXPORTER_LIMIT } = require('../src/coverage/coverageService');
const { createCoverageRouter } = require('../src/routes/coverage');
const { errorHandler, notFoundHandler } = require('../src/middleware/errorHandler');
const {
  makeAgentsRepo, makeSnmpDevicesRepo, makeSflowExportersRepo, authHeader,
} = require('../test-support/fakes');

function fakePool(handler) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return handler(sql, params); } };
}

const AT = new Date('2026-09-24T10:00:00Z');

test('recordSeen is one upsert that keeps first_seen and moves everything else', async () => {
  const pool = fakePool(() => [{ affectedRows: 3 }]);
  const n = await createSflowExportersRepository({ pool }).recordSeen([
    { agentId: 9, address: '10.14.0.2', deviceId: 5, interfaces: 52 },
    { agentId: 9, address: '10.99.0.1', deviceId: null, interfaces: 2.7 },
    { agentId: null, address: 'x' }, // dropped
    { agentId: 9, address: '' }, // dropped
  ], { at: AT });
  assert.equal(n, 3);
  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO sflow_exporters \(agent_id, address, device_id, interfaces, first_seen, last_seen\)/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE/);
  assert.doesNotMatch(sql, /first_seen\s*=/, 'first_seen is never overwritten');
  assert.deepEqual(params, [9, '10.14.0.2', 5, 52, AT, AT, 9, '10.99.0.1', null, 2, AT, AT]);
});

test('recordSeen: an exporter heard in flow samples only (interfaces: null) never overwrites the port count', async () => {
  const pool = fakePool(() => [{ affectedRows: 1 }]);
  const n = await createSflowExportersRepository({ pool }).recordSeen([
    { agentId: 9, address: '10.14.0.2', deviceId: 5, interfaces: 52 },
    { agentId: 9, address: '10.99.0.7', deviceId: null, interfaces: null },
  ], { at: AT });
  assert.equal(n, 2);
  assert.equal(pool.calls.length, 2, 'one statement per kind');
  assert.match(pool.calls[0].sql, /interfaces = VALUES\(interfaces\)/);
  assert.deepEqual(pool.calls[0].params, [9, '10.14.0.2', 5, 52, AT, AT]);
  assert.doesNotMatch(pool.calls[1].sql, /interfaces\s*=/, 'the heard-only upsert leaves interfaces alone');
  assert.match(pool.calls[1].sql, /device_id\s+= VALUES\(device_id\),\s+last_seen\s+= VALUES\(last_seen\)/);
  assert.deepEqual(pool.calls[1].params, [9, '10.99.0.7', null, 0, AT, AT], 'a new row starts at 0 ports');
});

test('recordSeen with nothing to write issues no statement', async () => {
  const pool = fakePool(() => { throw new Error('no query expected'); });
  assert.equal(await createSflowExportersRepository({ pool }).recordSeen([]), 0);
  assert.equal(await createSflowExportersRepository({ pool }).recordSeen(null), 0);
});

test('listRecent is windowed, newest first, bounded, and maps the row', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /WHERE last_seen >= \?\s+ORDER BY last_seen DESC, id DESC\s+LIMIT \?/);
    assert.deepEqual(params, [AT, 500]);
    return [[{ id: '4', agent_id: '9', address: '10.99.0.1', device_id: null, interfaces: '2', first_seen: AT, last_seen: AT }]];
  });
  const rows = await createSflowExportersRepository({ pool }).listRecent({ since: AT, limit: 500 });
  assert.deepEqual(rows, [{
    id: 4, agentId: 9, address: '10.99.0.1', deviceId: null, interfaces: 2,
    firstSeen: AT.toISOString(), lastSeen: AT.toISOString(),
  }]);
  const pool2 = fakePool((sql, params) => { assert.equal(params[1], 5000, 'limit clamped'); return [[]]; });
  await createSflowExportersRepository({ pool: pool2 }).listRecent({ since: AT, limit: 1e9 });
});

// ------------------------------------------------------------ coverage source
test('the coverage service reads the exporters from the last 24 h, capped, and lists the unregistered one', async () => {
  const agentsRepo = makeAgentsRepo();
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({ host: '10.14.0.2' });
  const sflowExportersRepo = makeSflowExportersRepo();
  await sflowExportersRepo.recordSeen([
    { agentId: 9, address: '10.14.0.2', deviceId: 1, interfaces: 52 },
    { agentId: 9, address: '10.99.0.1', deviceId: null, interfaces: 24 },
  ], { at: new Date(AT.getTime() - 3600_000) });
  let asked = null;
  const spy = { listRecent: async (opts) => { asked = opts; return sflowExportersRepo.listRecent(opts); } };
  const service = createCoverageService({ agentsRepo, snmpDevicesRepo, sflowExportersRepo: spy, now: () => AT });
  const r = await service.report();
  assert.equal(asked.limit, SFLOW_EXPORTER_LIMIT);
  assert.equal(asked.since.getTime(), AT.getTime() - 24 * 3600_000);
  const gaps = r.gaps.filter((g) => g.kind === 'sflowExporterUnregistered');
  assert.deepEqual(gaps.map((g) => g.subject.label), ['10.99.0.1']);
  assert.equal(r.checks.find((c) => c.key === 'sflowExporters').status, 'ok');
});

test('without the exporter store the check is skipped, and a throwing store is "failed", not clean', async () => {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  const none = await createCoverageService({ snmpDevicesRepo, now: () => AT }).report();
  assert.equal(none.checks.find((c) => c.key === 'sflowExporters').status, 'skipped');
  const broken = await createCoverageService({
    snmpDevicesRepo, sflowExportersRepo: { listRecent: async () => { throw new Error('db'); } }, now: () => AT,
  }).report();
  const c = broken.checks.find((x) => x.key === 'sflowExporters');
  assert.equal(c.status, 'skipped');
  assert.ok(c.missing.includes('sflowExporters'), JSON.stringify(c.missing));
});

test('GET /api/coverage carries the new kind through the router (admin)', async () => {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  const sflowExportersRepo = makeSflowExportersRepo();
  await sflowExportersRepo.recordSeen([{ agentId: 9, address: '10.99.0.1', interfaces: 4 }], { at: new Date() });
  const app = express();
  app.use((req, res, next) => { req.user = { id: 1, role: 'admin' }; next(); });
  app.use('/api/coverage', createCoverageRouter({
    coverageService: createCoverageService({ snmpDevicesRepo, sflowExportersRepo }),
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  const res = await request(app).get('/api/coverage').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.byKind.sflowExporterUnregistered, 1);
});
