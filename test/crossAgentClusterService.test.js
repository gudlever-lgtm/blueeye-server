'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCrossAgentClusterService } = require('../src/analysis/crossAgentClusterService');
const { makeEventClustersRepo, makeEventCasesRepo, makeFindingStore, makeAgentsRepo, makeDispatcher, makeAlertDispatchLogRepo } = require('../test-support/fakes');

const T = new Date('2026-07-01T12:00:00Z');
const ago = (ms) => new Date(T.getTime() - ms);

function finding(over = {}) {
  return { id: 'f', hostId: '1', metric: 'cpu', severity: 'WARN', explanation: 'x', evidence: [{}], createdAt: ago(60000), ...over };
}

// A fake opt-in assistant for the Step 2 advisory path.
function fakeAssistant({ enabled = true, answer = 'Likely a shared uplink fault at the site. Check the site switch/WAN.', throws = false } = {}) {
  const calls = [];
  return {
    calls,
    isEnabled: () => enabled,
    suggestClusterCause: async (cluster, members) => {
      calls.push({ cluster, members });
      if (throws) throw new Error('provider down');
      return { answer, model: 'test-model', usedFindings: (members || []).length };
    },
  };
}

// Two agents (1,2) in the same site (10) unless overridden.
function svcWith({ findings = [], agents = [{ id: 1, location_id: 10 }, { id: 2, location_id: 10 }], publishCluster, clustersRepo, assistant, alertDispatcher, alertLog, snapshotService, logger } = {}) {
  const repo = clustersRepo || makeEventClustersRepo();
  const findingStore = makeFindingStore();
  for (const f of findings) findingStore.rows.push({ ...f, acked: false });
  const agentsRepo = makeAgentsRepo({ findAll: async () => agents });
  const published = [];
  const svc = createCrossAgentClusterService({
    clustersRepo: repo,
    findingStore,
    agentsRepo,
    assistant,
    alertDispatcher,
    alertLog,
    snapshotService,
    publishCluster: publishCluster || ((c) => published.push(c)),
    logger,
    now: () => T,
  });
  return { svc, repo, findingStore, published };
}

// ---- detection + persistence ----------------------------------------------

test('two agents, same site, same metric in the window -> creates one HIGH cluster', async () => {
  const { svc, repo, published } = svcWith({
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'probe.loss', createdAt: ago(90000) }),
      finding({ id: 'b', hostId: '2', metric: 'probe.loss', createdAt: ago(30000) }),
    ],
  });
  const summary = await svc.detectAndPersist();
  assert.equal(summary.created, 1);
  assert.equal(repo.rows.length, 1);
  assert.equal(repo.rows[0].confidence, 'high');
  assert.deepEqual(repo.rows[0].member_finding_ids.sort(), ['a', 'b']);
  assert.equal(repo.rows[0].status, 'open');
  // Cluster event was published (server wraps it as {type:'event_cluster'}).
  assert.equal(published.length, 1);
  assert.equal(published[0].status, 'open');
});

test('opening a cluster fires a read-only evidence capture for the affected targets (fire-and-forget)', async () => {
  const captures = [];
  const snapshotService = { captureForCluster: async (id, targets, opts) => { captures.push({ id, targets, opts }); return { snapshots: [] }; } };
  const { svc } = svcWith({
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'probe.loss', createdAt: ago(90000) }),
      finding({ id: 'b', hostId: '2', metric: 'probe.loss', createdAt: ago(30000) }),
    ],
    snapshotService,
  });
  const summary = await svc.detectAndPersist();
  assert.equal(summary.created, 1);
  // The capture is fire-and-forget (not awaited by the sweep) — flush microtasks.
  await new Promise((r) => setImmediate(r));
  assert.equal(captures.length, 1);
  assert.equal(captures[0].opts.trigger, 'auto');
  assert.deepEqual([...captures[0].targets].map(String).sort(), ['1', '2']);
});

test('a throwing evidence capture never breaks the clustering sweep', async () => {
  const snapshotService = { captureForCluster: async () => { throw new Error('evidence boom'); } };
  const { svc, repo } = svcWith({
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'probe.loss', createdAt: ago(90000) }),
      finding({ id: 'b', hostId: '2', metric: 'probe.loss', createdAt: ago(30000) }),
    ],
    snapshotService,
  });
  const summary = await svc.detectAndPersist();
  await new Promise((r) => setImmediate(r));
  assert.equal(summary.created, 1);
  assert.equal(repo.rows.length, 1); // the cluster was still created
});

