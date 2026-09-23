'use strict';

// The agent-offline background job (src/health/agentOfflineMonitor.js):
// periodic stale sweep, ONE finding per offline episode past the grace period
// (with the verdict and its evidence), the same publish/event/alert path the
// probe pipeline uses, and resolving what it opened when the agent returns.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAgentOfflineMonitor, METRIC } = require('../src/health/agentOfflineMonitor');
const { makeFindingStore } = require('../test-support/fakes');

const T0 = Date.parse('2026-09-23T10:00:00.000Z');
const MIN = 60 * 1000;

function harness({ agents, now = T0, over = {} } = {}) {
  const clock = { t: now };
  const rows = agents.map((a) => ({ ...a }));
  const calls = { sweep: [], audit: [], notify: [], published: [], assigned: [], dispatched: [], emitted: [], resolved: [], auditLog: [] };
  const cases = new Map();
  let caseSeq = 0;
  const agentsRepo = {
    findAll: async () => rows.map((r) => ({ ...r })),
    sweepStaleOffline: async (args) => { calls.sweep.push(args); return over.flipped || []; },
    peerProbesTowards: over.peerProbesTowards || (async () => []),
  };
  const findingStore = makeFindingStore();
  const eventCaseService = {
    assignFinding: async (f) => {
      calls.assigned.push(f);
      caseSeq += 1;
      const at = new Date(f.createdAt).toISOString();
      cases.set(caseSeq, { id: caseSeq, status: 'open', primaryFindingId: f.id, firstEventAt: at, lastEventAt: at });
      return { eventCaseId: caseSeq, created: true };
    },
  };
  const eventCasesRepo = {
    findById: async (id) => (cases.has(id) ? { ...cases.get(id) } : null),
    updateStatus: async (id, { from, to }) => {
      const c = cases.get(id);
      if (!c || c.status !== from) return false;
      c.status = to;
      calls.resolved.push(id);
      return true;
    },
  };
  const monitor = createAgentOfflineMonitor({
    agentsRepo,
    findingStore,
    eventCaseService,
    eventCasesRepo,
    auditLogRepo: { record: async (r) => { calls.auditLog.push(r); } },
    auditEventsRepo: { record: async (r) => { calls.audit.push(r); } },
    notifyDashboard: (m) => calls.notify.push(m),
    publishFinding: (hostId, m) => calls.published.push({ hostId, m }),
    dispatcher: { dispatch: async (f) => { calls.dispatched.push(f); } },
    alertingEnabled: () => true,
    integrationTrigger: { emitFinding: async (f) => { calls.emitted.push(f); } },
    graceMs: 5 * MIN,
    maxAgeMs: 24 * 60 * MIN,
    now: () => clock.t,
    ...over.deps,
  });
  return { monitor, rows, calls, findingStore, cases, clock };
}

const offline = (id, sinceMs, extra = {}) => ({
  id, hostname: `h${id}`, status: 'offline', last_seen: new Date(sinceMs).toISOString(), location_id: null, ...extra,
});
const online = (id, extra = {}) => ({ id, hostname: `h${id}`, status: 'online', last_seen: new Date(T0).toISOString(), location_id: null, ...extra });

test('the sweep runs every tick, skips live sockets, and audits + pushes each flip', async () => {
  const h = harness({
    agents: [online(1)],
    over: { flipped: [4, 9], deps: { connectedAgentIds: () => [1, '2'], staleOfflineSec: 240 } },
  });
  const out = await h.monitor.runOnce();
  assert.deepEqual(out.flipped, [4, 9]);
  assert.deepEqual(h.calls.sweep, [{ olderThanSec: 240, exceptIds: [1, 2] }]);
  assert.deepEqual(h.calls.notify.map((m) => m.payload), [{ agentId: 4, status: 'offline' }, { agentId: 9, status: 'offline' }]);
  assert.deepEqual(h.calls.audit.map((a) => [a.actorId, a.action]), [[4, 'agent.offline'], [9, 'agent.offline']]);
});

test('no finding inside the grace period', async () => {
  const h = harness({ agents: [offline(1, T0 - 4 * MIN)] });
  const out = await h.monitor.runOnce();
  assert.deepEqual(out.raised, []);
  assert.equal(h.findingStore.rows.length, 0);
});

test('past the grace period: ONE finding, through store → publish → event → dispatch → integrations', async () => {
  const h = harness({ agents: [offline(1, T0 - 6 * MIN), online(2)] });
  const out = await h.monitor.runOnce();
  assert.equal(out.raised.length, 1);
  const [f] = h.findingStore.rows;
  assert.equal(f.hostId, '1');
  assert.equal(f.metric, METRIC);
  assert.equal(f.kind, 'THRESHOLD');
  assert.equal(f.observed, 6);
  assert.equal(f.baseline, 5);
  assert.ok(f.explanation.includes('h1 has been offline for 6 min'));
  assert.equal(f.evidence[0].verdict, 'unknown');
  assert.equal(f.evidence[0].checks.length, 4);
  assert.equal(h.calls.published.length, 1);
  assert.equal(h.calls.published[0].m.type, 'finding');
  assert.equal(h.calls.assigned.length, 1);
  assert.equal(h.calls.dispatched.length, 1);
  assert.equal(h.calls.emitted.length, 1);

  // The next tick, and the one after, do not raise again.
  h.clock.t += MIN;
  await h.monitor.runOnce();
  h.clock.t += MIN;
  await h.monitor.runOnce();
  assert.equal(h.findingStore.rows.length, 1);
  assert.equal(h.calls.dispatched.length, 1);
});

