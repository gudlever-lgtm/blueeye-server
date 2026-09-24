'use strict';

// The Troubleshooting overview on a SINGLE-AGENT site.
//
// Found by a real end-to-end run: a small water utility with one agent and two
// polled switches had its uplink down and flapping on both switches, probe
// outages, a TLS finding and a failed transaction — 22 unacknowledged CRITs
// and an open event case — and the screen meant for "what is broken now" said
// 0 active faults, 0 root causes, every switch `ok`. The correlator only forms
// a cluster from findings on ≥2 agents, so with one agent nothing reached it.
//
// What these tests hold: an open event case outside a live situation is a
// fault group (activeFaults / rootCauses / affectedDevices, and rows on
// /faults), a node an open fault sits on is `degraded` rather than `ok`, and
// an alarm that is in a live cluster AND in a case is counted once.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeEventClustersRepo, makeEventCasesRepo, makeFindingStore,
  makeSnmpDevicesRepo, authHeader,
} = require('../test-support/fakes');
const { createTroubleshootingOverviewService } = require('../src/troubleshooting/overviewService');
const {
  buildCaseRootCauses, buildTopologyView, openFaultNodes, firstSentence, caseRoot,
} = require('../src/troubleshooting/overview');

const NOW = new Date('2026-09-24T12:00:00.000Z');
const now = () => NOW;
const at = (min) => new Date(NOW.getTime() - min * 60 * 1000).toISOString();

const l2 = (a, b) => ({ type: 'l2_link', directed: false, source: a, target: b });

// One agent, two switches it polls, both answering their polls.
const AGENTS = [{ id: 1, hostname: 'vv-agent', status: 'online', location_id: 1 }];
const DEVICES = [
  { id: 1, host: '10.0.0.2', displayName: 'sw-core', enabled: true, lastOkAt: at(1), lastError: null },
  { id: 2, host: '10.0.0.3', displayName: 'sw-pump', enabled: true, lastOkAt: at(1), lastError: null },
];
const GRAPH = {
  nodes: [{ id: 1, label: 'vv-agent' }, { id: 'd:1', label: 'sw-core' }, { id: 'd:2', label: 'sw-pump' }],
  edges: [l2(1, 'd:1'), l2('d:1', 'd:2')],
};

const LINK_DOWN = 'Port Gi0/1 on sw-core went down (SNMP poll). It is the link to fw-1, known from the switch\'s own LLDP table.';

// The site's open work: one event case on the agent holding the uplink down on
// sw-core, the uplink flapping on sw-pump, a probe outage and a failed
// transaction.
async function seedSite({ findingStore = makeFindingStore(), eventCasesRepo = makeEventCasesRepo() } = {}) {
  const caseId = await eventCasesRepo.create({
    host_id: '1', title: 'CRIT if.11.link.down on vv-agent (Vandværket)', status: 'open', severity: 'CRIT',
    primary_finding_id: 'f-down', first_event_at: at(50), last_event_at: at(5),
  });
  const save = (f) => findingStore.save({
    observed: 0, baseline: null, deviation: null, kind: 'THRESHOLD',
    evidence: [{ ts: at(40), value: 0 }], eventCaseId: caseId, ...f,
  });
  await save({ id: 'f-down', hostId: '1', deviceId: 1, interfaceId: 11, metric: 'if.11.link.down', severity: 'CRIT', explanation: LINK_DOWN, createdAt: at(50) });
  await save({ id: 'f-flap', hostId: '1', deviceId: 2, interfaceId: 21, metric: 'if.21.link.flapping', severity: 'CRIT', explanation: 'Port Gi0/24 on sw-pump has changed link state 6 times.', createdAt: at(45) });
  await save({ id: 'f-probe', hostId: '1', metric: 'probe_outage.loss', severity: 'CRIT', explanation: 'Probe to 8.8.8.8 lost every packet.', createdAt: at(40) });
  await save({ id: 'f-tx', hostId: '1', metric: 'transaction.fail', severity: 'CRIT', explanation: 'Transaction SCADA login failed 3 times.', createdAt: at(30) });
  return { findingStore, eventCasesRepo, caseId };
}

function serviceFor({ findingStore, eventCasesRepo, clustersRepo = makeEventClustersRepo(), agents = AGENTS, graph = GRAPH } = {}) {
  return createTroubleshootingOverviewService({
    logger: { warn() {} },
    clustersRepo,
    findingStore,
    eventCasesRepo,
    agentsRepo: { findAll: async () => agents },
    blastRadiusService: { graph: async () => graph },
    snmpDevicesRepo: { list: async () => DEVICES },
  });
}

