'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeTopologyChangesRepo, makeLldpNeighborsRepo, makeAuditLogRepo } = require('../test-support/fakes');
const { createAuditLogger } = require('../src/services/complianceLogger');
const { createTopologyChangeService } = require('../src/topology/topologyChangeService');

const AGENT = 7;
const nb = (localPort, remoteChassisId, remotePort = 'gi1', linkState = null) => ({ localPort, remoteChassisId, remotePort, linkState });

function harness({ flapWindowSec = 300 } = {}) {
  const topologyChangesRepo = makeTopologyChangesRepo();
  const lldpNeighborsRepo = makeLldpNeighborsRepo();
  const auditLogRepo = makeAuditLogRepo();
  const auditLogger = createAuditLogger({ auditLogRepo });
  let clockMs = Date.parse('2026-07-24T10:00:00.000Z');
  const svc = createTopologyChangeService({ topologyChangesRepo, lldpNeighborsRepo, auditLogger, flapWindowSec, now: () => new Date(clockMs) });
  return {
    svc, topologyChangesRepo, lldpNeighborsRepo, auditLogRepo,
    advance: (sec) => { clockMs += sec * 1000; },
    // simulate the caller persisting the reported set after change detection
    persist: (set) => lldpNeighborsRepo.upsertMany(AGENT, set),
  };
}

test('no changes emitted on identical snapshots', async () => {
  const h = harness();
  await h.persist([nb('eth0', 'sw-a')]); // seed prev
  const r = await h.svc.processReport(AGENT, [nb('eth0', 'sw-a')]);
  assert.deepEqual(r.changes, []);
  assert.equal(h.topologyChangesRepo.rows.length, 0);
  assert.equal(h.auditLogRepo.rows.length, 0);
});

test('records each change type and writes each to the hash-chained audit log', async () => {
  const h = harness();
  await h.persist([nb('eth0', 'sw-a', 'gi1', 'up'), nb('eth1', 'sw-b'), nb('eth3', 'sw-c')]);
  const r = await h.svc.processReport(AGENT, [
    nb('eth0', 'sw-a', 'gi1', 'down'), // link_state_changed
    nb('eth1', 'sw-b'),                // unchanged
    nb('eth4', 'sw-c'),                // port_moved eth3->eth4
    nb('eth9', 'sw-d'),                // neighbour_added
    // sw-? none removed outright (sw-c move consumes its removal)
  ]);
  const types = r.changes.map((c) => c.changeType).sort();
  assert.deepEqual(types, ['link_state_changed', 'neighbour_added', 'port_moved']);
  assert.equal(h.topologyChangesRepo.rows.length, 3);
  // Every change is mirrored to the audit log under category 'topology', actor system.
  assert.equal(h.auditLogRepo.rows.length, 3);
  for (const row of h.auditLogRepo.rows) {
    assert.equal(row.category, 'topology');
    assert.equal(row.actorRole, 'system');
    assert.equal(row.actorUserId ?? null, null); // system-originated, no user
    assert.ok(String(row.action).startsWith('topology_'));
  }
  // Each stored change references its audit row.
  for (const c of h.topologyChangesRepo.rows) assert.ok(c.audit_log_id != null);
});

test('neighbour_removed is recorded and the edge is reconciled away', async () => {
  const h = harness();
  await h.persist([nb('eth0', 'sw-a'), nb('eth1', 'sw-b')]);
  const r = await h.svc.processReport(AGENT, [nb('eth0', 'sw-a')]); // sw-b gone
  assert.deepEqual(r.changes.map((c) => c.changeType), ['neighbour_removed']);
  // reconciled: sw-b row deleted so it won't re-emit next poll
  const remaining = await h.lldpNeighborsRepo.listByAgent(AGENT);
  assert.deepEqual(remaining.map((x) => x.remoteChassisId).sort(), ['sw-a']);
});

test('flap suppression: a revert WITHIN the window collapses to one flapping record', async () => {
  const h = harness({ flapWindowSec: 300 });
  // poll 1: neighbour added
  await h.svc.processReport(AGENT, [nb('eth0', 'sw-a')]);
  await h.persist([nb('eth0', 'sw-a')]);
  assert.equal(h.topologyChangesRepo.rows.length, 1);
  assert.equal(h.topologyChangesRepo.rows[0].change_type, 'neighbour_added');

  // poll 2 at +299s: neighbour removed -> reverts the add within 300s -> flapping
  h.advance(299);
  const r = await h.svc.processReport(AGENT, []);
  assert.equal(r.collapsed, 1);
  assert.equal(h.topologyChangesRepo.rows.length, 1);          // still ONE record
  assert.equal(h.topologyChangesRepo.rows[0].change_type, 'flapping');
});

test('flap suppression: a revert OUTSIDE the window stays two discrete records', async () => {
  const h = harness({ flapWindowSec: 300 });
  await h.svc.processReport(AGENT, [nb('eth0', 'sw-a')]);
  await h.persist([nb('eth0', 'sw-a')]);

  h.advance(301); // just past the window
  const r = await h.svc.processReport(AGENT, []);
  assert.equal(r.collapsed, 0);
  const types = h.topologyChangesRepo.rows.map((x) => x.change_type).sort();
  assert.deepEqual(types, ['neighbour_added', 'neighbour_removed']); // two records, no collapse
});

test('flap suppression: exact window boundary (300s) collapses', async () => {
  const h = harness({ flapWindowSec: 300 });
  await h.svc.processReport(AGENT, [nb('eth0', 'sw-a')]);
  await h.persist([nb('eth0', 'sw-a')]);
  h.advance(300);
  const r = await h.svc.processReport(AGENT, []);
  assert.equal(r.collapsed, 1);
  assert.equal(h.topologyChangesRepo.rows[0].change_type, 'flapping');
});

test('sustained flapping stays a single record', async () => {
  const h = harness({ flapWindowSec: 300 });
  await h.svc.processReport(AGENT, [nb('eth0', 'sw-a')]);        // added
  await h.persist([nb('eth0', 'sw-a')]);
  h.advance(10);
  await h.svc.processReport(AGENT, []);                           // removed -> flapping
  h.advance(10);
  await h.svc.processReport(AGENT, [nb('eth0', 'sw-a')]);         // added again (within window of flap)
  await h.persist([nb('eth0', 'sw-a')]);
  assert.equal(h.topologyChangesRepo.rows.length, 1);
  assert.equal(h.topologyChangesRepo.rows[0].change_type, 'flapping');
});
