'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createSettingsService } = require('../src/services/settings');
const { createAssistant } = require('../src/analysis/assistant');
const { listProvidersSafe } = require('../src/analysis/assistantProviders');
const { makeApp, makeSettingsService, authHeader } = require('../test-support/fakes');

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

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
  assert.deepEqual(safe, {
    enabled: true, provider: 'mistral', model: 'mistral-small-latest', baseUrl: MISTRAL_URL,
    apiKeySet: true, apiKeyHint: '••••1234', providers: listProvidersSafe(),
  });
  assert.equal(safe.apiKey, undefined); // never exposed

  const full = await svc.getAssistant();
  assert.equal(full.apiKey, 'sk-abcdef1234'); // server-internal getter keeps it
});

test('setAssistant persists, live-applies onto the analysis config, and returns the redacted view', async () => {
  const liveAnalysis = { assistantEnabled: false, assistantApiKey: '', assistantModel: 'mistral-small-latest' };
  const repo = memRepo();
  const svc = createSettingsService({ settingsRepo: repo, config: cfg, liveAnalysis });

  const out = await svc.setAssistant({ enabled: true, apiKey: 'sk-LIVE-9999', model: 'mistral-large-latest' });
  assert.deepEqual(out, {
    enabled: true, provider: 'mistral', model: 'mistral-large-latest', baseUrl: MISTRAL_URL,
    apiKeySet: true, apiKeyHint: '••••9999',
  });
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

test('setAssistant switches to a preset provider and reports its endpoint + default model', async () => {
  const liveAnalysis = { assistantEnabled: true, assistantApiKey: 'sk-x', assistantModel: 'mistral-small-latest' };
  const repo = memRepo();
  const svc = createSettingsService({ settingsRepo: repo, config: cfg, liveAnalysis });

  const out = await svc.setAssistant({ provider: 'ollama', model: 'llama3.1' });
  assert.equal(out.provider, 'ollama');
  assert.equal(out.baseUrl, 'http://localhost:11434/v1/chat/completions');
  assert.equal(liveAnalysis.assistantProvider, 'ollama');
  // A preset stores no custom base URL; the effective URL is derived from the preset.
  assert.equal((await repo.get('assistant')).baseUrl, '');
});

test('setAssistant: custom provider requires a base URL and round-trips it', async () => {
  const liveAnalysis = { assistantEnabled: true, assistantApiKey: 'sk-x', assistantModel: 'm' };
  const svc = createSettingsService({ settingsRepo: memRepo(), config: cfg, liveAnalysis });

  await assert.rejects(() => svc.setAssistant({ provider: 'custom' }), (e) => e.statusCode === 400 && Boolean(e.details.baseUrl));

  const out = await svc.setAssistant({ provider: 'custom', baseUrl: 'https://llm.example.eu/v1/chat/completions', model: 'my-model' });
  assert.equal(out.provider, 'custom');
  assert.equal(out.baseUrl, 'https://llm.example.eu/v1/chat/completions');
  assert.equal(liveAnalysis.assistantBaseUrl, 'https://llm.example.eu/v1/chat/completions');
});

test('validateAssistant rejects an unknown provider and a malformed base URL', async () => {
  const svc = createSettingsService({ settingsRepo: memRepo(), config: cfg, liveAnalysis: {} });
  await assert.rejects(() => svc.setAssistant({ provider: 'openai' }), (e) => e.statusCode === 400 && Boolean(e.details.provider));
  await assert.rejects(() => svc.setAssistant({ provider: 'custom', baseUrl: 'not-a-url' }), (e) => e.statusCode === 400 && Boolean(e.details.baseUrl));
});

test('getAssistantSafe exposes the provider catalog for the dashboard dropdown', async () => {
  const svc = createSettingsService({ settingsRepo: memRepo(), config: cfg, liveAnalysis: {} });
  const safe = await svc.getAssistantSafe();
  assert.ok(Array.isArray(safe.providers) && safe.providers.length >= 2);
  assert.ok(safe.providers.some((p) => p.id === 'mistral'));
  assert.ok(safe.providers.some((p) => p.id === 'custom' && p.custom === true));
});

// ---- settings route --------------------------------------------------------

test('PUT /api/settings/assistant saves (admin); GET reflects it; the key is never echoed', async () => {
  const app = makeApp({ settingsService: makeSettingsService() });
  const put = await request(app).put('/api/settings/assistant').set('Authorization', authHeader('admin'))
    .send({ enabled: true, apiKey: 'sk-route-4242', model: 'mistral-large-latest' });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.assistant, {
    enabled: true, provider: 'mistral', model: 'mistral-large-latest', baseUrl: MISTRAL_URL,
    apiKeySet: true, apiKeyHint: '••••4242',
  });
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

test('assistant honours a runtime provider switch: URL + key handling follow the provider', async () => {
  const config = { assistantEnabled: true, assistantProvider: 'mistral', assistantApiKey: 'sk-1', assistantModel: 'mistral-small-latest' };
  const captured = {};
  const assistant = createAssistant({ config, findingStore: { list: async () => [] }, fetchImpl: fakeFetchOk(captured) });

  await assistant.explain('why?', '1');
  assert.equal(captured.url, 'https://api.mistral.ai/v1/chat/completions'); // preset endpoint

  // Switch to a self-hosted provider that needs no key: even with the key cleared
  // the call goes through (no Authorization header) to the provider's endpoint.
  config.assistantProvider = 'ollama';
  config.assistantApiKey = '';
  config.assistantModel = 'llama3.1';
  await assistant.explain('why?', '1');
  assert.equal(captured.url, 'http://localhost:11434/v1/chat/completions');

  // Switch to a custom endpoint: the configured base URL is used verbatim.
  config.assistantProvider = 'custom';
  config.assistantBaseUrl = 'https://llm.example.eu/v1/chat/completions';
  await assistant.explain('why?', '1');
  assert.equal(captured.url, 'https://llm.example.eu/v1/chat/completions');
});
