'use strict';

// Beaconing detection (src/analysis/beaconDetector.js): an internal host
// contacting the same external address on a machine's schedule. The one
// detector here that measures RHYTHM rather than volume — and the one whose
// worst failure mode is calling a long-lived session a beacon.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createBeaconDetector, loadBeaconConfig, scoreRegularity, intervalsOf,
  buildIgnoreList, describeInterval, describeSpan, DEFAULT_IGNORE_PORTS,
} = require('../src/analysis/beaconDetector');
const { makeFlowsRepo } = require('../test-support/fakes');

const C = loadBeaconConfig({});

function sink() {
  const emitted = [];
  return { emitted, emit: async (f) => { emitted.push(f); return f; } };
}

// `n` timestamps `stepSec` apart from `startIso`, each offset by a
// deterministic wobble of up to `jitterSec` (no RNG: a flaky detector test is
// worse than no test).
function series(startIso, n, stepSec, jitterSec = 0) {
  const t0 = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => new Date(
    t0 + (i * stepSec + Math.round(Math.sin(i * 7.3) * jitterSec)) * 1000,
  ));
}

function candidate(over = {}) {
  return {
    agentId: 7,
    srcIp: '10.0.0.40',
    extIp: '203.0.113.7',
    dstPort: 443,
    proto: 'tcp',
    observations: 144,
    firstSeen: new Date('2026-09-29T12:00:00Z'),
    lastSeen: new Date('2026-09-30T11:00:00Z'),
    bytes: 144 * 820,
    packets: 1440,
    flowCount: 144,
    asn: 64500,
    asnName: 'Example Hosting',
    country: 'NL',
    ...over,
  };
}

test('intervalsOf sorts, drops duplicates and never divides by a zero gap', () => {
  const { times, gaps } = intervalsOf([
    new Date('2026-09-30T00:02:00Z'), new Date('2026-09-30T00:00:00Z'),
    new Date('2026-09-30T00:02:00Z'), '2026-09-30T00:05:00Z', 'not a date', null,
  ]);
  assert.equal(times.length, 4, 'an unparseable entry or a null reached the timings');
  assert.deepEqual(gaps, [120, 180], 'a repeated timestamp produced a zero gap');
  assert.deepEqual(intervalsOf(null).gaps, []);
});

test('a regular beacon is found, and its period and jitter are what was measured', () => {
  const s = scoreRegularity(series('2026-09-30T00:00:00Z', 40, 600), { cadenceSec: 60, config: C });
  assert.equal(s.severity, 'CRIT', 'gaps that never vary are the strongest beacon there is');
  assert.equal(s.medianIntervalSec, 600);
  assert.equal(s.jitter, 0);
  assert.equal(s.observations, 40);
  assert.equal(s.spanSec, 39 * 600);

  // Thirty seconds of drift on a ten-minute beacon is still a beacon — a
  // scheduler that wakes on a busy host does not hit the second every time.
  const wobbly = scoreRegularity(series('2026-09-30T00:00:00Z', 40, 600, 30), { cadenceSec: 60, config: C });
  assert.ok(wobbly.severity, 'half a minute of drift stopped it being a beacon');
  assert.ok(wobbly.jitter > 0 && wobbly.jitter <= C.maxJitter);
});

test('A PERSON IS NOT A BEACON — irregular gaps are rejected', () => {
  const s = scoreRegularity(series('2026-09-30T00:00:00Z', 40, 600, 300), { cadenceSec: 60, config: C });
  assert.equal(s.severity, null);
  assert.equal(s.rejected, 'irregular');
  assert.ok(s.jitter > C.maxJitter);
});

test('A SESSION LEFT OPEN IS NOT A BEACON — the agent’s own cadence is the test', () => {
  // Present in every interval of a 60-second agent: perfectly regular, and a
  // stream. This is the false positive that would get the detector turned off.
  const stream = scoreRegularity(series('2026-09-30T00:00:00Z', 200, 60), { cadenceSec: 60, config: C });
  assert.equal(stream.rejected, 'continuous');

  // The same shape on a five-minute agent. A fixed threshold would have called
  // this one a beacon; the derived cadence does not.
  const slowAgent = scoreRegularity(series('2026-09-30T00:00:00Z', 60, 300), { cadenceSec: 300, config: C });
  assert.equal(slowAgent.rejected, 'continuous');

  // And an hourly beacon on that same five-minute agent still IS one.
  const hourly = scoreRegularity(series('2026-09-30T00:00:00Z', 24, 3600), { cadenceSec: 300, config: C });
  assert.equal(hourly.severity, 'CRIT');

  // No cadence at all means no verdict — never a guess.
  assert.equal(scoreRegularity(series('2026-09-30T00:00:00Z', 40, 600), { cadenceSec: null, config: C }).rejected, 'no_cadence');
  assert.equal(scoreRegularity(series('2026-09-30T00:00:00Z', 40, 600), { cadenceSec: 0, config: C }).rejected, 'no_cadence');
});

