'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { throughputHealthSummary } = require('../src/health/throughputHealth');
const { mergeThroughput, computeAgentHealth, computeFleet } = require('../src/health/probeHealth');

const thr = { enabled: true, downWarnMbps: 100, downBadMbps: 50, upWarnMbps: 10, upBadMbps: 5 };

test('throughputHealthSummary is null when disabled or there is no measurement', () => {
  assert.equal(throughputHealthSummary({ ok: 1, down_mbps: 10 }, { enabled: false }), null);
  assert.equal(throughputHealthSummary(null, thr), null);
});

test('throughputHealthSummary flags below the floors and passes above', () => {
  assert.equal(throughputHealthSummary({ ok: 1, down_mbps: 40, up_mbps: 20 }, thr).status, 'bad'); // 40 < downBad 50
  assert.equal(throughputHealthSummary({ ok: 1, down_mbps: 80, up_mbps: 20 }, thr).status, 'warn'); // 80 < downWarn 100
  assert.equal(throughputHealthSummary({ ok: 1, down_mbps: 200, up_mbps: 20 }, thr).status, 'ok');
  // upload floors apply too
  assert.equal(throughputHealthSummary({ ok: 1, down_mbps: 200, up_mbps: 3 }, thr).status, 'bad'); // 3 < upBad 5
});

test('throughputHealthSummary marks a failed test as bad', () => {
  const s = throughputHealthSummary({ ok: 0, down_mbps: null, up_mbps: null }, thr);
  assert.equal(s.status, 'bad');
  assert.match(s.reason, /failed/i);
});

test('mergeThroughput records the metrics and leaves the verdict alone', () => {
  // A SPEED TEST MEASURES THE INTERNET. It runs against a server on the far
  // side of the customer's uplink: a slow result is their ISP, the far end, or
  // the time of day — not the agent. The Mbps is carried and the throughput
  // finding is raised as before; what it no longer does is colour an agent red
  // for a bad evening on a shared line.
  const ok = computeAgentHealth([{ ts: new Date().toISOString(), type: 'ping', target: '192.168.1.1', ok: true, rttMs: 10, lossPct: 0, jitterMs: 1 }]);
  assert.equal(ok.status, 'ok');
  const merged = mergeThroughput(ok, { status: 'bad', downMbps: 10, upMbps: 5, reason: 'Download 10 Mbps (below 50).' });
  assert.equal(merged.status, 'ok');
  assert.equal(merged.reason, ok.reason, 'and it does not take over the headline');
  const ev = merged.evidence.find((e) => e.metric === 'throughput');
  assert.ok(ev);
  assert.equal(ev.external, true);
  assert.equal(merged.metrics.downMbps, 10);
  assert.equal(merged.metrics.throughputStatus, 'bad', 'the measurement itself is reported in full');
  // a null summary leaves the verdict untouched
  assert.equal(mergeThroughput(ok, null), ok);
});

test('computeFleet folds throughput and always surfaces the latest speed test', () => {
  const agents = [{ id: 1, hostname: 'h', status: 'online' }];
  const latest = { 1: { ts: 't', ok: 1, down_mbps: 10, up_mbps: 5 } };
  // enabled: measured and flagged as a throughput problem, but the agent (which
  // has no probe rows at all here) is still 'unknown' rather than critical.
  const flagged = computeFleet(agents, {}, { throughputByAgentId: latest, throughputThresholds: thr });
  assert.equal(flagged.agents[0].health.status, 'unknown');
  assert.equal(flagged.agents[0].health.metrics.throughputStatus, 'bad');
  assert.equal(flagged.agents[0].throughput.downMbps, 10);
  // disabled: surfaced but not flagged (no probes ⇒ unknown)
  const shown = computeFleet(agents, {}, { throughputByAgentId: latest, throughputThresholds: { enabled: false } });
  assert.equal(shown.agents[0].health.status, 'unknown');
  assert.equal(shown.agents[0].throughput.downMbps, 10);
});
