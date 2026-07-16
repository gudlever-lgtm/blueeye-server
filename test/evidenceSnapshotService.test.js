'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSnapshotService } = require('../src/evidence/snapshotService');
const { COMMAND_SET_VERSION, DEFAULT_ITEMS, isAllowed, partition } = require('../src/evidence/commandAllowlist');
const { makeEvidenceSnapshotsRepo } = require('../test-support/fakes');

const flush = () => new Promise((r) => setImmediate(r));

// ---- server-side allowlist (single source of truth) -----------------------

test('the server allowlist is read-only and rejects write-class items', () => {
  assert.ok(isAllowed('agent.state'));
  assert.ok(isAllowed('iface.counters'));
  assert.equal(isAllowed('reboot'), false);
  assert.equal(isAllowed('iface.set'), false);
  // The default command set is exactly the read-only allowlist.
  assert.deepEqual([...DEFAULT_ITEMS].sort(), ['agent.state', 'arp.table', 'iface.counters', 'snmp.reads']);
});

test('partition splits requested items into allowed vs refused; empty → full default set', () => {
  const { allowed, refused } = partition(['agent.state', 'reboot', 'iface.set']);
  assert.deepEqual(allowed, ['agent.state']);
  assert.deepEqual(refused.sort(), ['iface.set', 'reboot']);
  assert.deepEqual([...partition([]).allowed].sort(), [...DEFAULT_ITEMS].sort());
});

// ---- capture: happy path, partial, timeout, offline -----------------------

function makeCommander(sendCommandAndWait) {
  return { sendCommand: () => 1, sendCommandAndWait };
}

test('captureForCluster completes a snapshot from the agent reply', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const svc = createSnapshotService({
    evidenceRepo,
    agentCommander: makeCommander(async () => ({
      delivered: 1, acked: true,
      reply: { evidence: { commandSetVersion: COMMAND_SET_VERSION, items: [
        { name: 'agent.state', status: 'ok', payload: 'connected: yes' },
        { name: 'iface.counters', status: 'ok', payload: 'eth0 errs=0' },
      ] } },
    })),
  });
  const out = await svc.captureForCluster(5, ['10'], { trigger: 'auto' });
  assert.equal(out.snapshots.length, 1);
  const snap = evidenceRepo.rows[0];
  assert.equal(snap.status, 'complete');
  assert.equal(snap.cluster_id, 5);
  const payload = await evidenceRepo.getPayload(snap.id);
  assert.match(payload, /connected: yes/);
});

test('a mix of ok + failing items is stored as a partial snapshot', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const svc = createSnapshotService({
    evidenceRepo,
    agentCommander: makeCommander(async () => ({
      delivered: 1, acked: true,
      reply: { evidence: { items: [
        { name: 'agent.state', status: 'ok', payload: 'ok' },
        { name: 'iface.counters', status: 'timeout' },
      ] } },
    })),
  });
  await svc.captureForCluster(5, ['10']);
  assert.equal(evidenceRepo.rows[0].status, 'partial');
});

test('a timed-out command records a failed snapshot (never blocks)', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const svc = createSnapshotService({
    evidenceRepo,
    agentCommander: makeCommander(async () => ({ delivered: 1, acked: false, timedOut: true, reply: null })),
  });
  await svc.captureForCluster(5, ['10']);
  assert.equal(evidenceRepo.rows[0].status, 'failed');
});

test('an offline agent is retried once, then recorded agent-offline', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  let attempts = 0;
  const svc = createSnapshotService({
    evidenceRepo,
    agentCommander: makeCommander(async () => { attempts += 1; return { delivered: 0, acked: false, reply: null }; }),
    // Run the retry synchronously so the test can observe the terminal state.
    scheduleRetry: (fn) => { fn(); },
  });
  await svc.captureForCluster(5, ['10']);
  await flush();
  assert.equal(attempts, 2, 'offline is retried exactly once');
  assert.equal(evidenceRepo.rows[0].status, 'agent-offline');
});

test('capture NEVER throws even if the commander blows up', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const svc = createSnapshotService({
    evidenceRepo,
    agentCommander: makeCommander(async () => { throw new Error('socket exploded'); }),
    scheduleRetry: (fn) => { fn(); },
  });
  // A send that throws is treated as offline (delivered 0) → retry → agent-offline.
  await assert.doesNotReject(() => svc.captureForCluster(5, ['10']));
  await flush();
  assert.equal(evidenceRepo.rows[0].status, 'agent-offline');
});

test('multiple targets each open their own snapshot row', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const svc = createSnapshotService({
    evidenceRepo,
    concurrency: 2,
    agentCommander: makeCommander(async () => ({ delivered: 1, acked: true, reply: { evidence: { items: [{ name: 'agent.state', status: 'ok', payload: 'x' }] } } })),
  });
  const out = await svc.captureForCluster(7, ['1', '2', '3', '3'], { trigger: 'auto' });
  assert.equal(out.snapshots.length, 3, 'duplicate targets are de-duplicated');
  assert.equal(evidenceRepo.rows.length, 3);
  assert.ok(evidenceRepo.rows.every((r) => r.status === 'complete'));
});

test('no targets → no snapshots, no commander calls', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  let called = false;
  const svc = createSnapshotService({ evidenceRepo, agentCommander: makeCommander(async () => { called = true; return { delivered: 1 }; }) });
  const out = await svc.captureForCluster(7, [], { trigger: 'auto' });
  assert.deepEqual(out.snapshots, []);
  assert.equal(called, false);
});

// ---- signing --------------------------------------------------------------

test('the evidence command is signed when a release key is configured', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const seen = [];
  const svc = createSnapshotService({
    evidenceRepo,
    releaseKeyService: { canSign: () => true, sign: (obj) => `sig(${obj.name}:${obj.items.length})` },
    agentCommander: makeCommander(async (target, command) => { seen.push(command); return { delivered: 1, acked: true, reply: { evidence: { items: [{ name: 'agent.state', status: 'ok', payload: 'x' }] } } }; }),
  });
  await svc.captureForCluster(5, ['10']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'evidence');
  assert.equal(seen[0].commandSetVersion, COMMAND_SET_VERSION);
  assert.deepEqual(seen[0].items, DEFAULT_ITEMS);
  assert.match(seen[0].signature, /^sig\(evidence:4\)$/);
});