const stateOf = (out) => Object.fromEntries(out.topology.nodes.map((n) => [String(n.id), n.state]));

// --- the headline -----------------------------------------------------------

test('a single-agent site with an open case is NOT an empty overview', async () => {
  const site = await seedSite();
  const out = await serviceFor(site).getOverview({ now });

  assert.equal(out.summary.activeFaults, 4, 'the case findings are the active faults');
  assert.equal(out.summary.rootCauses, 1, 'one open case is one cause');
  // The agent, and both switches the port findings name.
  assert.equal(out.summary.affectedDevices, 3);
  assert.equal(out.partial, false);

  const [rc] = out.rootCauses;
  assert.equal(rc.source, 'case');
  assert.equal(rc.caseId, site.caseId);
  assert.equal(rc.clusterId, null);
  assert.equal(rc.id, `case:${site.caseId}`);
  assert.equal(rc.severity, 'CRIT');
  assert.equal(rc.memberCount, 4);
  // The case's primary finding names it, in the detector's own words.
  assert.equal(rc.primaryFindingId, 'f-down');
  assert.equal(rc.cause, 'Port Gi0/1 on sw-core went down (SNMP poll).');
  assert.deepEqual(rc.affectedDeviceIds, [1, 'd:1', 'd:2']);
  // "Show path" walks from the switch the root finding is about.
  assert.equal(rc.primaryDeviceId, 'd:1');
  assert.equal(rc.status, 'open');
});

test('a switch with an open port fault is degraded, not ok — and so is an agent with open probe/transaction faults', async () => {
  const out = await serviceFor(await seedSite()).getOverview({ now });
  const s = stateOf(out);
  assert.equal(s['d:1'], 'degraded', 'uplink down on sw-core');
  assert.equal(s['d:2'], 'degraded', 'uplink flapping on sw-pump');
  assert.equal(s['1'], 'degraded', 'probe outage + failed transaction on the agent');
  assert.equal(out.topology.counts.degraded, 3);
  assert.equal(out.summary.devicesDegraded, 3);
  // A link takes the worse endpoint, so the degraded links are not green either.
  assert.ok(out.topology.links.every((l) => l.state === 'degraded'));
});

test('acknowledged and INFO findings never degrade a node', async () => {
  const site = await seedSite();
  for (const f of site.findingStore.rows) {
    if (f.id === 'f-flap') f.acked = true;
    if (f.id === 'f-probe' || f.id === 'f-tx') f.severity = 'INFO';
  }
  const s = stateOf(await serviceFor(site).getOverview({ now }));
  assert.equal(s['d:1'], 'degraded');
  assert.equal(s['d:2'], 'ok', 'an acknowledged flap is history');
  assert.equal(s['1'], 'ok', 'INFO is a note, not a fault');
});

test('the blast-radius rule holds: an ONLINE agent is never unreachable_downstream', async () => {
  const site = await seedSite();
  // A second agent behind sw-pump goes offline; the walk from it reaches
  // everything on the L2 graph. The online agent 1 stays reachable.
  const agents = [...AGENTS, { id: 2, hostname: 'vv-pump', status: 'offline', location_id: 1 }];
  const graph = { nodes: [...GRAPH.nodes, { id: 2, label: 'vv-pump' }], edges: [...GRAPH.edges, l2('d:2', 2)] };
  const out = await serviceFor({ ...site, agents, graph }).getOverview({ now });
  const s = stateOf(out);
  assert.equal(s['2'], 'down');
  assert.equal(s['1'], 'degraded');
  assert.notEqual(s['d:1'], 'unreachable_downstream');
  assert.notEqual(s['d:2'], 'unreachable_downstream');
});

test('a resolved or closed case is not an active fault', async () => {
  const site = await seedSite();
  site.eventCasesRepo.rows[0].status = 'resolved';
  const out = await serviceFor(site).getOverview({ now });
  assert.equal(out.summary.activeFaults, 0);
  assert.equal(out.summary.rootCauses, 0);
  assert.equal(stateOf(out)['d:1'], 'ok', 'no open work, no degraded node');
});

test('an investigating case is still open work', async () => {
  const site = await seedSite();
  site.eventCasesRepo.rows[0].status = 'investigating';
  const out = await serviceFor(site).getOverview({ now });
  assert.equal(out.summary.rootCauses, 1);
  assert.equal(out.rootCauses[0].status, 'investigating');
});

