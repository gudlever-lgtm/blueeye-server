'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVIDERS, getProvider, isProviderId, resolveBaseUrl, defaultModel, inferProvider, listProvidersSafe,
} = require('../src/analysis/assistantProviders');

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

test('the catalog offers Mistral (default) plus other EU / self-hosted options and a custom one', () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.ok(ids.includes('mistral'));
  assert.ok(ids.length >= 3); // a real "selection of others"
  const custom = PROVIDERS.find((p) => p.custom);
  assert.ok(custom, 'a custom ("Other") provider must exist');
  assert.equal(custom.baseUrl, ''); // admin supplies it
  // No US vendor presets (policy): no openai/azure/anthropic/google endpoints.
  assert.ok(!PROVIDERS.some((p) => /openai\.com|azure|anthropic|googleapis/.test(p.baseUrl || '')));
});

test('isProviderId / getProvider', () => {
  assert.ok(isProviderId('mistral'));
  assert.ok(!isProviderId('openai'));
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
  assert.equal(inferProvider('https://llm.internal/v1/chat'), 'custom');
  assert.equal(inferProvider(''), 'mistral'); // nothing configured -> default
});

test('listProvidersSafe carries no secrets and every entry is renderable', () => {
  const list = listProvidersSafe();
  for (const p of list) {
    assert.ok(p.id && p.label);
    assert.equal(typeof p.custom, 'boolean');
    assert.equal(typeof p.keyRequired, 'boolean');
  }
});
