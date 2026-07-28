'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Tests for interface state transitions (Fase 2b) — the dimension the changes
// feed could not report, because interfaces were never persisted.
//
// Two layers:
//   * the pure diff (src/health/interfaceStateDiff.js)
//   * the ingest seam (POST /agents/results), including flap collapse and the
//     guarantee that this bookkeeping can never cost an agent its results report

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentTokensRepo,
  makeAgentsRepo,
  makeInterfaceStatesRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');

const { diffInterfaceStates, severityFor, isReversal, isWorsening } = require('../src/health/interfaceStateDiff');
const { createInterfaceStateService } = require('../src/health/interfaceStateService');

const AT = new Date('2026-07-28T12:00:00.000Z');
const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

// A traffic payload with the given interfaces.
function traffic(ifaces) {
  return { elapsedSec: 60, interfaces: ifaces };
}
const iface = (over) => Object.assign({
  iface: 'eth0', operStatus: 'up', speedMbps: 1000,
  rxBytesPerSec: 1000, txBytesPerSec: 1000,
  rxErrors: 0, txErrors: 0, rxDrop: 0, txDrop: 0,
}, over);

function postResults(app, ifaces) {
  return request(app)
    .post('/agents/results')
    .set('Authorization', 'Bearer agent-tok')
    .send({ results: [{ payload: { traffic: traffic(ifaces) } }] });
}

// ------------------------------------------------------------------ pure diff
test('the diff emits nothing when nothing changed', () => {
  const prev = [{ iface: 'eth0', status: 'ok' }];
  const current = [{ iface: 'eth0', status: 'ok', operStatus: 'up', virtual: false }];
  const { transitions, states } = diffInterfaceStates(prev, current, { at: AT });

  assert.deepEqual(transitions, []);
  assert.equal(states.length, 1, 'the snapshot is still refreshed so last_seen moves');
});

test('the diff emits a transition when the status changes', () => {
  const prev = [{ iface: 'eth0', status: 'ok' }];
  const current = [{ iface: 'eth0', status: 'down', operStatus: 'down', virtual: false }];
  const { transitions } = diffInterfaceStates(prev, current, { at: AT });

  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].fromStatus, 'ok');
  assert.equal(transitions[0].toStatus, 'down');
  assert.equal(transitions[0].severity, 'CRIT');
  assert.match(transitions[0].summary, /eth0 link went down/);
});

test('a first sighting is only reported when the interface starts UNHEALTHY', () => {
  // Announcing every healthy interface on every new agent would bury the real
  // changes on the day an agent is enrolled.
  const healthy = diffInterfaceStates([], [{ iface: 'eth0', status: 'ok', virtual: false }], { at: AT });
  assert.deepEqual(healthy.transitions, []);

  const broken = diffInterfaceStates([], [{ iface: 'eth1', status: 'down', virtual: false }], { at: AT });
  assert.equal(broken.transitions.length, 1);
  assert.equal(broken.transitions[0].fromStatus, null);
  assert.match(broken.transitions[0].summary, /first seen down/);
});

test('an interface that DISAPPEARS is not reported as a change', () => {
  // A missing interface is far more often a collection hiccup (SNMP timeout,
  // truncated payload) than an interface that ceased to exist, and "eth0
  // vanished" is an alarming thing to say wrongly.
  const prev = [{ iface: 'eth0', status: 'ok' }, { iface: 'eth1', status: 'ok' }];
  const current = [{ iface: 'eth0', status: 'ok', virtual: false }];
  const { transitions, states } = diffInterfaceStates(prev, current, { at: AT });

  assert.deepEqual(transitions, []);
  assert.deepEqual(states.map((s) => s.iface), ['eth0'], 'eth1 simply stops being refreshed');
});

test('a DOWN virtual interface is INFO, not CRIT', () => {
  // docker0/veth/tun are routinely down because they are idle. Treating that as
  // an outage would make the feed unreadable every time a container exits.
  const { transitions } = diffInterfaceStates(
    [{ iface: 'docker0', status: 'ok' }],
    [{ iface: 'docker0', status: 'down', virtual: true }],
    { at: AT }
  );
  assert.equal(transitions[0].severity, 'INFO');
  assert.match(transitions[0].summary, /\(virtual\) went down/);
});

test('recovery is INFO, never the severity of the fault it ended', () => {
  const { transitions } = diffInterfaceStates(
    [{ iface: 'eth0', status: 'down' }],
    [{ iface: 'eth0', status: 'ok', virtual: false }],
    { at: AT }
  );
  assert.equal(transitions[0].severity, 'INFO');
  assert.match(transitions[0].summary, /came back up/);
});

