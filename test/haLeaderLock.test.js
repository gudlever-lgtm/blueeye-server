'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createLeaderLock } = require('../src/ha/leaderLock');

// A fake mysql2 pool that models the session-scoped advisory lock behaviour we
// rely on: GET_LOCK(name, 0) succeeds for exactly one live connection; others
// get 0. IS_USED_LOCK(name) returns the holder's connection id (or null), and
// CONNECTION_ID() returns the querying connection's id. A connection can be
// "killed" to simulate a dropped DB connection (which frees any lock it held).
function makeFakePool() {
  const holders = new Map(); // lockName -> owning connection id
  let nextCid = 1;
  const live = new Set();

  function freeLocksOf(cid) {
    for (const [name, owner] of holders) if (owner === cid) holders.delete(name);
  }

  function makeConnection() {
    const cid = nextCid++;
    live.add(cid);
    return {
      cid,
      async query(sql, params) {
        if (!live.has(cid)) {
          const err = new Error('connection lost');
          err.fatal = true;
          throw err;
        }
        if (/GET_LOCK/.test(sql)) {
          const [name] = params;
          const owner = holders.get(name);
          if (owner === undefined || owner === cid) {
            holders.set(name, cid);
            return [[{ ok: 1 }]];
          }
          return [[{ ok: 0 }]]; // held by another live connection
        }
        if (/IS_USED_LOCK/.test(sql)) {
          const [name] = params;
          const owner = holders.get(name);
          return [[{ owner_cid: owner === undefined ? null : owner, my_cid: cid }]];
        }
        if (/RELEASE_LOCK/.test(sql)) {
          const [name] = params;
          if (holders.get(name) === cid) { holders.delete(name); return [[{ released: 1 }]]; }
          return [[{ released: 0 }]];
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
      release() { /* returns the connection to the pool; lock persists */ },
    };
  }

  const pool = { async getConnection() { return makeConnection(); } };
  return {
    pool,
    holderOf: (name) => holders.get(name) ?? null,
    // Simulate the leader's held connection dropping.
    kill(cid) { live.delete(cid); freeLocksOf(cid); },
  };
}

test('a single node acquires leadership on the first tick', async () => {
  const fake = makeFakePool();
  const lock = createLeaderLock({ pool: fake.pool, lockName: 'L', nodeId: 'A' });
  assert.equal(lock.isLeader(), false);
  await lock.tick();
  assert.equal(lock.isLeader(), true);
  assert.ok(lock.status().since);
});

test('only one of two contending nodes becomes leader', async () => {
  const fake = makeFakePool();
  const a = createLeaderLock({ pool: fake.pool, lockName: 'L', nodeId: 'A' });
  const b = createLeaderLock({ pool: fake.pool, lockName: 'L', nodeId: 'B' });
  await a.tick();
  await b.tick();
  assert.equal(a.isLeader(), true);
  assert.equal(b.isLeader(), false);
  // B keeps failing to acquire while A holds it, however many times it tries.
  await b.tick();
  await b.tick();
  assert.equal(b.isLeader(), false);
});

test('a follower promotes after the leader steps down (release)', async () => {
  const fake = makeFakePool();
  const a = createLeaderLock({ pool: fake.pool, lockName: 'L', nodeId: 'A' });
  const b = createLeaderLock({ pool: fake.pool, lockName: 'L', nodeId: 'B' });
  await a.tick();
  await b.tick();
  assert.equal(a.isLeader(), true);

  await a.release(); // voluntary step-down
  assert.equal(a.isLeader(), false);
  assert.equal(fake.holderOf('L'), null);

  await b.tick(); // B now wins the free lock
  assert.equal(b.isLeader(), true);
});

test('a leader whose connection drops is demoted and a follower takes over', async () => {
  const fake = makeFakePool();
  const a = createLeaderLock({ pool: fake.pool, lockName: 'L', nodeId: 'A' });
  const b = createLeaderLock({ pool: fake.pool, lockName: 'L', nodeId: 'B' });
  await a.tick();
  await b.tick();
  assert.equal(a.isLeader(), true);

  // Simulate A's held DB connection dying — its lock is freed server-side.
  // holderOf returns the connection id that currently owns the lock (A's).
  const ownerCid = fake.holderOf('L');
  fake.kill(ownerCid);

  // Next health-check tick: A notices it no longer holds the lock → demotes.
  await a.tick();
  assert.equal(a.isLeader(), false);

  // B can now acquire.
  await b.tick();
  assert.equal(b.isLeader(), true);
});

test('acquire is idempotent — re-ticking the leader keeps it leader without re-locking', async () => {
  const fake = makeFakePool();
  const a = createLeaderLock({ pool: fake.pool, lockName: 'L', nodeId: 'A' });
  await a.tick();
  const firstSince = a.status().since;
  await a.tick();
  await a.tick();
  assert.equal(a.isLeader(), true);
  assert.equal(a.status().since, firstSince); // leadership not re-established
});

test('release on a node that never led is a safe no-op', async () => {
  const fake = makeFakePool();
  const a = createLeaderLock({ pool: fake.pool, lockName: 'L', nodeId: 'A' });
  await a.release();
  assert.equal(a.isLeader(), false);
});
