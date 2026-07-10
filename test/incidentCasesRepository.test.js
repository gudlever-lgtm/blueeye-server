'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIncidentCasesRepository, isWorse } = require('../src/repositories/incidentCasesRepository');

// A minimal fake pool: returns canned rows and records the last SQL + params.
function fakePool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return handler(sql, params, calls.length);
    },
  };
}

test('isWorse ranks CRIT > WARN > INFO', () => {
  assert.equal(isWorse('CRIT', 'WARN'), true);
  assert.equal(isWorse('WARN', 'INFO'), true);
  assert.equal(isWorse('INFO', 'WARN'), false);
  assert.equal(isWorse('WARN', 'WARN'), false);
});

test('create inserts an incident case and returns the new id', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /INSERT INTO incident_cases/);
    return [{ insertId: 42 }];
  });
  const repo = createIncidentCasesRepository({ pool });
  const id = await repo.create({
    host_id: 'core-sw', title: 'CRIT cpu on core-sw', severity: 'CRIT',
    primary_finding_id: 'f-1', first_event_at: new Date('2026-06-01T08:00:00Z'),
    last_event_at: new Date('2026-06-01T08:00:00Z'), created_by: 'system',
  });
  assert.equal(id, 42);
});

test('findById maps a row to the API shape', async () => {
  const pool = fakePool(() => [[{
    id: 7, host_id: 'core-sw', title: 't', status: 'open', severity: 'WARN',
    primary_finding_id: 'f-1', first_event_at: new Date('2026-06-01T08:00:00Z'),
    last_event_at: new Date('2026-06-01T08:05:00Z'), resolved_at: null,
    created_by: 'system', closed_by: null, created_at: new Date('2026-06-01T08:00:00Z'),
  }]]);
  const repo = createIncidentCasesRepository({ pool });
  const row = await repo.findById(7);
  assert.equal(row.id, 7);
  assert.equal(row.hostId, 'core-sw');
  assert.equal(row.status, 'open');
  assert.equal(row.primaryFindingId, 'f-1');
  assert.equal(row.lastEventAt, '2026-06-01T08:05:00.000Z');
  assert.equal(row.closedBy, null);
});

test('findById returns null when no row', async () => {
  const repo = createIncidentCasesRepository({ pool: fakePool(() => [[]]) });
  assert.equal(await repo.findById(9), null);
});

test('findOpenByHost only matches open|investigating for the host, newest activity first', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /host_id = \?/);
    assert.match(sql, /status IN \(\?, \?\)/);
    assert.match(sql, /ORDER BY last_event_at DESC/);
    assert.deepEqual(params, ['core-sw', 'open', 'investigating']);
    return [[{
      id: 3, host_id: 'core-sw', title: 't', status: 'investigating', severity: 'WARN',
      primary_finding_id: 'f-1', first_event_at: new Date('2026-06-01T08:00:00Z'),
      last_event_at: new Date('2026-06-01T08:10:00Z'), resolved_at: null,
      created_by: 'system', closed_by: null, created_at: new Date('2026-06-01T08:00:00Z'),
    }]];
  });
  const repo = createIncidentCasesRepository({ pool });
  const r = await repo.findOpenByHost('core-sw');
  assert.equal(r.id, 3);
  assert.equal(r.status, 'investigating');
});

test('updateActivity advances last_event_at (GREATEST) and only escalates severity', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /UPDATE incident_cases/);
    assert.match(sql, /last_event_at = GREATEST\(last_event_at, \?\)/);
    assert.match(sql, /WHEN \? = 'CRIT' THEN 'CRIT'/);
    assert.deepEqual(params.slice(1, 3), ['CRIT', 'CRIT']); // severity bound twice
    return [{ affectedRows: 1 }];
  });
  const repo = createIncidentCasesRepository({ pool });
  assert.equal(await repo.updateActivity(3, { lastEventAt: new Date('2026-06-01T08:20:00Z'), severity: 'CRIT' }), true);
});

test('list applies status/severity/host filters and bounds the limit', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /status = \?/);
    assert.match(sql, /severity = \?/);
    assert.match(sql, /host_id = \?/);
    assert.match(sql, /ORDER BY last_event_at DESC/);
    assert.deepEqual(params, ['open', 'CRIT', 'core-sw', 1000]);
    return [[]];
  });
  const repo = createIncidentCasesRepository({ pool });
  const rows = await repo.list({ status: 'open', severity: 'CRIT', hostId: 'core-sw' });
  assert.deepEqual(rows, []);
});

test('list with no filters selects with just the LIMIT bound', async () => {
  const pool = fakePool((sql, params) => {
    assert.doesNotMatch(sql, /WHERE/);
    assert.deepEqual(params, [1000]);
    return [[]];
  });
  const repo = createIncidentCasesRepository({ pool });
  await repo.list();
});
