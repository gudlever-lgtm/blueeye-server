'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIncidentsRepository } = require('../src/repositories/incidentsRepository');
const { createIncidentThresholdsRepository } = require('../src/repositories/incidentThresholdsRepository');
const { createProbeResultsRepository } = require('../src/repositories/probeResultsRepository');

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

// ---- incidentsRepository ---------------------------------------------------

test('incidents.list maps joined rows to the API shape and derives status', async () => {
  const pool = fakePool(() => [[
    {
      id: 5, location_id: 7, location_name: 'HQ', agent_id: 9, agent_name: 'fw',
      metric: 'reachability', severity: 'critical',
      started_at: new Date('2026-06-01T08:00:00Z'), resolved_at: null,
      duration_seconds: null, affected_target: 'x', created_at: new Date('2026-06-01T08:00:00Z'),
    },
  ]]);
  const repo = createIncidentsRepository({ pool });
  const rows = await repo.list({ from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-02T00:00:00Z') });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].locationName, 'HQ');
  assert.equal(rows[0].agentName, 'fw');
  assert.equal(rows[0].status, 'active'); // resolved_at null
  assert.equal(rows[0].startedAt, '2026-06-01T08:00:00.000Z');
});

test('incidents.list without a window omits the time clauses (no `<= NULL` matching nothing)', async () => {
  const pool = fakePool((sql, params) => {
    assert.doesNotMatch(sql, /started_at <= \?/);
    assert.doesNotMatch(sql, /resolved_at >= \?/);
    assert.deepEqual(params, [1000]); // just the LIMIT — no undefined bindings
    return [[]];
  });
  const repo = createIncidentsRepository({ pool });
  const rows = await repo.list(); // dashboard/advanced calls it with no args
  assert.deepEqual(rows, []);
  assert.equal(pool.calls.length, 1);
});

test('incidents.findActive returns the open row for the tuple or null', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /resolved_at IS NULL/);
    return [[{ id: 3, started_at: new Date('2026-06-01T08:00:00Z'), severity: 'warning' }]];
  });
  const repo = createIncidentsRepository({ pool });
  const r = await repo.findActive(9, 'latency', 'edge');
  assert.equal(r.id, 3);
  assert.equal(r.severity, 'warning');
});

test('incidents.resolve issues a guarded UPDATE computing duration in SQL', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /UPDATE incidents/);
    assert.match(sql, /TIMESTAMPDIFF\(SECOND, started_at/);
    assert.match(sql, /resolved_at IS NULL/);
    return [{ affectedRows: 1 }];
  });
  const repo = createIncidentsRepository({ pool });
  assert.equal(await repo.resolve(3, new Date('2026-06-01T09:00:00Z')), true);
});

test('incidents.updateSeverity issues a guarded UPDATE on active rows', async () => {
  const pool = fakePool((sql) => {
    assert.match(sql, /UPDATE incidents SET severity/);
    assert.match(sql, /resolved_at IS NULL/);
    return [{ affectedRows: 1 }];
  });
  const repo = createIncidentsRepository({ pool });
  assert.equal(await repo.updateSeverity(3, 'critical'), true);
});

// ---- incidentThresholdsRepository -----------------------------------------

test('thresholds.getEffective prefers a location row over the global (ORDER BY)', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /\(location_id IS NULL\) ASC/);
    assert.deepEqual(params, ['latency', 7]);
    return [[{ id: 2, location_id: 7, metric: 'latency', warning_value: 50, critical_value: 100, debounce_count: 3 }]];
  });
  const repo = createIncidentThresholdsRepository({ pool });
  const t = await repo.getEffective(7, 'latency');
  assert.equal(t.location_id, 7);
  assert.equal(t.warning_value, 50);
});

test('thresholds.upsert updates an existing global (select-then-update path)', async () => {
  let step = 0;
  const pool = fakePool((sql) => {
    step += 1;
    if (step === 1) { assert.match(sql, /SELECT id FROM incident_thresholds/); assert.match(sql, /location_id IS NULL/); return [[{ id: 2 }]]; }
    if (step === 2) { assert.match(sql, /UPDATE incident_thresholds SET/); return [{ affectedRows: 1 }]; }
    // findById after update
    return [[{ id: 2, location_id: null, metric: 'latency', warning_value: 120, critical_value: 240, debounce_count: 4 }]];
  });
  const repo = createIncidentThresholdsRepository({ pool });
  const t = await repo.upsert({ location_id: null, metric: 'latency', warning_value: 120, critical_value: 240, debounce_count: 4 });
  assert.equal(t.warning_value, 120);
  assert.equal(t.debounce_count, 4);
});

test('thresholds.upsert inserts a new location override when none exists', async () => {
  let step = 0;
  const pool = fakePool((sql) => {
    step += 1;
    if (step === 1) return [[]]; // no existing row
    if (step === 2) { assert.match(sql, /INSERT INTO incident_thresholds/); return [{ insertId: 9 }]; }
    return [[{ id: 9, location_id: 7, metric: 'packet_loss', warning_value: 1, critical_value: 3, debounce_count: 3 }]];
  });
  const repo = createIncidentThresholdsRepository({ pool });
  const t = await repo.upsert({ location_id: 7, metric: 'packet_loss', warning_value: 1, critical_value: 3 });
  assert.equal(t.id, 9);
  assert.equal(t.location_id, 7);
});

// ---- probeResultsRepository.availability -----------------------------------

test('probeResults.availability computes uptime % per agent', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /COUNT\(\*\) AS total/);
    assert.match(sql, /SUM\(pr.ok = 1\) AS up/);
    assert.deepEqual(params.slice(0, 2).map((d) => d.toISOString?.() || d), ['2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z']);
    return [[
      { location_id: 7, location_name: 'HQ', agent_id: 9, agent_name: 'fw', total: 4, up: 3 },
      { location_id: null, location_name: null, agent_id: 10, agent_name: 'edge', total: 0, up: 0 },
    ]];
  });
  const repo = createProbeResultsRepository({ pool });
  const rows = await repo.availability({ from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-02T00:00:00Z') });
  assert.equal(rows[0].uptimePct, 75);
  assert.equal(rows[0].down, 1);
  assert.equal(rows[1].uptimePct, null); // no probes => null, not NaN
});

test('probeResults.availability adds a location filter when given', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /a.location_id = \?/);
    assert.equal(params[params.length - 1], 7);
    return [[]];
  });
  const repo = createProbeResultsRepository({ pool });
  await repo.availability({ from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-02T00:00:00Z'), locationId: 7 });
});