test('severityFor maps degradation to WARN and a real link-down to CRIT', () => {
  assert.equal(severityFor('ok', 'down', false), 'CRIT');
  assert.equal(severityFor('ok', 'down', true), 'INFO');
  assert.equal(severityFor('ok', 'bad', false), 'WARN');
  assert.equal(severityFor('ok', 'warn', false), 'WARN');
  assert.equal(severityFor('down', 'ok', false), 'INFO');
});

test('isReversal detects a return to the previous state', () => {
  const down = { iface: 'eth0', from_status: 'ok', to_status: 'down' };
  const up = { iface: 'eth0', from_status: 'down', to_status: 'ok' };
  assert.equal(isReversal(down, up), true);
  assert.equal(isReversal(down, { iface: 'eth1', from_status: 'down', to_status: 'ok' }), false);
  assert.equal(isReversal(down, { iface: 'eth0', from_status: 'down', to_status: 'warn' }), false);
  assert.equal(isReversal(null, up), false);
});

test('isWorsening orders the status vocabulary correctly', () => {
  assert.equal(isWorsening('ok', 'down'), true);
  assert.equal(isWorsening('warn', 'bad'), true);
  assert.equal(isWorsening('down', 'ok'), false);
  assert.equal(isWorsening('ok', 'nonsense'), false);
});

test('the diff survives malformed input', () => {
  assert.deepEqual(diffInterfaceStates(null, null, { at: AT }), { transitions: [], states: [] });
  const { transitions } = diffInterfaceStates([null, { iface: null }], [null, { iface: null }], { at: AT });
  assert.deepEqual(transitions, []);
});

// ------------------------------------------------------------------ the seam
test('a results report records an interface going down', async () => {
  const interfaceStatesRepo = makeInterfaceStatesRepo();
  const app = makeApp({ interfaceStatesRepo, agentTokensRepo: agentToken() });

  await postResults(app, [iface()]);                                   // ok
  await postResults(app, [iface({ operStatus: 'down' })]);             // down

  assert.equal(interfaceStatesRepo.transitions.length, 1);
  assert.equal(interfaceStatesRepo.transitions[0].to_status, 'down');
  assert.equal(interfaceStatesRepo.transitions[0].agent_id, 9, 'agent id comes from the token');
  assert.equal(interfaceStatesRepo.transitions[0].severity, 'CRIT');
});

test('a steady interface produces no transitions however often it reports', async () => {
  const interfaceStatesRepo = makeInterfaceStatesRepo();
  const app = makeApp({ interfaceStatesRepo, agentTokensRepo: agentToken() });

  for (let i = 0; i < 5; i += 1) await postResults(app, [iface()]);

  assert.equal(interfaceStatesRepo.transitions.length, 0);
  assert.equal(interfaceStatesRepo.states.length, 1, 'one snapshot row, refreshed');
});

test('a flapping interface collapses onto ONE row instead of many', async () => {
  // An interface bouncing every 20 seconds is ONE finding — "flapping 6×" — not
  // six rows nobody can read.
  const interfaceStatesRepo = makeInterfaceStatesRepo();
  const app = makeApp({ interfaceStatesRepo, agentTokensRepo: agentToken() });

  await postResults(app, [iface()]);
  for (let i = 0; i < 3; i += 1) {
    await postResults(app, [iface({ operStatus: 'down' })]);
    await postResults(app, [iface({ operStatus: 'up' })]);
  }

  assert.equal(interfaceStatesRepo.transitions.length, 1, 'all the bouncing collapsed onto one row');
  const row = interfaceStatesRepo.transitions[0];
  assert.equal(row.flapping, 1);
  assert.ok(row.flap_count > 1, `expected a flap count, got ${row.flap_count}`);
  assert.match(row.summary, /flapping \d+×/);
  assert.equal(row.severity, 'WARN');
});

test('a transition outside the flap window is a fresh row, not a collapse', async () => {
  const interfaceStatesRepo = makeInterfaceStatesRepo();
  let clock = new Date('2026-07-28T12:00:00.000Z');
  const service = createInterfaceStateService({
    interfaceStatesRepo,
    flapWindowSeconds: 300,
    now: () => clock,
  });
  const results = (over) => [{ payload: { traffic: traffic([iface(over)]) } }];

  await service.processResults(9, results({}));                       // ok
  await service.processResults(9, results({ operStatus: 'down' }));    // down
  clock = new Date(clock.getTime() + 3600 * 1000);                     // an hour later
  await service.processResults(9, results({}));                        // back up

  assert.equal(interfaceStatesRepo.transitions.length, 2, 'an hour apart is not a flap');
  assert.equal(interfaceStatesRepo.transitions[1].flapping, 0);
});

