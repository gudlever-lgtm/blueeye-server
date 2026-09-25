'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Select several events / situations and act on them in one go.
//
// Walking a queue one dialog at a time is how a backlog stops being read. But
// bulk is exactly where a state machine gets quietly bypassed and where an
// audit trail turns into one useless "bulk: 50 items" row — so both endpoints
// apply the SAME rules the single-item ones do, per item, and record per item.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeEventCasesRepo, makeEventClustersRepo, makeAuditLogRepo, makeSettingsService, authHeader,
} = require('../test-support/fakes');

const op = (app, method, path, body) => request(app)[method](path)
  .set('Authorization', authHeader('operator')).send(body);

// ============================================================ events
async function seededEvents() {
  const eventCasesRepo = makeEventCasesRepo();
  // open → investigating → resolved → closed is the legal chain.
  const open = await eventCasesRepo.create({ host_id: '9', title: 'a', last_event_at: new Date() });
  const inv1 = await eventCasesRepo.create({ host_id: '9', title: 'b', last_event_at: new Date() });
  const inv2 = await eventCasesRepo.create({ host_id: '9', title: 'c', last_event_at: new Date() });
  await eventCasesRepo.updateStatus(inv1, { from: 'open', to: 'investigating' });
  await eventCasesRepo.updateStatus(inv2, { from: 'open', to: 'investigating' });
  return { eventCasesRepo, open, inv1, inv2 };
}

test('several events move in one request, and each is audited on its own', async () => {
  const { eventCasesRepo, inv1, inv2 } = await seededEvents();
  const auditLogRepo = makeAuditLogRepo();
  const app = makeApp({ eventCasesRepo, auditLogRepo });

  const res = await op(app, 'post', '/api/events/bulk-status', { ids: [inv1, inv2], status: 'resolved' });
  assert.equal(res.status, 200);
  assert.equal(res.body.moved, 2);
  assert.ok(res.body.results.every((r) => r.outcome === 'moved'));

  // One row PER EVENT. "What happened to event 2" has to be answerable, and a
  // single batch row cannot answer it.
  const audited = auditLogRepo.rows.filter((r) => r.action === 'event_status_change');
  assert.equal(audited.length, 2);
  assert.deepEqual(audited.map((r) => r.target).sort(), [String(inv1), String(inv2)].sort());
  assert.match(audited[0].detail, /bulk/);
});

test('an open event CAN be resolved in one step', async () => {
  // Most events are read and dismissed in one go. Forcing them through
  // `investigating` recorded a step nobody performed, and an audit trail where
  // everything was "investigated" says nothing about the ones that were.
  const { eventCasesRepo, open, inv1 } = await seededEvents();
  const app = makeApp({ eventCasesRepo });

  const res = await op(app, 'post', '/api/events/bulk-status', { ids: [open, inv1], status: 'resolved' });
  assert.equal(res.status, 200);
  assert.equal(res.body.moved, 2, 'open and investigating both reach resolved');
  assert.equal(eventCasesRepo.rows.find((r) => r.id === open).status, 'resolved');
});

test('an illegal transition is REPORTED, not silently performed', async () => {
  // `closed` is still not reachable from `open` — resolving is not skippable,
  // and bulk must not become the door that bypasses what is left of the chain.
  const { eventCasesRepo, open, inv1 } = await seededEvents();
  await eventCasesRepo.updateStatus(inv1, { from: 'investigating', to: 'resolved' });
  const app = makeApp({ eventCasesRepo });

  const res = await op(app, 'post', '/api/events/bulk-status', { ids: [open, inv1], status: 'closed' });
  assert.equal(res.status, 200);
  assert.equal(res.body.moved, 1, 'the resolved one still closed');

  const bad = res.body.results.find((r) => r.id === open);
  assert.equal(bad.outcome, 'illegal');
  assert.equal(bad.from, 'open');
  // NAMED, not just counted: "1 could not be closed" is unactionable.
  assert.equal(eventCasesRepo.rows.find((r) => r.id === open).status, 'open');
});

