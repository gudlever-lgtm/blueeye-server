'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeSettingsService, authHeader } = require('../test-support/fakes');
const { createDispatcher } = require('../src/analysis/alerting/dispatcher');
const { createSilencer, isWindowActive } = require('../src/analysis/alerting/maintenance');

const NOW = () => Date.parse('2026-06-02T12:00:00Z');
const span = { from: '2026-06-02T11:00:00Z', to: '2026-06-02T13:00:00Z' };

// ---- maintenance module ----------------------------------------------------

test('isWindowActive respects the from/to bounds', () => {
  assert.equal(isWindowActive(span, NOW()), true);
  assert.equal(isWindowActive({ from: '2026-06-01T00:00:00Z', to: '2026-06-01T01:00:00Z' }, NOW()), false);
});

test('createSilencer matches global / agent / location scopes', async () => {
  const global = createSilencer({ getWindows: async () => [{ id: 'g', scope: 'global', ...span }], now: NOW });
  assert.ok(await global({ hostId: 5 }));

  const agent = createSilencer({ getWindows: async () => [{ id: 'a', scope: 'agent', targetId: 5, ...span }], now: NOW });
  assert.ok(await agent({ hostId: 5 }));
  assert.equal(await agent({ hostId: 6 }), null);

  const loc = createSilencer({ getWindows: async () => [{ id: 'l', scope: 'location', targetId: 2, ...span }], getAgentLocationId: async (id) => (id === 5 ? 2 : 9), now: NOW });
  assert.ok(await loc({ hostId: 5 }));   // agent 5 is in location 2
  assert.equal(await loc({ hostId: 7 }), null);

  const expired = createSilencer({ getWindows: async () => [{ id: 'x', scope: 'global', from: '2026-06-01T00:00:00Z', to: '2026-06-01T01:00:00Z' }], now: NOW });
  assert.equal(await expired({ hostId: 5 }), null);
});

test('dispatcher suppresses a silenced finding (still no notification, no throttle)', async () => {
  let sent = 0;
  const channels = { email: { send: async () => { sent += 1; return { ok: true }; } } };
  const config = { enabled: true, cooldownMs: 0, channels: { email: { enabled: true, minSeverity: 'INFO' } } };
  const dispatcher = createDispatcher({ config, channels, silencer: async (f) => (String(f.hostId) === '9' ? { id: 'w1', name: 'Patch' } : null) });

  const suppressed = await dispatcher.dispatch({ hostId: '9', metric: 'cpu', kind: 'ANOMALY', severity: 'CRIT' });
  assert.equal(suppressed.dispatched, false);
  assert.equal(suppressed.reason, 'maintenance');
  assert.equal(sent, 0);

  const delivered = await dispatcher.dispatch({ hostId: '10', metric: 'cpu', kind: 'ANOMALY', severity: 'CRIT' });
  assert.equal(delivered.dispatched, true);
  assert.equal(sent, 1);
});

// ---- settings service ------------------------------------------------------

test('validateMaintenance rejects bad windows and generates missing ids', () => {
  const svc = makeSettingsService();
  assert.ok(svc.validateMaintenance({ windows: 'nope' }).errors);
  assert.ok(svc.validateMaintenance({ windows: [{ name: 'x', scope: 'agent', ...span }] }).errors); // agent needs targetId
  assert.ok(svc.validateMaintenance({ windows: [{ name: 'x', scope: 'global', from: 'bad', to: span.to }] }).errors);
  const { value } = svc.validateMaintenance({ windows: [{ name: 'Patch', scope: 'global', ...span }] });
  assert.equal(value.length, 1);
  assert.ok(value[0].id); // generated
});

// ---- route -----------------------------------------------------------------

test('PUT /api/settings/maintenance is admin-only; GET is viewer-readable (round-trip)', async () => {
  const app = makeApp();
  const win = { name: 'Patch-vindue', scope: 'global', ...span };

  const forbidden = await request(app).put('/api/settings/maintenance').set('Authorization', authHeader('operator')).send({ windows: [win] });
  assert.equal(forbidden.status, 403);

  const saved = await request(app).put('/api/settings/maintenance').set('Authorization', authHeader('admin')).send({ windows: [win] });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.windows.length, 1);
  assert.ok(saved.body.windows[0].id);

  const read = await request(app).get('/api/settings/maintenance').set('Authorization', authHeader('viewer'));
  assert.equal(read.status, 200);
  assert.equal(read.body.windows.length, 1);
  assert.equal(read.body.windows[0].name, 'Patch-vindue');
});

test('PUT /api/settings/maintenance returns 400 on an invalid window', async () => {
  const res = await request(makeApp()).put('/api/settings/maintenance').set('Authorization', authHeader('admin'))
    .send({ windows: [{ name: 'x', scope: 'agent', ...span }] }); // missing targetId
  assert.equal(res.status, 400);
});
