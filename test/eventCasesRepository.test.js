'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEventCasesRepository, isWorse } = require('../src/repositories/eventCasesRepository');

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

test('create inserts an event case and returns the new id', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /INSERT INTO event_cases/);
    return [{ insertId: 42 }];
  });
  const repo = createEventCasesRepository({ pool });
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
  const repo = createEventCasesRepository({ pool });
  const row = await repo.findById(7);
  assert.equal(row.id, 7);
  assert.equal(row.hostId, 'core-sw');
  assert.equal(row.status, 'open');
  assert.equal(row.primaryFindingId, 'f-1');
  assert.equal(row.lastEventAt, '2026-06-01T08:05:00.000Z');
  assert.equal(row.closedBy, null);
});

test('findById joins the device identity (agent + site) onto the event', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /LEFT JOIN agents a ON a\.id = ic\.host_id/);
    assert.match(sql, /LEFT JOIN locations l ON l\.id = a\.location_id/);
    return [[{
      id: 7, host_id: '4', title: 't', status: 'open', severity: 'WARN',
      primary_finding_id: null, first_event_at: new Date('2026-06-01T08:00:00Z'),
      last_event_at: new Date('2026-06-01T08:05:00Z'), resolved_at: null,
      created_by: 'system', closed_by: null, created_at: new Date('2026-06-01T08:00:00Z'),
      agent_display_name: 'core-sw', agent_hostname: 'sw01.dc1', location_id: 2, location_name: 'Copenhagen HQ',
    }]];
  });
  const row = await createEventCasesRepository({ pool }).findById(7);
  assert.equal(row.agentName, 'core-sw'); // display name wins over the hostname
  assert.equal(row.agentHostname, 'sw01.dc1');
  assert.equal(row.locationId, 2);
  assert.equal(row.locationName, 'Copenhagen HQ');
});

test('device identity falls back to the hostname and survives a deleted agent / unset site', async () => {
  const pool = fakePool(() => [[{
    id: 8, host_id: '4', title: 't', status: 'open', severity: 'WARN',
    primary_finding_id: null, first_event_at: new Date('2026-06-01T08:00:00Z'),
    last_event_at: new Date('2026-06-01T08:05:00Z'), resolved_at: null,
    created_by: 'system', closed_by: null, created_at: new Date('2026-06-01T08:00:00Z'),
    agent_display_name: null, agent_hostname: 'sw01.dc1', location_id: null, location_name: null,
  }, {
    id: 9, host_id: 'gone', title: 't', status: 'open', severity: 'WARN',
    primary_finding_id: null, first_event_at: new Date('2026-06-01T08:00:00Z'),
    last_event_at: new Date('2026-06-01T08:05:00Z'), resolved_at: null,
    created_by: 'system', closed_by: null, created_at: new Date('2026-06-01T08:00:00Z'),
    agent_display_name: null, agent_hostname: null, location_id: null, location_name: null,
  }]]);
  const [named, orphan] = await createEventCasesRepository({ pool }).list();
  assert.equal(named.agentName, 'sw01.dc1');
  assert.equal(named.locationName, null);
  assert.equal(orphan.agentName, null); // the LEFT JOIN missed — the id is all we have
  assert.equal(orphan.hostId, 'gone');
});

test('the reads that skip the join keep the plain shape (no misleading nulls)', async () => {
  const pool = fakePool(() => [[{
    id: 3, host_id: 'core-sw', title: 't', status: 'investigating', severity: 'WARN',
    primary_finding_id: null, first_event_at: new Date('2026-06-01T08:00:00Z'),
    last_event_at: new Date('2026-06-01T08:10:00Z'), resolved_at: null,
    created_by: 'system', closed_by: null, created_at: new Date('2026-06-01T08:00:00Z'),
  }]]);
  const r = await createEventCasesRepository({ pool }).findOpenByHost('core-sw');
  assert.equal('agentName' in r, false);
  assert.equal('locationName' in r, false);
});

test('findById returns null when no row', async () => {
  const repo = createEventCasesRepository({ pool: fakePool(() => [[]]) });
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
  const repo = createEventCasesRepository({ pool });
  const r = await repo.findOpenByHost('core-sw');
  assert.equal(r.id, 3);
  assert.equal(r.status, 'investigating');
});

test('updateActivity advances last_event_at (GREATEST) and only escalates severity', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /UPDATE event_cases/);
    assert.match(sql, /last_event_at = GREATEST\(last_event_at, \?\)/);
    assert.match(sql, /WHEN \? = 'CRIT' THEN 'CRIT'/);
    assert.deepEqual(params.slice(1, 3), ['CRIT', 'CRIT']); // severity bound twice
    return [{ affectedRows: 1 }];
  });
  const repo = createEventCasesRepository({ pool });
  assert.equal(await repo.updateActivity(3, { lastEventAt: new Date('2026-06-01T08:20:00Z'), severity: 'CRIT' }), true);
});

test('list applies status/severity/host filters and bounds the limit', async () => {
  const pool = fakePool((sql, params) => {
    // Qualified: the device join brings in an `agents.status` column of its own.
    assert.match(sql, /ic\.status = \?/);
    assert.match(sql, /ic\.severity = \?/);
    assert.match(sql, /ic\.host_id = \?/);
    assert.match(sql, /ORDER BY ic\.last_event_at DESC/);
    assert.deepEqual(params, ['open', 'CRIT', 'core-sw', 1000]);
    return [[]];
  });
  const repo = createEventCasesRepository({ pool });
  const rows = await repo.list({ status: 'open', severity: 'CRIT', hostId: 'core-sw' });
  assert.deepEqual(rows, []);
});

test('list with no filters selects with just the LIMIT bound', async () => {
  const pool = fakePool((sql, params) => {
    assert.doesNotMatch(sql, /WHERE/);
    assert.deepEqual(params, [1000]);
    return [[]];
  });
  const repo = createEventCasesRepository({ pool });
  await repo.list();
});