// --- nothing counts twice ---------------------------------------------------

test('a case linked to a LIVE situation is left out — the situation counts its findings', async () => {
  const site = await seedSite();
  const clustersRepo = makeEventClustersRepo();
  const cid = await clustersRepo.create({
    confidence: 'high', memberFindingIds: ['f-down', 'f-flap'], suspectedCommonCause: 'Uplink fw-1 lost', detectedAt: new Date(at(5)),
  });
  site.eventCasesRepo.rows[0].cluster_id = cid;
  const out = await serviceFor({ ...site, clustersRepo }).getOverview({ now });
  assert.equal(out.summary.rootCauses, 1);
  assert.equal(out.rootCauses[0].source, 'cluster');
  assert.equal(out.summary.activeFaults, 2, 'only the situation\'s two members');
});

test('the same findings in a live cluster AND an unlinked case are counted once, on the cluster', async () => {
  // The case has not been stamped with its situation yet (the sweep runs
  // every minute), but a live cluster already lists two of its findings.
  const site = await seedSite();
  const clustersRepo = makeEventClustersRepo();
  await clustersRepo.create({
    confidence: 'high', memberFindingIds: ['f-down', 'f-flap'], suspectedCommonCause: 'Uplink fw-1 lost', detectedAt: new Date(at(5)),
  });
  const out = await serviceFor({ ...site, clustersRepo }).getOverview({ now });
  assert.equal(out.summary.rootCauses, 2);
  assert.equal(out.summary.activeFaults, 4, '2 on the cluster + the 2 the case has left — never 6');
  const rc = out.rootCauses.find((r) => r.source === 'case');
  assert.equal(rc.memberCount, 2);
  // Its primary finding is counted by the cluster, so the case is named after
  // its earliest remaining one.
  assert.equal(rc.primaryFindingId, 'f-probe');
  assert.equal(rc.cause, 'Probe to 8.8.8.8 lost every packet.');

  const page = await serviceFor({ ...site, clustersRepo }).getFaults({});
  assert.equal(page.total, 4);
  assert.equal(new Set(page.faults.map((f) => f.findingId)).size, 4, 'a finding listed twice');
});

test('a case whose every finding a live cluster lists adds no cause at all', async () => {
  const site = await seedSite();
  const clustersRepo = makeEventClustersRepo();
  await clustersRepo.create({
    confidence: 'high', memberFindingIds: ['f-down', 'f-flap', 'f-probe', 'f-tx'], detectedAt: new Date(at(5)),
  });
  const out = await serviceFor({ ...site, clustersRepo }).getOverview({ now });
  assert.equal(out.summary.rootCauses, 1);
  assert.equal(out.summary.activeFaults, 4);
});

// --- bounded reads, partial failure -----------------------------------------

test('case members are read in ONE bulk read, narrow projection — never per case or per finding', async () => {
  const site = await seedSite();
  await site.eventCasesRepo.create({ host_id: '1', title: 'second', status: 'open', severity: 'WARN', first_event_at: at(200), last_event_at: at(190) });
  const calls = { bulk: 0, light: 0, perCase: 0, get: 0 };
  const store = {
    ...site.findingStore,
    listByEventCases: async (ids, opts) => { calls.bulk += 1; if (opts && opts.light) calls.light += 1; return site.findingStore.listByEventCases(ids, opts); },
    listByEventCase: async () => { calls.perCase += 1; return []; },
    get: async () => { calls.get += 1; return null; },
  };
  await serviceFor({ ...site, findingStore: store }).getOverview({ now });
  assert.equal(calls.bulk, 1);
  assert.equal(calls.light, 1);
  assert.equal(calls.perCase, 0);
  assert.equal(calls.get, 0);
});

test('a dead case store costs the case causes, flagged, and the rest of the screen stays', async () => {
  const site = await seedSite();
  const eventCasesRepo = { listOpenOutsideSituations: async () => { throw new Error('db down'); } };
  const out = await serviceFor({ ...site, eventCasesRepo }).getOverview({ now });
  assert.equal(out.partial, true);
  assert.deepEqual(out.failedSources, ['cases']);
  assert.equal(out.summary.rootCauses, 0);
  assert.equal(out.topology.nodes.length, 3);
});

