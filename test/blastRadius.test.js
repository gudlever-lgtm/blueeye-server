'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeBlastRadius, DEFAULT_MAX_DEPTH } = require('../src/topology/blastRadius');

const l2 = (a, b) => ({ type: 'l2_link', directed: false, source: a, target: b });
const dep = (src, tgt, dstPort) => ({ type: 'service_dep', directed: true, source: src, target: tgt, dstPort });
const ids = (list) => list.map((e) => e.hostId).sort((a, b) => a - b);

test('default depth cap is 4', () => {
  assert.equal(DEFAULT_MAX_DEPTH, 4);
});

test('linear chain: L2 isolates everything downstream within the cap', () => {
  // 1 - 2 - 3 - 4 - 5
  const edges = [l2(1, 2), l2(2, 3), l2(3, 4), l2(4, 5)];
  const r = computeBlastRadius({ edges }, 1, { maxDepth: 4 });
  assert.deepEqual(ids(r.directly_isolated), [2, 3, 4, 5]);
  assert.deepEqual(r.dependency_affected, []);
  // Path justification: 3 is reached via 1 -> 2 -> 3.
  const three = r.directly_isolated.find((e) => e.hostId === 3);
  assert.deepEqual(three.path, [1, 2, 3]);
});

test('depth cap is respected (linear chain)', () => {
  const edges = [l2(1, 2), l2(2, 3), l2(3, 4), l2(4, 5)];
  const r = computeBlastRadius({ edges }, 1, { maxDepth: 2 });
  assert.deepEqual(ids(r.directly_isolated), [2, 3]); // 4,5 are beyond 2 hops
  assert.equal(r.depthCap, 2);
});

test('star topology: failing hub isolates all leaves', () => {
  // hub 1 connected to 2,3,4
  const edges = [l2(1, 2), l2(1, 3), l2(1, 4)];
  const r = computeBlastRadius({ edges }, 1, { maxDepth: 4 });
  assert.deepEqual(ids(r.directly_isolated), [2, 3, 4]);
  // each leaf is one hop from the hub
  for (const e of r.directly_isolated) assert.deepEqual(e.path, [1, e.hostId]);
});

test('star topology: failing a leaf reaches the hub then the far leaves by depth', () => {
  const edges = [l2(1, 2), l2(1, 3), l2(1, 4)];
  const r = computeBlastRadius({ edges }, 2, { maxDepth: 1 });
  assert.deepEqual(ids(r.directly_isolated), [1]); // only the hub within 1 hop
  const r2 = computeBlastRadius({ edges }, 2, { maxDepth: 2 });
  assert.deepEqual(ids(r2.directly_isolated), [1, 3, 4]); // hub + sibling leaves at depth 2
});

test('cyclic topology is cycle-safe (no infinite loop, each node once)', () => {
  // triangle 1-2-3-1 plus a tail 3-4
  const edges = [l2(1, 2), l2(2, 3), l2(3, 1), l2(3, 4)];
  const r = computeBlastRadius({ edges }, 1, { maxDepth: 4 });
  assert.deepEqual(ids(r.directly_isolated), [2, 3, 4]);
  // failing node never appears in its own isolated set
  assert.ok(!r.directly_isolated.some((e) => e.hostId === 1));
});

test('dependency tier: service_dep dependents of the isolated set, transitively', () => {
  // L2: 1-2 (failing 1 isolates 2). Deps: 5->2:443, 6->5:8080.
  const edges = [l2(1, 2), dep(5, 2, 443), dep(6, 5, 8080)];
  const r = computeBlastRadius({ edges }, 1, { maxDepth: 4 });
  assert.deepEqual(ids(r.directly_isolated), [2]);
  assert.deepEqual(ids(r.dependency_affected), [5, 6]);

  const five = r.dependency_affected.find((e) => e.hostId === 5);
  // path: anchor (isolated host 2) -> 5, via the port 5 uses to reach 2.
  assert.deepEqual(five.path, [{ hostId: 2, viaPort: null }, { hostId: 5, viaPort: 443 }]);
  const six = r.dependency_affected.find((e) => e.hostId === 6);
  assert.deepEqual(six.path, [{ hostId: 2, viaPort: null }, { hostId: 5, viaPort: 443 }, { hostId: 6, viaPort: 8080 }]);
});

test('dependents of the FAILING node itself are affected (even with no L2 neighbours)', () => {
  const edges = [dep(9, 1, 22)]; // 9 depends on the failing node 1 on :22
  const r = computeBlastRadius({ edges }, 1, { maxDepth: 4 });
  assert.deepEqual(r.directly_isolated, []);
  assert.deepEqual(ids(r.dependency_affected), [9]);
  assert.deepEqual(r.dependency_affected[0].path, [{ hostId: 1, viaPort: null }, { hostId: 9, viaPort: 22 }]);
});

test('dependency tier respects the depth cap', () => {
  const edges = [dep(2, 1, 443), dep(3, 2, 443), dep(4, 3, 443)]; // 2->1, 3->2, 4->3
  const r = computeBlastRadius({ edges }, 1, { maxDepth: 2 });
  assert.deepEqual(ids(r.dependency_affected), [2, 3]); // 4 is 3 hops from node 1
});

test('empty result when the failing node has no downstream', () => {
  const edges = [l2(10, 11), dep(12, 11, 443)]; // unrelated component
  const r = computeBlastRadius({ edges }, 1, { maxDepth: 4 });
  assert.deepEqual(r.directly_isolated, []);
  assert.deepEqual(r.dependency_affected, []);
  assert.equal(r.totals.directly_isolated, 0);
  assert.equal(r.totals.dependency_affected, 0);
});

test('a host that is L2-isolated is not also double-counted as dependency_affected', () => {
  // 1-2 L2, and 2 also depends on 1 via service_dep -> 2 stays in tier 1 only.
  const edges = [l2(1, 2), dep(2, 1, 443)];
  const r = computeBlastRadius({ edges }, 1, { maxDepth: 4 });
  assert.deepEqual(ids(r.directly_isolated), [2]);
  assert.deepEqual(r.dependency_affected, []);
});

test('performance: 5,000-node graph completes well under 2s', () => {
  // A 5,000-node L2 chain + a parallel service_dep chain — the worst-case fan.
  const edges = [];
  for (let i = 1; i < 5000; i += 1) edges.push(l2(i, i + 1));
  for (let i = 1; i < 5000; i += 1) edges.push(dep(i + 1, i, 443));
  const start = process.hrtime.bigint();
  const r = computeBlastRadius({ edges }, 1, { maxDepth: 4 });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  // depth 4 from node 1 reaches nodes 2..5 over L2.
  assert.deepEqual(ids(r.directly_isolated), [2, 3, 4, 5]);
  assert.ok(ms < 2000, `blast radius took ${ms.toFixed(1)}ms (budget 2000ms)`);
});
