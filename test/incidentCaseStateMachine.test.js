'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canTransition, requiresComment, isStatus, STATUSES } = require('../src/incidentCases/stateMachine');
const { createIncidentCasesRepository } = require('../src/repositories/incidentCasesRepository');
const { createIncidentAutoResolveJob } = require('../src/incidentCases/autoResolveJob');
const { makeIncidentCasesRepo } = require('../test-support/fakes');

// ---- pure state machine ----------------------------------------------------

test('the four documented transitions are allowed, everything else rejected', () => {
  assert.equal(canTransition('open', 'investigating'), true);
  assert.equal(canTransition('investigating', 'resolved'), true);
  assert.equal(canTransition('resolved', 'closed'), true);
  assert.equal(canTransition('closed', 'open'), true);
  // rejected
  assert.equal(canTransition('open', 'resolved'), false);
  assert.equal(canTransition('open', 'closed'), false);
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
    assert.match(sql, /UPDATE incident_cases SET status = \?, resolved_at = \?/);
    assert.match(sql, /WHERE id = \? AND status = \?/);
    assert.deepEqual(params, ['resolved', 'AT', 5, 'investigating']);
    return [{ affectedRows: 1 }];
  });
  const repo = createIncidentCasesRepository({ pool });
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
  const repo = createIncidentCasesRepository({ pool });
  assert.equal(await repo.updateStatus(3, { from: 'resolved', to: 'closed', closedBy: 7 }), true);
  assert.equal(await repo.updateStatus(3, { from: 'closed', to: 'open' }), true);
});

test('listStaleInvestigating filters status=investigating and last_event_at < olderThan', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /status = 'investigating' AND last_event_at < \?/);
    assert.equal(params[0], 'CUT');
    return [[]];
  });
  const repo = createIncidentCasesRepository({ pool });
  assert.deepEqual(await repo.listStaleInvestigating('CUT'), []);
});

// ---- auto-resolve job ------------------------------------------------------

test('auto-resolve job resolves stale investigating incidents and audits each', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo();
  // Two investigating (one stale, one fresh) + one open (ignored).
  await incidentCasesRepo.create({ host_id: 'h1', title: 't', status: 'investigating', first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:00:00Z') });
  await incidentCasesRepo.create({ host_id: 'h2', title: 't', status: 'investigating', first_event_at: new Date('2026-06-01T09:59:00Z'), last_event_at: new Date('2026-06-01T09:59:00Z') });
  await incidentCasesRepo.create({ host_id: 'h3', title: 't', status: 'open', first_event_at: new Date('2026-06-01T08:00:00Z'), last_event_at: new Date('2026-06-01T08:00:00Z') });

  const audits = [];
  const auditLogRepo = { record: async (e) => { audits.push(e); } };
  const NOW = new Date('2026-06-01T10:00:00Z').getTime(); // inactivity default 15m
  const job = createIncidentAutoResolveJob({ incidentCasesRepo, auditLogRepo, now: () => NOW });

  const resolved = await job.runOnce();
  assert.equal(resolved, 1); // only h1 (>15m stale); h2 is 1m old, h3 is open
  assert.equal(incidentCasesRepo.rows.find((r) => r.host_id === 'h1').status, 'resolved');
  assert.equal(incidentCasesRepo.rows.find((r) => r.host_id === 'h2').status, 'investigating');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'incident_auto_resolve');
  assert.equal(audits[0].actorRole, 'system');
});

test('auto-resolve job swallows a repo failure (never crashes the scheduler)', async () => {
  const incidentCasesRepo = makeIncidentCasesRepo({ listStaleInvestigating: async () => { throw new Error('db down'); } });
  const job = createIncidentAutoResolveJob({ incidentCasesRepo });
  assert.equal(await job.runOnce(), 0);
});
