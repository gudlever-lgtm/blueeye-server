'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEventClustersRepository } = require('../src/repositories/eventClustersRepository');

// The bug these tests exist for: every listing here used to SELECT the whole row
// — including member_finding_ids, a JSON column — while ordering by detected_at.
// MySQL budgets a variable-length addon field at its MAXIMUM width when it fills
// the sort buffer, and JSON's maximum is far larger than the default 256 KB
// sort_buffer_size, so the server refused the query outright with
// ER_OUT_OF_SORTMEMORY ("Out of sort memory, consider increasing server sort
// buffer size"). GET /api/event-clusters 500'd and the clustering engine's own
// open/stale sweeps silently degraded to [].
//
// There is no MySQL in the test run, so these assert on the SQL the repository
// EMITS: the ordered query must stay narrow, and the rows must still come back
// in the ordered query's order.

// A fake pool that records every statement and answers from a handler.
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

// A full event_clusters row as mysql2 hands it back.
function row(id, overrides = {}) {
  return {
    id,
    confidence: 'high',
    member_finding_ids: ['f-1', 'f-2'],
    suspected_common_cause: 'shared site',
    advisory: null,
    alert_last_at: null,
    alert_last_severity: null,
    alert_member_count: null,
    itsm_ticket_ref: null,
    itsm_integration_id: null,
    nis2_draft_id: null,
    status: 'open',
    detected_at: new Date('2026-07-31T10:00:00Z'),
    acknowledged_at: null,
    acknowledged_by: null,
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    created_at: new Date('2026-07-31T09:00:00Z'),
    updated_at: new Date('2026-07-31T10:00:00Z'),
    ...overrides,
  };
}

// Splits a recorded statement into its select list (everything before FROM).
function selectList(sql) {
  return sql.slice(0, sql.search(/\bFROM\b/i));
}

const ORDERED = (c) => /\bORDER BY\b/i.test(c.sql);

// Answers phase 1 with ids and phase 2 with the matching rows.
function twoPhasePool(ids, rowsById) {
  return fakePool((sql, params) => {
    if (/\bORDER BY\b/i.test(sql)) return [ids.map((id) => ({ id }))];
    return [params.map((id) => rowsById[id]).filter(Boolean)];
  });
}

for (const [name, call] of [
  ['list', (repo) => repo.list({})],
  ['listOpen', (repo) => repo.listOpen()],
  ['listStaleOpen', (repo) => repo.listStaleOpen(new Date('2026-07-31T00:00:00Z'))],
]) {
  test(`${name} never sorts a result set containing the JSON column`, async () => {
    const pool = twoPhasePool([1], { 1: row(1) });
    await call(createEventClustersRepository({ pool }));

    const ordered = pool.calls.filter(ORDERED);
    assert.equal(ordered.length, 1, 'exactly one ordered statement per listing');
    // The mutation this guards: putting member_finding_ids back in the ordered
    // query is what made MySQL blow the sort buffer.
    assert.doesNotMatch(
      selectList(ordered[0].sql),
      /member_finding_ids/,
      `${name}'s ordered query must not select the JSON column`,
    );
    // ...and it should stay narrow generally — ids are all the sort needs.
    assert.match(selectList(ordered[0].sql), /SELECT\s+id\s*$/i);
  });

  test(`${name} returns full clusters in the ordered query's order`, async () => {
    // Phase 1 hands back 3, 1, 2; MySQL is free to return phase 2 in any order,
    // so the fake deliberately answers by the id order it was asked for.
    const rowsById = { 1: row(1), 2: row(2), 3: row(3) };
    const pool = twoPhasePool([3, 1, 2], rowsById);
    const out = await call(createEventClustersRepository({ pool }));

    assert.deepEqual(out.map((c) => c.id), [3, 1, 2]);
    // Fully mapped, not just ids — the JSON column survives the split.
    assert.deepEqual(out[0].memberFindingIds, ['f-1', 'f-2']);
    assert.equal(out[0].suspectedCommonCause, 'shared site');
    assert.equal(out[0].status, 'open');

    const hydrate = pool.calls.find((c) => !ORDERED(c));
    assert.match(hydrate.sql, /WHERE id IN \(\?, \?, \?\)/);
    assert.deepEqual(hydrate.params, [3, 1, 2]);
  });

  test(`${name} makes no second query when nothing matched`, async () => {
    const pool = twoPhasePool([], {});
    const out = await call(createEventClustersRepository({ pool }));
    assert.deepEqual(out, []);
    assert.equal(pool.calls.length, 1, 'an empty page must not fire a hydrate');
  });
}

test('a cluster deleted between the two phases is dropped, not left as a hole', async () => {
  // Retention can purge a row after phase 1 read its id.
  const pool = twoPhasePool([1, 2], { 1: row(1) });
  const out = await createEventClustersRepository({ pool }).list({});
  assert.deepEqual(out.map((c) => c.id), [1]);
});

test('the status filter and paging still ride on the ordered query', async () => {
  const pool = twoPhasePool([7], { 7: row(7, { status: 'resolved' }) });
  await createEventClustersRepository({ pool }).list({ status: 'resolved', limit: 25, offset: 50 });

  const ordered = pool.calls.find(ORDERED);
  assert.match(ordered.sql, /WHERE status = \?/);
  assert.match(ordered.sql, /ORDER BY detected_at DESC, id DESC LIMIT \? OFFSET \?/);
  assert.deepEqual(ordered.params, ['resolved', 25, 50]);
});

test('findById reads the full row directly — it never sorts, so it never needed splitting', async () => {
  const pool = fakePool(() => [[row(4)]]);
  const found = await createEventClustersRepository({ pool }).findById(4);

  assert.equal(pool.calls.length, 1);
  assert.doesNotMatch(pool.calls[0].sql, /ORDER BY/i);
  assert.match(selectList(pool.calls[0].sql), /member_finding_ids/);
  assert.equal(found.id, 4);
  assert.deepEqual(found.memberFindingIds, ['f-1', 'f-2']);
});
