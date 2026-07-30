'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// API tests for the changes landing page (Fase 2).
//
//   GET  /api/changes?since=&window=&limit=&offset=   viewer+
//   POST /api/changes/seen                            viewer+
//
// The rule this file exists to protect: the per-user marker moves ONLY on the
// explicit POST. A marker that advanced on read would mean the page could never
// show anyone anything after the first load — the exact failure the feature is
// meant to fix.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeUsersRepo,
  makeAuditEventsRepo,
  makeFindingStore,
  makeIncidentsRepo,
  makeTopologyChangesRepo,
  makeAuditLogRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');
const { createAuditLogger } = require('../src/services/complianceLogger');

const AGENTS = [
  { id: 7, hostname: 'sw-core', display_name: 'Core switch', last_seen: new Date().toISOString(), capabilities: {} },
  { id: 8, hostname: 'sw-edge', display_name: null, last_seen: new Date().toISOString(), capabilities: {} },
];

const minutesAgo = (n) => new Date(Date.now() - n * 60000);

function appWith(overrides = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => AGENTS }),
    ...overrides,
  });
}

const get = (app, qs = '', role = 'viewer') =>
  request(app).get(`/api/changes${qs}`).set('Authorization', authHeader(role));

// An audit-events fake carrying two agent transitions inside the window.
function agentTransitions() {
  return makeAuditEventsRepo({
    findByActor: async () => ([
      { id: 1, action: 'agent.offline', actorId: 7, lastSeenAt: minutesAgo(30).toISOString() },
      { id: 2, action: 'agent.online', actorId: 7, lastSeenAt: minutesAgo(20).toISOString() },
    ]),
  });
}

// ------------------------------------------------------------------ auth/RBAC
test('GET /api/changes returns 401 without a token', async () => {
  assert.equal((await request(appWith()).get('/api/changes')).status, 401);
});

test('viewer, operator and admin may all read the changes feed', async () => {
  for (const role of ['viewer', 'operator', 'admin']) {
    assert.equal((await get(appWith(), '', role)).status, 200, `${role} should be allowed`);
  }
});

// ------------------------------------------------------------------------ 400
test('GET /api/changes returns 400 for an invalid window', async () => {
  const app = appWith();
  for (const w of ['soon', '0h', '-5m', '99d', '1y', '5x', '']) {
    if (w === '') continue; // empty means "use the default", tested below
    const res = await get(app, `?window=${encodeURIComponent(w)}`);
    assert.equal(res.status, 400, `window=${w} should be rejected`);
  }
});

test('GET /api/changes accepts m/h/d windows and a bare number of minutes', async () => {
  const app = appWith();
  for (const w of ['30m', '6h', '7d', '90']) {
    assert.equal((await get(app, `?window=${w}`)).status, 200, `window=${w} should be accepted`);
  }
});

test('GET /api/changes returns 400 for an invalid since', async () => {
  const app = appWith();
  assert.equal((await get(app, '?since=not-a-date')).status, 400);
  // A future reference point cannot describe what already happened.
  const future = new Date(Date.now() + 3600_000).toISOString();
  assert.equal((await get(app, `?since=${encodeURIComponent(future)}`)).status, 400);
  // Beyond the scan ceiling this stops being "what changed" and becomes a report.
  const ancient = new Date(Date.now() - 400 * 24 * 3600_000).toISOString();
  assert.equal((await get(app, `?since=${encodeURIComponent(ancient)}`)).status, 400);
});

test('GET /api/changes returns 400 for an invalid limit or offset', async () => {
  const app = appWith();
  for (const q of ['?limit=0', '?limit=501', '?limit=abc', '?offset=-1', '?offset=x']) {
    assert.equal((await get(app, q)).status, 400, `${q} should be rejected`);
  }
});

