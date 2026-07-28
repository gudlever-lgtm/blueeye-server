'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Tests for the TWO ingest seams that populate arp_entries (migration 073):
//
//   1. POST /agents/me/capabilities — the agent reports its own neighbour table
//      on the regular cycle. Fresh and continuous, but only from agents new
//      enough to send it.
//   2. Evidence snapshot capture — the arp.table item that was ALREADY being
//      collected is parsed on the way past. Works against agents already in the
//      field, but only fires when a cluster opens.
//
// Both are best-effort: neither may break the thing it rides along with.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeAgentTokensRepo,
  makeArpEntriesRepo,
  makeEvidenceSnapshotsRepo,
  makeAgentCommander,
  throwingAsync,
} = require('../test-support/fakes');

const { createSnapshotService } = require('../src/evidence/snapshotService');

// An agent token that maps to agent_id 9.
const agentToken = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });

function postCapabilities(app, capabilities) {
  return request(app)
    .post('/agents/me/capabilities')
    .set('Authorization', 'Bearer agent-tok')
    .send({ capabilities });
}

// ------------------------------------------------- seam 1: capabilities report
test('capabilities.arp is ingested into arp_entries', async () => {
  const arpEntriesRepo = makeArpEntriesRepo();
  const app = makeApp({ arpEntriesRepo, agentTokensRepo: agentToken() });

  const res = await postCapabilities(app, {
    sources: ['proc'],
    arp: [
      { ip: '192.168.1.10', mac: '00:11:22:33:44:55', interface: 'eth0' },
      { ip: '192.168.1.11', mac: '00-1A-2B-3C-4D-5E', dev: 'eth0' },
    ],
  });

  assert.equal(res.status, 200);
  assert.equal(arpEntriesRepo.rows.length, 2);
  assert.equal(arpEntriesRepo.rows[0].agent_id, 9, 'agent id comes from the token, never the body');
  assert.equal(arpEntriesRepo.rows[0].source, 'capabilities');
  // Both spellings normalise to the same colon form.
  assert.deepEqual(arpEntriesRepo.rows.map((r) => r.mac), ['00:11:22:33:44:55', '00:1a:2b:3c:4d:5e']);
});

test('unusable ARP rows are dropped without failing the report', async () => {
  const arpEntriesRepo = makeArpEntriesRepo();
  const app = makeApp({ arpEntriesRepo, agentTokensRepo: agentToken() });

  const res = await postCapabilities(app, {
    sources: ['proc'],
    arp: [
      { ip: '192.168.1.255', mac: 'ff:ff:ff:ff:ff:ff' }, // broadcast
      { ip: '224.0.0.22', mac: '01:00:5e:00:00:16' },    // multicast
      { ip: '192.168.1.9', mac: '00:00:00:00:00:00' },   // incomplete
      { ip: 'not-an-ip', mac: '00:11:22:33:44:55' },
      null,
      { ip: '192.168.1.10', mac: '00:11:22:33:44:55' },  // the only good one
    ],
  });

  assert.equal(res.status, 200);
  assert.equal(arpEntriesRepo.rows.length, 1);
  assert.equal(arpEntriesRepo.rows[0].ip, '192.168.1.10');
});

test('a missing or malformed capabilities.arp is simply ignored', async () => {
  const arpEntriesRepo = makeArpEntriesRepo();
  const app = makeApp({ arpEntriesRepo, agentTokensRepo: agentToken() });

  for (const arp of [undefined, null, 'nope', 42, {}]) {
    const res = await postCapabilities(app, { sources: ['proc'], ...(arp === undefined ? {} : { arp }) });
    assert.equal(res.status, 200, `arp=${JSON.stringify(arp)} must not break the report`);
  }
  assert.equal(arpEntriesRepo.rows.length, 0);
});

test('an ARP ingest failure never breaks the capabilities report', async () => {
  // The capabilities report is the agent's lifeline; an identity side-benefit
  // must not be able to cost it.
  const arpEntriesRepo = makeArpEntriesRepo({ upsertMany: throwingAsync('arp table full') });
  const app = makeApp({ arpEntriesRepo, agentTokensRepo: agentToken() });

  const res = await postCapabilities(app, {
    sources: ['proc'],
    arp: [{ ip: '192.168.1.10', mac: '00:11:22:33:44:55' }],
  });
  assert.equal(res.status, 200);
});

test('re-reporting the same binding bumps last_seen without stamping a change', async () => {
  const arpEntriesRepo = makeArpEntriesRepo();
  const app = makeApp({ arpEntriesRepo, agentTokensRepo: agentToken() });
  const entry = { ip: '192.168.1.10', mac: '00:11:22:33:44:55' };

  await postCapabilities(app, { sources: ['proc'], arp: [entry] });
  const firstSeen = arpEntriesRepo.rows[0].first_seen;
  await postCapabilities(app, { sources: ['proc'], arp: [entry] });

  assert.equal(arpEntriesRepo.rows.length, 1, 'one row per (agent, ip)');
  assert.equal(arpEntriesRepo.rows[0].first_seen, firstSeen);
  assert.equal(arpEntriesRepo.rows[0].mac_changed_at, null, 'the binding did not move');
});

