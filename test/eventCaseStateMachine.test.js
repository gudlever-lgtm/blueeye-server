'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canTransition, requiresComment, isStatus, STATUSES } = require('../src/eventCases/stateMachine');
const { createEventCasesRepository } = require('../src/repositories/eventCasesRepository');
const { createEventAutoResolveJob } = require('../src/eventCases/autoResolveJob');
const { makeEventCasesRepo } = require('../test-support/fakes');

// ---- pure state machine ----------------------------------------------------

test('the documented transitions are allowed, everything else rejected', () => {
  assert.equal(canTransition('open', 'investigating'), true);
  assert.equal(canTransition('investigating', 'resolved'), true);
  assert.equal(canTransition('resolved', 'closed'), true);
  assert.equal(canTransition('closed', 'open'), true);
  // open → resolved, deliberately. Most events are read and dismissed in one
  // go, and forcing them through `investigating` recorded a step nobody
  // performed — an audit trail where everything was "investigated" says
  // nothing about the ones that actually were.
  assert.equal(canTransition('open', 'resolved'), true);
  // rejected
  assert.equal(canTransition('open', 'closed'), false, 'resolved is not skippable');
  assert.equal(canTransition('investigating', 'closed'), false);
  assert.equal(canTransition('resolved', 'open'), false);
  assert.equal(canTransition('open', 'open'), false);
  assert.equal(canTransition('bogus', 'open'), false);
});

test('only reopen (closed → open) requires a comment', () => {
  assert.equal(requiresComment('closed', 'open'), true);
  assert.equal(requiresComment('open', 'investigating'), false);
  assert.equal(requiresComment('investigating', 'resolved'), false);
});

test('isStatus recognises exactly the four statuses', () => {
  assert.deepEqual(STATUSES, ['open', 'investigating', 'resolved', 'closed']);
  assert.equal(isStatus('open'), true);
  assert.equal(isStatus('nope'), false);
});

// ---- repository guarded transition -----------------------------------------

function fakePool(handler) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return handler(sql, params, calls.length); } };
}

test('updateStatus →resolved stamps resolved_at and guards on the from-status', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /UPDATE event_cases SET status = \?, resolved_at = \?/);
    assert.match(sql, /WHERE id = \? AND status = \?/);
    assert.deepEqual(params, ['resolved', 'AT', 5, 'investigating']);
    return [{ affectedRows: 1 }];
  });
  const repo = createEventCasesRepository({ pool });
  assert.equal(await repo.updateStatus(5, { from: 'investigating', to: 'resolved', at: 'AT' }), true);
});

test('updateStatus →closed sets closed_by; →open (reopen) clears resolved_at + closed_by', async () => {
  let step = 0;
  const pool = fakePool((sql, params) => {
    step += 1;
    if (step === 1) {
      assert.match(sql, /status = \?, closed_by = \?/);
      assert.deepEqual(params, ['closed', 7, 3, 'resolved']);
    } else {
      assert.match(sql, /status = \?, resolved_at = NULL, closed_by = NULL/);
      assert.deepEqual(params, ['open', 3, 'closed']);
    }
    return [{ affectedRows: 1 }];
  });
  const repo = createEventCasesRepository({ pool });
  assert.equal(await repo.updateStatus(3, { from: 'resolved', to: 'closed', closedBy: 7 }), true);
  assert.equal(await repo.updateStatus(3, { from: 'closed', to: 'open' }), true);
});

test('listStaleInvestigating filters status=investigating and last_event_at < olderThan', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /status = 'investigating' AND last_event_at < \?/);
    assert.equal(params[0], 'CUT');
    return [[]];
  });
  const repo = createEventCasesRepository({ pool });
  assert.deepEqual(await repo.listStaleInvestigating('CUT'), []);
});

// ---- auto-resolve job ------------------------------------------------------