// ------------------------------------------------------------------------ 200
test('GET /api/changes returns transitions in the window, grouped by severity', async () => {
  const app = appWith({ auditEventsRepo: agentTransitions() });
  const res = await get(app, '?window=6h');

  assert.equal(res.status, 200);
  assert.ok(res.body.events.length >= 2);
  const offline = res.body.events.find((e) => e.type === 'agent.offline');
  assert.ok(offline, 'expected the disconnect');
  assert.match(offline.summary, /Core switch went offline/);
  assert.equal(offline.severity, 'WARN');
  // Grouping is present and ordered.
  const severities = res.body.groups.map((g) => g.severity);
  assert.deepEqual(severities, severities.slice().sort((a, b) => ['CRIT', 'WARN', 'INFO'].indexOf(a) - ['CRIT', 'WARN', 'INFO'].indexOf(b)));
});

test('an empty window is 200 with an empty list AND the reference time', async () => {
  // Not 404, and never a blank body: "nothing changed since 06:00" is the
  // answer, and the timestamp is the half that makes it meaningful.
  const res = await get(appWith(), '?window=30m');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.events, []);
  assert.deepEqual(res.body.groups, []);
  assert.equal(res.body.total, 0);
  assert.ok(res.body.since, 'the reference time must be present');
  assert.ok(res.body.until);
  assert.ok(!Number.isNaN(Date.parse(res.body.since)));
});

test('the window bounds what is returned', async () => {
  const auditEventsRepo = makeAuditEventsRepo({
    findByActor: async () => ([
      { id: 1, action: 'agent.offline', actorId: 7, lastSeenAt: minutesAgo(10).toISOString() },
      { id: 2, action: 'agent.offline', actorId: 8, lastSeenAt: minutesAgo(600).toISOString() },
    ]),
  });
  const res = await get(appWith({ auditEventsRepo }), '?window=30m');
  const ids = res.body.events.filter((e) => e.kind === 'agent_state').map((e) => e.ref_id);
  assert.deepEqual(ids, [1], 'the 10-hour-old transition is outside a 30m window');
});

test('limit caps the page and truncated reports the overflow', async () => {
  // Ten DIFFERENT agents: ten disconnects of ONE agent is a flapping agent, which
  // the feed correctly folds into a single counted row (see the test below).
  const auditEventsRepo = makeAuditEventsRepo({
    findByActor: async () => Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, action: 'agent.offline', actorId: i + 1, lastSeenAt: minutesAgo(i + 1).toISOString(),
    })),
  });
  const res = await get(appWith({ auditEventsRepo }), '?window=6h&limit=3');

  assert.equal(res.body.returned, 3);
  assert.equal(res.body.total, 10);
  assert.equal(res.body.truncated, true);
});

test('one agent flapping is ONE counted row, not ten', async () => {
  // The complaint this answers: a feed of 52 critical rows describing a handful of
  // conditions. The count is the diagnosis — ten disconnects is a flapping link,
  // and the row says so instead of leaving the reader to tally rows.
  const auditEventsRepo = makeAuditEventsRepo({
    findByActor: async () => Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, action: 'agent.offline', actorId: 7, lastSeenAt: minutesAgo(i + 1).toISOString(),
    })),
  });
  const res = await get(appWith({ auditEventsRepo }), '?window=6h');

  const rows = res.body.events.filter((e) => e.kind === 'agent_state');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 10);
  assert.equal(res.body.rawTotal, 10);
  assert.equal(res.body.correlated, 9, 'and the response says how many it folded');
});

test('every event links back to something the UI can open', async () => {
  const res = await get(appWith({ auditEventsRepo: agentTransitions() }), '?window=6h');
  for (const e of res.body.events) {
    assert.ok('ref_id' in e, 'every row needs a reference to open');
    assert.ok(e.kind, 'every row needs a kind for its label');
    assert.ok(e.timestamp);
  }
});

