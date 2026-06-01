'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractSamples } = require('../ingest');

const FIXED = () => new Date('2026-01-01T00:00:00Z');

test('extractSamples maps system + traffic totals into MetricSamples', () => {
  const payload = {
    name: 'm',
    system: { cpuPercent: 42, memUsedPercent: 70, loadavg: [1.5, 1, 0.5], uptimeSec: 1000 },
    traffic: { totals: { rxBytesPerSec: 2000, txBytesPerSec: 3000 } },
  };
  const out = extractSamples('h9', payload, FIXED);
  const byMetric = Object.fromEntries(out.map((s) => [s.metric, s.value]));
  assert.equal(byMetric.cpu, 42);
  assert.equal(byMetric.mem, 70);
  assert.equal(byMetric.load1, 1.5);
  assert.equal(byMetric.uptime, 1000);
  assert.equal(byMetric['rx.bytesPerSec'], 2000);
  assert.equal(byMetric['tx.bytesPerSec'], 3000);
  assert.ok(out.every((s) => s.hostId === 'h9' && s.ts instanceof Date));
});

test('extractSamples skips missing/non-numeric fields and odd payloads', () => {
  assert.deepEqual(extractSamples('h1', null), []);
  assert.deepEqual(extractSamples('h1', {}), []);
  const out = extractSamples('h1', { system: { cpuPercent: 'x', memUsedPercent: 55 } }, FIXED);
  assert.equal(out.length, 1);
  assert.equal(out[0].metric, 'mem');
  assert.equal(out[0].value, 55);
});