test('auto-resolve job resolves stale investigating events and audits each', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  // Two investigating (one stale, one fresh) + one open (ignored).
  await eventCasesRepo.create({ host_id: 'h1', title: 't', status: 'investigating', first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:00:00Z') });
  await eventCasesRepo.create({ host_id: 'h2', title: 't', status: 'investigating', first_event_at: new Date('2026-06-01T09:59:00Z'), last_event_at: new Date('2026-06-01T09:59:00Z') });
  await eventCasesRepo.create({ host_id: 'h3', title: 't', status: 'open', first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:00:00Z') });

  const audits = [];
  const auditLogRepo = { record: async (e) => { audits.push(e); } };
  const NOW = new Date('2026-06-01T10:00:00Z').getTime(); // inactivity default 15m
  const job = createEventAutoResolveJob({ eventCasesRepo, auditLogRepo, now: () => NOW });

  const resolved = await job.runOnce();
  assert.equal(resolved, 1); // only h1 (>15m stale); h2 is 1m old, h3 is open
  assert.equal(eventCasesRepo.rows.find((r) => r.host_id === 'h1').status, 'resolved');
  assert.equal(eventCasesRepo.rows.find((r) => r.host_id === 'h2').status, 'investigating');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'event_auto_resolve');
  assert.equal(audits[0].actorRole, 'system');
});

test('auto-resolve job swallows a repo failure (never crashes the scheduler)', async () => {
  const eventCasesRepo = makeEventCasesRepo({ listStaleInvestigating: async () => { throw new Error('db down'); } });
  const job = createEventAutoResolveJob({ eventCasesRepo });
  assert.equal(await job.runOnce(), 0);
});

// ---- situations (migration 129) ---------------------------------------------

test('auto-resolve leaves a quiet case alone while its SITUATION is still live, resolves it once that ends', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  const NOW = new Date('2026-06-01T10:00:00Z').getTime();
  const stale = new Date(NOW - 30 * 60 * 1000);
  const inSituation = await eventCasesRepo.create({ host_id: 'h1', title: 'a', status: 'investigating', first_event_at: stale, last_event_at: stale });
  const alone = await eventCasesRepo.create({ host_id: 'h2', title: 'b', status: 'investigating', first_event_at: stale, last_event_at: stale });
  await eventCasesRepo.linkCluster([inSituation], 7);
  // Updated deliberately (review round 2): a situation holds its cases only
  // while it is ACTIVE — live status AND activity (detected_at) inside the
  // window — so the fixture now carries a recent detectedAt. The quiet-but-open
  // case is the test after this one.
  const situation = { id: 7, status: 'open', detectedAt: new Date(NOW - 60 * 1000).toISOString() };
  const reads = [];
  const clustersRepo = { findById: async (id) => { reads.push(id); return id === 7 ? situation : null; } };
  const job = createEventAutoResolveJob({ eventCasesRepo, clustersRepo, now: () => NOW });

  assert.equal(await job.runOnce(), 1); // only the case with no situation
  assert.equal(eventCasesRepo.rows.find((r) => r.id === inSituation).status, 'investigating');
  assert.equal(eventCasesRepo.rows.find((r) => r.id === alone).status, 'resolved');

  situation.status = 'acknowledged'; // an operator owns it — still live
  assert.equal(await job.runOnce(), 0);

  situation.status = 'resolved';
  assert.equal(await job.runOnce(), 1);
  assert.equal(eventCasesRepo.rows.find((r) => r.id === inSituation).status, 'resolved');
});

test('auto-resolve: an unreadable situation does not hold the case open forever', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  const NOW = new Date('2026-06-01T10:00:00Z').getTime();
  const stale = new Date(NOW - 30 * 60 * 1000);
  const id = await eventCasesRepo.create({ host_id: 'h1', title: 'a', status: 'investigating', first_event_at: stale, last_event_at: stale });
  await eventCasesRepo.linkCluster([id], 7);
  const clustersRepo = { findById: async () => { throw new Error('db down'); } };
  const job = createEventAutoResolveJob({ eventCasesRepo, clustersRepo, now: () => NOW });
  assert.equal(await job.runOnce(), 1);
});

