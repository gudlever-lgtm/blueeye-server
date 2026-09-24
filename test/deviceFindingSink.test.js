'use strict';

// The device finding sink (src/devices/findingSink.js) — the path rule-based
// switch findings, transaction findings and probe outages take.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDeviceFindingSink } = require('../src/devices/findingSink');
const { makeFindingStore } = require('../test-support/fakes');

// A store whose save() applies a severity rule, as the real FindingStore does
// (migration 086): probe_outage.* is downgraded to INFO.
function downgradingStore() {
  const base = makeFindingStore();
  const save = base.save;
  base.save = async (f) => save(f.metric.startsWith('probe_outage.')
    ? { ...f, severity: 'INFO', originalSeverity: f.severity, severityRuleId: 7 }
    : f);
  return base;
}

function recorder() {
  const out = { published: [], cased: [], dispatched: [], integrated: [] };
  return {
    out,
    deps: {
      publishFinding: (_h, msg) => out.published.push(msg.payload),
      eventCaseService: { assignFinding: async (f) => { out.cased.push(f); return { eventCaseId: 42 }; } },
      dispatcher: { dispatch: async (f) => { out.dispatched.push(f); return { dispatched: true }; } },
      alertingEnabled: true,
      integrationTrigger: { emitFinding: async (f) => { out.integrated.push(f); } },
    },
  };
}

const draft = () => ({
  id: 'x1', hostId: '9', metric: 'probe_outage.reachability', severity: 'CRIT', kind: 'THRESHOLD',
  explanation: 'e', evidence: [{ target: 'erp.example.com' }], createdAt: new Date(),
});

// emit() used to ignore what save() returned and hand the CRIT draft on — a
// severity rule that downgraded the metric still paged.
test('a severity rule applied at save time is what gets published, event-cased, alerted, integrated and returned', async () => {
  const store = downgradingStore();
  const { out, deps } = recorder();
  const sink = createDeviceFindingSink({ findingStore: store, ...deps });
  const d = draft();
  const res = await sink.emit(d);
  assert.equal(res.severity, 'INFO');
  assert.equal(res.severityRuleId, 7);
  for (const k of ['published', 'cased', 'dispatched', 'integrated']) {
    assert.equal(out[k].length, 1, k);
    assert.equal(out[k][0].severity, 'INFO', k);
  }
  assert.equal(res.eventCaseId, 42);
  assert.equal(d.eventCaseId, 42, 'the caller\'s draft still learns its event case');
});

test('a store that answers nothing leaves the draft in place (older fakes)', async () => {
  const { out, deps } = recorder();
  const sink = createDeviceFindingSink({ findingStore: { save: async () => undefined }, ...deps });
  const res = await sink.emit(draft());
  assert.equal(res.severity, 'CRIT');
  assert.equal(out.dispatched[0].severity, 'CRIT');
});

test('emit(f, { alert: false }) stores, publishes and groups, but neither alerts nor integrates', async () => {
  const store = makeFindingStore();
  const { out, deps } = recorder();
  const sink = createDeviceFindingSink({ findingStore: store, ...deps });
  const res = await sink.emit(draft(), { alert: false });
  assert.ok(res);
  assert.equal(store.rows.length, 1);
  assert.equal(out.published.length, 1);
  assert.equal(out.cased.length, 1);
  assert.equal(out.dispatched.length, 0);
  assert.equal(out.integrated.length, 0);
});