// DELIBERATE CHANGE (audit §8): this used to assert a MEDIUM cluster for cpu
// on one agent + mem on another just because they share a site — two unrelated
// subjects merged into one situation. Without a topology relation they now stay
// apart; the same target from two agents is what groups (next test).
test('two agents, same site, unrelated subjects (cpu vs mem) -> NO cluster', async () => {
  const { svc, repo } = svcWith({
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'cpu', createdAt: ago(90000) }),
      finding({ id: 'b', hostId: '2', metric: 'mem', createdAt: ago(30000) }),
    ],
  });
  const summary = await svc.detectAndPersist();
  assert.equal(summary.created, 0);
  assert.equal(repo.rows.length, 0);
});

test('the same target failing from two sites -> one cluster that stores WHY (grouping basis)', async () => {
  const { svc, repo } = svcWith({
    agents: [{ id: 1, location_id: 10 }, { id: 2, location_id: 20 }],
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'probe.reachability', evidence: [{ target: 'erp.example.com' }], createdAt: ago(90000) }),
      finding({ id: 'b', hostId: '2', metric: 'probe.loss', evidence: [{ target: 'https://erp.example.com/' }], createdAt: ago(30000) }),
    ],
  });
  await svc.detectAndPersist();
  assert.equal(repo.rows.length, 1);
  assert.equal(repo.rows[0].confidence, 'medium'); // shared target, mixed conditions
  assert.deepEqual(repo.rows[0].grouping_basis.subjects, ['target:erp.example.com']);
  assert.equal(repo.rows[0].grouping_basis.reasons[0].kind, 'target');
});

test('a recurring fault on the SAME target joins its open cluster even when the old members aged out', async () => {
  const { svc, repo, findingStore } = svcWith({
    agents: [{ id: 1, location_id: 10 }, { id: 2, location_id: 20 }],
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'probe.loss', evidence: [{ target: 'erp.example.com' }], createdAt: ago(90000) }),
      finding({ id: 'b', hostId: '2', metric: 'probe.loss', evidence: [{ target: 'erp.example.com' }], createdAt: ago(30000) }),
    ],
  });
  await svc.detectAndPersist();
  // The first pair scrolls out of the detection window; the probe re-raises.
  findingStore.rows.length = 0;
  findingStore.rows.push({ ...finding({ id: 'c', hostId: '1', metric: 'probe.loss', evidence: [{ target: 'erp.example.com' }], createdAt: ago(20000) }), acked: false });
  findingStore.rows.push({ ...finding({ id: 'd', hostId: '2', metric: 'probe.loss', evidence: [{ target: 'erp.example.com' }], createdAt: ago(10000) }), acked: false });
  const s2 = await svc.detectAndPersist();
  assert.equal(s2.created, 0);
  assert.equal(s2.updated, 1);
  assert.equal(repo.rows.length, 1);
  assert.deepEqual(repo.rows[0].member_finding_ids.slice().sort(), ['a', 'b', 'c', 'd']);
});

test('a cluster is stamped on the event cases of its member findings', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  const c1 = await eventCasesRepo.create({ host_id: '1', title: 't1', first_event_at: ago(90000), last_event_at: ago(90000) });
  const c2 = await eventCasesRepo.create({ host_id: '2', title: 't2', first_event_at: ago(30000), last_event_at: ago(30000) });
  const repo = makeEventClustersRepo();
  const findingStore = makeFindingStore();
  findingStore.rows.push({ ...finding({ id: 'a', hostId: '1', metric: 'probe.loss', createdAt: ago(90000) }), eventCaseId: c1, acked: false });
  findingStore.rows.push({ ...finding({ id: 'b', hostId: '2', metric: 'probe.loss', createdAt: ago(30000) }), eventCaseId: c2, acked: false });
  const svc = createCrossAgentClusterService({
    clustersRepo: repo, findingStore, eventCasesRepo, now: () => T,
    agentsRepo: makeAgentsRepo({ findAll: async () => [{ id: 1, location_id: 10 }, { id: 2, location_id: 10 }] }),
  });
  await svc.detectAndPersist();
  assert.equal(repo.rows.length, 1);
  const cases = await eventCasesRepo.listByCluster(repo.rows[0].id);
  assert.deepEqual(cases.map((c) => c.id), [c1, c2]);
  assert.equal((await eventCasesRepo.findById(c1)).clusterId, repo.rows[0].id);
});

