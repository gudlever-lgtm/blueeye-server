'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCorrelator } = require('../correlator');
const { Severity } = require('../constants');

// The documented example graph (cause -> downstream effects). Injected directly
// so these tests are deterministic and independent of the shipped JSON file.
const GRAPH = { disk: ['io.await'], 'io.await': ['cpu'], cpu: ['app.latency'] };
const BASE = new Date('2026-01-01T00:00:00Z').getTime();

let seq = 0;
function finding({ id, hostId = 'h1', metric = 'cpu', severity = Severity.WARN, offsetMs = 0, createdAt } = {}) {
  seq += 1;
  return {
    id: id || `f${seq}`,
    hostId,
    metric,
    severity,
    explanation: 'x',
    evidence: [{}],
    correlatedWith: [],
    createdAt: createdAt || new Date(BASE + offsetMs),
  };
}

// ---- clustering ------------------------------------------------------------
test('two findings within the window form a single group', () => {
  const c = createCorrelator({ graph: GRAPH });
  const a = finding({ metric: 'cpu', offsetMs: 0 });
  const b = finding({ metric: 'mem', offsetMs: 30000 });
  const groups = c.correlate([a, b], 60000);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].findings.length, 2);
});

test('findings more than a window apart fall into separate groups', () => {
  const c = createCorrelator({ graph: GRAPH });
  const a = finding({ metric: 'cpu', offsetMs: 0 });
  const b = finding({ metric: 'cpu', offsetMs: 120000 });
  const groups = c.correlate([a, b], 60000);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.findings.length === 1));
});

test('findings on different hosts never share a group', () => {
  const c = createCorrelator({ graph: GRAPH });
  const a = finding({ hostId: 'h1', metric: 'cpu', offsetMs: 0 });
  const b = finding({ hostId: 'h2', metric: 'cpu', offsetMs: 0 });
  const groups = c.correlate([a, b], 60000);
  assert.equal(groups.length, 2);
});

// ---- likely cause (dependency graph) --------------------------------------
test('the upstream metric in the graph is chosen as the likely cause', () => {
  const c = createCorrelator({ graph: GRAPH });
  // cpu fires first, io.await slightly later — but io.await is upstream of cpu,
  // so the graph (not the timestamp) decides the cause.
  const cpu = finding({ metric: 'cpu', offsetMs: 0 });
  const ioAwait = finding({ metric: 'io.await', offsetMs: 5000 });
  const groups = c.correlate([cpu, ioAwait], 60000);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].likelyCause.metric, 'io.await');
});

test('the most upstream metric wins across a multi-hop chain', () => {
  const c = createCorrelator({ graph: GRAPH });
  const appLatency = finding({ metric: 'app.latency', offsetMs: 0 });
  const cpu = finding({ metric: 'cpu', offsetMs: 1000 });
  const disk = finding({ metric: 'disk', offsetMs: 2000 }); // root of disk->io.await->cpu->app.latency
  const groups = c.correlate([appLatency, cpu, disk], 60000);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].likelyCause.metric, 'disk');
});

test('with no causal relationship the earliest finding is the likely cause', () => {
  const c = createCorrelator({ graph: GRAPH });
  const mem = finding({ metric: 'mem', offsetMs: 0 }); // not in GRAPH
  const uptime = finding({ metric: 'uptime', offsetMs: 1000 }); // not in GRAPH
  const groups = c.correlate([uptime, mem], 60000);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].likelyCause.metric, 'mem'); // earliest
});

// ---- hint ------------------------------------------------------------------
test('the hint is non-empty and names the real metrics involved', () => {
  const c = createCorrelator({ graph: GRAPH });
  const cpu = finding({ metric: 'cpu', offsetMs: 0 });
  const ioAwait = finding({ metric: 'io.await', offsetMs: 5000 });
  const [group] = c.correlate([cpu, ioAwait], 60000);
  assert.ok(typeof group.hint === 'string' && group.hint.trim().length > 0);
  assert.match(group.hint, /io\.await/);
  assert.match(group.hint, /cpu/);
  assert.ok(!/\$\{/.test(group.hint)); // no template placeholders left in
});

test('a lone finding gets a single-member group, no correlations, real-metric hint', () => {
  const c = createCorrelator({ graph: GRAPH });
  const a = finding({ metric: 'cpu', offsetMs: 0 });
  const groups = c.correlate([a], 60000);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].findings.length, 1);
  assert.deepEqual(a.correlatedWith, []); // left untouched
  assert.ok(groups[0].hint.trim().length > 0);
  assert.match(groups[0].hint, /cpu/);
});

// ---- marking correlatedWith ------------------------------------------------
test('correlated findings are marked with the other findings\' ids', () => {
  const c = createCorrelator({ graph: GRAPH });
  const a = finding({ id: 'A', metric: 'cpu', offsetMs: 0 });
  const b = finding({ id: 'B', metric: 'io.await', offsetMs: 1000 });
  c.correlate([a, b], 60000);
  assert.deepEqual(a.correlatedWith, ['B']);
  assert.deepEqual(b.correlatedWith, ['A']);
});

// ---- error / edge paths ----------------------------------------------------
test('empty or non-array input yields no groups', () => {
  const c = createCorrelator({ graph: GRAPH });
  assert.deepEqual(c.correlate([], 60000), []);
  assert.deepEqual(c.correlate(null, 60000), []);
  assert.deepEqual(c.correlate(undefined), []);
  assert.deepEqual(c.correlate('nope'), []);
});

test('findings without a metric are ignored', () => {
  const c = createCorrelator({ graph: GRAPH });
  const a = finding({ metric: 'cpu', offsetMs: 0 });
  const groups = c.correlate([a, { id: 'x', hostId: 'h1', createdAt: new Date(BASE) }], 60000);
  const total = groups.reduce((n, g) => n + g.findings.length, 0);
  assert.equal(total, 1); // the metric-less finding was dropped
});

test('a cyclic dependency graph does not hang and still groups', () => {
  const c = createCorrelator({ graph: { a: ['b'], b: ['a'] } });
  const fa = finding({ metric: 'a', offsetMs: 0 });
  const fb = finding({ metric: 'b', offsetMs: 1000 });
  const groups = c.correlate([fa, fb], 60000);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].findings.length, 2);
  assert.equal(groups[0].likelyCause.metric, 'a'); // mutual upstream -> earliest wins
});

// ---- shipped graph ---------------------------------------------------------
test('the shipped dependency-graph.json loads and relates real BlueEye metrics', () => {
  const c = createCorrelator(); // default graph from dependency-graph.json
  const load1 = finding({ metric: 'load1', offsetMs: 0 });
  const cpu = finding({ metric: 'cpu', offsetMs: 1000 });
  const [group] = c.correlate([load1, cpu], 60000);
  // cpu is upstream of load1 in the shipped graph -> cpu is the likely cause.
  assert.equal(group.likelyCause.metric, 'cpu');
  assert.match(group.hint, /cpu/);
  assert.match(group.hint, /load1/);
});