test('too few calls, or too short a span, is not a pattern', () => {
  assert.equal(scoreRegularity(series('2026-09-30T00:00:00Z', 6, 600), { cadenceSec: 60, config: C }).rejected, 'too_few_observations');
  // Twenty calls, but all inside ten minutes: a burst, not a schedule.
  assert.equal(scoreRegularity(series('2026-09-30T00:00:00Z', 20, 30), { cadenceSec: 10, config: C }).rejected, 'too_short_span');
  assert.equal(scoreRegularity([], { cadenceSec: 60, config: C }).rejected, 'too_few_observations');
});

test('the WARN/CRIT line follows the configured jitter', () => {
  const loose = loadBeaconConfig({ BEACON_MAX_JITTER: '0.5', BEACON_CRIT_JITTER: '0.01' });
  const s = scoreRegularity(series('2026-09-30T00:00:00Z', 40, 600, 120), { cadenceSec: 60, config: loose });
  assert.equal(s.severity, 'WARN', 'regular enough to report, not regular enough to be a clock');
  // CRIT can never be above the WARN line, however the environment is written.
  assert.equal(loadBeaconConfig({ BEACON_MAX_JITTER: '0.1', BEACON_CRIT_JITTER: '0.9' }).critJitter, 0.1);
});

test('NTP is ignored by default, and an empty variable means nothing is', () => {
  assert.deepEqual(DEFAULT_IGNORE_PORTS, [123]);
  assert.deepEqual(loadBeaconConfig({}).ignorePorts, [123]);
  assert.deepEqual(loadBeaconConfig({ BEACON_IGNORE_PORTS: '' }).ignorePorts, []);
  assert.deepEqual(loadBeaconConfig({ BEACON_IGNORE_PORTS: '123,443,junk,0' }).ignorePorts, [123, 443]);
});

test('the ignore list takes addresses, CIDRs and AS numbers', () => {
  const bad = [];
  const list = buildIgnoreList({
    ignoreDestinations: ['198.51.100.7', '203.0.113.0/24', 'not-a-cidr/9'],
    ignoreAsns: [64501],
  }, (e) => bad.push(e));
  assert.equal(list.ignores({ extIp: '198.51.100.7' }), true);
  assert.equal(list.ignores({ extIp: '203.0.113.99' }), true);
  assert.equal(list.ignores({ extIp: '203.0.114.1' }), false);
  // An update service on a CDN is a moving set of addresses and one stable ASN.
  assert.equal(list.ignores({ extIp: '1.2.3.4', asn: 64501 }), true);
  assert.equal(list.ignores({ extIp: '1.2.3.4', asn: 64502 }), false);
  assert.deepEqual(bad, ['not-a-cidr/9']);
});

test('the job raises one finding with the period, the jitter and the ignore-list way out', async () => {
  const s = sink();
  const flowsRepo = makeFlowsRepo({
    reportCadence: async () => new Map([[7, 60]]),
    beaconCandidates: async () => [candidate()],
    beaconTimestamps: async () => series('2026-09-29T12:00:00Z', 144, 600),
  });
  const d = createBeaconDetector({
    flowsRepo, findingSink: s, config: loadBeaconConfig({}), now: () => new Date('2026-09-30T12:00:00Z'),
  });
  const out = await d.run();
  assert.equal(out.raised, 1);
  const f = s.emitted[0];
  assert.equal(f.metric, 'net.beacon');
  assert.equal(f.severity, 'CRIT');
  assert.equal(f.hostId, '7');
  assert.equal(f.observed, 600);
  assert.equal(f.evidence[0].target, '10.0.0.40 -> 203.0.113.7:443');
  assert.equal(f.evidence[0].labels.intervalSeconds, 600);
  assert.equal(f.evidence[0].labels.bytesPerCall, 820);
  assert.match(f.explanation, /every 10 minutes/);
  assert.match(f.explanation, /AS64500 Example Hosting, NL/);
  assert.match(f.explanation, /update checkers, monitoring/, 'the explanation claims it is malware');
  assert.match(f.explanation, /no payload was read/);
  assert.match(f.explanation, /Settings → Attack indication/, 'the explanation does not say how to silence a known beacon');
});