test('a switch finding + a finding from a downstream agent cluster via the blast-radius graph', async () => {
  const repo = makeEventClustersRepo();
  const findingStore = makeFindingStore();
  findingStore.rows.push({ ...finding({ id: 'a', hostId: '1', metric: 'if.4.link.down', createdAt: ago(90000) }), deviceId: 9, interfaceId: 4, acked: false });
  findingStore.rows.push({ ...finding({ id: 'b', hostId: '2', metric: 'probe.loss', evidence: [{ target: 'erp.example.com' }], createdAt: ago(30000) }), acked: false });
  // Switch d:9 cuts off agent 2 (an L2 edge between them).
  const blastRadiusService = {
    maxDepth: 4,
    graph: async () => ({ nodes: [{ id: 'd:9' }, { id: 2 }], edges: [{ source: 'd:9', target: 2, type: 'l2_link' }] }),
  };
  const svc = createCrossAgentClusterService({
    clustersRepo: repo, findingStore, blastRadiusService, now: () => T,
    agentsRepo: makeAgentsRepo({ findAll: async () => [{ id: 1, location_id: 10 }, { id: 2, location_id: 20 }] }),
  });
  await svc.detectAndPersist();
  assert.equal(repo.rows.length, 1);
  assert.equal(repo.rows[0].grouping_basis.reasons[0].kind, 'upstream');
});

// graph() is six full-table reads; the sweep runs about once a minute while a
// device finding is in the window. It used to be rebuilt on every sweep.
test('the blast-radius graph is cached across sweeps for graphTtlMs, and re-read after', async () => {
  const findingStore = makeFindingStore();
  findingStore.rows.push({ ...finding({ id: 'a', hostId: '1', metric: 'if.4.link.down', createdAt: ago(90000) }), deviceId: 9, interfaceId: 4, acked: false });
  findingStore.rows.push({ ...finding({ id: 'b', hostId: '2', metric: 'probe.loss', evidence: [{ target: 'erp.example.com' }], createdAt: ago(30000) }), acked: false });
  let reads = 0;
  let fail = false;
  const blastRadiusService = {
    maxDepth: 4,
    graph: async () => {
      reads += 1;
      if (fail) throw new Error('store down');
      return { nodes: [{ id: 'd:9' }, { id: 2 }], edges: [{ source: 'd:9', target: 2, type: 'l2_link' }] };
    },
  };
  let t = T.getTime();
  const svc = createCrossAgentClusterService({
    clustersRepo: makeEventClustersRepo(), findingStore, blastRadiusService, now: () => new Date(t),
    graphTtlMs: 5 * 60 * 1000,
    agentsRepo: makeAgentsRepo({ findAll: async () => [{ id: 1, location_id: 10 }, { id: 2, location_id: 20 }] }),
  });
  await svc.detectAndPersist();
  t += 60 * 1000;
  await svc.detectAndPersist();
  t += 60 * 1000;
  await svc.detectAndPersist();
  assert.equal(reads, 1, 'three sweeps inside the TTL read the graph once');
  t += 5 * 60 * 1000; // past the TTL
  fail = true;
  await svc.detectAndPersist();
  assert.equal(reads, 2);
  fail = false;
  await svc.detectAndPersist(); // a failed read is not cached
  assert.equal(reads, 3);
});

test('two agents, different sites -> topology gap, stays LOW', async () => {
  const { svc, repo } = svcWith({
    agents: [{ id: 1, location_id: 10 }, { id: 2, location_id: 20 }],
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'cpu', createdAt: ago(90000) }),
      finding({ id: 'b', hostId: '2', metric: 'cpu', createdAt: ago(30000) }),
    ],
  });
  await svc.detectAndPersist();
  assert.equal(repo.rows.length, 1);
  assert.equal(repo.rows[0].confidence, 'low');
});

