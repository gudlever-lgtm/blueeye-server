'use strict';

// OpenAI-compatible chat-completions providers the AI assistant can call.
// Every option must be EU-hosted or self-hosted (see CLAUDE.md: no US vendors).
// The assistant speaks the OpenAI `/v1/chat/completions` shape, which Mistral,
// Scaleway, Ollama and most self-hosted runtimes (vLLM, LocalAI, LM Studio, …)
// all implement — so switching provider is just a base URL + model + key change.
//
// Each preset carries its endpoint and a sensible default model. The special
// `custom` provider ("Other") lets an admin point the assistant at ANY other
// OpenAI-compatible endpoint by supplying the base URL themselves — keep it
// EU-hosted or self-hosted.

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_PROVIDER_ID = 'mistral';
const DEFAULT_MODEL = 'mistral-small-latest';

const PROVIDERS = [
  { id: 'mistral', label: 'Mistral AI (EU)', baseUrl: MISTRAL_URL, defaultModel: DEFAULT_MODEL, keyRequired: true, custom: false },
  { id: 'scaleway', label: 'Scaleway AI (EU, France)', baseUrl: 'https://api.scaleway.ai/v1/chat/completions', defaultModel: 'mistral-nemo-instruct-2407', keyRequired: true, custom: false },
  { id: 'ollama', label: 'Ollama (self-hosted)', baseUrl: 'http://localhost:11434/v1/chat/completions', defaultModel: 'llama3.1', keyRequired: false, custom: false },
  { id: 'custom', label: 'Other (custom endpoint)', baseUrl: '', defaultModel: '', keyRequired: false, custom: true },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

function getProvider(id) {
  return BY_ID.get(String(id || '')) || null;
}

function isProviderId(id) {
  return BY_ID.has(String(id || ''));
}

// Effective chat-completions URL for a provider. A non-custom preset always uses
// its fixed endpoint; the custom provider uses the admin-supplied URL. Falls back
// to Mistral when nothing usable is configured.
function resolveBaseUrl(providerId, customBaseUrl) {
  const p = getProvider(providerId);
  if (p && !p.custom && p.baseUrl) return p.baseUrl;
  const u = typeof customBaseUrl === 'string' ? customBaseUrl.trim() : '';
  return u || MISTRAL_URL;
}

// Default model for a provider (used when no model is configured).
function defaultModel(providerId) {
  const p = getProvider(providerId);
  return (p && p.defaultModel) || DEFAULT_MODEL;
}

// Infer a provider id from a base URL — backward compatibility for env-only
// installs that set ANALYSIS_ASSISTANT_URL without a provider: match a known
// preset endpoint, otherwise treat the URL as a `custom` provider so the
// configured URL is honoured rather than silently overridden.
function inferProvider(baseUrl) {
  const u = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (!u) return DEFAULT_PROVIDER_ID;
  for (const p of PROVIDERS) {
    if (!p.custom && p.baseUrl && p.baseUrl === u) return p.id;
  }
  return 'custom';
}

// Non-secret catalog for the dashboard's provider dropdown.
function listProvidersSafe() {
  return PROVIDERS.map((p) => ({
    id: p.id, label: p.label, baseUrl: p.baseUrl, defaultModel: p.defaultModel, keyRequired: p.keyRequired, custom: p.custom,
  }));
}

module.exports = {
  PROVIDERS, DEFAULT_PROVIDER_ID, DEFAULT_MODEL,
  getProvider, isProviderId, resolveBaseUrl, defaultModel, inferProvider, listProvidersSafe,
};