test('the job skips an ignored destination before paying for its timings', async () => {
  const s = sink();
  let timingReads = 0;
  const flowsRepo = makeFlowsRepo({
    reportCadence: async () => new Map([[7, 60]]),
    beaconCandidates: async () => [candidate()],
    beaconTimestamps: async () => { timingReads += 1; return series('2026-09-29T12:00:00Z', 144, 600); },
  });
  const d = createBeaconDetector({
    flowsRepo, findingSink: s,
    config: loadBeaconConfig({ BEACON_IGNORE_ASNS: '64500' }),
    now: () => new Date('2026-09-30T12:00:00Z'),
  });
  const out = await d.run();
  assert.equal(out.ignored, 1);
  assert.equal(out.raised, 0);
  assert.equal(timingReads, 0, 'the expensive read ran for a destination that was never going to be reported');
});

test('one beacon is one finding per cooldown, and the map is swept', async () => {
  const s = sink();
  let t = new Date('2026-09-30T12:00:00Z').getTime();
  const flowsRepo = makeFlowsRepo({
    reportCadence: async () => new Map([[7, 60]]),
    beaconCandidates: async () => [candidate()],
    beaconTimestamps: async () => series('2026-09-29T12:00:00Z', 144, 600),
  });
  const d = createBeaconDetector({
    flowsRepo, findingSink: s, config: loadBeaconConfig({}), now: () => new Date(t),
  });
  await d.run();
  t += 6 * 3600 * 1000;
  await d.run();
  assert.equal(s.emitted.length, 1, 'the 24-hour cooldown did not hold');
  t += 19 * 3600 * 1000;
  await d.run();
  assert.equal(s.emitted.length, 2);
});

test('live config: a getter is re-read on every run', async () => {
  const s = sink();
  const live = loadBeaconConfig({});
  const flowsRepo = makeFlowsRepo({
    reportCadence: async () => new Map([[7, 60]]),
    beaconCandidates: async () => [candidate()],
    beaconTimestamps: async () => series('2026-09-29T12:00:00Z', 144, 600),
  });
  const d = createBeaconDetector({
    flowsRepo, findingSink: s, config: () => live, now: () => new Date('2026-09-30T12:00:00Z'),
  });
  live.enabled = false;
  assert.equal(await d.run(), null, 'turning it off in Settings needed a restart');
  live.enabled = true;
  assert.equal((await d.run()).raised, 1);

  // A getter that throws leaves the shipped defaults in place rather than
  // silently turning the detector off.
  const broken = createBeaconDetector({
    flowsRepo, findingSink: sink(), config: () => { throw new Error('settings down'); },
    now: () => new Date('2026-09-30T12:00:00Z'),
  });
  assert.equal((await broken.run()).raised, 1);
});

test('off by flag, off without a licence, and a broken repo never throws', async () => {
  const flowsRepo = makeFlowsRepo({
    reportCadence: async () => new Map([[7, 60]]),
    beaconCandidates: async () => [candidate()],
    beaconTimestamps: async () => series('2026-09-29T12:00:00Z', 144, 600),
  });
  assert.equal(await createBeaconDetector({ flowsRepo, findingSink: sink(), config: loadBeaconConfig({ BEACON_ALERTS_ENABLED: 'false' }) }).run(), null);
  assert.equal(await createBeaconDetector({ flowsRepo, findingSink: sink(), config: loadBeaconConfig({}), licensed: () => false }).run(), null);

  const broken = createBeaconDetector({
    flowsRepo: makeFlowsRepo({ beaconCandidates: async () => { throw new Error('db down'); } }),
    findingSink: sink(), config: loadBeaconConfig({}),
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  });
  assert.equal(await broken.run(), null);

  // A timing read that fails costs that candidate, not the run.
  const s = sink();
  const partial = createBeaconDetector({
    flowsRepo: makeFlowsRepo({
      reportCadence: async () => new Map([[7, 60]]),
      beaconCandidates: async () => [candidate()],
      beaconTimestamps: async () => { throw new Error('db down'); },
    }),
    findingSink: s, config: loadBeaconConfig({}),
    logger: { warn() {}, info() {}, debug() {}, error() {} },
  });
  const out = await partial.run();
  assert.equal(out.raised, 0);
  assert.equal(s.emitted.length, 0);
});

test('the sentences a reader sees', () => {
  assert.equal(describeInterval(45), 'every 45 seconds');
  assert.equal(describeInterval(600), 'every 10 minutes');
  assert.equal(describeInterval(5400), 'every 1h 30m');
  assert.equal(describeInterval(7200), 'every 2 hours');
  assert.equal(describeSpan(1800), '30 minutes');
  assert.equal(describeSpan(36000), '10.0 hours');
  assert.equal(describeSpan(3 * 86400), '3.0 days');
});

test('start()/stop() schedule and clear without leaving a handle', () => {
  const d = createBeaconDetector({ flowsRepo: makeFlowsRepo(), findingSink: sink(), config: loadBeaconConfig({}) });
  d.start(); d.start(); d.stop(); d.stop();
});
