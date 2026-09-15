'use strict';

// What a monitor result MEANS — the decision layer, pure.
//
// The rules worth pinning down, because they are the ones that decide whether an
// operator keeps reading their alerts:
//
//   * one bad check is not an outage; a condition that is simply TRUE (a
//     certificate expiring, a record missing) does not wait for a streak;
//   * a monitor whose own credentials are wrong is a WARN, never a page — that
//     is our configuration, not their service;
//   * silently lost mail pages, because nothing else will ever report it.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { monitorReaction, monitorSummary, monitorEvidence, isFailure, explain } = require('../policy');
const { createMonitorRunner, observationFor } = require('../registry');
const { applyThresholds } = require('../result');
const { KIND, TYPE_NAMES } = require('../types');

const result = (over = {}) => ({ status: 'failed', kind: KIND.MAIL_UNDELIVERED, summary: 's', value: null, unit: null, duration_ms: 1, timings: null, detail: null, error_message: null, ...over });

test('a healthy result reacts to nothing', () => {
  assert.equal(monitorReaction(result({ status: 'ok', kind: null })), null);
  assert.equal(monitorReaction(null), null);
});

test('one bad check is not an outage — the streak threshold decides', () => {
  assert.equal(monitorReaction(result(), { failureStreak: 2, streak: 1 }), null);
  assert.deepEqual(monitorReaction(result(), { failureStreak: 2, streak: 2 }), { kind: KIND.MAIL_UNDELIVERED, severity: 'CRIT' });
  assert.deepEqual(monitorReaction(result(), { failureStreak: 1, streak: 1 }), { kind: KIND.MAIL_UNDELIVERED, severity: 'CRIT' });
});

test('a condition that is simply true does not wait for a second opinion', () => {
  for (const kind of [KIND.TLS_EXPIRED, KIND.RBL_LISTED, KIND.DNS_RECORD_MISSING, KIND.DNS_RECORD_MISMATCH]) {
    const reaction = monitorReaction(result({ kind }), { failureStreak: 3, streak: 1 });
    assert.ok(reaction, `${kind} waited for a streak it should not need`);
  }
});

test('a certificate deadline is judged from the days remaining, every time', () => {
  const expiring = (days) => result({ kind: KIND.TLS_EXPIRING, value: days, unit: 'days' });
  assert.equal(monitorReaction(expiring(20), { criticalDays: 7, streak: 1 }).severity, 'WARN');
  assert.equal(monitorReaction(expiring(3), { criticalDays: 7, streak: 1 }).severity, 'CRIT');
  // Move the critical window and the same row is re-judged on the next check.
  assert.equal(monitorReaction(expiring(20), { criticalDays: 30, streak: 1 }).severity, 'CRIT');
});

test('our own misconfiguration is a WARN and stays one, however long it lasts', () => {
  const bad = result({ status: 'misconfigured', kind: KIND.MISCONFIGURED });
  assert.equal(monitorReaction(bad, { failureStreak: 2, streak: 2 }).severity, 'WARN');
  assert.equal(monitorReaction(bad, { failureStreak: 2, streak: 40 }).severity, 'WARN');
  assert.equal(monitorReaction(result({ status: 'failed', kind: KIND.MAIL_AUTH_FAILED }), { streak: 9 }).severity, 'WARN');
});

test('slow carries the severity the threshold pass judged', () => {
  const slow = (hint) => result({ status: 'slow', kind: KIND.MAIL_SLOW, severity_hint: hint });
  assert.equal(monitorReaction(slow('WARN'), { streak: 2 }).severity, 'WARN');
  assert.equal(monitorReaction(slow('CRIT'), { streak: 2 }).severity, 'CRIT');
});

test('an unknown kind escalates with persistence rather than being ignored', () => {
  const odd = result({ kind: 'something_new' });
  assert.equal(monitorReaction(odd, { failureStreak: 2, streak: 2 }).severity, 'WARN');
  assert.equal(monitorReaction(odd, { failureStreak: 2, streak: 4 }).severity, 'CRIT');
});

test('every kind the checks can produce has a plain-language explanation', () => {
  for (const kind of Object.values(KIND)) {
    const record = explain(kind);
    assert.ok(record.summary && record.cause && record.detail, `${kind} has no explanation`);
    assert.ok(!/undefined/.test(JSON.stringify(record)), kind);
  }
});

