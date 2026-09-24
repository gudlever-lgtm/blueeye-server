'use strict';

// A crossed transaction threshold is a FINDING (src/analysis/transactionAlerts.js
// buildTransactionFinding), not a bare alert: the pure half of that change.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { diagnoseText, buildTransactionFinding } = require('../src/analysis/transactionAlerts');
const { createCrossAgentCorrelator, subjectOf } = require('../src/analysis/crossAgentCorrelator');

const TEST = { id: 4, name: 'Webshop login', type: 'http', config: { thresholds: { consecutive_fails: 2, latency_ms: 800 } } };

test('the explanation always carries the phase, the errno and the site-vs-system verdict', () => {
  const result = { status: 'fail', detail: { phase: 'tls', errno: 'CERT_HAS_EXPIRED', step: 2 } };
  const site = diagnoseText({ test: TEST, agentId: 9, result, crosscheck: { scope: 'site', failing: 1, total: 3 } });
  assert.match(site, /TLS handshake failed/);
  assert.match(site, /\(phase tls, errno CERT_HAS_EXPIRED\)/);
  assert.match(site, /\(step 2\)/);
  assert.match(site, /only agent 9 fails: problem from this agent's site\/network \(1 of 3 assigned agents failing\)/);
  const system = diagnoseText({ test: TEST, agentId: 9, result, crosscheck: { scope: 'system', failing: 3, total: 3 } });
  assert.match(system, /all assigned agents fail: the system is down \(3 of 3/);
  // Two of three failing is not "only this agent".
  const some = diagnoseText({ test: TEST, agentId: 9, result, crosscheck: { scope: 'site', failing: 2, total: 3 } });
  assert.doesNotMatch(some, /only agent/);
  assert.match(some, /2 of 3 assigned agents failing/);
  // An unknown phase still names the status and the raw phase.
  assert.match(diagnoseText({ test: TEST, agentId: 9, result: { status: 'error', detail: { phase: 'weird' } } }), /Failed \(error\) \(phase weird\)/);
});

test('buildTransactionFinding: a storable finding (THRESHOLD kind, evidence with the test id), assistant text appended', () => {
  const at = new Date('2026-09-01T10:00:00Z');
  const f = buildTransactionFinding({
    test: TEST, agentId: 9,
    result: { status: 'fail', latency_ms: null, detail: { phase: 'connect', errno: 'ECONNREFUSED' } },
    verdict: { metric: 'transaction.fail', kind: 'TRANSACTION_FAIL', severity: 'CRIT' },
    crosscheck: { scope: 'site', failing: 1, total: 2 },
    explanation: 'deterministic', assistantText: 'AI says', at,
  });
  assert.match(f.id, /^[0-9a-f-]{36}$/);
  assert.equal(f.kind, 'THRESHOLD');
  assert.equal(f.hostId, '9');
  assert.equal(f.explanation, 'deterministic\nAssistant: AI says');
  assert.equal(f.evidence.length, 1);
  assert.deepEqual(
    [f.evidence[0].testId, f.evidence[0].phase, f.evidence[0].errno, f.evidence[0].crosscheck, f.evidence[0].crosscheckTotal],
    [4, 'connect', 'ECONNREFUSED', 'site', 2],
  );
  assert.equal(subjectOf(f).key, 'transaction:4');
});

test('the same transaction test failing from two agents is ONE situation', () => {
  const mk = (agentId, ms) => buildTransactionFinding({
    test: TEST, agentId, result: { status: 'fail', detail: { phase: 'dns' } },
    verdict: { metric: 'transaction.fail', severity: 'CRIT' }, explanation: 'x',
    at: new Date(Date.UTC(2026, 8, 1, 10, 0, 0) + ms),
  });
  const clusters = createCrossAgentCorrelator().detect([mk(1, 0), mk(2, 60000)], { siteOf: (h) => `site-${h}` });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].topologySource, 'target');
  assert.match(clusters[0].suspectedCommonCause, /transaction test "Webshop login"/);
});