test('findings from only one agent create NO cluster', async () => {
  const { svc, repo } = svcWith({
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'cpu', createdAt: ago(90000) }),
      finding({ id: 'b', hostId: '1', metric: 'mem', createdAt: ago(30000) }),
    ],
  });
  const summary = await svc.detectAndPersist();
  assert.equal(summary.created, 0);
  assert.equal(repo.rows.length, 0);
});

// ---- dedup -----------------------------------------------------------------

test('re-running detection over the same findings UPDATES the open cluster, does not spawn a new one', async () => {
  const { svc, repo } = svcWith({
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'probe.loss', createdAt: ago(90000) }),
      finding({ id: 'b', hostId: '2', metric: 'probe.loss', createdAt: ago(30000) }),
    ],
  });
  const s1 = await svc.detectAndPersist();
  const s2 = await svc.detectAndPersist();
  assert.equal(s1.created, 1);
  assert.equal(s2.created, 0);
  assert.equal(s2.updated, 1);
  assert.equal(repo.rows.length, 1); // still one cluster
});

test('a new overlapping finding merges into the existing cluster (member set grows, no new row)', async () => {
  const { svc, repo, findingStore } = svcWith({
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'probe.loss', createdAt: ago(120000) }),
      finding({ id: 'b', hostId: '2', metric: 'probe.loss', createdAt: ago(90000) }),
    ],
  });
  await svc.detectAndPersist();
  // A third finding (same site+metric, new agent) arrives within the window.
  findingStore.rows.push({ id: 'c', hostId: '2', metric: 'probe.loss', severity: 'WARN', explanation: 'x', evidence: [{}], createdAt: ago(20000), acked: false });
  const s2 = await svc.detectAndPersist();
  assert.equal(s2.created, 0);
  assert.equal(s2.updated, 1);
  assert.equal(repo.rows.length, 1);
  assert.deepEqual(repo.rows[0].member_finding_ids.sort(), ['a', 'b', 'c']);
});

// ---- resolution ------------------------------------------------------------

test('resolveStale closes open clusters whose last activity is older than the inactivity window', async () => {
  const repo = makeEventClustersRepo();
  const id = await repo.create({ confidence: 'high', memberFindingIds: ['a', 'b'], suspectedCommonCause: 'x', detectedAt: ago(40 * 60 * 1000) }); // 40 min ago (> 30-min default)
  const { svc, published } = svcWith({ clustersRepo: repo });
  const resolved = await svc.resolveStale();
  assert.equal(resolved, 1);
  assert.equal(repo.rows.find((r) => r.id === id).status, 'resolved');
  assert.ok(published.some((p) => p.status === 'resolved'));
});

test('resolveStale leaves recently-active clusters open', async () => {
  const repo = makeEventClustersRepo();
  await repo.create({ confidence: 'high', memberFindingIds: ['a'], detectedAt: ago(2 * 60 * 1000) }); // 2 min ago
  const { svc } = svcWith({ clustersRepo: repo });
  const resolved = await svc.resolveStale();
  assert.equal(resolved, 0);
  assert.equal(repo.rows[0].status, 'open');
});

test('resolveStale NEVER auto-closes a cluster with an unacknowledged CRIT member', async () => {
  const repo = makeEventClustersRepo();
  const id = await repo.create({ confidence: 'high', memberFindingIds: ['a', 'b'], detectedAt: ago(40 * 60 * 1000) });
  const { svc } = svcWith({
    clustersRepo: repo,
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'probe.loss', severity: 'CRIT' }), // unacknowledged CRIT
      finding({ id: 'b', hostId: '2', metric: 'probe.loss', severity: 'WARN' }),
    ],
  });
  const resolved = await svc.resolveStale();
  assert.equal(resolved, 0);
  assert.equal(repo.rows.find((r) => r.id === id).status, 'open'); // stays open
});

