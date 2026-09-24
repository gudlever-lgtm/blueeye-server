'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// GET /api/coverage — the coverage-gap report over HTTP, and the service that
// gathers its sources (src/coverage/coverageService.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeLocationsRepo, makeSnmpDevicesRepo, authHeader, throwingAsync,
} = require('../test-support/fakes');
const { createCoverageRouter } = require('../src/routes/coverage');
const { createCoverageService, MAX_CREDENTIAL_LOOKUPS } = require('../src/coverage/coverageService');
const { errorHandler, notFoundHandler } = require('../src/middleware/errorHandler');

const NOW = new Date('2026-09-23T12:00:00Z');
const auth = (role) => ({ Authorization: authHeader(role) });

// ============================================================ auth
test('401 without a token', async () => {
  const res = await request(makeApp()).get('/api/coverage');
  assert.equal(res.status, 401);
});

test('403 for viewer and operator: a list of blind spots is admin-only', async () => {
  const app = makeApp();
  for (const role of ['viewer', 'operator']) {
    const res = await request(app).get('/api/coverage').set(auth(role));
    assert.equal(res.status, 403, role);
  }
});

test('200 for admin, with summary, gaps, checks and windows', async () => {
  const res = await request(makeApp()).get('/api/coverage').set(auth('admin'));
  assert.equal(res.status, 200);
  assert.ok(res.body.generatedAt);
  assert.equal(res.body.summary.total, 0);
  assert.deepEqual(res.body.gaps, []);
  assert.ok(res.body.checks.length > 0);
  assert.equal(res.body.limit, 50);
  assert.equal(res.body.windows.flowHours, 24);
});

// ============================================================ validation
test('400 on a limit that is not a whole number in range', async () => {
  const app = makeApp();
  for (const bad of ['abc', '0', '201', '-3', '1.5', '99999']) {
    const res = await request(app).get(`/api/coverage?limit=${encodeURIComponent(bad)}`).set(auth('admin'));
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.error, 'Validation failed');
    assert.ok(res.body.details.limit);
  }
  const twice = await request(app).get('/api/coverage?limit=5&limit=6').set(auth('admin'));
  assert.equal(twice.status, 400);
  const good = await request(app).get('/api/coverage?limit=200').set(auth('admin'));
  assert.equal(good.status, 200);
  assert.equal(good.body.limit, 200);
});

test('404 for a path under the prefix that is not a route', async () => {
  const res = await request(makeApp()).get('/api/coverage/nope').set(auth('admin'));
  assert.equal(res.status, 404);
});

// ============================================================ degradation
test('a repository that throws SKIPS its checks — 200, never 500, never "clean"', async () => {
  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findAll: throwingAsync() }),
    locationsRepo: makeLocationsRepo({ findAll: async () => [{ id: 1, name: 'HQ' }] }),
  });
  const res = await request(app).get('/api/coverage').set(auth('admin'));
  assert.equal(res.status, 200);
  const agentHealth = res.body.checks.find((c) => c.key === 'agentHealth');
  assert.equal(agentHealth.status, 'skipped');
  assert.deepEqual(agentHealth.missing, ['agents']);
  // No site is reported as agent-less on the strength of an agent read that failed.
  assert.ok(!res.body.gaps.some((g) => g.kind === 'siteNoAgent'));
});