// A situation with an unacknowledged CRIT member never auto-resolves, so
// holding on its STATUS held its cases forever.
test('auto-resolve: a situation that is still open but has gone quiet no longer holds its cases', async () => {
  const eventCasesRepo = makeEventCasesRepo();
  const NOW = new Date('2026-06-01T10:00:00Z').getTime();
  const stale = new Date(NOW - 30 * 60 * 1000);
  const id = await eventCasesRepo.create({ host_id: 'h1', title: 'a', status: 'investigating', first_event_at: stale, last_event_at: stale });
  await eventCasesRepo.linkCluster([id], 7);
  const situation = { id: 7, status: 'open', detectedAt: new Date(NOW - 5 * 60 * 1000).toISOString() };
  const job = createEventAutoResolveJob({ eventCasesRepo, clustersRepo: { findById: async () => situation }, now: () => NOW });
  assert.equal(await job.runOnce(), 0, 'held while the situation is active');
  // Last member joined 20 min ago: open, but inactive past the 15 min window.
  situation.detectedAt = new Date(NOW - 20 * 60 * 1000).toISOString();
  assert.equal(await job.runOnce(), 1);
  assert.equal(eventCasesRepo.rows.find((r) => r.id === id).status, 'resolved');
});

test('auto-resolve: held cases do not starve the batch — the query leaves them out', async () => {
  const NOW = new Date('2026-06-01T10:00:00Z').getTime();
  const LIMIT = 3;
  const eventCasesRepo = makeEventCasesRepo();
  // Three OLD held cases (they sort first) and one resolvable one behind them.
  for (let i = 0; i < 3; i += 1) {
    const t = new Date(NOW - (60 - i) * 60 * 1000);
    const cid = await eventCasesRepo.create({ host_id: `held${i}`, title: 'h', status: 'investigating', first_event_at: t, last_event_at: t });
    await eventCasesRepo.linkCluster([cid], 7);
  }
  const t = new Date(NOW - 30 * 60 * 1000);
  const free = await eventCasesRepo.create({ host_id: 'free', title: 'f', status: 'investigating', first_event_at: t, last_event_at: t });
  const situation = { id: 7, status: 'open', detectedAt: new Date(NOW - 60 * 1000).toISOString() };
  const base = eventCasesRepo.listStaleInvestigating;
  let opts = null;
  // Mirrors the SQL: oldest-first, LIMIT, and the optional hold exclusion.
  eventCasesRepo.listStaleInvestigating = async (olderThan, _limit, o = {}) => {
    opts = o;
    const all = await base(olderThan);
    const since = o.holdClustersActiveSince ? new Date(o.holdClustersActiveSince).getTime() : null;
    return all.filter((c) => since == null || c.clusterId !== 7
      || !((situation.status === 'open' || situation.status === 'acknowledged') && Date.parse(situation.detectedAt) >= since))
      .slice(0, LIMIT);
  };
  const job = createEventAutoResolveJob({ eventCasesRepo, clustersRepo: { findById: async () => situation }, now: () => NOW });
  assert.equal(await job.runOnce(), 1);
  assert.equal(eventCasesRepo.rows.find((r) => r.id === free).status, 'resolved');
  assert.equal(new Date(opts.holdClustersActiveSince).getTime(), NOW - 15 * 60 * 1000);
});

test('listStaleInvestigating with holdClustersActiveSince excludes cases of active situations in SQL', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /last_event_at < \? AND \(cluster_id IS NULL OR NOT EXISTS \(SELECT 1 FROM event_clusters c/);
    assert.match(sql, /c\.status IN \('open', 'acknowledged'\) AND c\.detected_at >= \?/);
    assert.deepEqual(params, ['CUT', 'SINCE', 500]);
    return [[]];
  });
  const repo = createEventCasesRepository({ pool });
  assert.deepEqual(await repo.listStaleInvestigating('CUT', undefined, { holdClustersActiveSince: 'SINCE' }), []);
});
