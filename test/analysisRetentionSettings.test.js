'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createSettingsService } = require('../src/services/settings');
const { makeApp, makeSettingsService, authHeader } = require('../test-support/fakes');

function memRepo(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); return v; } };
}
const cfg = { geo: { tileUrl: 'https://t/{z}/{x}/{y}.png', tileAttribution: 'a', tileMaxZoom: 19, geocodeUrl: '' } };

// ---- service: live-apply + validation -------------------------------------

test('setAnalysis live-applies to the shared config and leaves secrets alone', async () => {
  const liveAnalysis = { analysisEnabled: true, critSigma: 4, warnSigma: 3, baselineDays: 7, minSamples: 200, assistantApiKey: 'secret' };
  const svc = createSettingsService({ settingsRepo: memRepo(), config: cfg, liveAnalysis });
  assert.equal((await svc.getAnalysis()).critSigma, 4);
  const saved = await svc.setAnalysis({ critSigma: 6, warnSigma: 2.5, analysisEnabled: false });
  assert.equal(saved.critSigma, 6);
  assert.equal(liveAnalysis.critSigma, 6);       // live-applied (detector reads lazily)
  assert.equal(liveAnalysis.warnSigma, 2.5);
  assert.equal(liveAnalysis.analysisEnabled, false);
  assert.equal(liveAnalysis.assistantApiKey, 'secret'); // untouched
});

test('setAnalysis rejects out-of-range / non-integer values', async () => {
  const svc = createSettingsService({ settingsRepo: memRepo(), config: cfg });
  await assert.rejects(() => svc.setAnalysis({ critSigma: 99 }), (e) => e.statusCode === 400);
  await assert.rejects(() => svc.setAnalysis({ baselineDays: 1.5 }), (e) => e.statusCode === 400);
  await assert.rejects(() => svc.setAnalysis({ minSamples: 1 }), (e) => e.statusCode === 400);
});

test('setRetention live-applies windows + enable toggle, keeps cadence', async () => {
  const liveRetention = { enabled: true, rawRetentionDays: 7, rollupRetentionDays: 90, findingRetentionDays: 365, rollupIntervalMinutes: 60 };
  const svc = createSettingsService({ settingsRepo: memRepo(), config: cfg, liveRetention });
  const saved = await svc.setRetention({ rawRetentionDays: 14, enabled: false });
  assert.equal(saved.rawRetentionDays, 14);
  assert.equal(liveRetention.rawRetentionDays, 14);
  assert.equal(liveRetention.enabled, false);
  assert.equal(liveRetention.rollupIntervalMinutes, 60); // cadence not editable here
});

test('applyStoredOverrides re-applies persisted edits at boot', async () => {
  const repo = memRepo({ analysis: { critSigma: 5 }, retention: { rawRetentionDays: 30 } });
  const liveAnalysis = { critSigma: 4 };
  const liveRetention = { rawRetentionDays: 7 };
  const svc = createSettingsService({ settingsRepo: repo, config: cfg, liveAnalysis, liveRetention });
  await svc.applyStoredOverrides();
  assert.equal(liveAnalysis.critSigma, 5);
  assert.equal(liveRetention.rawRetentionDays, 30);
});

// ---- route ----------------------------------------------------------------

test('PUT /api/settings/analysis saves (admin) and GET reflects it', async () => {
  const app = makeApp({ settingsService: makeSettingsService() });
  const put = await request(app).put('/api/settings/analysis').set('Authorization', authHeader('admin')).send({ critSigma: 6.5 });
  assert.equal(put.status, 200);
  assert.equal(put.body.analysis.critSigma, 6.5);
  const get = await request(app).get('/api/settings').set('Authorization', authHeader('admin'));
  assert.equal(get.body.analysis.critSigma, 6.5);
});

test('PUT /api/settings/analysis validates (400) and is admin-only (403)', async () => {
  assert.equal((await request(makeApp()).put('/api/settings/analysis').set('Authorization', authHeader('admin')).send({ critSigma: 0 })).status, 400);
  assert.equal((await request(makeApp()).put('/api/settings/analysis').set('Authorization', authHeader('viewer')).send({ critSigma: 5 })).status, 403);
});

test('PUT /api/settings/retention saves (admin) and validates', async () => {
  const app = makeApp({ settingsService: makeSettingsService() });
  const put = await request(app).put('/api/settings/retention').set('Authorization', authHeader('admin')).send({ rawRetentionDays: 21, enabled: false });
  assert.equal(put.status, 200);
  assert.equal(put.body.retention.rawRetentionDays, 21);
  assert.equal(put.body.retention.enabled, false);
  assert.equal((await request(makeApp()).put('/api/settings/retention').set('Authorization', authHeader('admin')).send({ rawRetentionDays: 0 })).status, 400);
});
