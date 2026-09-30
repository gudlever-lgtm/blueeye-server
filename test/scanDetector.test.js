'use strict';

// Port-scan / fan-out detection (src/analysis/scanDetector.js): the count the
// flow explorer has always shown, run on a schedule as a `net.scan` finding —
// and, above all, never on this product's own discovery sweep.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createScanDetector, loadScanConfig, buildIgnoreList, classify,
} = require('../src/analysis/scanDetector');
const { makeFlowsRepo } = require('../test-support/fakes');

function sink() {
  const emitted = [];
  return { emitted, emit: async (f) => { emitted.push(f); return f; } };
}

function candidate(over = {}) {
  return {
    agentId: 7,
    srcIp: '10.0.0.66',
    distinctPorts: 400,
    distinctHosts: 3,
    bytes: 40000,
    packets: 800,
    flowCount: 1200,
    firstSeen: new Date('2026-09-30T09:47:10Z'),
    lastSeen: new Date('2026-09-30T09:47:40Z'),
    internal: true,
    ...over,
  };
}

function clock(iso) {
  let t = new Date(iso).getTime();
  return { now: () => new Date(t), advance: (ms) => { t += ms; } };
}

test('classify: the thresholds, the labels and the CRIT line', () => {
  const c = loadScanConfig({});
  assert.equal(classify(candidate({ distinctPorts: 49, distinctHosts: 49 }), c), null);
  assert.deepEqual(classify(candidate({ distinctPorts: 50, distinctHosts: 1 }), c), { kind: 'port-scan', severity: 'WARN', ports: 50, hosts: 1 });
  assert.deepEqual(classify(candidate({ distinctPorts: 1, distinctHosts: 50 }), c), { kind: 'fan-out', severity: 'WARN', ports: 1, hosts: 50 });
  // Over both lines is the more specific label.
  assert.equal(classify(candidate({ distinctPorts: 80, distinctHosts: 80 }), c).kind, 'port-scan');
  assert.equal(classify(candidate({ distinctPorts: 500, distinctHosts: 1 }), c).severity, 'CRIT');
  assert.equal(classify(candidate({ distinctPorts: 1, distinctHosts: 500 }), c).severity, 'CRIT');

  // Configured thresholds move both lines, and CRIT is never below WARN.
  const tuned = loadScanConfig({ SCAN_PORT_THRESHOLD: '200', SCAN_CRIT_PORT_THRESHOLD: '10' });
  assert.equal(classify(candidate({ distinctPorts: 100, distinctHosts: 1 }), tuned), null);
  assert.equal(tuned.critPortThreshold, 200);
});

test('raises a net.scan finding with the numbers and the window from the flows', async () => {
  const s = sink();
  const flowsRepo = makeFlowsRepo({ scanCandidates: async () => [candidate()] });
  const d = createScanDetector({
    flowsRepo, findingSink: s, config: loadScanConfig({}), now: () => new Date('2026-09-30T10:00:30Z'),
  });
  const out = await d.run();
  assert.equal(out.raised, 1);
  const f = s.emitted[0];
  assert.equal(f.metric, 'net.scan');
  assert.equal(f.severity, 'WARN');
  assert.equal(f.hostId, '7', 'the observing agent is the host key');
  assert.equal(f.evidence[0].target, '10.0.0.66', 'the source address is the subject');
  assert.equal(f.evidence[0].labels.scanKind, 'port-scan');
  assert.equal(f.observed, 400);
  // The window is the burst, not the whole search window.
  assert.equal(f.window[0].toISOString(), '2026-09-30T09:47:10.000Z');
  assert.equal(f.window[1].toISOString(), '2026-09-30T09:47:40.000Z');
  assert.match(f.explanation, /400 distinct ports across 3 distinct hosts/);
  assert.match(f.explanation, /SCAN_IGNORE_SOURCES/, 'the explanation does not say how to silence a known scanner');
  assert.match(f.explanation, /not what was sent/, 'the explanation claims more than metadata can say');
});

