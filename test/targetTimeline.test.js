'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeFindingStore, makeIncidentsRepo,
  makeAuditEventsRepo, makeIncidentCasesRepo, makeRemediationPlaybooksRepo, authHeader,
} = require('../test-support/fakes');
const { buildTargetTimeline } = require('../src/timeline/targetTimeline');

const AGENT_ID = 9;
const WINDOW = '?from=2026-06-01T00:00:00Z&to=2026-06-01T23:59:59Z';

// Builds an app whose agent #9 has one of every source in the query window.
function seededApp(over = {}) {
  const agentsRepo = over.agentsRepo || makeAgentsRepo({
    findById: async (id) => (id === AGENT_ID ? { id: AGENT_ID, hostname: 'core-sw' } : null),
  });

  const findingStore = over.findingStore || makeFindingStore();
  if (!over.findingStore) {
    findingStore.rows.push({
      id: 'f-1', hostId: String(AGENT_ID), metric: 'cpu', kind: 'ANOMALY',
      severity: 'CRIT', explanation: 'CPU sustained above baseline',
      createdAt: '2026-06-01T08:00:00Z',
    });
  }

  const incidentsRepo = over.incidentsRepo || makeIncidentsRepo();
  if (!over.incidentsRepo) {
    incidentsRepo.rows.push({
      id: 1, agent_id: AGENT_ID, metric: 'reachability', severity: 'critical',
      started_at: new Date('2026-06-01T07:00:00Z'), resolved_at: new Date('2026-06-01T07:30:00Z'),
      duration_seconds: 1800, affected_target: '8.8.8.8',
    });
  }

  const auditEventsRepo = over.auditEventsRepo || makeAuditEventsRepo();
  if (!over.auditEventsRepo) {
    auditEventsRepo.rows.push(
      { id: 10, ts: '2026-06-01T06:00:00Z', actorType: 'agent', actorId: AGENT_ID, action: 'agent.online', ip: '10.0.0.5' },
      { id: 11, ts: '2026-06-01T09:00:00Z', actorType: 'agent', actorId: AGENT_ID, action: 'agent.offline', ip: null },
      // Recurring activity — must NOT appear as a timeline event.
      { id: 12, ts: '2026-06-01T08:30:00Z', actorType: 'agent', actorId: AGENT_ID, action: 'agent.traffic-report', ip: null },
    );
  }

  const incidentCasesRepo = over.incidentCasesRepo || makeIncidentCasesRepo();
  const remediationPlaybooksRepo = over.remediationPlaybooksRepo || makeRemediationPlaybooksRepo();

  const app = makeApp({
    agentsRepo, findingStore, incidentsRepo, auditEventsRepo,
    incidentCasesRepo, remediationPlaybooksRepo,
  });
  return { app, agentsRepo, findingStore, incidentsRepo, auditEventsRepo, incidentCasesRepo, remediationPlaybooksRepo };
}

async function seedPlaybookRun(remediationPlaybooksRepo) {
  const pbId = await remediationPlaybooksRepo.create({ name: 'Restart iface', trigger_condition: 'cpu', action_type: 'manual' });
  await remediationPlaybooksRepo.recordRun({
    incidentCaseId: 1, playbookId: pbId, hostId: String(AGENT_ID), status: 'success', resultText: 'done',
    ranAt: new Date('2026-06-01T08:10:00Z'),
  });
}

// ---- 200 with a full event list ------------------------------------------

test('GET /api/targets/:id/timeline merges all sources, newest-first → 200', async () => {
  const ctx = seededApp();
  await seedPlaybookRun(ctx.remediationPlaybooksRepo);

  const res = await request(ctx.app)
    .get(`/api/targets/${AGENT_ID}/timeline${WINDOW}`)
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200);
  assert.equal(res.body.partial, false);
  assert.deepEqual(res.body.failedSources, []);

  const ev = res.body.events;
  // finding + 2×incident(open+resolved) + online + offline + playbook = 6.
  // The recurring traffic-report row is filtered out.
  assert.equal(ev.length, 6);

  // Descending by timestamp.
  const times = ev.map((e) => e.timestamp);
  const sorted = [...times].sort((a, b) => new Date(b) - new Date(a));
  assert.deepEqual(times, sorted);

  assert.equal(ev[0].type, 'agent.offline');   // 09:00, newest
  assert.equal(ev[ev.length - 1].type, 'agent.online'); // 06:00, oldest

  // Every event carries the normalised contract shape + a deep-link ref_id.
  for (const e of ev) {
    assert.ok(['finding', 'incident', 'agent', 'playbook'].includes(e.source));
    assert.ok(['INFO', 'WARN', 'CRIT'].includes(e.severity), `severity ${e.severity}`);
    assert.ok(e.ref_id != null && e.ref_id !== '', 'ref_id present');
    assert.equal(typeof e.summary, 'string');
  }

  // Cross-source severity normalisation: the critical incident → CRIT.
  const open = ev.find((e) => e.type === 'incident.reachability');
  assert.equal(open.severity, 'CRIT');
  assert.equal(open.ref_id, 1);

  // The finding deep-links back by its uuid.
  const finding = ev.find((e) => e.source === 'finding');
  assert.equal(finding.ref_id, 'f-1');
  assert.equal(finding.type, 'cpu');
});

