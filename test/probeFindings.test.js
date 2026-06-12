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