test('the LAST traffic sample in a batch wins', async () => {
  // Diffing against an earlier sample in the same batch would emit transitions
  // the agent already superseded.
  const interfaceStatesRepo = makeInterfaceStatesRepo();
  const service = createInterfaceStateService({ interfaceStatesRepo });

  await service.processResults(9, [{ payload: { traffic: traffic([iface()]) } }]);
  await service.processResults(9, [
    { payload: { traffic: traffic([iface({ operStatus: 'down' })]) } },
    { payload: { traffic: traffic([iface({ operStatus: 'up' })]) } },
  ]);

  assert.equal(interfaceStatesRepo.transitions.length, 0, 'it ended where it started');
  assert.equal(interfaceStatesRepo.states[0].status, 'ok');
});

test('a report with no traffic payload is a no-op', async () => {
  const interfaceStatesRepo = makeInterfaceStatesRepo();
  const service = createInterfaceStateService({ interfaceStatesRepo });

  await service.processResults(9, [{ payload: { probes: [] } }]);
  await service.processResults(9, []);
  await service.processResults(9, null);

  assert.equal(interfaceStatesRepo.states.length, 0);
  assert.equal(interfaceStatesRepo.transitions.length, 0);
});

test('an interface-state failure never breaks the results report', async () => {
  // The results report is the agent's lifeline; bookkeeping must not cost it.
  const interfaceStatesRepo = makeInterfaceStatesRepo({ statesForAgent: throwingAsync('db down') });
  const app = makeApp({ interfaceStatesRepo, agentTokensRepo: agentToken() });

  const res = await postResults(app, [iface({ operStatus: 'down' })]);
  assert.equal(res.status, 201);
});

test('the seam is inert when no interface-state repo is wired (pre-migration)', async () => {
  const app = makeApp({
    interfaceStatesRepo: null, interfaceStateService: null, agentTokensRepo: agentToken(),
  });
  assert.equal((await postResults(app, [iface({ operStatus: 'down' })])).status, 201);
});

// ------------------------------------------------------- into the changes feed
test('interface transitions appear in GET /api/changes', async () => {
  const interfaceStatesRepo = makeInterfaceStatesRepo();
  const app = makeApp({
    interfaceStatesRepo,
    agentTokensRepo: agentToken(),
    agentsRepo: makeAgentsRepo({
      findAll: async () => [{ id: 9, hostname: 'sw-core', display_name: 'Core switch', last_seen: new Date().toISOString(), capabilities: {} }],
    }),
  });

  await postResults(app, [iface()]);
  await postResults(app, [iface({ operStatus: 'down' })]);

  const res = await request(app).get('/api/changes?window=6h').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);

  const row = res.body.events.find((e) => e.kind === 'interface_state');
  assert.ok(row, 'the feed must now report interface state');
  assert.equal(row.severity, 'CRIT');
  assert.match(row.summary, /eth0 link went down on Core switch/);
  assert.equal(row.agentId, 9);
  assert.equal(row.currentState, false, 'this IS a transition, not a current condition');
});

test('a failing interface source degrades the feed to partial, not empty', async () => {
  const interfaceStatesRepo = makeInterfaceStatesRepo({ list: throwingAsync() });
  const app = makeApp({
    interfaceStatesRepo,
    agentsRepo: makeAgentsRepo({ findAll: async () => [{ id: 9, hostname: 'sw', last_seen: new Date().toISOString(), capabilities: {} }] }),
  });

  const res = await request(app).get('/api/changes?window=6h').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.partial, true);
  assert.deepEqual(res.body.failedSources, ['interfaces']);
});

// --------------------------------------------------------------------- retention
test('transitions and stale snapshot rows age out', async () => {
  const repo = makeInterfaceStatesRepo();
  await repo.insertTransition(9, {
    iface: 'eth0', fromStatus: 'ok', toStatus: 'down', severity: 'CRIT',
    summary: 'old', detectedAt: new Date('2026-01-01T00:00:00Z'),
  });
  await repo.insertTransition(9, {
    iface: 'eth0', fromStatus: 'down', toStatus: 'ok', severity: 'INFO',
    summary: 'recent', detectedAt: new Date('2026-07-28T00:00:00Z'),
  });

  assert.equal(await repo.purgeTransitionsBefore(new Date('2026-07-01T00:00:00Z')), 1);
  assert.deepEqual(repo.transitions.map((r) => r.summary), ['recent']);
});
