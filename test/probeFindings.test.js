'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateProbeFindings } = require('../src/analysis/probeFindings');

const T = '2026-06-01T12:00:00.000Z';
const at = () => new Date(T);

test('a fully-unreachable target yields a CRIT reachability finding', () => {
  const rows = [{ ts: T, type: 'ping', target: '1.1.1.1', ok: false, rttMs: null, lossPct: 100, jitterMs: null }];
  const fs = evaluateProbeFindings(7, rows, { now: at });
  assert.equal(fs.length, 1);
  assert.equal(fs[0].hostId, '7');
  assert.equal(fs[0].metric, 'probe.reachability');
  assert.equal(fs[0].severity, 'CRIT');
  assert.ok(fs[0].explanation.includes('1.1.1.1'));
  assert.equal(fs[0].evidence.length, 1); // findingStore.save requires >=1
});

test('moderate packet loss yields a WARN loss finding', () => {
  const rows = [{ ts: T, type: 'ping', target: '8.8.8.8', ok: true, rttMs: 10, lossPct: 5, jitterMs: 1 }];
  const loss = evaluateProbeFindings(7, rows, { now: at }).find((f) => f.metric === 'probe.loss');
  assert.ok(loss);
  assert.equal(loss.severity, 'WARN');
  assert.equal(loss.observed, 5);
});

test('a healthy target yields no findings', () => {
  const rows = [{ ts: T, type: 'ping', target: '8.8.8.8', ok: true, rttMs: 10, lossPct: 0, jitterMs: 1 }];
  assert.equal(evaluateProbeFindings(7, rows, { now: at }).length, 0);
});

test('a soon-to-expire TLS cert yields a cert finding independent of reachability', () => {
  const rows = [{ ts: T, type: 'http', target: 'https://ok.test/', ok: true, rttMs: 10, lossPct: 0, jitterMs: 1, status: 200, certExpiryDays: 2 }];
  const cert = evaluateProbeFindings(7, rows, { now: at }).find((f) => f.metric === 'probe.cert');
  assert.ok(cert);
  assert.equal(cert.severity, 'CRIT');
  assert.equal(cert.observed, 2);
  assert.ok(cert.explanation.includes('ok.test'));
});

test('a healthy cert (60 days) yields no cert finding', () => {
  const rows = [{ ts: T, type: 'http', target: 'https://ok.test/', ok: true, rttMs: 10, lossPct: 0, jitterMs: 1, status: 200, certExpiryDays: 60 }];
  const certs = evaluateProbeFindings(7, rows, { now: at }).filter((f) => f.metric === 'probe.cert');
  assert.equal(certs.length, 0);
});

// ---- AS-path change findings (needs a geoProvider to resolve ASNs) ----------

const geoFrom = (map) => ({ lookup: (ip) => map[ip] || null });
const trRun = (target, hops) => ({ ts: T, type: 'traceroute', target, ok: true, hops });

test('a changed destination AS yields a WARN aspath finding (rows newest-first)', () => {
  const geo = geoFrom({
    '203.0.113.1': { asn: 100, asnName: 'Transit', country: 'DE' },
    '198.51.100.1': { asn: 200, asnName: 'Old', country: 'NL' },
    '198.51.100.9': { asn: 999, asnName: 'New', country: 'FR' },
  });
  const rows = [ // newest first: now exits AS999, was AS200
    trRun('x', [{ hop: 1, ip: '203.0.113.1', rttMs: 1 }, { hop: 2, ip: '198.51.100.9', rttMs: 5 }]),
    trRun('x', [{ hop: 1, ip: '203.0.113.1', rttMs: 1 }, { hop: 2, ip: '198.51.100.1', rttMs: 5 }]),
  ];
  const f = evaluateProbeFindings(7, rows, { now: at, geoProvider: geo }).find((x) => x.metric === 'probe.aspath');
  assert.ok(f, 'an aspath finding was produced');
  assert.equal(f.severity, 'WARN');
  assert.ok(f.explanation.includes('AS999'));
  assert.equal(f.evidence[0].target, 'x'); // drives the pipeline's per-target cooldown key
  assert.deepEqual(f.evidence[0].curPath, [100, 999]);
});

