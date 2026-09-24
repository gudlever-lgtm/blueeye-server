'use strict';

// src/health/agentOfflineAlerter.js — an agent that stays disconnected past its
// grace period is alerted once, and again (as a recovery) when it is back.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAgentOfflineAlerter } = require('../src/health/agentOfflineAlerter');

// Manual timers and clock, so a test decides when the grace runs out.
function harness(over = {}) {
  let t = 1_000_000;
  const timers = new Map();
  let nextId = 1;
  const sent = [];
  const alerter = createAgentOfflineAlerter({
    dispatcher: { dispatch: async (s) => { sent.push(s); return { dispatched: true }; } },
    isConnected: over.isConnected || (() => false),
    agentName: async (id) => (id === 12 || id === '12' ? 'core-sw-1' : null),
    lastSeen: over.lastSeen || (async () => null),
    graceMs: 120000,
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
  });
  async function advance(ms) {
    t += ms;
    for (const [id, tm] of [...timers]) {
      if (tm.at <= t) { timers.delete(id); await tm.fn(); }
    }
    await new Promise((r) => setImmediate(r));
  }
  return { alerter, sent, advance, timers, now: () => t };
}

test('an agent still gone after the grace is alerted once, by name', async () => {
  const h = harness();
  h.alerter.onOffline(12, { closeCode: 1006 });
  await h.advance(60000);
  assert.equal(h.sent.length, 0, 'alerted inside the grace');
  await h.advance(60000);
  assert.equal(h.sent.length, 1);
  const a = h.sent[0];
  assert.equal(a.metric, 'agent.connection');
  assert.equal(a.kind, 'OFFLINE');
  assert.equal(a.hostId, '12');
  assert.match(a.explanation, /core-sw-1 has not been connected since/);
  assert.equal(a.evidence[0].closeCode, 1006);

  // A second disconnect report for the same outage does not alert again.
  h.alerter.onOffline(12, {});
  await h.advance(300000);
  assert.equal(h.sent.length, 1);
});

test('a reconnect inside the grace is not an outage', async () => {
  const h = harness();
  h.alerter.onOffline(12);
  await h.advance(30000);
  await h.alerter.onOnline(12);
  await h.advance(300000);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.alerter.state(), { pending: [], alerted: [] });
});

test('coming back after an alert sends a recovery', async () => {
  const h = harness();
  h.alerter.onOffline(12);
  await h.advance(120000);
  await h.advance(600000);
  await h.alerter.onOnline(12);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].kind, 'ONLINE');
  assert.match(h.sent[1].explanation, /core-sw-1 is connected again after 12 min offline/);
});

test('an agent connected again (here, or to another instance) is not alerted', async () => {
  const live = harness({ isConnected: () => true });
  live.alerter.onOffline(12);
  await live.advance(120000);
  assert.equal(live.sent.length, 0);

  let h;
  // Seen well after the disconnect: alive through another server.
  h = harness({ lastSeen: async () => new Date(h.now() + 60000) });
  h.alerter.onOffline(12);
  await h.advance(120000);
  assert.equal(h.sent.length, 0);
});

test('the close itself stamping last_seen does not count as alive', async () => {
  let h;
  h = harness({ lastSeen: async () => new Date(h.now() - 120000 + 50) });
  h.alerter.onOffline(12);
  await h.advance(120000);
  assert.equal(h.sent.length, 1);
});

test('at boot, agents that were alive get the grace to reconnect', async () => {
  const h = harness();
  h.alerter.watch([12, 13]);
  await h.advance(60000);
  await h.alerter.onOnline(13);
  await h.advance(60000);
  assert.deepEqual(h.sent.map((s) => s.hostId), ['12']);
  assert.match(h.sent[0].explanation, /agent 12|core-sw-1/);
});

test('after stop(), the sockets closing on shutdown alert nothing', async () => {
  const h = harness();
  h.alerter.onOffline(12);
  h.alerter.stop();
  h.alerter.onOffline(13);
  await h.advance(600000);
  assert.equal(h.sent.length, 0);
});

test('a dispatcher that throws does not throw out of the alerter', async () => {
  let t = 0;
  let fire = null;
  const alerter = createAgentOfflineAlerter({
    dispatcher: { dispatch: async () => { throw new Error('smtp down'); } },
    now: () => t,
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => {},
  });
  alerter.onOffline(1);
  t = 200000;
  await assert.doesNotReject(async () => {
    fire();
    await new Promise((r) => setImmediate(r));
  });
});
