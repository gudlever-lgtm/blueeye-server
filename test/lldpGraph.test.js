'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildLldpGraph } = require('../src/topology/lldpGraph');
const { createLldpGraphService } = require('../src/topology/lldpGraphService');
const { makeLldpNeighborsRepo } = require('../test-support/fakes');

// Rows: agent 1 (chassis A) plugged into switch S1; agent 2 (chassis B) also on
// S1 (shared segment → adjacent). Agent 3 (chassis C) directly links agent 4
// (its remote chassis is D = agent 4's own chassis).
const row = (o) => ({ localAgentId: null, localChassisId: null, localPort: null, remoteChassisId: null, remotePort: null, lastSeen: new Date(), ...o });

// ---- graph queries ---------------------------------------------------------

test('shared-segment agents are adjacent (1 hop); evidence names the source', () => {
  const g = buildLldpGraph([
    row({ localAgentId: 1, localChassisId: 'A', remoteChassisId: 'S1' }),
    row({ localAgentId: 2, localChassisId: 'B', remoteChassisId: 'S1' }),
  ]);
  const r = g.relation('1', '2');
  assert.equal(r.relation, 'adjacent');
  assert.equal(r.hops, 1);
  assert.equal(r.related, true);
  assert.match(r.detail, /^LLDP:/);
});

test('direct link (remote chassis is another agent) is adjacent', () => {
  const g = buildLldpGraph([
    row({ localAgentId: 3, localChassisId: 'C', remoteChassisId: 'D' }), // 3 sees 4's chassis
    row({ localAgentId: 4, localChassisId: 'D', remoteChassisId: 'C' }), // 4 sees 3's chassis
  ]);
  assert.equal(g.relation('3', '4').relation, 'adjacent');
  assert.match(g.relation('3', '4').detail, /C adjacent to D|D adjacent to C/);
});

test('2-hop path is within-N; beyond maxHops is unknown', () => {
  // 1—2 (via S1), 2—3 (via S2): 1 and 3 are 2 hops apart.
  const g = buildLldpGraph([
    row({ localAgentId: 1, localChassisId: 'A', remoteChassisId: 'S1' }),
    row({ localAgentId: 2, localChassisId: 'B', remoteChassisId: 'S1' }),
    row({ localAgentId: 2, localChassisId: 'B', remoteChassisId: 'S2' }),
    row({ localAgentId: 3, localChassisId: 'C', remoteChassisId: 'S2' }),
  ]);
  assert.equal(g.relation('1', '3', { maxHops: 2 }).relation, 'within-N');
  assert.equal(g.relation('1', '3', { maxHops: 2 }).hops, 2);
  assert.equal(g.relation('1', '3', { maxHops: 1 }).relation, 'unknown'); // beyond 1 hop → unknown, not "unrelated"
});

test('an agent with no LLDP data is UNKNOWN, never "unrelated" (graceful degradation)', () => {
  const g = buildLldpGraph([
    row({ localAgentId: 1, localChassisId: 'A', remoteChassisId: 'S1' }),
    row({ localAgentId: 2, localChassisId: 'B', remoteChassisId: 'S1' }),
  ]);
  const r = g.relation('1', '99'); // 99 never reported
  assert.equal(r.relation, 'unknown');
  assert.equal(r.related, false);
});

test('partial coverage yields a partial graph (present pairs resolve, others unknown)', () => {
  const g = buildLldpGraph([
    row({ localAgentId: 1, localChassisId: 'A', remoteChassisId: 'S1' }),
    row({ localAgentId: 2, localChassisId: 'B', remoteChassisId: 'S1' }),
    // agent 3 reported nothing
  ]);
  assert.equal(g.relation('1', '2').related, true);
  assert.equal(g.relation('2', '3').relation, 'unknown');
});

// ---- service: cache + age-out ----------------------------------------------

test('service ages out stale rows before building the graph', async () => {
  const repo = makeLldpNeighborsRepo();
  const now = new Date('2026-07-01T12:00:00Z').getTime();
  await repo.upsert({ localAgentId: 1, localChassisId: 'A', remoteChassisId: 'S1', lastSeen: new Date(now - 60 * 1000) }); // fresh
  await repo.upsert({ localAgentId: 2, localChassisId: 'B', remoteChassisId: 'S1', lastSeen: new Date(now - 60 * 1000) });
  await repo.upsert({ localAgentId: 9, localChassisId: 'Z', remoteChassisId: 'S9', lastSeen: new Date(now - 48 * 60 * 60 * 1000) }); // 48h old → aged out

  const svc = createLldpGraphService({ lldpNeighborsRepo: repo, maxAgeMs: 24 * 60 * 60 * 1000, now: () => now });
  await svc.refresh();
  assert.equal(repo.rows.length, 2, 'stale row was aged out');
  assert.equal(svc.relation('1', '2').related, true);
  assert.equal(svc.relation('1', '9').relation, 'unknown'); // aged out → gone
});

test('ensureFresh rebuilds at most once per TTL', async () => {
  let calls = 0;
  const repo = makeLldpNeighborsRepo({ listAll: async () => { calls += 1; return []; } });
  let clock = 1000;
  const svc = createLldpGraphService({ lldpNeighborsRepo: repo, refreshMs: 60000, now: () => clock });
  await svc.ensureFresh(); // first load
  await svc.ensureFresh(); // within TTL → no reload
  assert.equal(calls, 1);
  clock += 61000;
  await svc.ensureFresh(); // TTL elapsed → reload
  assert.equal(calls, 2);
});

test('upsert bumps last_seen instead of duplicating the edge', async () => {
  const repo = makeLldpNeighborsRepo();
  await repo.upsert({ localAgentId: 1, localChassisId: 'A', localPort: 'eth0', remoteChassisId: 'S1', remotePort: 'gi1', lastSeen: new Date('2026-07-01T12:00:00Z') });
  await repo.upsert({ localAgentId: 1, localChassisId: 'A', localPort: 'eth0', remoteChassisId: 'S1', remotePort: 'gi1', lastSeen: new Date('2026-07-01T12:05:00Z') });
  assert.equal(repo.rows.length, 1);
  assert.equal(new Date(repo.rows[0].last_seen).toISOString(), '2026-07-01T12:05:00.000Z');
});

test('upsertMany persists a reported batch and skips entries without a remote chassis', async () => {
  const repo = makeLldpNeighborsRepo();
  const n = await repo.upsertMany(5, [
    { localChassisId: 'E', localPort: 'eth0', remoteChassisId: 'SW', remotePort: 'p1' },
    { localPort: 'eth1' }, // no remote chassis → skipped
  ]);
  assert.equal(n, 1);
  assert.equal(repo.rows.length, 1);
});