test('dedup is durable: a finding already stored for this episode is not raised again after a restart', async () => {
  const h = harness({ agents: [offline(1, T0 - 10 * MIN)] });
  await h.findingStore.save({ hostId: '1', metric: METRIC, createdAt: new Date(T0 - 4 * MIN).toISOString(), evidence: [{ verdict: 'unknown' }] });
  const out = await h.monitor.runOnce();
  assert.deepEqual(out.raised, []);
  assert.equal(h.findingStore.rows.length, 1);
});

test('agents never seen, long abandoned, or not offline are left alone', async () => {
  const h = harness({
    agents: [
      { id: 1, hostname: 'never', status: 'offline', last_seen: null },
      offline(2, T0 - 3 * 24 * 60 * MIN),
      online(3, { last_seen: new Date(T0 - 60 * MIN).toISOString() }),
    ],
  });
  const out = await h.monitor.runOnce();
  assert.deepEqual(out.raised, []);
});

test('an agent with a live socket here is never raised, whatever its row says', async () => {
  const h = harness({ agents: [offline(1, T0 - 10 * MIN)], over: { deps: { connectedAgentIds: () => [1] } } });
  const out = await h.monitor.runOnce();
  assert.deepEqual(out.raised, []);
});

test('the verdict uses the site peers and the other agents\' probes', async () => {
  const h = harness({
    agents: [
      offline(1, T0 - 6 * MIN, { location_id: 3, location_name: 'Aarhus', capabilities: { ips: ['10.0.0.1'] } }),
      online(2, { location_id: 3 }),
    ],
    over: {
      peerProbesTowards: async ({ targets, excludeAgentId, from }) => {
        assert.deepEqual(targets, ['10.0.0.1', 'h1']);
        assert.equal(excludeAgentId, 1);
        assert.equal(from.getTime(), T0 - 6 * MIN);
        return [{ agentId: 2, agentName: 'h2', type: 'ping', target: '10.0.0.1', ok: true, ts: new Date(T0 - MIN).toISOString() }];
      },
    },
  });
  await h.monitor.runOnce();
  const [f] = h.findingStore.rows;
  assert.equal(f.evidence[0].verdict, 'agent_process_down');
  const checks = Object.fromEntries(f.evidence[0].checks.map((c) => [c.check, c.result]));
  assert.equal(checks.site, 'peers_online');
  assert.equal(checks.peer_probes, 'reachable');
});

test('switch-port evidence: IP → MAC (ARP) → access port (FDB) → oper status + link.down', async () => {
  const deps = {
    arpEntriesRepo: { findByIp: async ({ ip }) => (ip === '10.0.0.1' ? [{ agentId: 2, ip, mac: 'AA-BB-CC-DD-EE-01' }] : []) },
    fdbEntriesRepo: {
      findByMac: async (mac) => {
        assert.equal(mac, 'aa:bb:cc:dd:ee:01');
        return [
          // The uplink on the core switch learns it too — many MACs behind it.
          { deviceId: 9, deviceName: 'core', ifName: 'Te1/1', portMacCount: 300, lastSeen: new Date(T0).toISOString() },
          { deviceId: 5, deviceName: 'sw-a', ifName: 'Gi1/0/7', portMacCount: 1, lastSeen: new Date(T0 - MIN).toISOString() },
        ];
      },
    },
    deviceInterfacesRepo: {
      listForDevice: async (id) => (id === 5 ? [{ ifName: 'Gi1/0/7', operStatus: 'up', adminStatus: 'up', lastSeen: new Date(T0 - 20 * MIN).toISOString() }] : []),
    },
    deviceEventsRepo: {
      listForDevice: async () => [{ eventType: 'link.down', ifname: 'gi1/0/7', receivedAt: new Date(T0 - 6 * MIN).toISOString() }],
    },
  };
  const h = harness({ agents: [offline(1, T0 - 6 * MIN, { capabilities: { ips: ['10.0.0.1'] } })], over: { deps } });
  await h.monitor.runOnce();
  const [f] = h.findingStore.rows;
  assert.equal(f.evidence[0].verdict, 'switch_port_down');
  const port = f.evidence[0].checks.find((c) => c.check === 'switch_port');
  assert.equal(port.result, 'down');
  assert.equal(port.data.device, 'sw-a');
  assert.equal(port.data.port, 'Gi1/0/7');
});