// ---- 200 empty (not 404) --------------------------------------------------

test('GET /api/targets/:id/timeline returns [] (not 404) when no events → 200', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async (id) => (id === AGENT_ID ? { id: AGENT_ID, hostname: 'q' } : null) });
  const app = makeApp({ agentsRepo });
  const res = await request(app)
    .get(`/api/targets/${AGENT_ID}/timeline${WINDOW}`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.events, []);
  assert.equal(res.body.partial, false);
});

// ---- 404 unknown target ---------------------------------------------------

test('GET /api/targets/:id/timeline → 404 when the target does not exist', async () => {
  const { app } = seededApp();
  const res = await request(app)
    .get(`/api/targets/999/timeline${WINDOW}`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

// ---- 400 validation -------------------------------------------------------

test('GET /api/targets/:id/timeline → 400 on invalid from', async () => {
  const { app } = seededApp();
  const res = await request(app)
    .get(`/api/targets/${AGENT_ID}/timeline?from=not-a-date`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/targets/:id/timeline → 400 on invalid to', async () => {
  const { app } = seededApp();
  const res = await request(app)
    .get(`/api/targets/${AGENT_ID}/timeline?to=nonsense`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/targets/:id/timeline → 400 when from is after to', async () => {
  const { app } = seededApp();
  const res = await request(app)
    .get(`/api/targets/${AGENT_ID}/timeline?from=2026-06-02T00:00:00Z&to=2026-06-01T00:00:00Z`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/targets/:id/timeline → 400 on non-numeric id', async () => {
  const { app } = seededApp();
  const res = await request(app)
    .get('/api/targets/abc/timeline')
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

test('GET /api/targets/:id/timeline → 400 on invalid limit', async () => {
  const { app } = seededApp();
  const res = await request(app)
    .get(`/api/targets/${AGENT_ID}/timeline?limit=0`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 400);
});

// ---- RBAC -----------------------------------------------------------------

test('GET /api/targets/:id/timeline requires auth → 401', async () => {
  const { app } = seededApp();
  assert.equal((await request(app).get(`/api/targets/${AGENT_ID}/timeline`)).status, 401);
});

// ---- partial-failure path (one source down, others survive) ---------------

test('GET /api/targets/:id/timeline flags partial:true when a source fails, keeps the rest', async () => {
  const findingStore = makeFindingStore({ list: async () => { throw new Error('findings backend down'); } });
  const ctx = seededApp({ findingStore });

  const res = await request(ctx.app)
    .get(`/api/targets/${AGENT_ID}/timeline${WINDOW}`)
    .set('Authorization', authHeader('viewer'));

  assert.equal(res.status, 200); // NOT a 500 — one bad source must not blank it
  assert.equal(res.body.partial, true);
  assert.ok(res.body.failedSources.includes('findings'));
  // The surviving sources still produce events (incidents + agent lifecycle).
  assert.ok(res.body.events.length >= 3);
  assert.ok(!res.body.events.some((e) => e.source === 'finding'));
});

// ---- limit cap ------------------------------------------------------------

test('GET /api/targets/:id/timeline honours limit (most recent first)', async () => {
  const { app } = seededApp();
  const res = await request(app)
    .get(`/api/targets/${AGENT_ID}/timeline${WINDOW}&limit=1`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 1);
  assert.equal(res.body.events[0].type, 'agent.offline'); // the newest event
});

// ---- default 24h window ---------------------------------------------------

test('GET /api/targets/:id/timeline defaults to the last 24h when from/to omitted', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: AGENT_ID, hostname: 'q' }) });
  const findingStore = makeFindingStore();
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 2d ago
  findingStore.rows.push(
    { id: 'recent', hostId: String(AGENT_ID), metric: 'cpu', severity: 'WARN', explanation: 'recent', createdAt: recent },
    { id: 'old', hostId: String(AGENT_ID), metric: 'cpu', severity: 'WARN', explanation: 'old', createdAt: old },
  );
  const app = makeApp({ agentsRepo, findingStore });
  const res = await request(app)
    .get(`/api/targets/${AGENT_ID}/timeline`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const ids = res.body.events.map((e) => e.ref_id);
  assert.ok(ids.includes('recent'));
  assert.ok(!ids.includes('old')); // outside the default 24h window
});

// ---- historical window: findings must be bounded by `to`, not just `from` --
// Regression guard for the truncation bug: without an upper bound in the query,
// a `limit` applied to [from, now] can hide the in-window rows for a window that
// ends in the past. Here the newer (out-of-window) findings must NOT crowd out
// the in-window one, and none of them should leak into the result.
test('GET /api/targets/:id/timeline bounds findings by `to` for a past window', async () => {
  const agentsRepo = makeAgentsRepo({ findById: async () => ({ id: AGENT_ID, hostname: 'q' }) });
  const findingStore = makeFindingStore();
  // One finding inside the window …
  findingStore.rows.push({ id: 'in-window', hostId: String(AGENT_ID), metric: 'cpu', severity: 'WARN', explanation: 'in', createdAt: '2026-06-01T07:00:00Z' });
  // … and several NEWER ones after `to` that would fill a small limit first.
  for (let i = 0; i < 5; i += 1) {
    findingStore.rows.push({ id: `after-${i}`, hostId: String(AGENT_ID), metric: 'cpu', severity: 'WARN', explanation: 'after', createdAt: `2026-06-01T1${i}:00:00Z` });
  }
  const app = makeApp({ agentsRepo, findingStore });
  const res = await request(app)
    .get(`/api/targets/${AGENT_ID}/timeline?from=2026-06-01T00:00:00Z&to=2026-06-01T08:00:00Z&limit=3`)
    .set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 200);
  const ids = res.body.events.filter((e) => e.source === 'finding').map((e) => e.ref_id);
  assert.deepEqual(ids, ['in-window']); // the past-window finding survives; none of the newer ones leak
});

// ---- pure builder unit tests ---------------------------------------------

test('buildTargetTimeline sorts descending and normalises severity', () => {
  const events = buildTargetTimeline({
    findings: [{ id: 'f1', metric: 'cpu', severity: 'crit', explanation: 'x', createdAt: '2026-06-01T02:00:00Z' }],
    incidents: [{ id: 1, metric: 'latency', severity: 'warning', affectedTarget: 'x', startedAt: '2026-06-01T01:00:00Z' }],
    agentEvents: [{ id: 5, action: 'agent.offline', ts: '2026-06-01T03:00:00Z' }],
  });
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'agent.offline');
  assert.equal(events[0].severity, 'WARN');
  assert.equal(events[1].severity, 'CRIT'); // 'crit' → CRIT
  assert.equal(events[2].severity, 'WARN'); // 'warning' → WARN
});

test('buildTargetTimeline emits open + resolved for a resolved incident', () => {
  const events = buildTargetTimeline({
    incidents: [{ id: 1, metric: 'reachability', severity: 'critical', affectedTarget: '8.8.8.8', startedAt: '2026-06-01T01:00:00Z', resolvedAt: '2026-06-01T01:30:00Z', durationSeconds: 1800 }],
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'incident.reachability.resolved');
  assert.equal(events[0].severity, 'INFO');
  assert.equal(events[1].type, 'incident.reachability');
  assert.equal(events[1].severity, 'CRIT');
  assert.equal(events[0].ref_id, 1);
});

test('buildTargetTimeline ignores non-lifecycle agent events and null timestamps', () => {
  const events = buildTargetTimeline({
    agentEvents: [
      { id: 1, action: 'agent.traffic-report', ts: '2026-06-01T01:00:00Z' },
      { id: 2, action: 'agent.online', ts: null },
      { id: 3, action: 'agent.online', ts: '2026-06-01T02:00:00Z' },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].ref_id, 3);
});

test('buildTargetTimeline caps to limit (most recent)', () => {
  const findings = Array.from({ length: 5 }, (_, i) => ({
    id: `f${i}`, metric: 'cpu', severity: 'INFO', explanation: 'x',
    createdAt: `2026-06-0${i + 1}T00:00:00Z`,
  }));
  const events = buildTargetTimeline({ findings, limit: 2 });
  assert.equal(events.length, 2);
  assert.equal(events[0].ref_id, 'f4'); // newest
  assert.equal(events[1].ref_id, 'f3');
});
