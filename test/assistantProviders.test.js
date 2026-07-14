'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVIDERS, getProvider, isProviderId, resolveBaseUrl, defaultModel, inferProvider, listProvidersSafe,
} = require('../src/analysis/assistantProviders');

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

test('the catalog offers Mistral (default) plus a broad selection and a custom one', () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.ok(ids.includes('mistral'));
  assert.equal(PROVIDERS[0].id, 'mistral'); // default sits first
  assert.ok(ids.length >= 5); // a real "selection of others"
  const custom = PROVIDERS.find((p) => p.custom);
  assert.ok(custom, 'a custom ("Other") provider must exist');
  assert.equal(custom.baseUrl, ''); // admin supplies it
  // The choice is the admin's: both EU and US presets are offered (no US block).
  assert.ok(PROVIDERS.some((p) => p.region === 'EU'));
  assert.ok(PROVIDERS.some((p) => p.region === 'US'));
  assert.ok(PROVIDERS.some((p) => p.region === 'self-hosted'));
  // Every preset carries a region hint so an admin can weigh data residency.
  for (const p of PROVIDERS) assert.ok(p.region, `${p.id} must declare a region`);
});

test('the catalog includes the EU + additional presets we advertise', () => {
  const ids = PROVIDERS.map((p) => p.id);
  for (const id of ['ovhcloud', 'ionos', 'alephalpha', 'together', 'deepseek', 'azure']) {
    assert.ok(ids.includes(id), `expected provider ${id}`);
  }
  // The three added EU presets are region EU with a fixed https endpoint + a model.
  for (const id of ['ovhcloud', 'ionos', 'alephalpha']) {
    const p = getProvider(id);
    assert.equal(p.region, 'EU');
    assert.match(p.baseUrl, /^https:\/\//);
    assert.ok(p.defaultModel);
  }
  // Azure has no fixed endpoint — it behaves like a custom provider (admin URL).
  const azure = getProvider('azure');
  assert.equal(azure.custom, true);
  assert.equal(azure.baseUrl, '');
  assert.equal(resolveBaseUrl('azure', 'https://my.openai.azure.com/…'), 'https://my.openai.azure.com/…');
});

test('isProviderId / getProvider', () => {
  assert.ok(isProviderId('mistral'));
  assert.ok(isProviderId('openai'));
  assert.ok(!isProviderId('not-a-provider'));
  assert.ok(!isProviderId(''));
  assert.equal(getProvider('mistral').keyRequired, true);
  assert.equal(getProvider('ollama').keyRequired, false);
  assert.equal(getProvider('nope'), null);
});

test('resolveBaseUrl: presets use their endpoint; custom uses the supplied URL', () => {
  assert.equal(resolveBaseUrl('mistral', 'ignored'), MISTRAL_URL);
  assert.equal(resolveBaseUrl('ollama'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(resolveBaseUrl('custom', 'https://llm.eu/v1/chat'), 'https://llm.eu/v1/chat');
  assert.equal(resolveBaseUrl('custom', ''), MISTRAL_URL); // safe fallback
  assert.equal(resolveBaseUrl('unknown', ''), MISTRAL_URL);
});

test('defaultModel falls back per provider', () => {
  assert.equal(defaultModel('mistral'), 'mistral-small-latest');
  assert.equal(defaultModel('ollama'), 'llama3.1');
  assert.equal(defaultModel('nope'), 'mistral-small-latest');
});

test('inferProvider matches known endpoints, else custom', () => {
  assert.equal(inferProvider(MISTRAL_URL), 'mistral');
  assert.equal(inferProvider('http://localhost:11434/v1/chat/completions'), 'ollama');
  assert.equal(inferProvider('https://api.openai.com/v1/chat/completions'), 'openai');
  assert.equal(inferProvider('https://llm.internal/v1/chat'), 'custom');
  assert.equal(inferProvider(''), 'mistral'); // nothing configured -> default
});

test('listProvidersSafe carries no secrets and every entry is renderable', () => {
  const list = listProvidersSafe();
  for (const p of list) {
    assert.ok(p.id && p.label && p.region);
    assert.equal(typeof p.custom, 'boolean');
    assert.equal(typeof p.keyRequired, 'boolean');
  }
});
