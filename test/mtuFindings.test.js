'use strict';

// Root-cause rules for the path_mtu probe. Three fixtures — blackhole, reduced,
// ok — plus the corroboration and MSS-clamp cases, because the whole value of
// this module is that it tells those apart instead of reporting "MTU problem".

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateMtuFindings } = require('../src/analysis/mtuFindings');
const { evaluateProbeFindings } = require('../src/analysis/probeFindings');
const { Severity } = require('../src/analysis/constants');

const AT = new Date('2026-09-16T10:00:00.000Z');

const HOPS = (dropAt, mtu, status) => [
  { hop: 1, ip: '192.0.2.1', maxMtu: 1500, status: 'ok' },
  { hop: 2, ip: '192.0.2.2', maxMtu: 1500, status: 'ok' },
  { hop: dropAt, ip: '198.51.100.7', maxMtu: mtu, status },
  { hop: dropAt + 1, ip: '203.0.113.5', maxMtu: mtu, status },
];

// A blackhole: the path narrows and nothing says so.
const BLACKHOLE = {
  ts: AT.toISOString(),
  type: 'path_mtu',
  target: '10.20.30.40',
  ok: true,
  hops: HOPS(3, 1420, 'blackhole'),
  mtu: {
    ipVersion: 4,
    pathMtu: 1420,
    blackholeDetected: true,
    icmpFragNeededSeen: false,
    mtuDropAtHop: 3,
    mssSupported: true,
    mssObserved: 1380,
    recommendedMss: 1380,
  },
};

// The same path with the ICMP allowed through.
const REDUCED = {
  ...BLACKHOLE,
  hops: HOPS(3, 1420, 'reduced'),
  mtu: { ...BLACKHOLE.mtu, blackholeDetected: false, icmpFragNeededSeen: true },
};

// Nothing narrows the path at all.
const OK = {
  ts: AT.toISOString(),
  type: 'path_mtu',
  target: '10.20.30.40',
  ok: true,
  hops: [
    { hop: 1, ip: '192.0.2.1', maxMtu: 1500, status: 'ok' },
    { hop: 2, ip: '203.0.113.5', maxMtu: 1500, status: 'ok' },
  ],
  mtu: {
    ipVersion: 4,
    pathMtu: 1500,
    blackholeDetected: false,
    icmpFragNeededSeen: false,
    mtuDropAtHop: null,
    mssSupported: true,
    mssObserved: 1460,
    recommendedMss: 1460,
  },
};

const byMetric = (fs, m) => fs.find((f) => f.metric === m) || null;

// ---------------------------------------------------------------- blackhole
test('a blackhole is CRIT and names the firewall rule, the hop and the MSS to clamp to', () => {
  const fs = evaluateMtuFindings('7', [BLACKHOLE], AT);
  const f = byMetric(fs, 'probe.mtu.blackhole');
  assert.ok(f, 'no blackhole finding');
  assert.equal(f.severity, Severity.CRIT);
  assert.equal(f.hostId, '7');
  assert.equal(f.observed, 1420);
  // The exact ICMP type/code, because "allow ICMP" is neither acceptable to a
  // firewall team nor specific enough to act on.
  assert.match(f.explanation, /type 3 code 4/);
  assert.match(f.explanation, /hop 3 \(198\.51\.100\.7\)/);
  assert.match(f.explanation, /clamp TCP MSS to 1380/);
  assert.match(f.explanation, /stall/i, 'says what the operator is actually seeing');
  assert.equal(f.evidence[0].dropAtHop, 3);
  assert.equal(f.evidence[0].hopIp, '198.51.100.7');
  assert.equal(f.evidence[0].recommendedMss, 1380);
});

// ------------------------------------------------------------------ reduced
test('a reduced path with ICMP working is INFO, says it is expected, and is not a blackhole', () => {
  const fs = evaluateMtuFindings('7', [REDUCED], AT);
  assert.equal(byMetric(fs, 'probe.mtu.blackhole'), null, 'must not raise a blackhole');
  const f = byMetric(fs, 'probe.mtu.reduced');
  assert.ok(f);
  assert.equal(f.severity, Severity.INFO);
  assert.match(f.explanation, /expected on a tunnelled path/i);
  assert.match(f.explanation, /IPsec, GRE, PPPoE/);
  assert.match(f.explanation, /only becomes a fault if an application/i);
  assert.equal(f.observed, 1420);
});

// ----------------------------------------------------------------------- ok
test('a clean path produces no findings at all', () => {
  assert.deepEqual(evaluateMtuFindings('7', [OK], AT), []);
});

test('a hop that answers no ICMP does not produce a finding on its own', () => {
  const silent = {
    ...OK,
    hops: [
      { hop: 1, ip: '192.0.2.1', maxMtu: 1500, status: 'ok' },
      { hop: 2, ip: null, maxMtu: null, status: 'no_response' },
      { hop: 3, ip: '203.0.113.5', maxMtu: 1500, status: 'ok' },
    ],
  };
  assert.deepEqual(evaluateMtuFindings('7', [silent], AT), []);
});

// -------------------------------------------------------------- MSS clamping
test('an MSS above the measured path is a WARN naming the value to clamp to', () => {
  const row = { ...REDUCED, mtu: { ...REDUCED.mtu, mssObserved: 1460, recommendedMss: 1380 } };
  const f = byMetric(evaluateMtuFindings('7', [row], AT), 'probe.mtu.clamp');
  assert.ok(f);
  assert.equal(f.severity, Severity.WARN);
  assert.equal(f.observed, 1460);
  assert.equal(f.baseline, 1380);
  assert.equal(f.evidence[0].gapBytes, 80);
  assert.match(f.explanation, /cannot arrive whole/);
  assert.match(f.explanation, /set it to 1380/);
});

