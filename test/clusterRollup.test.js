'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decideAlert } = require('../src/analysis/clusterRollup');
const { createDispatcher } = require('../src/analysis/alerting/dispatcher');

const T = 1000000;
const prevAt = (msAgo) => ({ alertLastAt: new Date(T - msAgo), alertLastSeverity: 'WARN', alertMemberCount: 2 });

// ---- decideAlert (pure) ----------------------------------------------------

test('first notification → opened', () => {
  assert.equal(decideAlert('opened', { severity: 'WARN', memberCount: 2 }, {}).kind, 'opened');
  // an "updated" event before any alert also opens.
  assert.equal(decideAlert('updated', { severity: 'WARN', memberCount: 2 }, { alertLastAt: null }).kind, 'opened');
});

test('no new members since last alert → nothing', () => {
  const d = decideAlert('updated', { severity: 'WARN', memberCount: 2 }, prevAt(60 * 60 * 1000), { now: () => T });
  assert.equal(d.kind, null);
});

test('new members within the digest window → nothing (digest holds)', () => {
  const d = decideAlert('updated', { severity: 'WARN', memberCount: 5 }, prevAt(2 * 60 * 1000), { digestMs: 10 * 60 * 1000, now: () => T });
  assert.equal(d.kind, null);
});

test('new members after the digest window → update', () => {
  const d = decideAlert('updated', { severity: 'WARN', memberCount: 5 }, prevAt(11 * 60 * 1000), { digestMs: 10 * 60 * 1000, now: () => T });
  assert.equal(d.kind, 'update');
});

test('severity climb → escalation, bypassing the digest window', () => {
  // Only 2 min since last alert (inside the 10-min window) but severity WARN→CRIT.
  const d = decideAlert('updated', { severity: 'CRIT', memberCount: 3 }, prevAt(2 * 60 * 1000), { digestMs: 10 * 60 * 1000, now: () => T });
  assert.equal(d.kind, 'escalation');
});

test('resolved event → resolved', () => {
  assert.equal(decideAlert('resolved', { severity: 'CRIT' }, prevAt(5)).kind, 'resolved');
});

// ---- dispatchClusterEvent: per-channel digest (update vs silent) -----------

function dispatcherWith(digestModes) {
  const sent = { email: [], webhook: [] };
  const channels = {
    email: { send: async (s) => { sent.email.push(s.clusterEvent); return { ok: true }; } },
    webhook: { send: async (s) => { sent.webhook.push(s.clusterEvent); return { ok: true }; } },
  };
  const config = {
    enabled: true,
    channels: {
      email: { enabled: true, minSeverity: 'INFO', digestMode: digestModes.email },
      webhook: { enabled: true, minSeverity: 'INFO', digestMode: digestModes.webhook },
    },
  };
  const d = createDispatcher({ config, channels });
  return { d, sent };
}

test('a "silent" channel skips update events but gets opened/escalation/resolved', async () => {
  const { d, sent } = dispatcherWith({ email: 'update', webhook: 'silent' });
  const subject = { clusterId: 1, severity: 'WARN' };

  await d.dispatchClusterEvent(subject, {}, { kind: 'opened' });
  await d.dispatchClusterEvent(subject, {}, { kind: 'update' });
  await d.dispatchClusterEvent(subject, {}, { kind: 'resolved' });

  // email (update mode) got all three; webhook (silent) skipped the 'update'.
  assert.deepEqual(sent.email, ['opened', 'update', 'resolved']);
  assert.deepEqual(sent.webhook, ['opened', 'resolved']);
});

test('below-minSeverity channels are skipped for cluster events too', async () => {
  const sent = [];
  const channels = { webhook: { send: async () => { sent.push(1); return { ok: true }; } } };
  const config = { enabled: true, channels: { webhook: { enabled: true, minSeverity: 'CRIT', digestMode: 'update' } } };
  const d = createDispatcher({ config, channels });
  await d.dispatchClusterEvent({ clusterId: 1, severity: 'WARN' }, {}, { kind: 'opened' });
  assert.equal(sent.length, 0); // WARN < CRIT
});
