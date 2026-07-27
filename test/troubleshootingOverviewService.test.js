'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTroubleshootingOverviewService } = require('../src/troubleshooting/overviewService');

const NOW = new Date('2026-07-27T12:00:00.000Z');
const now = () => NOW;

const l2 = (a, b) => ({ type: 'l2_link', directed: false, source: a, target: b });
const dep = (a, b, dstPort = 443) => ({ type: 'service_dep', directed: true, source: a, target: b, dstPort });

function finding(over = {}) {
  return {
    id: 'f1', hostId: '1', metric: 'link.errors', severity: 'CRIT',
    observed: 10, baseline: 1, deviation: 9, createdAt: '2026-07-27T11:50:00.000Z',
    evidence: [], ...over,
  };
}

// Builds a service over in-memory stubs. Every dep is optional so the
// "domain unavailable" paths are exercised by simply leaving one out.
function makeService(over = {}) {
  const findings = over.findings || [];
  const byId = new Map(findings.map((f) => [f.id, f]));
  const graphCalls = { n: 0 };
  return {
    graphCalls,
    service: createTroubleshootingOverviewService({
      logger: { warn() {} },
      clustersRepo: over.clustersRepo === undefined
        ? { listOpen: async () => over.clusters || [] }
        : over.clustersRepo,
      findingStore: over.findingStore === undefined
        ? {
          get: async (id) => byId.get(id) || null,
          list: async (hostId, from, limit, to, filters = {}) => findings.filter((f) => f.metric === filters.metric),
        }
        : over.findingStore,
      agentsRepo: over.agentsRepo === undefined
        ? { findAll: async () => over.agents || [] }
        : over.agentsRepo,
      blastRadiusService: over.blastRadiusService === undefined
        ? { graph: async () => { graphCalls.n += 1; return over.graph || { nodes: [], edges: [] }; } }
        : over.blastRadiusService,
      topologyChangesRepo: over.topologyChangesRepo === undefined
        ? { list: async () => over.topologyChanges || [] }
        : over.topologyChangesRepo,
      auditEventsRepo: over.auditEventsRepo === undefined
        ? { findAll: async ({ action }) => (over.agentEvents || []).filter((e) => e.action === action) }
        : over.auditEventsRepo,
      discoveredDevicesRepo: over.discoveredDevicesRepo === undefined
        ? { list: async () => over.discovered || [] }
        : over.discoveredDevicesRepo,
    }),
  };
}

test('empty everything returns a well-formed, zeroed payload', async () => {
  const { service } = makeService();
  const out = await service.getOverview({ now });
  assert.deepEqual(out.summary, {
    activeFaults: 0, affectedDevices: 0, rootCauses: 0, anomalies: 0,
    devicesDown: 0, devicesUnreachable: 0,
  });
  assert.deepEqual(out.rootCauses, []);
  assert.deepEqual(out.anomalies, []);
  assert.deepEqual(out.timeline, []);
  assert.deepEqual(out.topology.nodes, []);
  assert.equal(out.partial, false);
  assert.deepEqual(out.failedSources, []);
});

test('window defaults to 24h and is clamped to 7 days', async () => {
  const { service } = makeService();
  const def = await service.getOverview({ now });
  assert.equal(def.window.minutes, 24 * 60);
  assert.equal(def.window.to, NOW.toISOString());

  const clamped = await service.getOverview({ windowMinutes: 99999, now });
  assert.equal(clamped.window.minutes, 7 * 24 * 60);

  const floored = await service.getOverview({ windowMinutes: -5, now });
  assert.equal(floored.window.minutes, 24 * 60);
});

