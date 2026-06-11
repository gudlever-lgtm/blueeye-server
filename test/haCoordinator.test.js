'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHaCoordinator } = require('../src/ha/coordinator');

// A job that records start/stop calls and its running state.
function makeJob() {
  const calls = [];
  return {
    calls,
    running: false,
    start() { this.running = true; calls.push('start'); },
    stop() { this.running = false; calls.push('stop'); },
  };
}

// A controllable fake leader lock — its leadership is flipped by the test.
function makeFakeLock(initial = false) {
  let leader = initial;
  return {
    setLeader(v) { leader = v; },
    async tick() { return leader; },
    async release() { leader = false; },
    isLeader() { return leader; },
    status() { return { lockName: 'L', isLeader: leader }; },
  };
}

function makeNodesRepo() {
  const beats = [];
  return {
    beats,
    async heartbeat(row) { beats.push(row); },
    // Mirror the real repository's row shape (snake_case columns).
    async listActive() {
      if (!beats.length) return [];
      const b = beats[beats.length - 1];
      return [{ node_id: b.nodeId, hostname: b.hostname, pid: b.pid, version: b.version, is_leader: b.isLeader, active: true }];
    },
    async markStopped() {},
  };
}

test('HA disabled: the node is permanently leader and runs every job immediately', async () => {
  const job = makeJob();
  const coord = createHaCoordinator({ enabled: false, nodeId: 'solo', jobs: [job] });
  await coord.start();
  assert.equal(coord.isLeader(), true);
  assert.equal(job.running, true);
  assert.deepEqual(job.calls, ['start']);
  const status = coord.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.role, 'leader');
  // step-down is a no-op when HA is off.
  assert.deepEqual(await coord.stepDown(), { ok: false, reason: 'ha_disabled' });
});

test('HA enabled: a follower runs NO jobs until it wins the lock', async () => {
  const job = makeJob();
  const lock = makeFakeLock(false);
  const nodesRepo = makeNodesRepo();
  const coord = createHaCoordinator({ enabled: true, nodeId: 'n1', lock, nodesRepo, jobs: [job] });

  await coord.start(); // first tick: lock not held → stays follower
  assert.equal(coord.isLeader(), false);
  assert.equal(job.running, false);
  assert.equal(coord.getStatus().role, 'follower');
  // It still heartbeats so the cluster registry sees it.
  assert.ok(nodesRepo.beats.length >= 1);

  // It wins the election on a later tick → jobs start exactly once.
  lock.setLeader(true);
  await coord.tickOnce();
  assert.equal(coord.isLeader(), true);
  assert.equal(job.running, true);
  assert.deepEqual(job.calls, ['start']);

  // Re-ticking while still leader does NOT restart the jobs (idempotent).
  await coord.tickOnce();
  assert.deepEqual(job.calls, ['start']);
});

test('HA enabled: losing the lock stops the singleton jobs', async () => {
  const job = makeJob();
  const lock = makeFakeLock(true);
  const coord = createHaCoordinator({ enabled: true, nodeId: 'n1', lock, nodesRepo: makeNodesRepo(), jobs: [job] });

  await coord.start(); // becomes leader, starts jobs
  assert.equal(job.running, true);

  // The lock is lost (e.g. connection dropped) — next tick demotes us.
  lock.setLeader(false);
  await coord.tickOnce();
  assert.equal(coord.isLeader(), false);
  assert.equal(job.running, false);
  assert.deepEqual(job.calls, ['start', 'stop']);
});

test('HA enabled: an admin step-down releases the lock and stops jobs', async () => {
  const job = makeJob();
  const lock = makeFakeLock(true);
  const coord = createHaCoordinator({ enabled: true, nodeId: 'n1', lock, nodesRepo: makeNodesRepo(), jobs: [job] });
  await coord.start();
  assert.equal(coord.isLeader(), true);

  const res = await coord.stepDown();
  assert.deepEqual(res, { ok: true });
  assert.equal(coord.isLeader(), false);
  assert.equal(job.running, false);

  // A follower cannot step down.
  assert.deepEqual(await coord.stepDown(), { ok: false, reason: 'not_leader' });
});

test('listNodes reflects the cluster registry when enabled', async () => {
  const lock = makeFakeLock(true);
  const nodesRepo = makeNodesRepo();
  const coord = createHaCoordinator({ enabled: true, nodeId: 'n1', lock, nodesRepo, jobs: [], version: '9.9.9' });
  await coord.start();
  const nodes = await coord.listNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].node_id, 'n1');
  assert.equal(nodes[0].is_leader, true);
});

test('coordinator survives a job throwing on start', async () => {
  const bad = { start() { throw new Error('boom'); }, stop() {} };
  const good = makeJob();
  const coord = createHaCoordinator({ enabled: false, nodeId: 'solo', jobs: [bad, good] });
  await coord.start(); // must not reject
  assert.equal(good.running, true); // the good job still started
});
