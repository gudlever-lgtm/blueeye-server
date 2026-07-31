'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeLldpNeighborsRepo, makeServiceDependenciesRepo,
  makeEventClustersRepo, makeFindingStore, makeTopologyChangesRepo,
  makeDiscoveredDevicesRepo, authHeader,
} = require('../test-support/fakes');

const PATH = '/api/troubleshooting/overview';

// Fleet: 1 —L2— 2 —L2— 3 ; app 4 depends on 3:5432.
const AGENTS = [
  { id: 1, hostname: 'sw-core', status: 'offline', location_id: 1 },
  { id: 2, hostname: 'sw-acc-a', status: 'online', location_id: 1 },
  { id: 3, hostname: 'sw-acc-b', status: 'online', location_id: 1 },
  { id: 4, hostname: 'app-1', status: 'online', location_id: 1 },
];

function agentsRepo(agents = AGENTS) {
  return makeAgentsRepo({
    findAll: async () => agents,
    findById: async (id) => agents.find((a) => a.id === Number(id)) || null,
  });
}

async function topologyRepos() {
  const lldpNeighborsRepo = makeLldpNeighborsRepo();
  await lldpNeighborsRepo.upsert({ localAgentId: 1, localChassisId: 'c1', remoteChassisId: 'c2' });
  await lldpNeighborsRepo.upsert({ localAgentId: 2, localChassisId: 'c2', remoteChassisId: 'c1' });
  await lldpNeighborsRepo.upsert({ localAgentId: 2, localChassisId: 'c2', remoteChassisId: 'c3' });
  await lldpNeighborsRepo.upsert({ localAgentId: 3, localChassisId: 'c3', remoteChassisId: 'c2' });
  const serviceDependenciesRepo = makeServiceDependenciesRepo();
  await serviceDependenciesRepo.upsert({
    srcHostId: 4, dstHostId: 3, dstPort: 5432, bytes: 100, packets: 1, connCount: 1,
    firstSeen: new Date(), lastSeen: new Date(),
  });
  return { lldpNeighborsRepo, serviceDependenciesRepo };
}

// One cluster whose member findings span agents 2 and 3.
async function clusterWithMembers(findingStore, clustersRepo) {
  const a = await findingStore.save({ hostId: '2', metric: 'link.errors', severity: 'CRIT', observed: 9, baseline: 1, deviation: 8, explanation: 'errors up', createdAt: new Date().toISOString() });
  const b = await findingStore.save({ hostId: '3', metric: 'link.errors', severity: 'WARN', observed: 5, baseline: 1, deviation: 4, explanation: 'errors up', createdAt: new Date().toISOString() });
  await clustersRepo.create({
    confidence: 'high', memberFindingIds: [a.id, b.id],
    suspectedCommonCause: 'Uplink sw-core down', detectedAt: new Date(),
  });
  return [a, b];
}

async function fullApp(over = {}) {
  const { lldpNeighborsRepo, serviceDependenciesRepo } = await topologyRepos();
  const findingStore = over.findingStore || makeFindingStore();
  const eventClustersRepo = over.eventClustersRepo || makeEventClustersRepo();
  if (!over.skipCluster) await clusterWithMembers(findingStore, eventClustersRepo);
  return makeApp({
    agentsRepo: agentsRepo(over.agents),
    lldpNeighborsRepo, serviceDependenciesRepo, findingStore, eventClustersRepo,
    ...over.appOverrides,
  });
}

// --- auth / RBAC ------------------------------------------------------------
test('401 without a token', async () => {
  const app = await fullApp();
  assert.equal((await request(app).get(PATH)).status, 401);
});

test('403 for a viewer — aggregating must not widen access', async () => {
  const app = await fullApp();
  const res = await request(app).get(PATH).set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 403);
});

test('200 for operator and admin', async () => {
  const app = await fullApp();
  for (const role of ['operator', 'admin']) {
    const res = await request(app).get(PATH).set('Authorization', authHeader(role));
    assert.equal(res.status, 200, `role ${role}`);
  }
});

// --- 400 --------------------------------------------------------------------
test('400 on an invalid minutes window', async () => {
  const app = await fullApp();
  for (const minutes of ['0', '-1', 'abc', '1.5', '10081']) {
    const res = await request(app).get(`${PATH}?minutes=${minutes}`).set('Authorization', authHeader('operator'));
    assert.equal(res.status, 400, `minutes=${minutes}`);
    assert.match(res.body.error, /minutes/);
  }
});

test('400 on an invalid limit', async () => {
  const app = await fullApp();
  for (const limit of ['0', '-3', 'x', '1001']) {
    const res = await request(app).get(`${PATH}?limit=${limit}`).set('Authorization', authHeader('operator'));
    assert.equal(res.status, 400, `limit=${limit}`);
  }
});