// --- THE contract: N devices collapse to 1 root cause -----------------------
test('a cluster spanning 4 devices yields ONE root cause, not four', async () => {
  const findings = [1, 2, 3, 4].map((h) => finding({ id: `f${h}`, hostId: String(h), severity: h === 1 ? 'CRIT' : 'WARN' }));
  const { service } = makeService({
    findings,
    clusters: [{
      id: 77, status: 'open', confidence: 'high', createdAt: '2026-07-27T11:00:00.000Z',
      detectedAt: '2026-07-27T11:55:00.000Z', memberFindingIds: findings.map((f) => f.id),
      suspectedCommonCause: 'Uplink sw-core-1 down',
    }],
  });
  const out = await service.getOverview({ now });

  assert.equal(out.rootCauses.length, 1);
  const [rc] = out.rootCauses;
  assert.equal(rc.id, 77);
  assert.equal(rc.severity, 'CRIT'); // worst member
  assert.equal(rc.cause, 'Uplink sw-core-1 down');
  assert.deepEqual(rc.affectedDeviceIds, [1, 2, 3, 4]);
  // 4 raw alarms -> 1 cause. That ratio IS the rollup.
  assert.equal(out.summary.activeFaults, 4);
  assert.equal(out.summary.rootCauses, 1);
});

test('blast radius is computed from ONE graph read, not one per device', async () => {
  const findings = [1, 2, 3].map((h) => finding({ id: `f${h}`, hostId: String(h) }));
  const { service, graphCalls } = makeService({
    findings,
    clusters: [{
      id: 1, status: 'open', confidence: 'high', createdAt: NOW, detectedAt: NOW,
      memberFindingIds: findings.map((f) => f.id), suspectedCommonCause: null,
    }],
    agents: [{ id: 1, status: 'offline' }, { id: 2, status: 'offline' }, { id: 3, status: 'online' }],
    graph: { nodes: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 9 }], edges: [l2(1, 9)] },
  });
  const out = await service.getOverview({ now });

  assert.equal(graphCalls.n, 1, 'the topology graph must be read exactly once');
  // Agent 9 sits behind agent 1 and is not itself named by the cause.
  assert.equal(out.rootCauses[0].blastRadiusCount, 1);
  assert.deepEqual(out.rootCauses[0].blastRadius.directlyIsolated, [9]);
});

test('offline agents drive node state and grey out what they isolate', async () => {
  const { service } = makeService({
    agents: [{ id: 1, status: 'offline', hostname: 'core' }, { id: 2, status: 'online', hostname: 'acc' }],
    graph: { nodes: [{ id: 1, label: 'core' }, { id: 2, label: 'acc' }], edges: [l2(1, 2)] },
  });
  const out = await service.getOverview({ now });
  assert.deepEqual(out.topology.counts, { ok: 0, down: 1, unreachable_downstream: 1 });
  assert.equal(out.summary.devicesDown, 1);
  assert.equal(out.summary.devicesUnreachable, 1);
  assert.equal(out.summary.affectedDevices, 2);
});

test('both layers reach the topology panel', async () => {
  const { service } = makeService({
    agents: [{ id: 1, status: 'online' }, { id: 2, status: 'online' }],
    graph: { nodes: [{ id: 1 }, { id: 2 }], edges: [l2(1, 2), dep(2, 1, 5432)] },
  });
  const out = await service.getOverview({ now });
  assert.deepEqual(out.topology.layers, { l2: 1, l3: 1 });
});

test('flow.volume findings become anomalies; other metrics do not', async () => {
  const { service } = makeService({
    findings: [
      finding({
        id: 'fv', metric: 'flow.volume', observed: 2000, baseline: 1000,
        window: ['2026-07-27T11:00:00.000Z', '2026-07-27T12:00:00.000Z'],
        evidence: [{ labels: { src: '1', dst: '2', dstPort: 443 } }],
      }),
      finding({ id: 'cpu', metric: 'cpu' }),
    ],
  });
  const out = await service.getOverview({ now });
  assert.equal(out.anomalies.length, 1);
  assert.equal(out.anomalies[0].linkId, '1->2:443');
  assert.equal(out.anomalies[0].currentVsBaselinePct, 100);
  assert.equal(out.summary.anomalies, 1);
});

