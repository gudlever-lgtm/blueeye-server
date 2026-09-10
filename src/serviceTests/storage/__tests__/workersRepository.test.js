'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakePool, ok } = require('./fakePool');
const { createWorkersRepository } = require('../workersRepository');

const NOW = new Date('2026-09-10T12:00:00.000Z');
const now = () => NOW;

function makeRepo(handlers = []) {
  const pool = makeFakePool(handlers);
  return { pool, repo: createWorkersRepository({ db: { pool }, now }) };
}

test('a heartbeat is an upsert, so a running worker never accumulates rows', async () => {
  const { pool, repo } = makeRepo([[/^INSERT INTO service_test_workers/i, () => ok()]]);
  await repo.heartbeat({ workerId: 'assurance-1-12', hostname: 'assurance-1', version: '0.120.4' });

  const [call] = pool.matching(/^INSERT INTO service_test_workers/i);
  assert.match(call.sql, /ON DUPLICATE KEY UPDATE/i);
  assert.match(call.sql, /last_seen_at = VALUES\(last_seen_at\)/i);
  // started_at is deliberately NOT in the update list — the UI shows uptime.
  assert.ok(!/started_at = VALUES/i.test(call.sql));
  assert.deepEqual(call.params, ['assurance-1-12', 'assurance-1', '0.120.4', NOW, NOW]);
});

test('an over-long worker id, hostname or version is truncated to the column width', async () => {
  const { pool, repo } = makeRepo([[/^INSERT INTO service_test_workers/i, () => ok()]]);
  await repo.heartbeat({ workerId: 'w'.repeat(400), hostname: 'h'.repeat(400), version: 'v'.repeat(400) });
  const [call] = pool.matching(/^INSERT INTO service_test_workers/i);
  assert.equal(call.params[0].length, 190);
  assert.equal(call.params[1].length, 255);
  assert.equal(call.params[2].length, 64);
});

test('a heartbeat with no worker id is refused rather than written as an empty key', async () => {
  const { repo } = makeRepo([[/^INSERT INTO service_test_workers/i, () => ok()]]);
  await assert.rejects(() => repo.heartbeat({ workerId: '' }), /workerId is required/);
  await assert.rejects(() => repo.heartbeat({}), /workerId is required/);
});

test('listAlive asks for the rows inside the window, newest first', async () => {
  const row = {
    worker_id: 'w1', hostname: 'assurance-1', version: '0.120.4', started_at: NOW, last_seen_at: NOW,
  };
  const { pool, repo } = makeRepo([[/^SELECT .* FROM service_test_workers WHERE last_seen_at >= \?/i, () => [[row]]]]);
  const alive = await repo.listAlive(60000);

  const [call] = pool.matching(/^SELECT .* FROM service_test_workers WHERE/i);
  assert.match(call.sql, /ORDER BY last_seen_at DESC/i);
  assert.deepEqual(call.params, [new Date(NOW.getTime() - 60000)]);
  assert.deepEqual(alive, [row]);
});

test('a nonsense window falls back to a minute rather than asking for everything', async () => {
  const { pool, repo } = makeRepo([[/^SELECT .* FROM service_test_workers WHERE/i, () => [[]]]]);
  await repo.listAlive('not a number');
  await repo.listAlive(-5000);
  const calls = pool.matching(/^SELECT .* FROM service_test_workers WHERE/i);
  assert.deepEqual(calls[0].params, [new Date(NOW.getTime() - 60000)]);
  assert.deepEqual(calls[1].params, [new Date(NOW.getTime() - 1000)]);
});

test('prune deletes only rows well past the window', async () => {
  const { pool, repo } = makeRepo([[/^DELETE FROM service_test_workers/i, () => ok({ affectedRows: 3 })]]);
  const removed = await repo.prune(7 * 24 * 60 * 60 * 1000);
  assert.equal(removed, 3);
  const [call] = pool.matching(/^DELETE FROM service_test_workers/i);
  assert.deepEqual(call.params, [new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000)]);
});
