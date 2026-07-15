'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCrossAgentClusterService } = require('../src/analysis/crossAgentClusterService');
const { makeIncidentClustersRepo, makeFindingStore, makeAgentsRepo, makeDispatcher, makeAlertDispatchLogRepo } = require('../test-support/fakes');

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
function svcWith({ findings = [], agents = [{ id: 1, location_id: 10 }, { id: 2, location_id: 10 }], publishCluster, clustersRepo, assistant, alertDispatcher, alertLog } = {}) {
  const repo = clustersRepo || makeIncidentClustersRepo();
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
    publishCluster: publishCluster || ((c) => published.push(c)),
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
  // Cluster event was published (server wraps it as {type:'incident_cluster'}).
  assert.equal(published.length, 1);
  assert.equal(published[0].status, 'open');
});

test('two agents, same site, different metric -> MEDIUM cluster', async () => {
  const { svc, repo } = svcWith({
    findings: [
      finding({ id: 'a', hostId: '1', metric: 'cpu', createdAt: ago(90000) }),
      finding({ id: 'b', hostId: '2', metric: 'mem', createdAt: ago(30000) }),
    ],
  });
  await svc.detectAndPersist();
  assert.equal(repo.rows.length, 1);
  assert.equal(repo.rows[0].confidence, 'medium');
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
  const repo = makeIncidentClustersRepo();
  const id = await repo.create({ confidence: 'high', memberFindingIds: ['a', 'b'], suspectedCommonCause: 'x', detectedAt: ago(20 * 60 * 1000) }); // 20 min ago
  const { svc, published } = svcWith({ clustersRepo: repo });
  const resolved = await svc.resolveStale();
  assert.equal(resolved, 1);
  assert.equal(repo.rows.find((r) => r.id === id).status, 'resolved');
  assert.ok(published.some((p) => p.status === 'resolved'));
});

test('resolveStale leaves recently-active clusters open', async () => {
  const repo = makeIncidentClustersRepo();
  await repo.create({ confidence: 'high', memberFindingIds: ['a'], detectedAt: ago(2 * 60 * 1000) }); // 2 min ago
  const { svc } = svcWith({ clustersRepo: repo });
  const resolved = await svc.resolveStale();
  assert.equal(resolved, 0);
  assert.equal(repo.rows[0].status, 'open');
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
  assert.equal(cluster.metric, 'incident_cluster');
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
    clustersRepo: makeIncidentClustersRepo(),
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