test('timeline merges agent lifecycle + topology changes, newest first, with the owning device', async () => {
  const { service } = makeService({
    agentEvents: [
      { id: 11, action: 'agent.offline', actorId: 3, ts: '2026-07-27T11:30:00.000Z', ip: '10.0.0.9' },
      { id: 12, action: 'agent.online', actorId: 3, ts: '2026-07-27T11:00:00.000Z' },
      // Recurring, non-lifecycle activity must never reach the timeline.
      { id: 13, action: 'agent.report', actorId: 3, ts: '2026-07-27T11:45:00.000Z' },
    ],
    topologyChanges: [
      { id: 21, agentId: 5, changeType: 'link_state_changed', severity: 'WARN', summary: 'eth0 down', detectedAt: '2026-07-27T11:40:00.000Z' },
    ],
  });
  const out = await service.getOverview({ now });
  assert.deepEqual(out.timeline.map((e) => e.type), ['topology.link_state_changed', 'agent.offline', 'agent.online']);
  assert.equal(out.timeline[0].agentId, 5);
  assert.equal(out.timeline[1].agentId, 3);
});

test('discovery candidates are excluded unless explicitly requested', async () => {
  const discovered = [{ id: 1, ip: '10.0.0.5', hostname: 'unknown', openPorts: [22], lastSeen: NOW.toISOString() }];
  const { service } = makeService({ discovered });

  const hidden = await service.getOverview({ now });
  assert.deepEqual(hidden.topology.discovered, []);

  const shown = await service.getOverview({ includeDiscovery: true, now });
  assert.equal(shown.topology.discovered.length, 1);
  assert.equal(shown.topology.discovered[0].ip, '10.0.0.5');
  // Candidates are never topology nodes — they have no agent id and no edges.
  assert.deepEqual(shown.topology.nodes, []);
});

// --- partial failure: one dead domain costs one panel ------------------------
test('a failing source is reported, the rest of the screen still renders', async () => {
  const { service } = makeService({
    agents: [{ id: 1, status: 'offline' }],
    graph: { nodes: [{ id: 1 }], edges: [] },
    topologyChangesRepo: { list: async () => { throw new Error('tsdb down'); } },
  });
  const out = await service.getOverview({ now });
  assert.equal(out.partial, true);
  assert.deepEqual(out.failedSources, ['topologyChanges']);
  assert.deepEqual(out.timeline, []);
  // The panels that did not depend on it are intact.
  assert.equal(out.topology.counts.down, 1);
});

test('every source failing still yields a renderable payload', async () => {
  const boom = () => { throw new Error('down'); };
  const { service } = makeService({
    clustersRepo: { listOpen: boom },
    agentsRepo: { findAll: boom },
    blastRadiusService: { graph: boom },
    findingStore: { get: boom, list: boom },
    topologyChangesRepo: { list: boom },
    auditEventsRepo: { findAll: boom },
  });
  const out = await service.getOverview({ now });
  assert.equal(out.partial, true);
  assert.deepEqual(
    out.failedSources.sort(),
    ['agentEvents', 'agents', 'anomalies', 'clusters', 'graph', 'topologyChanges'],
  );
  assert.equal(out.summary.activeFaults, 0);
  assert.deepEqual(out.topology.nodes, []);
});

test('an entirely unwired server (no repos at all) returns empty, not a crash', async () => {
  const service = createTroubleshootingOverviewService({ logger: { warn() {} } });
  const out = await service.getOverview({ now });
  assert.equal(out.partial, false);
  assert.deepEqual(out.rootCauses, []);
  assert.deepEqual(out.topology.nodes, []);
});

test('purged member findings are dropped, the cluster still reports', async () => {
  const { service } = makeService({
    findings: [finding({ id: 'alive', hostId: '2', severity: 'WARN' })],
    clusters: [{
      id: 5, status: 'open', confidence: 'low', createdAt: NOW, detectedAt: NOW,
      memberFindingIds: ['gone', 'alive'], suspectedCommonCause: null,
    }],
  });
  const out = await service.getOverview({ now });
  assert.equal(out.rootCauses.length, 1);
  assert.equal(out.rootCauses[0].severity, 'WARN');
  assert.deepEqual(out.rootCauses[0].affectedDeviceIds, [2]);
});
