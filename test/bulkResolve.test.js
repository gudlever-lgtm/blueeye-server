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
  makeApp, makeEventCasesRepo, makeEventClustersRepo, makeAuditLogRepo, authHeader,
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

test('an illegal transition is REPORTED, not silently performed', async () => {
  // open → resolved is not in the state machine. Bulk must not become the door
  // that bypasses it.
  const { eventCasesRepo, open, inv1 } = await seededEvents();
  const app = makeApp({ eventCasesRepo });

  const res = await op(app, 'post', '/api/events/bulk-status', { ids: [open, inv1], status: 'resolved' });
  assert.equal(res.status, 200);
  assert.equal(res.body.moved, 1, 'the legal one still moved');

  const bad = res.body.results.find((r) => r.id === open);
  assert.equal(bad.outcome, 'illegal');
  assert.equal(bad.from, 'open');
  // NAMED, not just counted: "1 could not be resolved" is unactionable.
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