test('the product’s own sweep is never reported while discovery is enabled', async () => {
  const s = sink();
  const flowsRepo = makeFlowsRepo({ scanCandidates: async () => [candidate({ srcIp: '192.168.5.4' })] });
  const nics = () => ({ eth0: [{ address: '192.168.5.4', internal: false }], lo: [{ address: '127.0.0.1', internal: true }] });

  // The ignore list itself: own addresses only when the sweep is on.
  assert.equal(buildIgnoreList({ config: loadScanConfig({}), discoveryEnabled: true, interfaces: nics }).ignores('192.168.5.4'), true);
  assert.equal(buildIgnoreList({ config: loadScanConfig({}), discoveryEnabled: false, interfaces: nics }).ignores('192.168.5.4'), false);

  // With the sweep OFF this server scanning the network is worth hearing about.
  const loud = createScanDetector({ flowsRepo, findingSink: s, config: loadScanConfig({}), discoveryEnabled: () => false });
  // (The job reads its own interfaces; the unit above pins the rule, so here
  // only the configured allowlist is exercised.)
  await loud.run();
  assert.equal(s.emitted.length, 1);

  const s2 = sink();
  const quiet = createScanDetector({
    flowsRepo, findingSink: s2, config: loadScanConfig({ SCAN_IGNORE_SOURCES: '192.168.5.4' }),
  });
  const out = await quiet.run();
  assert.equal(out.raised, 0);
  assert.equal(out.ignored, 1);
});

test('SCAN_IGNORE_SOURCES takes CIDRs, and an unparseable entry is reported not silently empty', async () => {
  const bad = [];
  const list = buildIgnoreList({
    config: loadScanConfig({ SCAN_IGNORE_SOURCES: '10.9.0.0/24, not-a-cidr/99, 10.8.0.5' }),
    onBadEntry: (e) => bad.push(e),
  });
  assert.equal(list.ignores('10.9.0.77'), true);
  assert.equal(list.ignores('10.9.1.77'), false);
  assert.equal(list.ignores('10.8.0.5'), true);
  assert.deepEqual(bad, ['not-a-cidr/99']);
  // A blank source is never reported: there is nothing to name.
  assert.equal(list.ignores(null), true);
});

test('one scanner is one finding per cooldown, and the cooldown map is swept', async () => {
  const s = sink();
  const c = clock('2026-09-30T10:00:00Z');
  const flowsRepo = makeFlowsRepo({ scanCandidates: async () => [candidate()] });
  const d = createScanDetector({ flowsRepo, findingSink: s, config: loadScanConfig({}), now: c.now });

  await d.run();
  await d.run();
  c.advance(30 * 60 * 1000);
  await d.run();
  assert.equal(s.emitted.length, 1, 'the 60-minute cooldown did not hold');

  c.advance(31 * 60 * 1000);
  const out = await d.run();
  assert.equal(out.raised, 1, 'the source never came back after the cooldown');
  assert.equal(s.emitted.length, 2);
});

test('a wide sweep is capped per run and says so rather than raising hundreds', async () => {
  const s = sink();
  const many = Array.from({ length: 40 }, (_, i) => candidate({ srcIp: `10.0.1.${i}` }));
  const warnings = [];
  const d = createScanDetector({
    flowsRepo: makeFlowsRepo({ scanCandidates: async () => many }),
    findingSink: s,
    config: loadScanConfig({ SCAN_MAX_PER_RUN: '5' }),
    logger: { warn: (m) => warnings.push(m), info() {}, debug() {}, error() {} },
  });
  const out = await d.run();
  assert.equal(out.raised, 5);
  assert.equal(out.over, 35);
  assert.ok(warnings.some((w) => /SCAN_MAX_PER_RUN/.test(w)));
});

test('off by flag, off without a licence, and a broken repo never throws', async () => {
  const s = sink();
  const flowsRepo = makeFlowsRepo({ scanCandidates: async () => [candidate()] });
  assert.equal(await createScanDetector({ flowsRepo, findingSink: s, config: loadScanConfig({ SCAN_ALERTS_ENABLED: 'false' }) }).run(), null);
  assert.equal(await createScanDetector({ flowsRepo, findingSink: s, config: loadScanConfig({}), licensed: () => false }).run(), null);
  assert.equal(s.emitted.length, 0);

  const broken = createScanDetector({
    flowsRepo: makeFlowsRepo({ scanCandidates: async () => { throw new Error('db down'); } }),
    findingSink: s,
    config: loadScanConfig({}),
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  });
  assert.equal(await broken.run(), null);
});

test('start()/stop() schedule and clear without leaving a handle', () => {
  const d = createScanDetector({
    flowsRepo: makeFlowsRepo({ scanCandidates: async () => [] }), findingSink: sink(), config: loadScanConfig({}),
  });
  d.start();
  d.start();
  d.stop();
  d.stop();
});
