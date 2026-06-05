'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createSettingsService } = require('../src/services/settings');
const { createAssistant } = require('../src/analysis/assistant');
const { makeApp, makeSettingsService, authHeader } = require('../test-support/fakes');

function memRepo(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); return v; } };
}
const cfg = { geo: { tileUrl: 'https://t/{z}/{x}/{y}.png', tileAttribution: 'a', tileMaxZoom: 19, geocodeUrl: '' } };

// ---- settings service: assistant config (secret-safe) ----------------------

test('getAssistantSafe redacts the key; getAssistant keeps it for internal use', async () => {
  const liveAnalysis = { assistantEnabled: true, assistantApiKey: 'sk-abcdef1234', assistantModel: 'mistral-small-latest' };
  const svc = createSettingsService({ settingsRepo: memRepo(), config: cfg, liveAnalysis });

  const safe = await svc.getAssistantSafe();
  assert.deepEqual(safe, { enabled: true, model: 'mistral-small-latest', apiKeySet: true, apiKeyHint: '••••1234' });
  assert.equal(safe.apiKey, undefined); // never exposed

  const full = await svc.getAssistant();
  assert.equal(full.apiKey, 'sk-abcdef1234'); // server-internal getter keeps it
});

test('setAssistant persists, live-applies onto the analysis config, and returns the redacted view', async () => {
  const liveAnalysis = { assistantEnabled: false, assistantApiKey: '', assistantModel: 'mistral-small-latest' };
  const repo = memRepo();
  const svc = createSettingsService({ settingsRepo: repo, config: cfg, liveAnalysis });

  const out = await svc.setAssistant({ enabled: true, apiKey: 'sk-LIVE-9999', model: 'mistral-large-latest' });
  assert.deepEqual(out, { enabled: true, model: 'mistral-large-latest', apiKeySet: true, apiKeyHint: '••••9999' });
  // Live-applied so the running assistant (which reads this object) sees it.
  assert.equal(liveAnalysis.assistantEnabled, true);
  assert.equal(liveAnalysis.assistantApiKey, 'sk-LIVE-9999');
  assert.equal(liveAnalysis.assistantModel, 'mistral-large-latest');
  // Persisted under the 'assistant' key.
  assert.equal((await repo.get('assistant')).apiKey, 'sk-LIVE-9999');
});

test('setAssistant: blank apiKey keeps the key, clearApiKey removes it', async () => {
  const liveAnalysis = { assistantEnabled: true, assistantApiKey: 'keepme-7777', assistantModel: 'mistral-small-latest' };
  const svc = createSettingsService({ settingsRepo: memRepo(), config: cfg, liveAnalysis });

  // Saving the form without retyping the key (blank) must not wipe it.
  let out = await svc.setAssistant({ enabled: false, apiKey: '' });
  assert.equal(out.apiKeySet, true);
  assert.equal(out.apiKeyHint, '••••7777');
  assert.equal(liveAnalysis.assistantApiKey, 'keepme-7777');

  // Explicit clear removes it.
  out = await svc.setAssistant({ clearApiKey: true });
  assert.equal(out.apiKeySet, false);
  assert.equal(out.apiKeyHint, '');
  assert.equal(liveAnalysis.assistantApiKey, '');
});

test('validateAssistant rejects a malformed model', async () => {
  const svc = createSettingsService({ settingsRepo: memRepo(), config: cfg, liveAnalysis: {} });
  await assert.rejects(() => svc.setAssistant({ model: 'bad model!' }), (e) => e.statusCode === 400 && Boolean(e.details.model));
  await assert.rejects(() => svc.setAssistant({ model: '' }), (e) => e.statusCode === 400);
});

test('applyStoredOverrides re-applies the assistant override onto the live config at boot', async () => {
  const repo = memRepo({ assistant: { enabled: true, apiKey: 'boot-key-0001', model: 'mistral-medium' } });
  const liveAnalysis = { assistantEnabled: false, assistantApiKey: '', assistantModel: 'mistral-small-latest' };
  const svc = createSettingsService({ settingsRepo: repo, config: cfg, liveAnalysis });
  await svc.applyStoredOverrides();
  assert.equal(liveAnalysis.assistantEnabled, true);
  assert.equal(liveAnalysis.assistantApiKey, 'boot-key-0001');
  assert.equal(liveAnalysis.assistantModel, 'mistral-medium');
});

// ---- settings route --------------------------------------------------------

test('PUT /api/settings/assistant saves (admin); GET reflects it; the key is never echoed', async () => {
  const app = makeApp({ settingsService: makeSettingsService() });
  const put = await request(app).put('/api/settings/assistant').set('Authorization', authHeader('admin'))
    .send({ enabled: true, apiKey: 'sk-route-4242', model: 'mistral-large-latest' });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.assistant, { enabled: true, model: 'mistral-large-latest', apiKeySet: true, apiKeyHint: '••••4242' });
  assert.ok(!JSON.stringify(put.body).includes('sk-route-4242')); // raw key never returned

  const get = await request(app).get('/api/settings').set('Authorization', authHeader('admin'));
  assert.equal(get.body.assistant.enabled, true);
  assert.equal(get.body.assistant.apiKeySet, true);
  assert.equal(get.body.assistant.apiKey, undefined);
});

test('PUT /api/settings/assistant validates (400) and is admin-only (403)', async () => {
  assert.equal((await request(makeApp()).put('/api/settings/assistant').set('Authorization', authHeader('admin')).send({ model: 'no spaces!' })).status, 400);
  assert.equal((await request(makeApp()).put('/api/settings/assistant').set('Authorization', authHeader('viewer')).send({ enabled: true })).status, 403);
  assert.equal((await request(makeApp()).put('/api/settings/assistant').send({ enabled: true })).status, 401);
});

// ---- assistant module: reads enable/key/model live from config -------------

function fakeFetchOk(captured) {
  return async (url, opts) => {
    captured.url = url;
    captured.body = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hello' } }] }) };
  };
}

test('assistant honours runtime config changes (enable + key + model) without rebuild', async () => {
  const config = { assistantEnabled: false, assistantApiKey: '', assistantModel: 'mistral-small-latest' };
  const captured = {};
  const assistant = createAssistant({
    config,
    findingStore: { list: async () => [] },
    fetchImpl: fakeFetchOk(captured),
  });

  // Off by default.
  assert.equal(assistant.isEnabled(), false);
  await assert.rejects(() => assistant.explain('why?', '1'), (e) => e.name === 'FeatureDisabled');

  // Enable at runtime, but no key yet -> misconfigured.
  config.assistantEnabled = true;
  assert.equal(assistant.isEnabled(), true);
  await assert.rejects(() => assistant.explain('why?', '1'), (e) => e.name === 'AssistantMisconfigured');

  // Provide a key + a different model at runtime -> works, and uses them.
  config.assistantApiKey = 'sk-runtime';
  config.assistantModel = 'mistral-large-latest';
  const res = await assistant.explain('why?', '1');
  assert.equal(res.answer, 'hello');
  assert.equal(res.model, 'mistral-large-latest');
  assert.equal(captured.body.model, 'mistral-large-latest');
});
