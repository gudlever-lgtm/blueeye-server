'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCrossAgentCorrelator, subjectOf, confidenceBreakdown } = require('../crossAgentCorrelator');

const BASE = new Date('2026-07-01T00:00:00Z').getTime();
const WINDOW = 5 * 60 * 1000;

let seq = 0;
function finding({ id, hostId, metric = 'cpu', severity = 'WARN', offsetMs = 0, evidence = [{}], deviceId, interfaceId } = {}) {
  seq += 1;
  return {
    id: id || `f${seq}`,
    hostId,
    metric,
    severity,
    explanation: 'x',
    evidence,
    ...(deviceId != null ? { deviceId } : {}),
    ...(interfaceId != null ? { interfaceId } : {}),
    createdAt: new Date(BASE + offsetMs),
  };
}

// siteOf helper from a plain map { hostId: siteId }.
const siteMap = (m) => (hostId) => (Object.prototype.hasOwnProperty.call(m, hostId) ? m[hostId] : null);

// ---- confidence tiers ------------------------------------------------------

// DELIBERATE CHANGE (audit fejlscenarie-audit.md §8): these two used to assert
// that ANY two agents in one 5-min bucket formed a cluster (low), and that two
// agents at one site formed a medium cluster whatever they reported. That is
// the bug — two independent faults on one site became one situation. Findings
// about unrelated subjects (cpu on one agent, mem on another) now stay apart
// unless a topology relation joins them.
test('unrelated subjects at different sites (cpu vs mem) -> NO cluster', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const a = finding({ id: 'a', hostId: 'h1', metric: 'cpu', offsetMs: 0 });
  const b = finding({ id: 'b', hostId: 'h2', metric: 'mem', offsetMs: 30000 });
  assert.deepEqual(cx.detect([a, b], { siteOf: siteMap({ h1: 's1', h2: 's2' }) }), []);
});

test('unrelated subjects on the SAME site with no topology relation -> NO cluster', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const a = finding({ id: 'a', hostId: 'h1', metric: 'cpu', offsetMs: 0 });
  const b = finding({ id: 'b', hostId: 'h2', metric: 'mem', offsetMs: 60000 });
  assert.deepEqual(cx.detect([a, b], { siteOf: siteMap({ h1: 's1', h2: 's1' }) }), []);
});

test('TIME + TOPOLOGY + TYPE (same site, same metric) -> high', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const a = finding({ id: 'a', hostId: 'h1', metric: 'probe.loss', offsetMs: 0 });
  const b = finding({ id: 'b', hostId: 'h2', metric: 'probe.loss', offsetMs: 45000 });
  const clusters = cx.detect([a, b], { siteOf: siteMap({ h1: 's1', h2: 's1' }) });
  assert.equal(clusters.length, 1);
  const c = clusters[0];
  assert.equal(c.confidence, 'high');
  assert.deepEqual(c.signals, { time: true, topology: true, type: true });
  assert.equal(c.site, 's1');
  assert.equal(c.commonType, 'probe.loss');
});

test('same type across DIFFERENT sites stays low (topology required for medium/high)', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const a = finding({ id: 'a', hostId: 'h1', metric: 'flatline', offsetMs: 0 });
  const b = finding({ id: 'b', hostId: 'h2', metric: 'flatline', offsetMs: 10000 });
  const clusters = cx.detect([a, b], { siteOf: siteMap({ h1: 's1', h2: 's2' }) });
  assert.equal(clusters.length, 1);
  const c = clusters[0];
  assert.equal(c.confidence, 'low');
  assert.deepEqual(c.signals, { time: true, topology: false, type: true });
  assert.equal(c.commonType, 'flatline');
});

// ---- no false clusters -----------------------------------------------------