// -------------------------------------------------------------- current state
test('a stale heartbeat is reported as current state, not as a change', async () => {
  const agentsRepo = makeAgentsRepo({
    findAll: async () => [{ id: 7, hostname: 'sw-core', display_name: null, last_seen: minutesAgo(120).toISOString(), capabilities: {} }],
  });
  const res = await get(appWith({ agentsRepo }), '?window=30m');

  const row = res.body.events.find((e) => e.type === 'agent.heartbeat_stale');
  assert.ok(row, 'expected the silent agent to be surfaced');
  // The flag is what lets the UI say "current state" instead of implying the
  // condition began inside the window — we do not know when it began.
  assert.equal(row.currentState, true);
  assert.equal(row.kind, 'agent_health');
});

// ------------------------------------------------------------ partial failure
test('one failing source degrades to partial rather than blanking the page', async () => {
  // This is the page a shift STARTS on; one dead source must not empty it.
  const findingStore = makeFindingStore({ list: throwingAsync('findings unavailable') });
  const res = await get(appWith({ findingStore, auditEventsRepo: agentTransitions() }), '?window=6h');

  assert.equal(res.status, 200);
  assert.equal(res.body.partial, true);
  assert.deepEqual(res.body.failedSources, ['findings']);
  assert.ok(res.body.events.length > 0, 'the surviving sources still answer');
});

test('GET /api/changes returns 500 when the agent list itself fails', async () => {
  // Loading agents happens before the fan-out and every mapper labels from it,
  // so this one is genuinely fatal.
  const agentsRepo = makeAgentsRepo({ findAll: throwingAsync() });
  const res = await get(appWith({ agentsRepo }), '?window=6h');

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
  assert.ok(!/at Object|at async|\.js:\d+:\d+/.test(JSON.stringify(res.body)), 'must not leak a stack trace');
});

// ------------------------------------------------------------- the seen marker
test('GET does NOT move the marker — no matter how many times it is called', async () => {
  // The rule the whole feature rests on.
  const usersRepo = makeUsersRepo();
  const app = appWith({ usersRepo });

  assert.equal(await usersRepo.getLastSeenChanges(1), null);
  await get(app, '?since=last_login');
  await get(app, '?window=6h');
  await get(app, '?since=last_login');
  assert.equal(await usersRepo.getLastSeenChanges(1), null, 'a read must never advance the marker');
});

test('POST /api/changes/seen is the only thing that moves the marker', async () => {
  const usersRepo = makeUsersRepo();
  const app = appWith({ usersRepo });

  const res = await request(app).post('/api/changes/seen')
    .set('Authorization', authHeader('viewer')).send({});

  assert.equal(res.status, 200);
  assert.ok(res.body.lastSeenChanges);
  const stored = await usersRepo.getLastSeenChanges(1);
  assert.ok(stored instanceof Date);
});

test('since=last_login reads the marker once it is set', async () => {
  const marker = minutesAgo(45);
  const usersRepo = makeUsersRepo({ initialLastSeenChanges: marker });
  const res = await get(appWith({ usersRepo }), '?since=last_login');

  assert.equal(res.status, 200);
  assert.equal(res.body.sinceMode, 'marker');
  assert.equal(res.body.since, marker.toISOString());
});

test('since=last_login falls back to the default window when no marker exists', async () => {
  // A first-time visitor wants their shift, not four years of history.
  const res = await get(appWith({ usersRepo: makeUsersRepo() }), '?since=last_login&window=6h');

  assert.equal(res.status, 200);
  assert.equal(res.body.sinceMode, 'window');
  const ageMs = Date.parse(res.body.until) - Date.parse(res.body.since);
  assert.ok(Math.abs(ageMs - 6 * 3600_000) < 5000, `expected a 6h window, got ${ageMs}ms`);
});

test('the marker is monotonic — a stale tab cannot rewind it', async () => {
  const usersRepo = makeUsersRepo();
  const app = appWith({ usersRepo });
  const post = (at) => request(app).post('/api/changes/seen')
    .set('Authorization', authHeader('viewer')).send(at ? { at } : {});

  const recent = minutesAgo(5).toISOString();
  await post(recent);
  await post(minutesAgo(600).toISOString()); // a tab left open since this morning

  const stored = await usersRepo.getLastSeenChanges(1);
  assert.equal(stored.toISOString(), recent, 'an old mark must not re-surface handled changes');
});