test('an empty query param is treated as absent, not invalid', async () => {
  const app = await fullApp();
  const res = await request(app).get(`${PATH}?minutes=&limit=`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.window.minutes, 1440);
});

// --- 404 --------------------------------------------------------------------
test('404 on an unknown path under the mount', async () => {
  const app = await fullApp();
  for (const path of ['/api/troubleshooting', '/api/troubleshooting/nope', '/api/troubleshooting/overview/1']) {
    const res = await request(app).get(path).set('Authorization', authHeader('operator'));
    assert.equal(res.status, 404, path);
  }
});

test('404 keeps the JSON error contract', async () => {
  const app = await fullApp();
  const res = await request(app).get('/api/troubleshooting/nope').set('Authorization', authHeader('admin'));
  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /json/);
  assert.ok(res.body.error);
});

// --- 500 --------------------------------------------------------------------
test('a dead domain degrades to partial, it does not 500 the screen', async () => {
  const findingStore = makeFindingStore({
    list: async () => { throw new Error('boom'); },
    get: async () => { throw new Error('boom'); },
  });
  const clustersRepo = makeEventClustersRepo({
    listOpen: async () => { throw new Error('boom'); },
  });
  const app = makeApp({
    agentsRepo: agentsRepo(),
    findingStore,
    eventClustersRepo: {
      ...clustersRepo,
      listOpen: () => { throw new Error('synchronous explosion'); },
    },
  });
  const res = await request(app).get(PATH).set('Authorization', authHeader('operator'));
  // The service catches per-source faults; a synchronous throw inside the
  // fan-out is still caught by allSettled, so this must degrade, not 500.
  assert.equal(res.status, 200);
  assert.equal(res.body.partial, true);
});