test('findings more than a window apart do NOT cluster (unrelated in time)', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const a = finding({ id: 'a', hostId: 'h1', metric: 'cpu', offsetMs: 0 });
  const b = finding({ id: 'b', hostId: 'h2', metric: 'cpu', offsetMs: 10 * 60 * 1000 }); // +10 min
  const clusters = cx.detect([a, b], { siteOf: siteMap({ h1: 's1', h2: 's1' }) });
  assert.deepEqual(clusters, []);
});

test('multiple findings from a SINGLE agent never form a cross-agent cluster', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const a = finding({ id: 'a', hostId: 'h1', metric: 'cpu', offsetMs: 0 });
  const b = finding({ id: 'b', hostId: 'h1', metric: 'mem', offsetMs: 5000 });
  const clusters = cx.detect([a, b], { siteOf: siteMap({ h1: 's1' }) });
  assert.deepEqual(clusters, []);
});

test('empty / non-array input yields no clusters', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  assert.deepEqual(cx.detect([], {}), []);
  assert.deepEqual(cx.detect(null, {}), []);
  assert.deepEqual(cx.detect(undefined), []);
});

test('findings missing id / hostId / metric are dropped before clustering', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const a = finding({ id: 'a', hostId: 'h1', metric: 'cpu', offsetMs: 0 });
  const bad = { hostId: 'h2', metric: 'cpu', createdAt: new Date(BASE) }; // no id
  const clusters = cx.detect([a, bad], { siteOf: siteMap({ h1: 's1', h2: 's1' }) });
  assert.deepEqual(clusters, []); // only one usable finding -> <2 distinct agents
});

// ---- multi-agent + explainability -----------------------------------------

test('three agents at one site on the same metric -> one high cluster of three', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const fs = [
    finding({ id: 'a', hostId: 'h1', metric: 'probe.loss', offsetMs: 0 }),
    finding({ id: 'b', hostId: 'h2', metric: 'probe.loss', offsetMs: 20000 }),
    finding({ id: 'c', hostId: 'h3', metric: 'probe.loss', offsetMs: 40000 }),
  ];
  const clusters = cx.detect(fs, { siteOf: siteMap({ h1: 's1', h2: 's1', h3: 's1' }) });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].confidence, 'high');
  assert.equal(clusters[0].hostIds.length, 3);
  assert.equal(clusters[0].memberFindingIds.length, 3);
});

test('suspected_common_cause is non-empty, names real details, no leftover placeholders', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const a = finding({ id: 'a', hostId: 'h1', metric: 'probe.loss', offsetMs: 0 });
  const b = finding({ id: 'b', hostId: 'h2', metric: 'probe.loss', offsetMs: 45000 });
  const [c] = cx.detect([a, b], { siteOf: siteMap({ h1: 's1', h2: 's1' }) });
  assert.ok(typeof c.suspectedCommonCause === 'string' && c.suspectedCommonCause.trim().length > 0);
  assert.match(c.suspectedCommonCause, /probe\.loss/);
  assert.match(c.suspectedCommonCause, /2 agents/);
  assert.ok(!/\$\{/.test(c.suspectedCommonCause));
});

test('severity is the max across members; detectedAt is the latest member time', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const a = finding({ id: 'a', hostId: 'h1', metric: 'cpu', severity: 'WARN', offsetMs: 0 });
  const b = finding({ id: 'b', hostId: 'h2', metric: 'cpu', severity: 'CRIT', offsetMs: 60000 });
  const [c] = cx.detect([a, b], { siteOf: siteMap({ h1: 's1', h2: 's1' }) });
  assert.equal(c.severity, 'CRIT');
  assert.equal(new Date(c.detectedAt).getTime(), BASE + 60000);
});

// ---- target-aware grouping (subjects) --------------------------------------

