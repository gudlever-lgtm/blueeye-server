'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeTransactionsRepo } = require('../test-support/fakes');
const { createTransactionBaselineJob } = require('../src/analysis/transactionBaselines');

// Seeds a test + assignment + ok results, then verifies the job computes a
// median/MAD baseline per step (step 0 = latency, steps 1..N = step_timings).
test('baseline job computes median + MAD per (test, agent, step)', async () => {
  const repo = makeTransactionsRepo();
  await repo.create({ name: 'T', type: 'http', config: { steps: [{ url: 'https://x/' }] } }); // id 1
  await repo.setAgents(1, [9]);
  // latency 10/20/30 -> median 20, mad 10; step1 5/5/5 -> median 5, mad 0
  for (const [lat, s1] of [[10, 5], [20, 5], [30, 5]]) {
    repo.resultRows.push({ time: 't', test_id: 1, agent_id: 9, status: 'ok', latency_ms: lat, step_timings: [s1] });
  }
  const job = createTransactionBaselineJob({ repo });
  const updated = await job.runOnce();
  assert.ok(updated >= 2, 'should upsert baselines for step 0 and step 1');

  const b0 = await repo.getBaseline(1, 9, 0);
  assert.equal(b0.median_ms, 20);
  assert.equal(b0.mad_ms, 10);
  assert.equal(b0.sample_count, 3);

  const b1 = await repo.getBaseline(1, 9, 1);
  assert.equal(b1.median_ms, 5);
  assert.equal(b1.mad_ms, 0);
});

test('baseline job skips pairs with no ok results (no throw)', async () => {
  const repo = makeTransactionsRepo();
  await repo.create({ name: 'T', type: 'tcp', target: 'db', config: { port: 5432 } });
  await repo.setAgents(1, [9]);
  const job = createTransactionBaselineJob({ repo });
  const updated = await job.runOnce();
  assert.equal(updated, 0);
});