test('a failed case-member read is flagged as the cases source', async () => {
  const site = await seedSite();
  const findingStore = { ...site.findingStore, listByEventCases: async () => { throw new Error('boom'); } };
  const out = await serviceFor({ ...site, findingStore }).getOverview({ now });
  assert.deepEqual(out.failedSources, ['cases']);
  assert.equal(out.summary.rootCauses, 0);
});

test('without an event-case store the overview is the cluster path alone, as before', async () => {
  const site = await seedSite();
  const out = await serviceFor({ ...site, eventCasesRepo: null }).getOverview({ now });
  assert.equal(out.summary.rootCauses, 0);
  assert.equal(out.partial, false);
});

// --- the fault list ---------------------------------------------------------

test('/faults lists the case findings, oldest first, each saying where it comes from', async () => {
  const site = await seedSite();
  const page = await serviceFor(site).getFaults({});
  assert.equal(page.total, 4);
  assert.deepEqual(page.faults.map((f) => f.findingId), ['f-down', 'f-flap', 'f-probe', 'f-tx']);
  for (const f of page.faults) {
    assert.equal(f.source, 'case');
    assert.equal(f.caseId, site.caseId);
    assert.equal(f.clusterId, null);
    assert.equal(f.cause, 'Port Gi0/1 on sw-core went down (SNMP poll).');
    assert.equal(f.missing, false);
  }
  assert.equal(page.faults[0].deviceId, 1);
  assert.equal(page.faults[0].interfaceId, 11);
  assert.ok(page.faults[0].explanation, 'the full row, not the light one');
});

test('/faults pages across the cluster → case boundary without repeating or skipping', async () => {
  const site = await seedSite();
  const clustersRepo = makeEventClustersRepo();
  await site.findingStore.save({ id: 'c-1', hostId: '1', metric: 'link.errors', severity: 'WARN', explanation: 'x', evidence: [{}], createdAt: at(3) });
  await site.findingStore.save({ id: 'c-2', hostId: '1', metric: 'link.errors', severity: 'WARN', explanation: 'x', evidence: [{}], createdAt: at(3) });
  const cid = await clustersRepo.create({ confidence: 'high', memberFindingIds: ['c-1', 'c-2'], suspectedCommonCause: 'errs', detectedAt: new Date(at(3)) });
  const svc = serviceFor({ ...site, clustersRepo });
  const seen = [];
  for (let offset = 0; offset < 6; offset += 4) {
    const page = await svc.getFaults({ limit: 4, offset });
    assert.equal(page.total, 6);
    seen.push(...page.faults);
  }
  assert.deepEqual(seen.map((f) => f.findingId), ['c-1', 'c-2', 'f-down', 'f-flap', 'f-probe', 'f-tx']);
  assert.deepEqual(seen.map((f) => f.source), ['cluster', 'cluster', 'case', 'case', 'case', 'case']);
  assert.equal(seen[0].clusterId, cid);
  assert.equal(seen[0].caseId, null);
});

test('/faults filters: caseId narrows to one case, clusterId and source=cluster leave the cases out', async () => {
  const site = await seedSite();
  const other = await site.eventCasesRepo.create({ host_id: '1', title: 'older', status: 'open', severity: 'WARN', first_event_at: at(300), last_event_at: at(290) });
  await site.findingStore.save({ id: 'g-1', hostId: '1', metric: 'probe.tls', severity: 'WARN', explanation: 'TLS cert expires in 5 days.', evidence: [{}], eventCaseId: other, createdAt: at(300) });
  const clustersRepo = makeEventClustersRepo();
  await site.findingStore.save({ id: 'c-1', hostId: '1', metric: 'link.errors', severity: 'WARN', explanation: 'x', evidence: [{}], createdAt: at(3) });
  const cid = await clustersRepo.create({ confidence: 'high', memberFindingIds: ['c-1'], detectedAt: new Date(at(3)) });
  const svc = serviceFor({ ...site, clustersRepo });

  const one = await svc.getFaults({ caseId: other });
  assert.deepEqual(one.faults.map((f) => f.findingId), ['g-1']);
  assert.equal(one.faults[0].cause, 'TLS cert expires in 5 days.');

  const cl = await svc.getFaults({ clusterId: cid });
  assert.deepEqual(cl.faults.map((f) => f.findingId), ['c-1']);

  assert.deepEqual((await svc.getFaults({ source: 'cluster' })).faults.map((f) => f.source), ['cluster']);
  const cases = await svc.getFaults({ source: 'case' });
  assert.equal(cases.total, 5);
  assert.ok(cases.faults.every((f) => f.source === 'case'));
  // Newest case first, then the older one.
  assert.equal(cases.faults[4].findingId, 'g-1');
});