test('subjectOf normalises what a finding is about', () => {
  const site = siteMap({ h1: 's1', h2: 's2' });
  const probe = (target, hostId = 'h1') => subjectOf({ hostId, metric: 'probe.loss', evidence: [{ target }] }, { siteOf: site });
  // URL, host:port and bare host are the same public target.
  assert.equal(probe('https://Example.com/login').key, 'target:example.com');
  assert.equal(probe('example.com:443').key, 'target:example.com');
  assert.equal(probe('example.com.').key, 'target:example.com');
  assert.equal(probe('[2001:db8::1]:443').key, 'target:2001:db8::1');
  // A private address only means one machine within one site.
  assert.equal(probe('10.0.0.1', 'h1').key, 'target:site:s1@10.0.0.1');
  assert.equal(probe('10.0.0.1', 'h2').key, 'target:site:s2@10.0.0.1');
  assert.equal(probe('printer', 'h9').key, 'target:agent:h9@printer'); // no site: only the agent vouches
  // Switch port / switch / transaction / new device / the agent itself.
  assert.equal(subjectOf({ hostId: '1', metric: 'if.12.link.down', deviceId: 5, interfaceId: 12, evidence: [{}] }).key, 'port:5/12');
  assert.equal(subjectOf({ hostId: '1', metric: 'l2.loop', deviceId: 5, evidence: [{}] }).key, 'device:5');
  assert.equal(subjectOf({ hostId: '1', metric: 'transaction.fail', evidence: [{ testId: 7, testName: 'Login' }] }).key, 'transaction:7');
  assert.equal(subjectOf({ hostId: '1', metric: 'device.new', evidence: [{ target: '10.0.0.9', labels: { mac: 'AA:BB:CC:00:11:22' } }] }).key, 'mac:aa:bb:cc:00:11:22');
  assert.equal(subjectOf({ hostId: '3', metric: 'agent.offline', evidence: [{ target: 'agent:3' }] }).key, 'agent:3:agent.offline');
  assert.equal(subjectOf({ hostId: '3', metric: 'cpu', evidence: [{}] }).key, 'agent:3:cpu');
});

test('the SAME target seen from two sites is one cluster, not a weak low one', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const clusters = cx.detect([
    finding({ id: 'a', hostId: 'h1', metric: 'probe.reachability', offsetMs: 0, evidence: [{ target: '203.0.113.7' }] }),
    finding({ id: 'b', hostId: 'h2', metric: 'probe.reachability', offsetMs: 90000, evidence: [{ target: 'https://203.0.113.7/' }] }),
  ], { siteOf: siteMap({ h1: 's1', h2: 's2' }) });
  assert.equal(clusters.length, 1);
  const [c] = clusters;
  assert.equal(c.confidence, 'high');
  assert.equal(c.topologySource, 'target');
  assert.equal(c.site, null); // two sites
  assert.deepEqual(c.grouping.subjects, ['target:203.0.113.7']);
  assert.equal(c.grouping.reasons[0].kind, 'target');
  assert.match(c.suspectedCommonCause, /203\.0\.113\.7/);
  assert.match(c.suspectedCommonCause, /from 2 sites/);
  assert.match(c.suspectedCommonCause, /Grouped because: shared target/);
});

test('the same PRIVATE address at two sites is two machines -> no cluster', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const clusters = cx.detect([
    finding({ id: 'a', hostId: 'h1', metric: 'probe.reachability', offsetMs: 0, evidence: [{ target: '10.0.0.1' }] }),
    finding({ id: 'b', hostId: 'h2', metric: 'probe.reachability', offsetMs: 1000, evidence: [{ target: '10.0.0.1' }] }),
  ], { siteOf: siteMap({ h1: 's1', h2: 's2' }) });
  assert.deepEqual(clusters, []);
});

