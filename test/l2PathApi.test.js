'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// GET /api/topology/l2-path, GET /api/devices/locate and GET
// /api/devices/inventory over HTTP (src/routes/l2Path.js), wired through the
// real app with the repositories of test-support/l2TopologyFixture.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, authHeader, throwingAsync } = require('../test-support/fakes');
const F = require('../test-support/l2TopologyFixture');

const auth = (role) => ({ Authorization: authHeader(role) });
const appWith = (over = {}) => {
  const r = { ...F.repos(), ...over };
  return makeApp({
    agentsRepo: r.agentsRepo,
    locationsRepo: r.locationsRepo,
    snmpDevicesRepo: r.snmpDevicesRepo,
    snmpNeighborsRepo: r.snmpNeighborsRepo,
    deviceInterfacesRepo: r.deviceInterfacesRepo,
    fdbEntriesRepo: r.fdbEntriesRepo,
    counterSamplesRepo: r.counterSamplesRepo,
    arpEntriesRepo: r.arpEntriesRepo,
    discoveredDevicesRepo: r.discoveredDevicesRepo,
    lldpNeighborsRepo: r.lldpNeighborsRepo,
  });
};
const PATH = '/api/topology/l2-path';

// ============================================================ auth
test('401 without a token on all three', async () => {
  const app = makeApp();
  for (const p of [`${PATH}?from=10.1.10.5&to=10.1.10.6`, '/api/devices/locate?q=10.1.10.5', '/api/devices/inventory']) {
    assert.equal((await request(app).get(p)).status, 401, p);
  }
});

test('path and locate are viewer+; the inventory is operator+ (403 for a viewer)', async () => {
  const app = appWith();
  assert.equal((await request(app).get(`${PATH}?from=10.1.10.5&to=10.1.10.6`).set(auth('viewer'))).status, 200);
  assert.equal((await request(app).get('/api/devices/locate?q=10.1.10.5').set(auth('viewer'))).status, 200);
  assert.equal((await request(app).get('/api/devices/inventory').set(auth('viewer'))).status, 403);
  assert.equal((await request(app).get('/api/devices/inventory').set(auth('operator'))).status, 200);
});

// ============================================================ validation
test('400 on missing or malformed endpoints, with the field named', async () => {
  const app = appWith();
  for (const [q, field] of [['', 'from'], ['from=10.1.10.5', 'to'], ['from=10.1.10.5&to=not%20a%20host!', 'to'], ['from=agent:0&to=10.1.10.6', 'from'], ['from=10.1.10.5&to=10.1.10.6&gateway=%3Cx%3E', 'gateway']]) {
    const res = await request(app).get(`${PATH}?${q}`).set(auth('viewer'));
    assert.equal(res.status, 400, q);
    assert.equal(res.body.error, 'Validation failed');
    assert.ok(res.body.details[field], `${q}: ${JSON.stringify(res.body.details)}`);
  }
  assert.equal((await request(app).get('/api/devices/locate').set(auth('viewer'))).status, 400);
  assert.equal((await request(app).get(`/api/devices/locate?q=${'a'.repeat(300)}`).set(auth('viewer'))).status, 400);
  for (const q of ['limit=0', 'limit=201', 'limit=abc', 'offset=-1', 'kind=router', 'q=' + 'x'.repeat(65)]) {
    assert.equal((await request(app).get(`/api/devices/inventory?${q}`).set(auth('admin'))).status, 400, q);
  }
});

// ============================================================ 404 / 503
test('404 names the endpoint nothing knows', async () => {
  const app = appWith();
  const res = await request(app).get(`${PATH}?from=10.1.10.5&to=10.99.0.1`).set(auth('viewer'));
  assert.equal(res.status, 404);
  assert.deepEqual(Object.keys(res.body.details), ['to']);
  const loc = await request(app).get('/api/devices/locate?q=ghost-host').set(auth('viewer'));
  assert.equal(loc.status, 404);
  assert.ok(loc.body.details.q);
});

test('503 for a path when this install has no forwarding table at all', async () => {
  const res = await request(makeApp({ fdbEntriesRepo: null })).get(`${PATH}?from=10.1.10.5&to=10.1.10.6`).set(auth('viewer'));
  assert.equal(res.status, 503);
});

// ============================================================ 500
test('500 when the forwarding table cannot be read — never a silent "not found"', async () => {
  const r = F.repos();
  r.fdbEntriesRepo.findByMac = throwingAsync();
  const app = appWith({ fdbEntriesRepo: r.fdbEntriesRepo });
  const res = await request(app).get(`${PATH}?from=10.1.10.5&to=10.1.10.6`).set(auth('viewer'));
  assert.equal(res.status, 500);
  assert.equal((await request(app).get('/api/devices/locate?q=10.1.10.5').set(auth('viewer'))).status, 500);
  const inv = appWith({ agentsRepo: { findAll: throwingAsync(), findById: async () => null } });
  assert.equal((await request(inv).get('/api/devices/inventory').set(auth('admin'))).status, 500);
});

// ============================================================ 200
test('200: the path, switch by switch, with the evidence', async () => {
  const res = await request(appWith()).get(`${PATH}?from=agent:7&to=10.1.10.6`).set(auth('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.complete, true);
  assert.deepEqual(res.body.segments[0].hops.map((h) => h.name), ['sw-a', 'sw-core', 'sw-b']);
  assert.deepEqual(res.body.vlans, { from: 10, to: 10, shared: true });
  assert.ok(res.body.generatedAt);
});

test('200: a path across a missing LLDP link carries the gap as an uncertainty', async () => {
  const res = await request(appWith()).get(`${PATH}?from=10.1.10.5&to=b8:27:eb:00:00:0d`).set(auth('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.complete, false);
  const u = res.body.uncertainties.find((x) => x.code === 'missingLink');
  assert.ok(u);
  assert.equal(u.evidence.fromName, 'sw-b');
  assert.equal(u.evidence.toName, 'sw-c');
});

test('200: locate and the inventory', async () => {
  const app = appWith();
  const loc = await request(app).get('/api/devices/locate?q=AA-00-00-00-00-0B').set(auth('viewer'));
  assert.equal(loc.status, 200);
  assert.equal(loc.body.location.deviceName, 'sw-b');
  assert.equal(loc.body.location.ifName, 'Gi0/7');
  const inv = await request(app).get('/api/devices/inventory?kind=switch&limit=2').set(auth('operator'));
  assert.equal(inv.status, 200);
  assert.equal(inv.body.items.length, 2);
  assert.equal(inv.body.total, 4);
  assert.ok(inv.body.items.every((i) => i.kind === 'switch'));
});