test('resolveStale DOES auto-close once the CRIT member is acknowledged', async () => {
  const repo = makeEventClustersRepo();
  const id = await repo.create({ confidence: 'high', memberFindingIds: ['a'], detectedAt: ago(40 * 60 * 1000) });
  const { svc, findingStore } = svcWith({
    clustersRepo: repo,
    findings: [finding({ id: 'a', hostId: '1', metric: 'probe.loss', severity: 'CRIT' })],
  });
  findingStore.rows.find((f) => f.id === 'a').acked = true; // operator acknowledged the CRIT finding
  const resolved = await svc.resolveStale();
  assert.equal(resolved, 1);
  assert.equal(repo.rows.find((r) => r.id === id).status, 'resolved');
});

test('resolveStale auto-closes an ACKNOWLEDGED (non-CRIT) cluster gone quiet', async () => {
  const repo = makeEventClustersRepo();
  const id = await repo.create({ confidence: 'high', memberFindingIds: ['a'], detectedAt: ago(40 * 60 * 1000) });
  await repo.acknowledge(id, { by: 7, at: ago(35 * 60 * 1000) });
  const { svc } = svcWith({
    clustersRepo: repo,
    findings: [finding({ id: 'a', hostId: '1', metric: 'probe.loss', severity: 'WARN' })],
  });
  const resolved = await svc.resolveStale();
  assert.equal(resolved, 1);
  assert.equal(repo.rows.find((r) => r.id === id).status, 'resolved');
});

// ---- resolution logging ----------------------------------------------------
// The sweep runs every 60s and the retention rule holds the same clusters open
// until their CRIT member is acknowledged, so per-cluster logging restates the
// same fact ~1 440 times a day per cluster. A fleet holding 70 of them printed
// ~100 000 INFO lines a day and buried every other line in the log.

// A logger that records what was written at each level.
function recordingLogger() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    debug: (m) => lines.debug.push(m),
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
  };
}

// Three stale clusters, each held open by its own unacknowledged CRIT member.
function heldOpenSvc(logger, count = 3) {
  const repo = makeEventClustersRepo();
  const findings = [];
  for (let i = 0; i < count; i += 1) {
    repo.rows.push({
      id: i + 1,
      confidence: 'high',
      member_finding_ids: [`c${i}`],
      status: 'open',
      detected_at: ago(40 * 60 * 1000),
      created_at: ago(40 * 60 * 1000),
    });
    findings.push(finding({ id: `c${i}`, hostId: String(i + 1), metric: 'probe.loss', severity: 'CRIT' }));
  }
  return svcWith({ clustersRepo: repo, findings, logger });
}

test('resolveStale logs ONE summary line for the clusters it keeps open, not one per cluster', async () => {
  const logger = recordingLogger();
  const { svc } = heldOpenSvc(logger, 3);
  const resolved = await svc.resolveStale();

  assert.equal(resolved, 0); // the retention rule still holds every one of them
  const kept = logger.lines.info.filter((l) => l.includes('kept open'));
  assert.equal(kept.length, 1, `one summary line, got: ${JSON.stringify(logger.lines.info)}`);
  assert.match(kept[0], /3 inactive cluster\(s\) kept open/);
  // The per-cluster detail is still there for anyone running at debug level.
  assert.equal(logger.lines.debug.filter((l) => l.includes('kept open')).length, 3);
});

test('resolveStale does not repeat the summary while the count is unchanged', async () => {
  const logger = recordingLogger();
  const { svc } = heldOpenSvc(logger, 3);
  await svc.resolveStale();
  await svc.resolveStale();
  await svc.resolveStale();

  assert.equal(logger.lines.info.filter((l) => l.includes('kept open')).length, 1);
});

test('resolveStale reports the count again when it moves, and says so once it clears', async () => {
  const logger = recordingLogger();
  const { svc, findingStore } = heldOpenSvc(logger, 3);
  await svc.resolveStale();

  findingStore.rows.find((f) => f.id === 'c0').acked = true; // operator acknowledges one
  assert.equal(await svc.resolveStale(), 1);
  const kept = logger.lines.info.filter((l) => l.includes('kept open'));
  assert.equal(kept.length, 2);
  assert.match(kept[1], /2 inactive cluster\(s\) kept open/);

  for (const f of findingStore.rows) f.acked = true; // …and then the rest
  await svc.resolveStale();
  assert.ok(logger.lines.info.some((l) => l.includes('no inactive clusters are held open any more')));
  // Still quiet once nothing is held.
  const before = logger.lines.info.length;
  await svc.resolveStale();
  assert.equal(logger.lines.info.length, before);
});