test('two independent faults on ONE site in one window are TWO clusters', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const site = siteMap({ h1: 's1', h2: 's1', h3: 's1', h4: 's1' });
  const clusters = cx.detect([
    // Fault 1: a public service down, seen by h1 + h2.
    finding({ id: 'a', hostId: 'h1', metric: 'probe.reachability', offsetMs: 0, evidence: [{ target: 'erp.example.com' }] }),
    finding({ id: 'b', hostId: 'h2', metric: 'probe.reachability', offsetMs: 20000, evidence: [{ target: 'erp.example.com:443' }] }),
    // Fault 2: a duplex mismatch + link flap on switch 9, seen by h3 + h4.
    finding({ id: 'c', hostId: 'h3', metric: 'if.4.duplex.mismatch', offsetMs: 30000, deviceId: 9, interfaceId: 4 }),
    finding({ id: 'd', hostId: 'h4', metric: 'if.7.link.flapping', offsetMs: 60000, deviceId: 9, interfaceId: 7 }),
  ], { siteOf: site });
  assert.equal(clusters.length, 2);
  const byMembers = clusters.map((c) => c.memberFindingIds.slice().sort().join(','));
  assert.deepEqual(byMembers.sort(), ['a,b', 'c,d']);
  const sw = clusters.find((c) => c.memberFindingIds.includes('c'));
  assert.equal(sw.topologySource, 'switch');
  assert.equal(sw.confidence, 'medium'); // same switch, different conditions
});

test('a switch finding and a finding from an agent DOWNSTREAM of it group as "upstream"', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const topology = { downstreamOf: (id) => (id === 9 ? new Set(['h2']) : null), deviceLabel: () => 'core-sw' };
  const findings = [
    finding({ id: 'a', hostId: 'h1', metric: 'if.4.link.down', offsetMs: 0, deviceId: 9, interfaceId: 4 }),
    finding({ id: 'b', hostId: 'h2', metric: 'probe.loss', offsetMs: 60000, evidence: [{ target: 'erp.example.com' }] }),
  ];
  const clusters = cx.detect(findings, { siteOf: siteMap({ h1: 's1', h2: 's2' }), topology });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].memberFindingIds.slice().sort(), ['a', 'b']);
  assert.equal(clusters[0].topologySource, 'upstream');
  assert.match(clusters[0].topologyDetail, /core-sw is upstream of agent h2/);
  // Without the topology the same two findings are unrelated.
  assert.deepEqual(cx.detect(findings, { siteOf: siteMap({ h1: 's1', h2: 's2' }) }), []);
});

test('sliding window: a chain that straddles a fixed 5-min boundary is ONE cluster', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const ev = [{ target: 'vpn.example.com' }];
  const clusters = cx.detect([
    finding({ id: 'a', hostId: 'h1', metric: 'probe.loss', offsetMs: 0, evidence: ev }),
    // 4:50 after a, 5:10 after the anchor of a fixed bucket starting at a.
    finding({ id: 'b', hostId: 'h2', metric: 'probe.loss', offsetMs: 290000, evidence: ev }),
    finding({ id: 'c', hostId: 'h3', metric: 'probe.loss', offsetMs: 310000, evidence: ev }),
  ], { siteOf: siteMap({ h1: 's1', h2: 's2', h3: 's3' }) });
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].memberFindingIds.slice().sort(), ['a', 'b', 'c']);
  assert.equal(new Date(clusters[0].firstSeenAt).getTime(), BASE);          // anchored on the earliest
  assert.equal(new Date(clusters[0].detectedAt).getTime(), BASE + 310000);  // slides to the latest
});

test('confidenceBreakdown names the stored grouping reasons', () => {
  const bd = confidenceBreakdown('high', [
    { hostId: '1', metric: 'probe.loss' }, { hostId: '2', metric: 'probe.loss' },
  ], { subjects: ['target:x'], reasons: [{ kind: 'target', detail: 'x' }], why: ['shared target: x (seen by 2 agents)'] });
  assert.equal(bd.tier, 'high');
  assert.deepEqual(bd.reasons, [{ kind: 'target', detail: 'x' }]);
  assert.match(bd.explanation, /Grouped because: shared target: x/);
});