// --- the pure read-model ----------------------------------------------------

test('openFaultNodes: a port finding marks the SWITCH, an agent finding the agent; acked/INFO mark nothing', () => {
  const keys = openFaultNodes([
    { hostId: '1', deviceId: 3, severity: 'CRIT' },
    { hostId: '1', severity: 'WARN' },
    { hostId: '2', severity: 'CRIT', acked: true },
    { hostId: '4', severity: 'INFO' },
    null,
    { hostId: 'not-an-agent', severity: 'CRIT' },
  ]);
  assert.deepEqual([...keys].sort(), ['1', 'd:3']);
});

test('degraded never overrules down or unreachable_downstream, and never greys a node', () => {
  const view = buildTopologyView({
    graph: { nodes: [{ id: 1 }, { id: 2 }, { id: 'd:1' }], edges: [l2(1, 'd:1'), l2('d:1', 2)] },
    agents: [{ id: 1, status: 'offline' }, { id: 2, status: 'online' }],
    devices: [{ id: 1, enabled: true }], // never polled -> unknown
    blastByNode: new Map([['1', { directly_isolated: [{ hostId: 'd:1' }] }]]),
    faultNodes: new Set(['1', '2', 'd:1']),
  });
  const s = Object.fromEntries(view.nodes.map((n) => [String(n.id), n.state]));
  assert.equal(s['1'], 'down', 'an open fault on an offline agent keeps it down');
  assert.equal(s['d:1'], 'unreachable_downstream');
  assert.equal(s['2'], 'degraded');
  assert.equal(view.counts.degraded, 1);
});

test('no open faults: the counts carry no degraded entry (a legend entry that always reads 0 is noise)', () => {
  const view = buildTopologyView({ graph: { nodes: [{ id: 1 }], edges: [] }, agents: [{ id: 1, status: 'online' }] });
  assert.deepEqual(view.counts, { ok: 1, down: 0, unreachable_downstream: 0 });
});

test('buildCaseRootCauses: root = primary finding, else earliest member; a case with no member is dropped', () => {
  const cases = [
    { id: 1, hostId: '1', title: 'A', status: 'open', severity: 'WARN', primaryFindingId: 'p', firstEventAt: at(10), lastEventAt: at(2) },
    { id: 2, hostId: '1', title: 'B', status: 'open', severity: 'CRIT', primaryFindingId: 'gone', firstEventAt: at(20), lastEventAt: at(1) },
    { id: 3, hostId: '1', title: 'C', status: 'open', severity: 'CRIT', firstEventAt: at(20), lastEventAt: at(1) },
  ];
  const membersByCase = new Map([
    [1, [{ id: 'e', hostId: '1', severity: 'WARN' }, { id: 'p', hostId: '1', severity: 'WARN', deviceId: 4 }]],
    [2, [{ id: 'x', hostId: '1', severity: 'CRIT' }]],
  ]);
  const out = buildCaseRootCauses(cases, { membersByCase, primaryById: new Map([['p', { explanation: 'Port down. More.' }]]) });
  assert.equal(out.length, 2, 'case 3 has no members');
  // CRIT first.
  assert.equal(out[0].caseId, 2);
  assert.equal(out[0].primaryFindingId, 'x');
  assert.equal(out[0].cause, 'B', 'no full row -> the case title');
  assert.equal(out[1].primaryFindingId, 'p');
  assert.equal(out[1].cause, 'Port down.');
  assert.equal(out[1].primaryDeviceId, 'd:4');
  assert.deepEqual(out[1].affectedDeviceIds, [1, 'd:4']);
  assert.equal(caseRoot({ primaryFindingId: 'nope' }, []), null);
});

test('firstSentence keeps dotted names and addresses whole, and bounds the length', () => {
  assert.equal(firstSentence('Probe to 10.0.0.1 failed. Next.'), 'Probe to 10.0.0.1 failed.');
  assert.equal(firstSentence('No full stop here'), 'No full stop here');
  assert.equal(firstSentence(''), null);
  assert.equal(firstSentence('x'.repeat(300)).length, 200);
});

// --- HTTP -------------------------------------------------------------------