test('a mid-path reroute with an unchanged origin is INFO, not WARN', () => {
  const geo = geoFrom({
    '203.0.113.1': { asn: 100 }, '203.0.113.2': { asn: 300 },
    '198.51.100.1': { asn: 200 }, '198.51.100.9': { asn: 999 },
  });
  const rows = [
    trRun('x', [{ hop: 1, ip: '203.0.113.2', rttMs: 1 }, { hop: 2, ip: '198.51.100.9', rttMs: 5 }]), // [300,999]
    trRun('x', [{ hop: 1, ip: '203.0.113.1', rttMs: 1 }, { hop: 2, ip: '198.51.100.9', rttMs: 5 }]), // [100,999]
  ];
  const f = evaluateProbeFindings(7, rows, { now: at, geoProvider: geo }).find((x) => x.metric === 'probe.aspath');
  assert.ok(f);
  assert.equal(f.severity, 'INFO');
});

test('an unchanged AS-path yields no aspath finding', () => {
  const geo = geoFrom({ '203.0.113.1': { asn: 100 }, '203.0.113.2': { asn: 100 } });
  const rows = [
    trRun('x', [{ hop: 1, ip: '203.0.113.1', rttMs: 1 }]),
    trRun('x', [{ hop: 1, ip: '203.0.113.2', rttMs: 1 }]), // different IP, same AS100 → no change
  ];
  assert.equal(evaluateProbeFindings(7, rows, { now: at, geoProvider: geo }).filter((x) => x.metric === 'probe.aspath').length, 0);
});

test('without a geoProvider no aspath findings are produced (backward compatible)', () => {
  const rows = [
    trRun('x', [{ hop: 1, ip: '203.0.113.1' }]),
    trRun('x', [{ hop: 1, ip: '198.51.100.1' }]),
  ];
  assert.equal(evaluateProbeFindings(7, rows, { now: at }).filter((x) => x.metric === 'probe.aspath').length, 0);
});

test('a single traceroute run (no prior path to compare) yields no aspath finding', () => {
  const geo = geoFrom({ '203.0.113.1': { asn: 100 } });
  const rows = [trRun('x', [{ hop: 1, ip: '203.0.113.1', rttMs: 1 }])];
  assert.equal(evaluateProbeFindings(7, rows, { now: at, geoProvider: geo }).filter((x) => x.metric === 'probe.aspath').length, 0);
});

// ------------------------------------------- reroute → what it cost in RTT
// "The path changed" is a fact an operator can do nothing with. "The path
// changed and latency went from 24 ms to 91 ms" names the cost and decides
// whether anyone should care tonight (docs/service-assurance-v2.md §6).

const { rttAcrossPathChange, explainRttShift } = require('../src/analysis/probeFindings');

// A traceroute run on a named path, carrying its own whole-run RTT.
const trRtt = (target, hops, rttMs) => ({ ...trRun(target, hops), rttMs });

const REROUTE_GEO = geoFrom({
  '203.0.113.1': { asn: 100 }, '203.0.113.2': { asn: 300 },
  '198.51.100.9': { asn: 999 },
});
const OLD_PATH = [{ hop: 1, ip: '203.0.113.1', rttMs: 1 }, { hop: 2, ip: '198.51.100.9', rttMs: 5 }]; // [100,999]
const NEW_PATH = [{ hop: 1, ip: '203.0.113.2', rttMs: 1 }, { hop: 2, ip: '198.51.100.9', rttMs: 5 }]; // [300,999]

// Newest-first, as the detector receives them. A path change is detected on the
// tick it happens, so realistic input is ONE run on the new path followed by the
// window of runs on the old one — the detector compares the newest two, and two
// consecutive new-path runs would mean the change already happened and is no
// longer a change.
function rerouteRows(afterRtts, beforeRtts) {
  return [
    ...afterRtts.map((ms) => trRtt('x', NEW_PATH, ms)),
    ...beforeRtts.map((ms) => trRtt('x', OLD_PATH, ms)),
  ];
}

test('a reroute that made latency worse is WARN even when the origin AS is unchanged', () => {
  // The case the old severity rule could not see: it only looked at the control
  // plane, so a mid-path reroute that doubled the latency was filed as INFO.
  const rows = rerouteRows([91], [23, 24, 26, 24, 25]);
  const f = evaluateProbeFindings(7, rows, { now: at, geoProvider: REROUTE_GEO })
    .find((x) => x.metric === 'probe.aspath');

  assert.equal(f.severity, 'WARN');
  assert.match(f.explanation, /Latency rose from 24 ms to 91 ms/);
  assert.match(f.explanation, /median of 1 run on the new path vs 5 on the old/,
    'the sample counts are stated, because one run on the new path is all there is at detection');
  assert.equal(f.observed, 91, 'the number a human reads is the latency, not the AS-path length');
  assert.equal(f.baseline, 24);
  assert.equal(f.deviation, 67);
  assert.equal(f.evidence[0].rtt.worse, true);
});

