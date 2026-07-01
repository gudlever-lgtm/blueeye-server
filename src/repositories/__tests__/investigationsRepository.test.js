'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createInvestigationsRepository } = require('../investigationsRepository');

// A tiny in-memory fake of the mysql2 pool that understands the exact SQL
// investigationsRepository issues (INSERT / SELECT).
function makeFakePool() {
  const rows = [];
  return {
    rows,
    async query(sql, params = []) {
      if (/^INSERT INTO investigations/i.test(sql)) {
        const [id, location_ref, window_from, window_to, classification, confidence,
          explanation, evidence, suspected_segment, related_finding_ids,
          workaround_hints, narrative] = params;
        rows.push({
          id, location_ref, window_from, window_to, classification, confidence,
          explanation, evidence, suspected_segment, related_finding_ids,
          workaround_hints, narrative, created_at: new Date(),
        });
        return [{ affectedRows: 1 }];
      }
      if (/^SELECT .* FROM investigations WHERE id = \?/i.test(sql)) {
        return [rows.filter((r) => r.id === params[0])];
      }
      if (/^SELECT .* FROM investigations/i.test(sql)) {
        return [rows.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1))];
      }
      throw new Error(`unexpected SQL in fake pool: ${sql}`);
    },
  };
}

function investigation(over = {}) {
  return {
    locationRef: { type: 'agent', value: '1' },
    window: { from: new Date('2026-01-01T00:00:00.000Z').toISOString(), to: new Date('2026-01-01T00:30:00.000Z').toISOString() },
    classification: 'LOCAL',
    confidence: 0.8,
    explanation: 'Afvigelse er koncentreret på agent-1',
    evidence: [{ type: 'finding', ref: '1/rx.errors', observed: 10, baseline: 2, deviation: 8, ts: new Date().toISOString() }],
    suspectedSegment: null,
    relatedFindingIds: [],
    workaroundHints: [],
    narrative: null,
    ...over,
  };
}

test('save throws on an empty explanation', async () => {
  const repo = createInvestigationsRepository({ pool: makeFakePool() });
  await assert.rejects(() => repo.save(investigation({ explanation: '   ' })), /explanation/);
});

test('save throws on an empty evidence array', async () => {
  const repo = createInvestigationsRepository({ pool: makeFakePool() });
  await assert.rejects(() => repo.save(investigation({ evidence: [] })), /evidence/);
});

// Regression test: the locator returns window.from/to as ISO strings (its
// public JSON shape). mysql2 sends a raw string param through to MySQL
// unmodified — including the 'T'/'Z'/milliseconds — which MySQL's strict-mode
// DATETIME parser rejects. save() must convert to Date objects before the
// query reaches mysql2, matching the convention used by findings.js.
test('save converts window.from/to ISO strings to Date objects for the DB params', async () => {
  const pool = makeFakePool();
  const repo = createInvestigationsRepository({ pool });
  await repo.save(investigation());
  assert.ok(pool.rows[0].window_from instanceof Date);
  assert.ok(pool.rows[0].window_to instanceof Date);
});

test('save persists and returns an investigation with an id', async () => {
  const repo = createInvestigationsRepository({ pool: makeFakePool() });
  const saved = await repo.save(investigation());
  assert.ok(saved.id && typeof saved.id === 'string');
});

test('list returns saved investigations newest first', async () => {
  const pool = makeFakePool();
  const repo = createInvestigationsRepository({ pool });
  await repo.save(investigation());
  await repo.save(investigation());
  const list = await repo.list({ limit: 50, offset: 0 });
  assert.equal(list.length, 2);
});

test('findById returns null for an unknown id', async () => {
  const repo = createInvestigationsRepository({ pool: makeFakePool() });
  const result = await repo.findById('no-such-id');
  assert.equal(result, null);
});