test('500 when the report itself fails', async () => {
  const app = express();
  app.use((req, _res, next) => { req.log = { error() {} }; next(); });
  app.use('/api/coverage', createCoverageRouter({ coverageService: { report: throwingAsync('boom') } }));
  app.use(notFoundHandler);
  app.use(errorHandler());
  const res = await request(app).get('/api/coverage').set(auth('admin'));
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

// ============================================================ end to end over the fakes
test('gaps from the real wiring: a site with no agent, an offline agent, an unpolled switch', async () => {
  const snmpDevicesRepo = makeSnmpDevicesRepo();
  await snmpDevicesRepo.create({ host: '10.0.0.2', agentId: null, displayName: 'orphan', locationId: 1 });
  const app = makeApp({
    locationsRepo: makeLocationsRepo({ findAll: async () => [{ id: 1, name: 'HQ' }, { id: 2, name: 'Branch' }] }),
    agentsRepo: makeAgentsRepo({
      findAll: async () => [{
        id: 7, hostname: 'hq-1', platform: 'linux', status: 'offline', location_id: 1, location_name: 'HQ',
        last_seen: '2026-09-20T00:00:00Z', monitor_config: { source: 'sflow' }, capabilities: { ips: ['10.0.0.5'] },
      }],
    }),
    snmpDevicesRepo,
  });
  const res = await request(app).get('/api/coverage').set(auth('admin'));
  assert.equal(res.status, 200);
  const kinds = res.body.gaps.map((g) => g.kind);
  assert.ok(kinds.includes('siteNoAgent'), kinds.join());
  assert.ok(kinds.includes('agentOffline'), kinds.join());
  assert.ok(kinds.includes('deviceNoPoller'), kinds.join());
  const site = res.body.gaps.find((g) => g.kind === 'siteNoAgent');
  assert.deepEqual(site.subject, { id: 2, label: 'Branch' });
  assert.deepEqual(site.link, { view: 'enrollment' });
  assert.ok(res.body.summary.warn >= 3);
});

// ============================================================ the service
test('service: a store that is not wired is "unavailable", one that throws is "failed"', async () => {
  const warnings = [];
  const svc = createCoverageService({
    agentsRepo: { findAll: throwingAsync('db down') },
    logger: { warn: (m) => warnings.push(m) },
    now: () => NOW,
  });
  const r = await svc.report();
  const agentHealth = r.checks.find((c) => c.key === 'agentHealth');
  assert.equal(agentHealth.status, 'skipped');
  const discovery = r.checks.find((c) => c.key === 'discovery');
  assert.deepEqual(discovery.missing, ['discovered']);
  assert.ok(warnings.some((w) => /agents unavailable \(db down\)/.test(w)));
  assert.equal(r.generatedAt, NOW.toISOString());
});

test('service: reads are bounded and windowed', async () => {
  const calls = {};
  const rec = (name, value) => async (arg) => { calls[name] = arg; return value; };
  const svc = createCoverageService({
    agentsRepo: { findAll: async () => [{ id: 1, platform: 'linux', capabilities: { ips: ['10.0.0.5', 7] } }] },
    fdbEntriesRepo: { listUpPortMacs: rec('fdb', []) },
    arpEntriesRepo: { subnetSummary: rec('arp', []), macsForIps: rec('macs', []) },
    lldpNeighborsRepo: { listAll: rec('lldp', []) },
    snmpNeighborsRepo: { listAll: rec('snmpNb', []) },
    deviceInterfacesRepo: { listMacs: rec('ifMacs', []) },
    discoveredDevicesRepo: { list: rec('disc', []), countByStatus: async () => ({ discovered: 3 }) },
    now: () => NOW,
  });
  const r = await svc.report({ limit: 10 });
  assert.equal(calls.fdb.limit, 20000);
  assert.equal(calls.fdb.since.toISOString(), '2026-09-22T12:00:00.000Z');
  assert.equal(calls.arp.since.toISOString(), '2026-09-16T12:00:00.000Z');
  assert.equal(calls.lldp.since.toISOString(), '2026-09-16T12:00:00.000Z');
  assert.ok(calls.snmpNb.limit > 0 && calls.ifMacs.limit > 0);
  assert.deepEqual(calls.macs, ['10.0.0.5'], 'only string IPs are looked up');
  assert.deepEqual(calls.disc, { status: 'discovered', limit: 10 });
  assert.equal(r.summary.byKind.discoveredPending, 3);
});

test('service: a read that comes back at its bound is marked capped', async () => {
  const svc = createCoverageService({
    arpEntriesRepo: { subnetSummary: async ({ limit }) => Array.from({ length: limit }, (_, i) => ({ prefix: `10.9.${i % 250}`, ips: 1 })) },
    agentsRepo: { findAll: async () => [] },
    now: () => NOW,
  });
  const r = await svc.report();
  const subnets = r.checks.find((c) => c.key === 'subnets');
  assert.equal(subnets.status, 'partial');
  assert.deepEqual(subnets.capped, ['arpSubnets']);
});

test('service: credentials are resolved only where the resolver is the answer, and capped', async () => {
  const asked = [];
  const devices = [
    { id: 1, enabled: true, agentId: 4, hasCommunity: true },        // own community: not asked
    { id: 2, enabled: true, agentId: null, hasCommunity: false },    // no poller: not asked
    { id: 3, enabled: false, agentId: 4, hasCommunity: false },      // disabled: not asked
    { id: 4, enabled: true, agentId: 4, hasCommunity: false, locationId: 9, credentialProfileId: null },
    { id: 5, enabled: true, agentId: 4, hasCommunity: false, locationId: 9, credentialProfileId: 2 },
  ];
  const svc = createCoverageService({
    snmpDevicesRepo: { list: async () => devices },
    snmpProfilesRepo: {
      resolveForAgent: async (q) => {
        asked.push(q);
        return q.profileId ? { profileId: null, blocked: 2 } : { profileId: 11, blocked: null };
      },
    },
    now: () => NOW,
  });
  const r = await svc.report();
  assert.deepEqual(asked, [
    { profileId: null, locationId: 9, agentId: 4 },
    { profileId: 2, locationId: 9, agentId: 4 },
  ]);
  const g = r.gaps.filter((x) => x.kind === 'deviceNoCredential');
  assert.deepEqual(g.map((x) => [x.subject.id, x.suggestion]), [[5, 'grantCredential']]);

  // More than the cap: the check says it is partial rather than pretending.
  const many = Array.from({ length: MAX_CREDENTIAL_LOOKUPS + 1 }, (_, i) => ({ id: i + 1, enabled: true, agentId: 1, hasCommunity: false }));
  const big = await createCoverageService({
    snmpDevicesRepo: { list: async () => many },
    snmpProfilesRepo: { resolveForAgent: async () => ({ profileId: 1 }) },
    now: () => NOW,
  }).report();
  assert.equal(big.checks.find((c) => c.key === 'snmpCredentials').status, 'partial');
});
