'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildExplanation, buildWhy } = require('../explanation');

const incident = { id: 1, hostId: '7', severity: 'CRIT', title: 't' };
const finding = {
  id: 'f1', metric: 'io.await', kind: 'ANOMALY', severity: 'CRIT',
  observed: 40, baseline: 5, deviation: 6.2, explanation: 'io.await at 40 deviated 6.2σ',
  evidence: [{ metric: 'io.await', value: 40, ts: '2026-06-01T00:00:00.000Z' }],
};

test('buildExplanation: what = anomaly-type + severity', () => {
  const out = buildExplanation({ incident, primaryFinding: finding });
  assert.equal(out.what.anomalyType, 'io.await');
  assert.equal(out.what.severity, 'CRIT');
});

test('buildExplanation: where = device (+ label from agent)', () => {
  const out = buildExplanation({ incident, primaryFinding: finding, agent: { display_name: 'core-sw-1', hostname: 'h1' } });
  assert.equal(out.where.device, '7');
  assert.equal(out.where.deviceLabel, 'core-sw-1');
  assert.equal(out.where.interface, null); // none in evidence
  assert.equal(out.where.topology, null); // Fase-6 not incident-scoped yet
});

test('buildExplanation: where.interface is pulled from evidence when present', () => {
  const f = { ...finding, evidence: [{ metric: 'if.errors', iface: 'eth0', value: 3, ts: 'x' }] };
  const out = buildExplanation({ incident, primaryFinding: f });
  assert.equal(out.where.interface, 'eth0');
});

test('why: falls back to RAW trigger-data (no confidence model for this anomaly-type)', () => {
  const why = buildWhy(finding);
  assert.equal(why.source, 'raw_trigger');
  assert.equal(why.available, true);
  assert.equal(why.observed, 40);
  assert.equal(why.baseline, 5);
  assert.equal(why.deviation, 6.2);
  assert.equal(why.evidence.length, 1); // same evidence-array format a model would use
  assert.equal(why.confidence, undefined); // no confidence score in the fallback
});

test('why: no primary finding → available:false, raw_trigger, empty evidence', () => {
  const why = buildWhy(null);
  assert.equal(why.source, 'raw_trigger');
  assert.equal(why.available, false);
  assert.deepEqual(why.evidence, []);
});

test('buildExplanation: null incident → null', () => {
  assert.equal(buildExplanation({ incident: null }), null);
});