test('a reroute that changed nothing measurable stays INFO', () => {
  const rows = rerouteRows([25], [24, 24, 26, 23, 25]);
  const f = evaluateProbeFindings(7, rows, { now: at, geoProvider: REROUTE_GEO })
    .find((x) => x.metric === 'probe.aspath');

  assert.equal(f.severity, 'INFO');
  assert.match(f.explanation, /Latency is unchanged/);
  assert.equal(f.evidence[0].rtt.material, false);
});

test('a reroute that made things FASTER is reported, but never escalated', () => {
  // Good news is still news — it just should not wake anyone.
  const rows = rerouteRows([20], [88, 91, 95, 90, 92]);
  const f = evaluateProbeFindings(7, rows, { now: at, geoProvider: REROUTE_GEO })
    .find((x) => x.metric === 'probe.aspath');

  assert.equal(f.severity, 'INFO');
  assert.match(f.explanation, /Latency fell from 91 ms to 20 ms/);
  assert.equal(f.evidence[0].rtt.worse, false);
});

test('the shift must be material in BOTH relative and absolute terms', () => {
  const geo = { geoProvider: REROUTE_GEO };
  // +12 ms on a 400 ms path: absolutely real, relatively nothing.
  const big = rttAcrossPathChange(rerouteRows([412], [400, 398, 402]), { prevSequence: [100, 999], curSequence: [300, 999], ...geo });
  assert.equal(big.material, false, '3% of a slow path is not a reroute cost');

  // +4 ms on a 5 ms path: relatively huge, absolutely nothing.
  const small = rttAcrossPathChange(rerouteRows([9], [5, 5, 6]), { prevSequence: [100, 999], curSequence: [300, 999], ...geo });
  assert.equal(small.material, false, '4 ms is inside the noise of a traceroute');

  // Both: real.
  const real = rttAcrossPathChange(rerouteRows([91], [24, 25, 23]), { prevSequence: [100, 999], curSequence: [300, 999], ...geo });
  assert.equal(real.material, true);
});

test('the BASELINE is a median, so one slow historical run cannot move it', () => {
  // The side where noise protection is both needed and available: a single 250 ms
  // outlier among the old-path runs must not become the baseline the change is
  // judged against. (The new-path side is one sample at detection — see the
  // comment on rttAcrossPathChange; that is stated in the sentence, not hidden.)
  const rows = rerouteRows([26], [24, 250, 23, 25, 24]);
  const f = evaluateProbeFindings(7, rows, { now: at, geoProvider: REROUTE_GEO })
    .find((x) => x.metric === 'probe.aspath');

  assert.equal(f.evidence[0].rtt.beforeMs, 24, 'a mean would have put the baseline near 69 ms');
  assert.equal(f.evidence[0].rtt.material, false);
  assert.equal(f.severity, 'INFO');
});

test('runs are attributed to a path by their OWN path, so a flap does not smear the two', () => {
  // new, old, new, old, … — if the split were positional, both populations would
  // contain both paths and the medians would converge on nonsense.
  const rows = [
    trRtt('x', NEW_PATH, 90), trRtt('x', OLD_PATH, 24),
    trRtt('x', NEW_PATH, 92), trRtt('x', OLD_PATH, 25),
    trRtt('x', NEW_PATH, 91), trRtt('x', OLD_PATH, 23),
  ];
  const rtt = rttAcrossPathChange(rows, { prevSequence: [100, 999], curSequence: [300, 999], geoProvider: REROUTE_GEO });
  assert.equal(rtt.afterMs, 91);
  assert.equal(rtt.beforeMs, 24);
  assert.equal(rtt.samplesAfter, 3);
  assert.equal(rtt.samplesBefore, 3);
});

test('with no usable RTT on either side the finding still reports the path change', () => {
  // Backward compatible: a traceroute row without a whole-run rttMs is what the
  // existing fixtures (and older agents) produce.
  const rows = [trRun('x', NEW_PATH), trRun('x', OLD_PATH)];
  const f = evaluateProbeFindings(7, rows, { now: at, geoProvider: REROUTE_GEO })
    .find((x) => x.metric === 'probe.aspath');

  assert.ok(f, 'the path change is still reported without latency to go with it');
  assert.equal(f.severity, 'INFO');
  assert.equal(f.evidence[0].rtt, null);
  assert.ok(!/Latency/.test(f.explanation), 'no latency sentence is better than an invented one');
  assert.equal(f.observed, 2, 'falls back to the AS-path length');
});

test('explainRttShift says nothing when there is nothing to say', () => {
  assert.equal(explainRttShift(null), '');
  assert.match(explainRttShift({ material: false, afterMs: 24, samplesAfter: 2, samplesBefore: 2 }), /unchanged/);
});
