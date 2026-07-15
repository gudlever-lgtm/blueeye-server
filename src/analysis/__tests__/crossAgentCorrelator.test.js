'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCrossAgentCorrelator } = require('../crossAgentCorrelator');

const BASE = new Date('2026-07-01T00:00:00Z').getTime();
const WINDOW = 5 * 60 * 1000;

let seq = 0;
function finding({ id, hostId, metric = 'cpu', severity = 'WARN', offsetMs = 0 } = {}) {
  seq += 1;
  return {
    id: id || `f${seq}`,
    hostId,
    metric,
    severity,
    explanation: 'x',
    evidence: [{}],
    createdAt: new Date(BASE + offsetMs),
  };
}

// siteOf helper from a plain map { hostId: siteId }.
const siteMap = (m) => (hostId) => (Object.prototype.hasOwnProperty.call(m, hostId) ? m[hostId] : null);

// ---- confidence tiers ------------------------------------------------------

test('TIME ONLY (>=2 agents in window, no shared site, no shared type) -> low', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const a = finding({ id: 'a', hostId: 'h1', metric: 'cpu', offsetMs: 0 });
  const b = finding({ id: 'b', hostId: 'h2', metric: 'mem', offsetMs: 30000 });
  const clusters = cx.detect([a, b], { siteOf: siteMap({ h1: 's1', h2: 's2' }) });
  assert.equal(clusters.length, 1);
  const c = clusters[0];
  assert.equal(c.confidence, 'low');
  assert.deepEqual(c.signals, { time: true, topology: false, type: false });
  assert.equal(c.site, null);
  assert.equal(c.commonType, null);
  assert.equal(c.hostIds.length, 2);
  assert.equal(c.memberFindingIds.length, 2);
});

test('TIME + TOPOLOGY (same site, different metric) -> medium', () => {
  const cx = createCrossAgentCorrelator({ windowMs: WINDOW });
  const a = finding({ id: 'a', hostId: 'h1', metric: 'cpu', offsetMs: 0 });
  const b = finding({ id: 'b', hostId: 'h2', metric: 'mem', offsetMs: 60000 });
  const clusters = cx.detect([a, b], { siteOf: siteMap({ h1: 's1', h2: 's1' }) });
  assert.equal(clusters.length, 1);
  const c = clusters[0];
  assert.equal(c.confidence, 'medium');
  assert.deepEqual(c.signals, { time: true, topology: true, type: false });
  assert.equal(c.site, 's1');
  assert.equal(c.commonType, null);
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