test('partial success is a success — one stale row does not roll back the rest', async () => {
  const { eventCasesRepo, inv1 } = await seededEvents();
  const app = makeApp({ eventCasesRepo });
  const res = await op(app, 'post', '/api/events/bulk-status', { ids: [inv1, 9999], status: 'resolved' });

  assert.equal(res.status, 200);
  assert.equal(res.body.moved, 1);
  assert.equal(res.body.results.find((r) => r.id === 9999).outcome, 'not_found');
});

test('a reopen still needs its comment, in bulk too', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  const id = await eventCasesRepo.create({ host_id: '9', title: 'x', last_event_at: new Date() });
  for (const [from, to] of [['open', 'investigating'], ['investigating', 'resolved'], ['resolved', 'closed']]) {
    await eventCasesRepo.updateStatus(id, { from, to });
  }
  const app = makeApp({ eventCasesRepo });

  const without = await op(app, 'post', '/api/events/bulk-status', { ids: [id], status: 'open' });
  assert.equal(without.body.results[0].outcome, 'needs_comment');
  assert.equal(eventCasesRepo.rows.find((r) => r.id === id).status, 'closed');

  const withIt = await op(app, 'post', '/api/events/bulk-status', { ids: [id], status: 'open', comment: 'came back' });
  assert.equal(withIt.body.moved, 1);
});

// ---- the filter-scoped form ------------------------------------------------
// The cap is a bound on the request's WORK — a read, a guarded write and an
// audit row per id. A queue of a thousand open events is not cleared 500 ids at
// a time by somebody who is never going to scroll it, so the same transition
// can be scoped by FILTER instead: one statement, one audit row, no cap.