test('a NEW MAC on a known IP rewrites the row and stamps mac_changed_at', async () => {
  // This is the signal a technician chasing an intermittent fault wants: the
  // address is the same, but something else is answering for it now.
  const arpEntriesRepo = makeArpEntriesRepo();
  const app = makeApp({ arpEntriesRepo, agentTokensRepo: agentToken() });

  await postCapabilities(app, { sources: ['proc'], arp: [{ ip: '192.168.1.10', mac: '00:11:22:33:44:55' }] });
  await postCapabilities(app, { sources: ['proc'], arp: [{ ip: '192.168.1.10', mac: '00:1a:2b:3c:4d:5e' }] });

  assert.equal(arpEntriesRepo.rows.length, 1);
  assert.equal(arpEntriesRepo.rows[0].mac, '00:1a:2b:3c:4d:5e');
  assert.ok(arpEntriesRepo.rows[0].mac_changed_at, 'expected the change to be stamped');
});

test('the seam is inert when no ARP repo is wired (pre-migration)', async () => {
  const app = makeApp({ arpEntriesRepo: null, agentTokensRepo: agentToken() });
  const res = await postCapabilities(app, {
    sources: ['proc'],
    arp: [{ ip: '192.168.1.10', mac: '00:11:22:33:44:55' }],
  });
  assert.equal(res.status, 200);
});

// ----------------------------------------------------- seam 2: evidence capture
// Builds a snapshot service over fakes, with a commander that replies with the
// given evidence items.
function evidenceSetup(items, arpOverrides = {}) {
  const arpEntriesRepo = makeArpEntriesRepo(arpOverrides);
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async () => ({ delivered: 1, acked: true, reply: { evidence: { items } } }),
  });
  const service = createSnapshotService({ evidenceRepo, agentCommander, arpEntriesRepo });
  return { service, arpEntriesRepo, evidenceRepo };
}

const PROC_NET_ARP = [
  'IP address       HW type     Flags       HW address            Mask     Device',
  '192.168.1.1      0x1         0x2         00:11:22:33:44:55     *        eth0',
  '192.168.1.50     0x1         0x2         00:1a:2b:3c:4d:5e     *        eth0',
  '192.168.1.99     0x1         0x0         00:00:00:00:00:00     *        eth0',
].join('\n');

test('an evidence capture harvests its arp.table item into arp_entries', async () => {
  const { service, arpEntriesRepo, evidenceRepo } = evidenceSetup([
    { name: 'iface.counters', status: 'ok', payload: 'rx 1 tx 2' },
    { name: 'arp.table', status: 'ok', payload: PROC_NET_ARP },
  ]);

  await service.captureForCluster(1, [9]);

  assert.equal(arpEntriesRepo.rows.length, 2, 'the incomplete row is dropped');
  assert.deepEqual(arpEntriesRepo.rows.map((r) => r.ip), ['192.168.1.1', '192.168.1.50']);
  assert.equal(arpEntriesRepo.rows[0].agent_id, 9);
  assert.equal(arpEntriesRepo.rows[0].source, 'evidence');
  // The snapshot itself is untouched — it stays an immutable record of what the
  // agent said; this only ALSO parses one item on the way past.
  assert.equal(evidenceRepo.rows.length, 1);
  assert.match(evidenceRepo.rows[0].payload_gzip, /00:11:22:33:44:55/);
});

test('a failed arp.table item is not harvested', async () => {
  const { service, arpEntriesRepo } = evidenceSetup([
    { name: 'arp.table', status: 'timeout', payload: PROC_NET_ARP },
  ]);
  await service.captureForCluster(1, [9]);
  assert.equal(arpEntriesRepo.rows.length, 0, 'only an ok item is trustworthy');
});

test('an arp harvest failure never breaks the evidence capture', async () => {
  const { service, arpEntriesRepo, evidenceRepo } = evidenceSetup(
    [{ name: 'arp.table', status: 'ok', payload: PROC_NET_ARP }],
    { upsertMany: throwingAsync('arp write failed') },
  );

  await service.captureForCluster(1, [9]);

  assert.equal(arpEntriesRepo.rows.length, 0);
  // Evidence capture is the actual job here and it still completed.
  assert.equal(evidenceRepo.rows.length, 1);
  assert.equal(evidenceRepo.rows[0].status, 'complete');
});

test('evidence capture works unchanged when no ARP repo is wired', async () => {
  const evidenceRepo = makeEvidenceSnapshotsRepo();
  const agentCommander = makeAgentCommander({
    sendCommandAndWait: async () => ({
      delivered: 1, acked: true,
      reply: { evidence: { items: [{ name: 'arp.table', status: 'ok', payload: PROC_NET_ARP }] } },
    }),
  });
  const service = createSnapshotService({ evidenceRepo, agentCommander, arpEntriesRepo: null });

  await service.captureForCluster(1, [9]);
  assert.equal(evidenceRepo.rows.length, 1);
});

// --------------------------------------------------------------------- retention
test('purgeBefore ages out entries not re-observed in the window', async () => {
  // A neighbour table is a snapshot of a segment; a stale answer to "where is
  // this MAC" is worse than no answer.
  const repo = makeArpEntriesRepo();
  await repo.upsertMany(9, [{ ip: '10.0.0.1', mac: '00:11:22:33:44:55' }], { at: new Date('2026-01-01T00:00:00Z') });
  await repo.upsertMany(9, [{ ip: '10.0.0.2', mac: '00:1a:2b:3c:4d:5e' }], { at: new Date('2026-07-28T00:00:00Z') });

  const removed = await repo.purgeBefore(new Date('2026-07-01T00:00:00Z'));
  assert.equal(removed, 1);
  assert.deepEqual(repo.rows.map((r) => r.ip), ['10.0.0.2']);
});