test('POST /api/changes/seen returns 400 for a bad or future timestamp', async () => {
  const app = appWith({ usersRepo: makeUsersRepo() });
  const post = (at) => request(app).post('/api/changes/seen')
    .set('Authorization', authHeader('viewer')).send({ at });

  assert.equal((await post('not-a-date')).status, 400);
  assert.equal((await post(new Date(Date.now() + 3600_000).toISOString())).status, 400);
});

test('POST /api/changes/seen returns 401 without a token', async () => {
  assert.equal((await request(appWith()).post('/api/changes/seen').send({})).status, 401);
});

test('marking as seen is audited', async () => {
  const auditLogRepo = makeAuditLogRepo();
  const app = appWith({ usersRepo: makeUsersRepo(), auditLogRepo, auditLogger: createAuditLogger({ auditLogRepo }) });

  await request(app).post('/api/changes/seen').set('Authorization', authHeader('operator')).send({});

  const entry = auditLogRepo.rows.find((r) => r.action === 'changes_marked_seen');
  assert.ok(entry, 'expected an audit entry');
  assert.equal(entry.actorEmail, 'operator@blueeye.local');
});

test('POST /api/changes/seen returns 500 when the write fails', async () => {
  const usersRepo = makeUsersRepo({ setLastSeenChanges: throwingAsync() });
  const res = await request(appWith({ usersRepo })).post('/api/changes/seen')
    .set('Authorization', authHeader('viewer')).send({});

  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Internal Server Error');
});

// -------------------------------------------------- correlation, end to end
// The complaint that produced this: "Critical (52)" listing an anomaly row AND an
// event row for the same detection, repeated every time the condition came back —
// a handful of actual problems presented as fifty-two things to read.
test('a recurring condition is ONE event row, not an anomaly + event pair per occurrence', async () => {
  const { makeIncidentCasesRepo } = require('../test-support/fakes');

  // Six occurrences of one condition on agent 7. Each opened its own case (the
  // previous one having been resolved), and each has its anomaly linked to it —
  // exactly the shape the screenshot showed.
  //
  // One frozen base, so the assertions below compare exact timestamps rather than
  // racing a fresh Date.now() per helper call.
  const base = Date.now();
  const at = (mins) => new Date(base - mins * 60000).toISOString();
  const occurrences = [15, 45, 75, 105, 135, 165];
  const cases = occurrences.map((mins, i) => ({
    id: 100 + i,
    host_id: '7',
    title: 'CRIT probe.latency on Core switch (Copenhagen HQ)',
    status: 'open',
    severity: 'CRIT',
    primary_finding_id: `f${i}`,
    primary_metric: 'probe.latency',
    first_event_at: at(mins),
    last_event_at: at(mins),
    created_by: 'system',
  }));
  const incidentCasesRepo = makeIncidentCasesRepo();
  incidentCasesRepo.rows.push(...cases);

  const findingStore = makeFindingStore();
  occurrences.forEach((mins, i) => findingStore.rows.push({
    id: `f${i}`, hostId: '7', metric: 'probe.latency', severity: 'CRIT',
    createdAt: at(mins), incidentCaseId: 100 + i,
  }));

  const res = await get(appWith({ incidentCasesRepo, findingStore }), '?window=6h');
  assert.equal(res.status, 200);

  // Twelve raw occurrences (six anomalies + six events) → one row.
  assert.equal(res.body.rawTotal, 12);
  assert.equal(res.body.total, 1, 'one condition, one row');
  assert.equal(res.body.correlated, 11);

  const [row] = res.body.events;
  assert.equal(row.kind, 'event', 'the event survives; its anomalies fold into it');
  assert.equal(row.count, 6, 'and it says how many times the condition came back');
  assert.equal(row.findingCount, 6, 'and how many anomalies it absorbed');
  assert.equal(row.firstAt, at(165), 'with the span it happened over');
  assert.equal(row.timestamp, at(15), 'timestamped by its latest activity');
  assert.equal(row.family, 'latency', 'which is what the UI turns into "what this indicates"');
  assert.equal(row.refIds.length, 6, 'every folded record stays drillable');

  // No anomaly row survived beside the event that represents it.
  assert.equal(res.body.events.filter((e) => e.kind === 'finding').length, 0);
});