// ---- simulation ------------------------------------------------------------

test('simulation: 10 agents share one finding-type within 3 min -> exactly ONE cluster, all 10 members, confidence above baseline', async () => {
  const { confidenceBreakdown } = require('../src/analysis/crossAgentCorrelator');
  const agents = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, location_id: 10 })); // one shared site
  const findings = Array.from({ length: 10 }, (_, i) => finding({
    id: `s${i + 1}`, hostId: String(i + 1), metric: 'probe.loss', severity: 'WARN',
    createdAt: ago((i % 3) * 60000), // spread across a 0..2 min (i.e. <3 min) window
  }));
  const { svc, repo } = svcWith({ agents, findings });

  const summary = await svc.detectAndPersist();
  assert.equal(summary.created, 1);            // exactly ONE cluster
  assert.equal(repo.rows.length, 1);
  assert.equal(repo.rows[0].member_finding_ids.length, 10); // all 10 members
  assert.equal(repo.rows[0].confidence, 'high');            // same site + same type

  // Confidence is above the single-signal (time-only) baseline.
  const bd = confidenceBreakdown('high', findings);
  assert.ok(bd.aboveBaseline, 'clustered confidence exceeds the single-signal baseline');
  assert.ok(bd.score > bd.baseline);
});

// ---- Step 2: cluster-level advisory ---------------------------------------

const highFindings = () => [
  finding({ id: 'a', hostId: '1', metric: 'probe.loss', createdAt: ago(90000) }),
  finding({ id: 'b', hostId: '2', metric: 'probe.loss', createdAt: ago(30000) }),
];

test('a HIGH cluster gets an AI advisory stored + published WITH its evidence (assistant enabled)', async () => {
  const assistant = fakeAssistant();
  const { svc, repo, published } = svcWith({ findings: highFindings(), assistant });
  await svc.detectAndPersist();
  assert.equal(assistant.calls.length, 1);
  assert.equal(repo.rows[0].advisory, 'Likely a shared uplink fault at the site. Check the site switch/WAN.');
  // The advisory publish carries the evidence list (member findings).
  const advEvent = published.find((p) => p.advisory);
  assert.ok(advEvent, 'an advisory event was published');
  assert.ok(Array.isArray(advEvent.evidence) && advEvent.evidence.length === 2);
  assert.deepEqual(advEvent.evidence.map((e) => e.findingId).sort(), ['a', 'b']);
});

test('a LOW cluster gets NO advisory (medium/high only)', async () => {
  const assistant = fakeAssistant();
  const { svc, repo } = svcWith({
    agents: [{ id: 1, location_id: 10 }, { id: 2, location_id: 20 }], // different sites -> low
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'cpu', createdAt: ago(90000) }),
      finding({ id: 'b', hostId: '2', metric: 'cpu', createdAt: ago(30000) }),
    ],
    assistant,
  });
  await svc.detectAndPersist();
  assert.equal(assistant.calls.length, 0);
  assert.equal(repo.rows[0].advisory, null);
});

test('no advisory when the assistant is opted out (disabled)', async () => {
  const assistant = fakeAssistant({ enabled: false });
  const { svc, repo } = svcWith({ findings: highFindings(), assistant });
  await svc.detectAndPersist();
  assert.equal(assistant.calls.length, 0);
  assert.equal(repo.rows[0].advisory, null);
});

test('an "insufficient context" answer is NOT surfaced as advice', async () => {
  const assistant = fakeAssistant({ answer: 'There is not enough data to reach a conclusion.' });
  const { svc, repo, published } = svcWith({ findings: highFindings(), assistant });
  await svc.detectAndPersist();
  assert.equal(assistant.calls.length, 1);
  assert.equal(repo.rows[0].advisory, null);
  assert.ok(!published.some((p) => p.advisory));
});

test('an assistant failure never breaks the sweep (advisory just absent)', async () => {
  const assistant = fakeAssistant({ throws: true });
  const { svc, repo } = svcWith({ findings: highFindings(), assistant });
  const summary = await svc.detectAndPersist();
  assert.equal(summary.created, 1);           // cluster still created
  assert.equal(repo.rows[0].advisory, null);  // advisory absent, no throw
});