test('500 when the route hands back a rejecting service', async () => {
  const { createTroubleshootingRouter } = require('../src/routes/troubleshooting');
  const express = require('express');
  const { errorHandler, notFoundHandler } = require('../src/middleware/errorHandler');
  const app = express();
  app.use('/api/troubleshooting', createTroubleshootingRouter({
    overviewService: { getOverview: async () => { throw new Error('aggregation failed'); } },
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  const res = await request(app).get(PATH).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 500);
});

test('503 when the overview service is not wired', async () => {
  const { createTroubleshootingRouter } = require('../src/routes/troubleshooting');
  const express = require('express');
  const app = express();
  app.use('/api/troubleshooting', createTroubleshootingRouter({ overviewService: null }));
  const res = await request(app).get(PATH).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 503);
});

// --- payload contract -------------------------------------------------------
test('the payload carries every block the view needs', async () => {
  const app = await fullApp();
  const res = await request(app).get(PATH).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  const b = res.body;
  assert.deepEqual(Object.keys(b.summary).sort(), [
    'activeFaults', 'affectedDevices', 'anomalies', 'devicesDown', 'devicesUnreachable', 'rootCauses',
  ]);
  assert.ok(Array.isArray(b.topology.nodes));
  assert.ok(Array.isArray(b.topology.links));
  assert.ok(Array.isArray(b.rootCauses));
  assert.ok(Array.isArray(b.anomalies));
  assert.ok(Array.isArray(b.timeline));
  assert.ok(b.window.from && b.window.to);
  assert.equal(b.partial, false);
});

// --- THE headline requirement ----------------------------------------------
test('rollup collapses N affected devices into ONE root cause', async () => {
  const app = await fullApp();
  const res = await request(app).get(PATH).set('Authorization', authHeader('operator'));
  assert.equal(res.body.rootCauses.length, 1);
  const [rc] = res.body.rootCauses;
  assert.deepEqual(rc.affectedDeviceIds, [2, 3]); // two devices…
  assert.equal(rc.severity, 'CRIT'); // …worst member severity
  assert.equal(rc.cause, 'Uplink sw-core down');
  // 2 raw member findings collapsed to 1 cause.
  assert.equal(res.body.summary.activeFaults, 2);
  assert.equal(res.body.summary.rootCauses, 1);
});

test('blast radius names the impact beyond the affected devices', async () => {
  const app = await fullApp();
  const res = await request(app).get(PATH).set('Authorization', authHeader('operator'));
  const [rc] = res.body.rootCauses;
  // Devices 2 and 3 are named; agent 1 (L2) and app 4 (depends on 3) are not.
  assert.ok(rc.blastRadiusCount >= 1, 'expected impact beyond the named devices');
  const beyond = [...rc.blastRadius.directlyIsolated, ...rc.blastRadius.dependencyAffected];
  assert.ok(!beyond.includes(2) && !beyond.includes(3), 'named devices must not be re-counted');
  assert.ok(beyond.includes(4), 'app-1 depends on sw-acc-b and must be in the blast radius');
});

test('an offline agent is down and greys out what it isolates', async () => {
  const app = await fullApp();
  const res = await request(app).get(PATH).set('Authorization', authHeader('operator'));
  const byId = Object.fromEntries(res.body.topology.nodes.map((n) => [n.id, n]));
  assert.equal(byId[1].state, 'down'); // sw-core is offline
  assert.equal(byId[2].state, 'unreachable_downstream'); // behind sw-core
  assert.equal(byId[3].state, 'unreachable_downstream');
  assert.equal(res.body.summary.devicesDown, 1);
});

test('both layers are present and tagged', async () => {
  const app = await fullApp();
  const res = await request(app).get(PATH).set('Authorization', authHeader('operator'));
  assert.ok(res.body.topology.layers.l2 > 0, 'expected L2 links');
  assert.ok(res.body.topology.layers.l3 > 0, 'expected L3 links');
  for (const link of res.body.topology.links) {
    assert.ok(['l2', 'l3'].includes(link.layer));
    assert.ok(['ok', 'down', 'unreachable_downstream'].includes(link.state));
  }
});

test('flow-pair deviations surface as anomalies', async () => {
  const findingStore = makeFindingStore();
  await findingStore.save({
    hostId: '2', metric: 'flow.volume', severity: 'WARN', observed: 4000, baseline: 1000, deviation: 7,
    window: ['2026-07-27T09:00:00.000Z', '2026-07-27T10:00:00.000Z'],
    createdAt: new Date().toISOString(),
    evidence: [{ labels: { src: '2', dst: '4', dstPort: 5432 } }],
  });
  const app = await fullApp({ findingStore });
  const res = await request(app).get(PATH).set('Authorization', authHeader('operator'));
  const anomaly = res.body.anomalies.find((a) => a.linkId === '2->4:5432');
  assert.ok(anomaly, 'expected the flow pair to be listed');
  assert.equal(anomaly.currentVsBaselinePct, 300);
  assert.equal(anomaly.since, '2026-07-27T09:00:00.000Z');
});

test('topology changes reach the timeline as change events', async () => {
  const topologyChangesRepo = makeTopologyChangesRepo();
  await topologyChangesRepo.insert({
    agentId: 2, changeType: 'link_state_changed', severity: 'WARN',
    summary: 'eth0 went down', detectedAt: new Date(),
  });
  const app = await fullApp({ appOverrides: { topologyChangesRepo } });
  const res = await request(app).get(PATH).set('Authorization', authHeader('operator'));
  const event = res.body.timeline.find((e) => e.type === 'topology.link_state_changed');
  assert.ok(event, 'expected the topology change on the timeline');
  assert.equal(event.agentId, 2);
  assert.equal(event.severity, 'WARN');
});

// --- discovery is admin-only ------------------------------------------------
test('discovery candidates are admin-only and never 403 an operator', async () => {
  const discoveredDevicesRepo = makeDiscoveredDevicesRepo();
  await discoveredDevicesRepo.upsertCandidate({ ip: '10.0.0.55', hostname: 'unknown-box', openPorts: [22, 443] });
  const app = await fullApp({ appOverrides: { discoveredDevicesRepo } });

  const operator = await request(app).get(PATH).set('Authorization', authHeader('operator'));
  assert.equal(operator.status, 200);
  assert.deepEqual(operator.body.topology.discovered, []);

  const admin = await request(app).get(PATH).set('Authorization', authHeader('admin'));
  assert.equal(admin.status, 200);
  assert.equal(admin.body.topology.discovered.length, 1);
  assert.equal(admin.body.topology.discovered[0].ip, '10.0.0.55');
});

// --- empty state ------------------------------------------------------------
test('a healthy, empty fleet renders zeros without crashing', async () => {
  const app = makeApp({ agentsRepo: agentsRepo([]) });
  const res = await request(app).get(PATH).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.activeFaults, 0);
  assert.equal(res.body.summary.rootCauses, 0);
  assert.deepEqual(res.body.rootCauses, []);
  assert.deepEqual(res.body.topology.nodes, []);
  assert.equal(res.body.partial, false);
});

test('a narrow window still returns a well-formed payload', async () => {
  const app = await fullApp();
  const res = await request(app).get(`${PATH}?minutes=15&limit=5`).set('Authorization', authHeader('operator'));
  assert.equal(res.status, 200);
  assert.equal(res.body.window.minutes, 15);
});