test('a link.up after the link.down means the port is not down', async () => {
  const deps = {
    arpEntriesRepo: { findByIp: async () => [{ agentId: 2, mac: 'aa:bb:cc:dd:ee:01' }] },
    fdbEntriesRepo: { findByMac: async () => [{ deviceId: 5, deviceName: 'sw-a', ifName: 'Gi1/0/7', portMacCount: 1 }] },
    deviceInterfacesRepo: { listForDevice: async () => [] },
    deviceEventsRepo: {
      listForDevice: async () => [ // newest first
        { eventType: 'link.up', ifname: 'Gi1/0/7', receivedAt: new Date(T0 - 2 * MIN).toISOString() },
        { eventType: 'link.down', ifname: 'Gi1/0/7', receivedAt: new Date(T0 - 6 * MIN).toISOString() },
      ],
    },
  };
  const h = harness({ agents: [offline(1, T0 - 6 * MIN, { capabilities: { ips: ['10.0.0.1'] } })], over: { deps } });
  await h.monitor.runOnce();
  const port = h.findingStore.rows[0].evidence[0].checks.find((c) => c.check === 'switch_port');
  assert.notEqual(port.result, 'down');
});

test('an evidence source that throws costs that check, never the finding', async () => {
  const deps = {
    arpEntriesRepo: { findByIp: async () => { throw new Error('db down'); } },
    fdbEntriesRepo: { findByMac: async () => [] },
  };
  const h = harness({
    agents: [offline(1, T0 - 6 * MIN, { capabilities: { ips: ['10.0.0.1'] } })],
    over: { deps, peerProbesTowards: async () => { throw new Error('db down'); } },
  });
  const out = await h.monitor.runOnce();
  assert.equal(out.raised.length, 1);
  const checks = Object.fromEntries(h.findingStore.rows[0].evidence[0].checks.map((c) => [c.check, c.result]));
  assert.equal(checks.switch_port, 'unknown');
  assert.equal(checks.peer_probes, 'unknown');
  const probeCheck = h.findingStore.rows[0].evidence[0].checks.find((c) => c.check === 'peer_probes');
  assert.match(probeCheck.detail, /lookup failed/);
});

test('reconnect resolves the event case the finding opened, and a new episode raises again', async () => {
  const h = harness({ agents: [offline(1, T0 - 6 * MIN)] });
  await h.monitor.runOnce();
  assert.equal(h.cases.get(1).status, 'open');

  // Back online.
  h.rows[0].status = 'online';
  h.rows[0].last_seen = new Date(T0 + MIN).toISOString();
  h.clock.t += MIN;
  const out = await h.monitor.runOnce();
  assert.deepEqual(out.resolved, [1]);
  assert.equal(h.cases.get(1).status, 'resolved');
  assert.equal(h.calls.auditLog[0].action, 'event_auto_resolve');
  assert.match(h.calls.auditLog[0].detail, /agent 1 reconnected/);

  // Drops again: a new episode, a new finding once the grace period passes.
  h.rows[0].status = 'offline';
  h.rows[0].last_seen = new Date(T0 + 2 * MIN).toISOString();
  h.clock.t = T0 + 8 * MIN;
  const again = await h.monitor.runOnce();
  assert.equal(again.raised.length, 1);
  assert.equal(h.findingStore.rows.length, 2);
});

test('reconnect leaves an event case alone when other findings joined it', async () => {
  const h = harness({ agents: [offline(1, T0 - 6 * MIN)] });
  await h.monitor.runOnce();
  h.cases.get(1).lastEventAt = new Date(T0 + 30000).toISOString(); // something else joined
  h.rows[0].status = 'online';
  h.clock.t += MIN;
  const out = await h.monitor.runOnce();
  assert.deepEqual(out.resolved, []);
  assert.equal(h.cases.get(1).status, 'open');
});

test('unlicensed: the sweep still runs, but no finding is raised', async () => {
  const h = harness({ agents: [offline(1, T0 - 6 * MIN)], over: { flipped: [3], deps: { licensed: () => false } } });
  const out = await h.monitor.runOnce();
  assert.deepEqual(out.flipped, [3]);
  assert.deepEqual(out.raised, []);
});

test('alerting off: the finding is recorded but not dispatched', async () => {
  const h = harness({ agents: [offline(1, T0 - 6 * MIN)], over: { deps: { alertingEnabled: () => false } } });
  await h.monitor.runOnce();
  assert.equal(h.findingStore.rows.length, 1);
  assert.equal(h.calls.dispatched.length, 0);
});

test('a failing agent list or sweep never throws out of the tick', async () => {
  const monitor = createAgentOfflineMonitor({
    agentsRepo: {
      findAll: async () => { throw new Error('db down'); },
      sweepStaleOffline: async () => { throw new Error('db down'); },
    },
    findingStore: makeFindingStore(),
  });
  const out = await monitor.runOnce();
  assert.deepEqual(out, { flipped: [], resolved: [], raised: [] });
});

test('start/stop: the timer is unref\'d and stop is idempotent', () => {
  const monitor = createAgentOfflineMonitor({
    agentsRepo: { findAll: async () => [], sweepStaleOffline: async () => [] },
    intervalMs: 10 * MIN,
  });
  monitor.start();
  monitor.start(); // second start is a no-op
  monitor.stop();
  monitor.stop();
});