test('advisory is generated once, not regenerated on the next sweep', async () => {
  const assistant = fakeAssistant();
  const { svc } = svcWith({ findings: highFindings(), assistant });
  await svc.detectAndPersist();
  await svc.detectAndPersist();
  assert.equal(assistant.calls.length, 1); // second sweep sees advisory already set -> no call
});

// ---- Step 3: cluster-level alerting ---------------------------------------

test('a medium/high cluster fires exactly ONE cluster-level alert, referencing already-alerted members', async () => {
  const alertDispatcher = makeDispatcher();
  const alertLog = makeAlertDispatchLogRepo();
  // Member 'a' was already alerted individually (finding-level).
  await alertLog.record({ subjectType: 'finding', subjectId: 'a', sentAt: T });
  const { svc } = svcWith({ findings: highFindings(), alertDispatcher, alertLog });
  await svc.detectAndPersist();
  assert.equal(alertDispatcher.clusterCalls.length, 1);
  const { cluster, group } = alertDispatcher.clusterCalls[0];
  assert.equal(cluster.metric, 'event_cluster');
  assert.equal(cluster.severity, 'WARN'); // max of the two WARN members
  assert.ok(Array.isArray(cluster.evidence) && cluster.evidence.length === 2);
  assert.deepEqual(group.memberFindingIds.sort(), ['a', 'b']);
  assert.deepEqual(group.alreadyAlerted, ['a']); // referenced, not resent
});

test('a LOW cluster fires NO cluster alert', async () => {
  const alertDispatcher = makeDispatcher();
  const { svc } = svcWith({
    agents: [{ id: 1, location_id: 10 }, { id: 2, location_id: 20 }], // different sites -> low
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'cpu', createdAt: ago(90000) }),
      finding({ id: 'b', hostId: '2', metric: 'cpu', createdAt: ago(30000) }),
    ],
    alertDispatcher,
  });
  await svc.detectAndPersist();
  assert.equal(alertDispatcher.clusterCalls.length, 0);
});

test('the cluster alert carries the AI advisory when one was generated', async () => {
  const alertDispatcher = makeDispatcher();
  const assistant = fakeAssistant();
  const { svc } = svcWith({ findings: highFindings(), assistant, alertDispatcher });
  await svc.detectAndPersist();
  assert.equal(alertDispatcher.clusterCalls.length, 1);
  assert.equal(alertDispatcher.clusterCalls[0].group.advisory, 'Likely a shared uplink fault at the site. Check the site switch/WAN.');
  assert.match(alertDispatcher.clusterCalls[0].cluster.explanation, /uplink/);
});

test('a dispatcher failure never breaks the sweep', async () => {
  const alertDispatcher = makeDispatcher({ dispatchCluster: async () => { throw new Error('smtp down'); } });
  const { svc, repo } = svcWith({ findings: highFindings(), alertDispatcher });
  const summary = await svc.detectAndPersist();
  assert.equal(summary.created, 1);
  assert.equal(repo.rows.length, 1); // cluster still persisted
});

// ---- best-effort -----------------------------------------------------------

test('a finding-store failure is swallowed (never throws to the sweep)', async () => {
  const findingStore = makeFindingStore({ list: async () => { throw new Error('db down'); } });
  const svc = createCrossAgentClusterService({
    clustersRepo: makeEventClustersRepo(),
    findingStore,
    agentsRepo: makeAgentsRepo(),
    now: () => T,
  });
  const summary = await svc.detectAndPersist();
  assert.deepEqual(summary, { created: 0, updated: 0 });
});

test('unrelated findings spread beyond the window create no cluster', async () => {
  const { svc, repo } = svcWith({
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'cpu', createdAt: ago(4 * 60 * 1000) }),
      // 'b' is outside the 5-min load window entirely, so it is never even fetched.
      finding({ id: 'b', hostId: '2', metric: 'cpu', createdAt: ago(30 * 60 * 1000) }),
    ],
  });
  const summary = await svc.detectAndPersist();
  assert.equal(summary.created, 0);
  assert.equal(repo.rows.length, 0);
});