async function siteApp(over = {}) {
  const site = await seedSite();
  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => AGENTS, findById: async (id) => AGENTS.find((a) => a.id === Number(id)) || null }),
    findingStore: site.findingStore,
    eventCasesRepo: site.eventCasesRepo,
    eventClustersRepo: makeEventClustersRepo(),
    snmpDevicesRepo: makeSnmpDevicesRepo({ list: async () => DEVICES }),
    blastRadiusService: { graph: async () => GRAPH, compute: async () => ({ directly_isolated: [], dependency_affected: [] }) },
    ...over,
  });
  return { app, site };
}

test('GET /overview on a single-agent site: 200 with the case as a root cause', async () => {
  const { app, site } = await siteApp();
  for (const role of ['viewer', 'operator', 'admin']) {
    const res = await request(app).get('/api/troubleshooting/overview').set('Authorization', authHeader(role));
    assert.equal(res.status, 200, role);
    assert.equal(res.body.summary.activeFaults, 4, role);
    assert.equal(res.body.summary.rootCauses, 1, role);
    assert.equal(res.body.summary.affectedDevices, 3, role);
    assert.equal(res.body.rootCauses[0].caseId, site.caseId, role);
    const s = Object.fromEntries(res.body.topology.nodes.map((n) => [String(n.id), n.state]));
    assert.equal(s['d:1'], 'degraded', role);
    assert.equal(s['d:2'], 'degraded', role);
  }
});

test('GET /overview: 401 without a token, 403 without a recognised role', async () => {
  const { app } = await siteApp();
  assert.equal((await request(app).get('/api/troubleshooting/overview')).status, 401);
  assert.equal((await request(app).get('/api/troubleshooting/overview').set('Authorization', authHeader('guest'))).status, 403);
});

test('GET /overview: 500 on an unexpected fault after the fan-out', async () => {
  const { app } = await siteApp({
    // A rejecting agents list is a source failure (partial), so force the
    // unexpected path instead: a graph whose nodes blow up on read.
    blastRadiusService: { graph: async () => ({ get nodes() { throw new Error('corrupt graph'); }, edges: [] }) },
  });
  const res = await request(app).get('/api/troubleshooting/overview').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});

test('GET /faults on a single-agent site: 200 with case rows for every reader role', async () => {
  const { app, site } = await siteApp();
  for (const role of ['viewer', 'operator', 'admin']) {
    const res = await request(app).get('/api/troubleshooting/faults').set('Authorization', authHeader(role));
    assert.equal(res.status, 200, role);
    assert.equal(res.body.total, 4, role);
    assert.ok(res.body.faults.every((f) => f.source === 'case' && f.caseId === site.caseId), role);
  }
  const one = await request(app).get(`/api/troubleshooting/faults?caseId=${site.caseId}&source=case`).set('Authorization', authHeader('operator'));
  assert.equal(one.status, 200);
  assert.equal(one.body.total, 4);
  const none = await request(app).get('/api/troubleshooting/faults?source=cluster').set('Authorization', authHeader('operator'));
  assert.equal(none.status, 200);
  assert.equal(none.body.total, 0);
});

test('GET /faults: 401 without a token, 403 without a recognised role', async () => {
  const { app } = await siteApp();
  assert.equal((await request(app).get('/api/troubleshooting/faults')).status, 401);
  assert.equal((await request(app).get('/api/troubleshooting/faults').set('Authorization', authHeader('guest'))).status, 403);
});

test('GET /faults: 400 on a bad caseId, a bad source, or filters that contradict each other', async () => {
  const { app } = await siteApp();
  for (const q of ['caseId=0', 'caseId=abc', 'caseId=1.5', 'source=both', 'clusterId=1&caseId=1', 'source=case&clusterId=1', 'source=cluster&caseId=1']) {
    const res = await request(app).get(`/api/troubleshooting/faults?${q}`).set('Authorization', authHeader('operator'));
    assert.equal(res.status, 400, q);
    assert.ok(res.body.error, q);
  }
  // Empty is absent, not invalid.
  const ok = await request(app).get('/api/troubleshooting/faults?caseId=&source=').set('Authorization', authHeader('operator'));
  assert.equal(ok.status, 200);
});

test('GET /faults: 500 when the case store fails (the list has no partial mode)', async () => {
  const { app } = await siteApp({ eventCasesRepo: makeEventCasesRepo({ listOpenOutsideSituations: async () => { throw new Error('db down'); } }) });
  const res = await request(app).get('/api/troubleshooting/faults').set('Authorization', authHeader('operator'));
  assert.equal(res.status, 500);
  assert.ok(res.body.error);
});
