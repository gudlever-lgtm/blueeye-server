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
  assert.equal(res.ok, true);
  assert.ok(res.drainingUntil); // reports when re-contention resumes
  assert.equal(coord.isLeader(), false);
  assert.equal(job.running, false);

  // A follower cannot step down.
  assert.deepEqual(await coord.stepDown(), { ok: false, reason: 'not_leader' });
});

test('HA enabled: a stepped-down node does not recontend during the cooldown', async () => {
  const job = makeJob();
  const lock = makeFakeLock(true);
  let clock = 1000;
  const coord = createHaCoordinator({
    enabled: true, nodeId: 'n1', lock, nodesRepo: makeNodesRepo(), jobs: [job],
    stepDownCooldownMs: 5000, now: () => clock,
  });
  await coord.start();
  assert.equal(coord.isLeader(), true);

  await coord.stepDown();
  assert.equal(coord.isLeader(), false);
  assert.equal(coord.getStatus().draining, true);

  // Even though the lock is now free (and would grant), the drained node stands
  // down: it must NOT reacquire while the cooldown is active.
  lock.setLeader(true); // simulate the lock being grantable again
  await coord.tickOnce();
  assert.equal(coord.isLeader(), false, 'should not reacquire during cooldown');
  assert.equal(job.running, false);

  // After the cooldown elapses it is allowed to contend again.
  clock += 6000;
  assert.equal(coord.getStatus().draining, false);
  await coord.tickOnce();
  assert.equal(coord.isLeader(), true);
  assert.equal(job.running, true);
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

test('HA enabled but UNLICENSED degrades to standalone (no clustering), then activates when entitled', async () => {
  const job = makeJob();
  const lock = makeFakeLock(false);
  const nodesRepo = makeNodesRepo();
  let allowed = false;
  const featureGate = { isFeatureEnabled: () => allowed };
  const coord = createHaCoordinator({ enabled: true, nodeId: 'n1', lock, nodesRepo, jobs: [job], featureGate });

  await coord.start();
  // Not licensed for ha_deployment → standalone leader: jobs run locally, but no
  // lock contention and no cluster-registry write.
  assert.equal(coord.isLeader(), true);
  assert.equal(job.running, true);
  assert.equal(coord.getStatus().clustering, false);
  assert.equal(coord.getStatus().licensed, false);
  assert.equal(nodesRepo.beats.length, 0, 'must not register in the cluster view while unlicensed');
  // Step-down is a no-op when not clustering.
  assert.deepEqual(await coord.stepDown(), { ok: false, reason: 'ha_disabled' });
  // The cluster view is just this node.
  const nodes = await coord.listNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].node_id, 'n1');

  // Licence validates and the node wins the (now contended) lock → clustering
  // activates on the next tick: it holds the lock and registers a heartbeat.
  allowed = true;
  lock.setLeader(true);
  await coord.tickOnce();
  assert.equal(coord.getStatus().clustering, true);
  assert.equal(coord.isLeader(), true);
  assert.equal(job.running, true);
  assert.ok(nodesRepo.beats.length >= 1, 'should register in the cluster view once entitled');
});

test('coordinator survives a job throwing on start', async () => {
  const bad = { start() { throw new Error('boom'); }, stop() {} };
  const good = makeJob();
  const coord = createHaCoordinator({ enabled: false, nodeId: 'solo', jobs: [bad, good] });
  await coord.start(); // must not reject
  assert.equal(good.running, true); // the good job still started
});
