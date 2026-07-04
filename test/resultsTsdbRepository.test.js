'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createResultsTsdbRepository } = require('../src/repositories/resultsTsdbRepository');

// Fake pg pool that records the last query and returns a scripted result.
function makePool(result = { rows: [], rowCount: 0 }, onQuery) {
  const calls = [];
  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (onQuery) return onQuery(text, params);
      return result;
    },
  };
}

test('createMany: builds a parameterized multi-row INSERT and returns rowCount', async () => {
  const pool = makePool({ rowCount: 2 });
  const repo = createResultsTsdbRepository({ pool });
  const at = new Date('2026-07-04T12:00:00Z');

  const n = await repo.createMany(42, [{ a: 1 }, { b: 2 }], at);

  assert.equal(n, 2);
  assert.equal(pool.calls.length, 1);
  const { text, params } = pool.calls[0];
  assert.match(text, /INSERT INTO results \(agent_id, ts, payload\) VALUES \(\$1, \$2, \$3\), \(\$4, \$5, \$6\)/);
  assert.deepEqual(params, [42, at, JSON.stringify({ a: 1 }), 42, at, JSON.stringify({ b: 2 })]);
});

test('createMany: empty/invalid payload list is a no-op (no query, returns 0)', async () => {
  const pool = makePool();
  const repo = createResultsTsdbRepository({ pool });

  assert.equal(await repo.createMany(1, []), 0);
  assert.equal(await repo.createMany(1, null), 0);
  assert.equal(pool.calls.length, 0);
});

test('latestPerAgent: uses last() with a mandatory time bound and maps rows', async () => {
  const rows = [
    { agent_id: 7, payload: { cpu: 10 }, created_at: new Date('2026-07-04T12:00:00Z') },
  ];
  const pool = makePool({ rows });
  const repo = createResultsTsdbRepository({ pool }, { latestWindowMinutes: 5 });

  const out = await repo.latestPerAgent();

  assert.deepEqual(out, [{ agent_id: 7, payload: { cpu: 10 }, created_at: rows[0].created_at }]);
  const { text, params } = pool.calls[0];
  assert.match(text, /last\(payload, ts\)/);
  assert.match(text, /WHERE ts >= now\(\) - make_interval\(mins => \$1::int\)/);
  assert.deepEqual(params, [5]);
});

test('latestPerAgent: window override is passed through; empty result yields []', async () => {
  const pool = makePool({ rows: [] });
  const repo = createResultsTsdbRepository({ pool }, { latestWindowMinutes: 5 });

  const out = await repo.latestPerAgent(15);

  assert.deepEqual(out, []);
  assert.deepEqual(pool.calls[0].params, [15]);
});

test('latestPerAgent: propagates a TSDB error (caller decides how to degrade → 500)', async () => {
  const pool = makePool(undefined, async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:5432');
  });
  const repo = createResultsTsdbRepository({ pool });

  await assert.rejects(() => repo.latestPerAgent(), /ECONNREFUSED/);
});

test('createMany: propagates a TSDB write error (mirror caller swallows it)', async () => {
  const pool = makePool(undefined, async () => {
    throw new Error('relation "results" does not exist');
  });
  const repo = createResultsTsdbRepository({ pool });

  await assert.rejects(() => repo.createMany(1, [{ a: 1 }]), /does not exist/);
});