test('the summary and the evidence read like something a human wrote at 2am', () => {
  const monitor = { name: 'Customer mail', type: 'mail', target: 'smtp.example.com' };
  const r = result({
    summary: 'smtp.example.com accepted the message but it never reached mailprobe@example.com.',
    value: 300000,
    unit: 'ms',
    detail: { smtp_code: 250, smtp_response: '2.0.0 Ok', queue_id: '4bXk2Z' },
    error_message: null,
  });
  assert.match(monitorSummary(monitor, r, 3), /^"Customer mail" — smtp\.example\.com accepted .* \(3 checks in a row\)$/);
  assert.match(monitorSummary(monitor, r, 1), /^"Customer mail" — /);

  const evidence = monitorEvidence(monitor, r, 3);
  assert.ok(evidence.some((line) => line.includes('Monitor: Customer mail (mail)')));
  assert.ok(evidence.some((line) => line.includes('Target: smtp.example.com')));
  assert.ok(evidence.some((line) => line.includes('Consecutive failures: 3')));
  assert.ok(evidence.some((line) => line.includes('Queue id: 4bXk2Z')));
});

test('anything that is not ok counts as a failure for the streak, slow included', () => {
  assert.equal(isFailure(result({ status: 'ok' })), false);
  for (const status of ['slow', 'failed', 'unreachable', 'misconfigured', 'unknown']) {
    assert.equal(isFailure(result({ status })), true, status);
  }
});

// ------------------------------------------------------------------ runner
test('the runner applies the operator\'s thresholds to whatever the check measured', () => {
  const slow = applyThresholds(
    { status: 'ok', kind: null, value: 90000, unit: 'ms', duration_ms: 90000 },
    { warnMs: 60000, critMs: 120000, slowKind: KIND.MAIL_SLOW, what: 'Delivery' }
  );
  assert.equal(slow.status, 'slow');
  assert.equal(slow.severity_hint, 'WARN');
  assert.match(slow.summary, /Delivery took 90000 ms/);

  const critical = applyThresholds(
    { status: 'ok', value: 200000, unit: 'ms', duration_ms: 200000 },
    { warnMs: 60000, critMs: 120000 }
  );
  assert.equal(critical.severity_hint, 'CRIT');

  // A failing result is never re-judged into "slow".
  const failing = applyThresholds({ status: 'failed', kind: KIND.MAIL_REJECTED, value: 5, unit: 'ms' }, { warnMs: 1 });
  assert.equal(failing.status, 'failed');
});

test('the runner never throws, never hangs and always names the monitor type it could not run', async () => {
  const runner = createMonitorRunner({
    checkers: {
      mail: { async check() { throw new Error('the checker exploded'); } },
      tcp_port: { check() { return new Promise(() => {}); } },
    },
    hardCapMs: 40,
  });

  const thrown = await runner.run({ id: 1, type: 'mail', config: {}, name: 'm' });
  assert.equal(thrown.status, 'unknown');
  assert.match(thrown.summary, /could not be completed/);

  const hung = await runner.run({ id: 2, type: 'tcp_port', config: {}, name: 'm' });
  assert.equal(hung.status, 'unknown');
  assert.match(hung.summary, /did not finish within/);

  const unknownType = await runner.run({ id: 3, type: 'telepathy', config: {}, name: 'm' });
  assert.equal(unknownType.status, 'misconfigured');
  assert.match(unknownType.summary, /Unknown monitor type/);
});

test('the real registry has a checker for every type in the catalogue', () => {
  const runner = createMonitorRunner({});
  for (const type of TYPE_NAMES) {
    assert.ok(typeof runner.checkers[type].check === 'function', `${type} has no checker`);
  }
});

test('a result becomes one typed observation, and "unknown" stays unknown', () => {
  const monitor = { type: 'mail', target: 'smtp.example.com' };
  const good = observationFor(monitor, { status: 'ok', value: 4100, unit: 'ms', summary: 's', detail: null });
  assert.deepEqual(
    { layer: good.layer, kind: good.kind, outcome: good.outcome, subject: good.subject },
    { layer: 'application', kind: 'mail.delivery', outcome: 'ok', subject: 'mail:smtp.example.com' }
  );
  assert.equal(observationFor(monitor, { status: 'failed' }).outcome, 'bad');
  assert.equal(observationFor(monitor, { status: 'unknown' }).outcome, 'unknown', 'we did not look must never read as fine');
  assert.equal(observationFor({ type: 'telepathy' }, { status: 'ok' }), null);
});