test('two different conditions on one device stay two rows', async () => {
  const { makeIncidentCasesRepo } = require('../test-support/fakes');
  const incidentCasesRepo = makeIncidentCasesRepo();
  incidentCasesRepo.rows.push(
    { id: 1, host_id: '7', title: 'CRIT probe.latency on Core switch', status: 'open', severity: 'CRIT', primary_metric: 'probe.latency', first_event_at: minutesAgo(30).toISOString(), last_event_at: minutesAgo(30).toISOString(), created_by: 'system' },
    { id: 2, host_id: '7', title: 'CRIT if.errors on Core switch', status: 'open', severity: 'CRIT', primary_metric: 'if.errors', first_event_at: minutesAgo(20).toISOString(), last_event_at: minutesAgo(20).toISOString(), created_by: 'system' }
  );

  const res = await get(appWith({ incidentCasesRepo }), '?window=6h');
  const rows = res.body.events.filter((e) => e.kind === 'event');
  assert.equal(rows.length, 2, 'latency and interface errors are different problems');
  assert.deepEqual(rows.map((r) => r.family).sort(), ['interface', 'latency']);
});

test('an anomaly with no event of its own is still reported', async () => {
  // Its event fell outside the window, or none exists yet. This row is the only
  // thing that would report the detection — folding it would lose it.
  const findingStore = makeFindingStore();
  findingStore.rows.push({
    id: 'orphan', hostId: '7', metric: 'cpu', severity: 'WARN',
    createdAt: minutesAgo(10).toISOString(), incidentCaseId: null,
  });
  const res = await get(appWith({ findingStore }), '?window=6h');
  const rows = res.body.events.filter((e) => e.kind === 'finding');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].family, 'resources');
});

test('no feed row ever renders a raw table name as its source', async () => {
  // `incident_case` was printed verbatim on the page because SOURCE_LABELS had no
  // entry for it. The source vocabulary is now the feed's contract.
  const { makeIncidentCasesRepo } = require('../test-support/fakes');
  const incidentCasesRepo = makeIncidentCasesRepo();
  incidentCasesRepo.rows.push({
    id: 1, host_id: '7', title: 'CRIT probe.latency on Core switch', status: 'open', severity: 'CRIT',
    primary_metric: 'probe.latency', first_event_at: minutesAgo(30).toISOString(), last_event_at: minutesAgo(30).toISOString(), created_by: 'system',
  });
  const incidentsRepo = makeIncidentsRepo({
    list: async () => [{ id: 9, agentId: 8, metric: 'loss', severity: 'critical', affectedTarget: '8.8.8.8', startedAt: minutesAgo(40).toISOString(), resolvedAt: null }],
  });

  const res = await get(appWith({ incidentCasesRepo, incidentsRepo, auditEventsRepo: agentTransitions() }), '?window=6h');
  const KNOWN = ['finding', 'event', 'probe', 'cluster', 'agent', 'interface', 'topology', 'playbook', 'config'];
  for (const e of res.body.events) {
    assert.ok(KNOWN.includes(e.source), `unlabelled source "${e.source}" would render as a raw key`);
    assert.ok(!String(e.source).includes('_case'), 'a table name must never reach the page');
  }
  // The two records that used to share the kind `incident` are now distinguishable.
  assert.ok(res.body.events.some((e) => e.kind === 'event'));
  assert.ok(res.body.events.some((e) => e.kind === 'probe'));
});