test('all: true moves everything matching the filters, past the id cap', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  for (let i = 0; i < 600; i += 1) {
    await eventCasesRepo.create({ host_id: '9', title: `e${i}`, last_event_at: new Date() });
  }
  const auditLogRepo = makeAuditLogRepo();
  const app = makeApp({ eventCasesRepo, auditLogRepo });

  const res = await op(app, 'post', '/api/events/bulk-status', {
    all: true, status: 'resolved', filters: { status: 'open' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.moved, 600, 'more than the 500-id cap, in one request');
  assert.equal(res.body.all, true);
  assert.ok(eventCasesRepo.rows.every((r) => r.status === 'resolved'));

  // ONE audit row, and the FILTER is the record: "resolved 600" that does not
  // say which 600 is not something an auditor can check afterwards.
  const audited = auditLogRepo.rows.filter((r) => r.action === 'event_status_change_bulk');
  assert.equal(audited.length, 1);
  assert.equal(audited[0].target, 'filter');
  assert.match(audited[0].detail, /moved=600/);
  assert.match(audited[0].detail, /status=open/);
});

test('all: true still obeys the state machine and the filters', async () => {
  const { eventCasesRepo, open, inv1, inv2 } = await seededEvents();
  await eventCasesRepo.updateStatus(inv2, { from: 'investigating', to: 'resolved' });
  const app = makeApp({ eventCasesRepo });

  // open|investigating → resolved is legal; the already-resolved one is not
  // matched (its status is not in the legal `from` set), so it is missed rather
  // than moved illegally.
  const res = await op(app, 'post', '/api/events/bulk-status', { all: true, status: 'resolved' });
  assert.equal(res.body.moved, 2);
  assert.equal(eventCasesRepo.rows.find((r) => r.id === open).status, 'resolved');
  assert.equal(eventCasesRepo.rows.find((r) => r.id === inv1).status, 'resolved');

  // A status filter that cannot reach the target is REFUSED, not answered with
  // "0 moved" — the operator asked for something the state machine forbids.
  const bad = await op(app, 'post', '/api/events/bulk-status', {
    all: true, status: 'closed', filters: { status: 'open' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /no event with status open can move to closed/);
});

test('all: true narrows by severity and device like the list does', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  const crit = await eventCasesRepo.create({ host_id: '7', title: 'a', severity: 'CRIT', last_event_at: new Date() });
  const warn = await eventCasesRepo.create({ host_id: '7', title: 'b', severity: 'WARN', last_event_at: new Date() });
  const other = await eventCasesRepo.create({ host_id: '8', title: 'c', severity: 'CRIT', last_event_at: new Date() });
  const app = makeApp({ eventCasesRepo });

  const res = await op(app, 'post', '/api/events/bulk-status', {
    all: true, status: 'resolved', filters: { severity: 'CRIT', device: '7' },
  });
  assert.equal(res.body.moved, 1);
  assert.equal(eventCasesRepo.rows.find((r) => r.id === crit).status, 'resolved');
  assert.equal(eventCasesRepo.rows.find((r) => r.id === warn).status, 'open', 'the severity filter was ignored');
  assert.equal(eventCasesRepo.rows.find((r) => r.id === other).status, 'open', 'the device filter was ignored');
});

test('a reopen needs its comment in the filter-scoped form too', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  const id = await eventCasesRepo.create({ host_id: '9', title: 'x', last_event_at: new Date() });
  for (const [from, to] of [['open', 'investigating'], ['investigating', 'resolved'], ['resolved', 'closed']]) {
    await eventCasesRepo.updateStatus(id, { from, to });
  }
  const app = makeApp({ eventCasesRepo });

  const without = await op(app, 'post', '/api/events/bulk-status', { all: true, status: 'open' });
  assert.equal(without.status, 400);
  assert.equal(eventCasesRepo.rows.find((r) => r.id === id).status, 'closed');

  const withIt = await op(app, 'post', '/api/events/bulk-status', { all: true, status: 'open', comment: 'came back' });
  assert.equal(withIt.body.moved, 1);
});

test('the cap and the all-form are what Settings → Events says they are', async () => {
  const { eventCasesRepo, inv1, inv2 } = await seededEvents();
  const settingsService = makeSettingsService();
  const app = makeApp({ eventCasesRepo, settingsService });

  // The list reports the policy, because Settings itself is admin-only and the
  // page still has to respect a cap it cannot read anywhere else.
  const list = await request(app).get('/api/events').set('Authorization', authHeader('operator'));
  assert.equal(list.body.bulkMax, 500);
  assert.equal(list.body.bulkAll, true);

  await settingsService.setEvents({ bulkMax: 1, bulkAll: false });
  const over = await op(app, 'post', '/api/events/bulk-status', { ids: [inv1, inv2], status: 'resolved' });
  assert.equal(over.status, 400);
  assert.equal(over.body.limit, 1);
  // With the all-form off, the error does not suggest it — and the form itself
  // is refused rather than quietly ignored.
  assert.doesNotMatch(over.body.error, /all: true/);
  assert.equal((await op(app, 'post', '/api/events/bulk-status', { all: true, status: 'resolved' })).status, 403);

  const after = await request(app).get('/api/events').set('Authorization', authHeader('operator'));
  assert.equal(after.body.bulkMax, 1);
  assert.equal(after.body.bulkAll, false);
});

test('events bulk: the boring guards', async () => {
  const { eventCasesRepo, inv1 } = await seededEvents();
  const app = makeApp({ eventCasesRepo });
  const post = (body, role = 'operator') => request(app).post('/api/events/bulk-status')
    .set('Authorization', authHeader(role)).send(body);

  assert.equal((await post({ ids: [], status: 'resolved' })).status, 400);
  assert.equal((await post({ ids: [inv1] })).status, 400, 'a status is required');
  assert.equal((await post({ ids: [inv1], status: 'nope' })).status, 400);
  assert.equal((await post({ ids: ['x'], status: 'resolved' })).status, 400);
  assert.equal((await post({ ids: Array.from({ length: 501 }, (_, i) => i + 1), status: 'resolved' })).status, 400);
  assert.equal((await post({ ids: [inv1], all: true, status: 'resolved' })).status, 400, 'ids and all are exclusive');
  assert.equal((await post({ all: true })).status, 400, 'a status is required for the all form too');
  assert.equal((await post({ all: true, status: 'resolved' }, 'viewer')).status, 403);
  assert.equal((await post({ ids: [inv1], status: 'resolved' }, 'viewer')).status, 403);
  assert.equal((await request(app).post('/api/events/bulk-status').send({ ids: [inv1], status: 'resolved' })).status, 401);
});

// ======================================================== situations
async function seededClusters() {
  const eventClustersRepo = makeEventClustersRepo();
  const a = await eventClustersRepo.create({ confidence: 'high', detectedAt: new Date(), memberFindingIds: [1, 2] });
  const b = await eventClustersRepo.create({ confidence: 'low', detectedAt: new Date(), memberFindingIds: [3] });
  return { eventClustersRepo, a, b };
}

test('several situations resolve in one request, with one shared note', async () => {
  const { eventClustersRepo, a, b } = await seededClusters();
  const auditLogRepo = makeAuditLogRepo();
  const app = makeApp({ eventClustersRepo, auditLogRepo });

  const res = await op(app, 'post', '/api/event-clusters/bulk-resolve', {
    ids: [a, b], note: 'same power blip, confirmed with the site',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.resolved, 2);
  // The note is the point of the action, so it reaches every row.
  assert.ok(eventClustersRepo.rows.every((r) => r.resolution_note === 'same power blip, confirmed with the site'));
  assert.equal(auditLogRepo.rows.filter((r) => r.action === 'cluster_resolve').length, 2);
});

test('the note stays REQUIRED in bulk — otherwise bulk becomes the easy path', async () => {
  // If a bulk resolve could skip the note, every situation in the history
  // would end up resolved with no reason recorded.
  const { eventClustersRepo, a } = await seededClusters();
  const app = makeApp({ eventClustersRepo });

  for (const body of [{ ids: [a] }, { ids: [a], note: '   ' }]) {
    const res = await op(app, 'post', '/api/event-clusters/bulk-resolve', body);
    assert.equal(res.status, 400);
  }
  assert.equal(eventClustersRepo.rows.find((r) => r.id === a).status, 'open');
});

test('an already-resolved situation is a conflict, and the others still go', async () => {
  const { eventClustersRepo, a, b } = await seededClusters();
  await eventClustersRepo.resolve(a, { by: 1, note: 'done earlier', at: new Date() });
  const app = makeApp({ eventClustersRepo });

  const res = await op(app, 'post', '/api/event-clusters/bulk-resolve', { ids: [a, b], note: 'sweep' });
  assert.equal(res.body.resolved, 1);
  assert.equal(res.body.results.find((r) => r.id === a).outcome, 'conflict');
  assert.equal(eventClustersRepo.rows.find((r) => r.id === a).resolution_note, 'done earlier',
    'the earlier resolution is not overwritten');
});

test('a bulk resolve does NOT page everybody once per situation', async () => {
  // Forty notifications for one operator action is how a channel gets muted,
  // and a muted channel is worse than a quiet one.
  const sent = [];
  const { eventClustersRepo, a, b } = await seededClusters();
  const app = makeApp({ eventClustersRepo, clusterNotifier: { notify: async (m) => { sent.push(m); } } });

  // The CONTRAST is the test. Resolving one high-confidence situation the
  // normal way notifies — so a bulk resolve staying silent is a decision this
  // file pins, not a notifier that was never wired up.
  await op(app, 'post', `/api/event-clusters/${a}/resolve`, { note: 'single' });
  assert.equal(sent.length, 1, 'the single-item resolve DOES notify');

  await op(app, 'post', '/api/event-clusters/bulk-resolve', { ids: [b], note: 'one cause' });
  assert.equal(sent.length, 1, 'and the bulk one added nothing');
});

test('situations bulk: the boring guards', async () => {
  const { eventClustersRepo, a } = await seededClusters();
  const app = makeApp({ eventClustersRepo });
  const post = (body, role = 'operator') => request(app).post('/api/event-clusters/bulk-resolve')
    .set('Authorization', authHeader(role)).send(body);

  assert.equal((await post({ ids: [], note: 'x' })).status, 400);
  assert.equal((await post({ ids: ['x'], note: 'x' })).status, 400);
  assert.equal((await post({ ids: Array.from({ length: 501 }, (_, i) => i + 1), note: 'x' })).status, 400);
  assert.equal((await post({ ids: [a], note: 'x' }, 'viewer')).status, 403);
  assert.equal((await request(app).post('/api/event-clusters/bulk-resolve').send({ ids: [a], note: 'x' })).status, 401);
});
