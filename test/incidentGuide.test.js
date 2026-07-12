'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildIncidentGuide, metricStep, primaryMetricOf } = require('../src/incidentCases/guide');

const INCIDENT = { id: 3, deviceId: '9', primaryFindingId: 'a1', severity: 'CRIT', status: 'open' };

test('the guide always opens with a confirm-scope step and ends with document/escalate', () => {
  const g = buildIncidentGuide({ incident: INCIDENT, anomalies: [{ id: 'a1', metric: 'cpu' }] });
  assert.equal(g.steps[0].title, 'Confirm the incident is still active');
  assert.equal(g.steps[0].action.view, 'agent');
  assert.equal(g.steps[0].action.targetId, '9');
  assert.match(g.steps[g.steps.length - 1].title, /Document findings/);
  assert.ok(g.steps.every((s) => s.id && s.title && s.rationale));
});

test('primaryMetricOf prefers the primary finding, else the first anomaly', () => {
  assert.equal(primaryMetricOf({ primaryFindingId: 'a2' }, [{ id: 'a1', metric: 'cpu' }, { id: 'a2', metric: 'latency' }]), 'latency');
  assert.equal(primaryMetricOf({}, [{ id: 'a1', metric: 'loss' }]), 'loss');
  assert.equal(primaryMetricOf({}, []), null);
});

test('metric families map to tailored, explainable checks', () => {
  assert.match(metricStep('probe.reachability', 9).title, /where packets are lost/i);
  assert.match(metricStep('latency', 9).title, /latency or rerouting/i);
  assert.match(metricStep('interface_errors', 9).title, /interface counters/i);
  assert.match(metricStep('throughput', 9).title, /saturation/i);
  assert.match(metricStep('cpu', 9).title, /device resources/i);
  assert.match(metricStep('something_else', 9).title, /against its baseline/i);
});

test('a correlated config change becomes an early, high-priority step', () => {
  const g = buildIncidentGuide({
    incident: INCIDENT,
    anomalies: [{ id: 'a1', metric: 'probe.reachability' }],
    configContext: { configChangeId: 5, minutesBefore: 15, risk: 'high', riskReasons: ['acl'] },
  });
  const cfg = g.steps.find((s) => /correlated config change/i.test(s.title));
  assert.ok(cfg);
  assert.match(cfg.detail, /15 min before onset/);
  assert.match(cfg.detail, /risk: high, acl/);
  assert.equal(cfg.action.view, 'config-context');
  // it comes before the metric-specific step
  assert.ok(g.steps.indexOf(cfg) < g.steps.findIndex((s) => /packets are lost/i.test(s.title)));
});

test('a similar past incident adds a resolution step that deep-links to it', () => {
  const g = buildIncidentGuide({
    incident: INCIDENT,
    anomalies: [{ id: 'a1', metric: 'cpu' }],
    similar: [{ id: 42, title: 'CPU on core', resolvedAt: '2026-05-01T00:00:00.000Z', closedBy: 'ops@x' }],
  });
  const sim = g.steps.find((s) => /similar incident/i.test(s.title));
  assert.ok(sim);
  assert.match(sim.detail, /#42/);
  assert.match(sim.detail, /2026-05-01/);
  assert.match(sim.detail, /ops@x/);
  assert.deepEqual(sim.action, { label: 'Open similar incident', view: 'incident', targetId: 42 });
});

test('multiple linked anomalies add a "follow the correlated anomalies" step', () => {
  const g = buildIncidentGuide({ incident: INCIDENT, anomalies: [{ id: 'a1', metric: 'cpu' }, { id: 'a2', metric: 'latency' }] });
  const cor = g.steps.find((s) => /correlated anomalies/i.test(s.title));
  assert.ok(cor);
  assert.match(cor.detail, /2 anomalies fired together/);
});

test('empty incident yields an empty guide', () => {
  assert.deepEqual(buildIncidentGuide({}), { incidentId: null, primaryMetric: null, steps: [] });
});