test('an MSS at or just above the recommendation is not a clamping failure', () => {
  for (const mss of [1380, 1384, 1388]) {
    const row = { ...REDUCED, mtu: { ...REDUCED.mtu, mssObserved: mss, recommendedMss: 1380 } };
    assert.equal(byMetric(evaluateMtuFindings('7', [row], AT), 'probe.mtu.clamp'), null, `fired at ${mss}`);
  }
});

test('no MSS reading (non-Linux agent) never produces a clamping finding', () => {
  const row = { ...REDUCED, mtu: { ...REDUCED.mtu, mssSupported: false, mssObserved: null } };
  assert.equal(byMetric(evaluateMtuFindings('7', [row], AT), 'probe.mtu.clamp'), null);
});

// ------------------------------------------------------------ corroboration
test('clean small-packet loss on the same target is quoted as corroboration', () => {
  const ping = { ts: AT.toISOString(), type: 'ping', target: '10.20.30.40', ok: true, lossPct: 0 };
  const f = byMetric(evaluateMtuFindings('7', [BLACKHOLE, ping], AT), 'probe.mtu.blackhole');
  assert.match(f.explanation, /Small packets .* are getting through \(0% loss\)/);
  assert.match(f.explanation, /size limit, not general packet loss/);
  assert.ok(f.evidence.some((e) => e.metric === 'corroboration' && e.lossPct === 0));
});

test('small packets ALSO being lost is stated, not spun into corroboration', () => {
  const ping = { ts: AT.toISOString(), type: 'ping', target: '10.20.30.40', ok: true, lossPct: 40 };
  const f = byMetric(evaluateMtuFindings('7', [BLACKHOLE, ping], AT), 'probe.mtu.blackhole');
  assert.match(f.explanation, /also losing small packets \(40% loss\)/);
  assert.match(f.explanation, /reachability problem on top of/);
});

test('with no ping row the corroboration is simply absent, never implied', () => {
  const f = byMetric(evaluateMtuFindings('7', [BLACKHOLE], AT), 'probe.mtu.blackhole');
  assert.doesNotMatch(f.explanation, /Small packets/);
  assert.ok(!f.evidence.some((e) => e.metric === 'corroboration'));
  // A ping to a DIFFERENT target says nothing about this path.
  const other = { ts: AT.toISOString(), type: 'ping', target: '8.8.8.8', ok: true, lossPct: 0 };
  const g = byMetric(evaluateMtuFindings('7', [BLACKHOLE, other], AT), 'probe.mtu.blackhole');
  assert.doesNotMatch(g.explanation, /Small packets/);
});

// -------------------------------------------------------------------- shape
test('only the newest row per target is judged', () => {
  const older = { ...BLACKHOLE, ts: '2026-09-16T09:00:00.000Z' };
  const fs = evaluateMtuFindings('7', [REDUCED, older], AT);
  assert.equal(byMetric(fs, 'probe.mtu.blackhole'), null, 'a stale blackhole must not outvote the current row');
  assert.ok(byMetric(fs, 'probe.mtu.reduced'));
});

test('every finding carries the shape the finding store expects', () => {
  const fs = evaluateMtuFindings('7', [BLACKHOLE], AT);
  assert.ok(fs.length);
  for (const f of fs) {
    for (const k of ['id', 'hostId', 'metric', 'severity', 'kind', 'observed', 'baseline',
      'deviation', 'window', 'explanation', 'evidence', 'correlatedWith', 'createdAt', 'acked']) {
      assert.ok(k in f, `${f.metric} missing ${k}`);
    }
    assert.equal(f.window.length, 2);
    assert.ok(f.evidence.length > 0, 'a finding with no evidence must not be listed');
    assert.ok(f.explanation.length > 40);
    assert.equal(f.createdAt, AT);
  }
});

test('garbage and partial rows never throw and never invent a finding', () => {
  for (const rows of [undefined, null, 'str', 42, {}, [], [null], [{}], [{ type: 'path_mtu' }],
    [{ type: 'path_mtu', target: 'x', mtu: null }], [{ type: 'path_mtu', target: 'x', mtu: 'nope' }],
    [{ type: 'path_mtu', target: 'x', mtu: {}, hops: 'nope' }]]) {
    assert.deepEqual(evaluateMtuFindings('7', rows, AT), []);
  }
});

test('a blackhole with no hop attribution still reports, without inventing a hop', () => {
  const row = { ...BLACKHOLE, hops: [], mtu: { ...BLACKHOLE.mtu, mtuDropAtHop: null } };
  const f = byMetric(evaluateMtuFindings('7', [row], AT), 'probe.mtu.blackhole');
  assert.ok(f);
  assert.match(f.explanation, /somewhere on the path/);
  assert.equal(f.evidence[0].dropAtHop, null);
  assert.equal(f.evidence[0].hopIp, null);
});

// ------------------------------------------------------- wired into the pipe
test('the probe evaluator emits MTU findings alongside its own', () => {
  const rows = [BLACKHOLE, { ts: AT.toISOString(), type: 'ping', target: '10.20.30.40', ok: true, lossPct: 0, rttMs: 12 }];
  const fs = evaluateProbeFindings(7, rows, { now: () => AT });
  assert.ok(fs.some((f) => f.metric === 'probe.mtu.blackhole'), 'MTU findings are not reaching the pipeline');
  assert.ok(fs.every((f) => f.hostId === '7'));
});

test('a path_mtu row does not itself make the agent look unreachable', () => {
  // The probe reports ok:true by design; this pins that the health verdict the
  // other findings are built on does not see a blackhole as a dead target.
  const fs = evaluateProbeFindings(7, [BLACKHOLE], { now: () => AT });
  assert.equal(fs.filter((f) => f.metric === 'probe.reachability').length, 0);
});
