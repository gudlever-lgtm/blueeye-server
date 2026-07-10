'use strict';

// OpenAI-compatible chat-completions providers the AI assistant can call.
// The assistant speaks the OpenAI `/v1/chat/completions` shape, which Mistral,
// Scaleway, OpenAI, Anthropic, Gemini, Groq, OpenRouter, Ollama and most
// self-hosted runtimes (vLLM, LocalAI, LM Studio, …) all implement — so
// switching provider is just a base URL + model + key change.
//
// Which LLM to use is the ADMIN's decision, not a product constraint: the
// no-US-vendor rule in CLAUDE.md governs BlueEye's own dependencies (map tiles,
// GeoIP, geocoder, fonts), not where an admin chooses to send the assistant's
// context. The assistant only ever sends metadata-derived summaries (never raw
// data or payload), so the choice is about data residency preference. Each
// preset therefore carries a `region` hint (EU / US / self-hosted) so an admin
// who cares can choose accordingly — but no option is blocked. Default is
// Mistral (EU). The special `custom` provider ("Other") points the assistant at
// ANY other OpenAI-compatible endpoint (e.g. an Azure or self-hosted deployment).

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_PROVIDER_ID = 'mistral';
const DEFAULT_MODEL = 'mistral-small-latest';

const PROVIDERS = [
  { id: 'mistral', label: 'Mistral AI (EU)', region: 'EU', baseUrl: MISTRAL_URL, defaultModel: DEFAULT_MODEL, keyRequired: true, custom: false },
  { id: 'scaleway', label: 'Scaleway AI (EU, France)', region: 'EU', baseUrl: 'https://api.scaleway.ai/v1/chat/completions', defaultModel: 'mistral-nemo-instruct-2407', keyRequired: true, custom: false },
  { id: 'openai', label: 'OpenAI (US)', region: 'US', baseUrl: 'https://api.openai.com/v1/chat/completions', defaultModel: 'gpt-4o-mini', keyRequired: true, custom: false },
  { id: 'anthropic', label: 'Anthropic · Claude (US)', region: 'US', baseUrl: 'https://api.anthropic.com/v1/chat/completions', defaultModel: 'claude-3-5-haiku-latest', keyRequired: true, custom: false },
  { id: 'gemini', label: 'Google Gemini (US)', region: 'US', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', defaultModel: 'gemini-1.5-flash', keyRequired: true, custom: false },
  { id: 'groq', label: 'Groq (US)', region: 'US', baseUrl: 'https://api.groq.com/openai/v1/chat/completions', defaultModel: 'llama-3.3-70b-versatile', keyRequired: true, custom: false },
  { id: 'openrouter', label: 'OpenRouter (US, aggregator)', region: 'US', baseUrl: 'https://openrouter.ai/api/v1/chat/completions', defaultModel: 'openai/gpt-4o-mini', keyRequired: true, custom: false },
  { id: 'ollama', label: 'Ollama (self-hosted)', region: 'self-hosted', baseUrl: 'http://localhost:11434/v1/chat/completions', defaultModel: 'llama3.1', keyRequired: false, custom: false },
  { id: 'custom', label: 'Other (custom endpoint)', region: 'any', baseUrl: '', defaultModel: '', keyRequired: false, custom: true },
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
    id: p.id, label: p.label, region: p.region, baseUrl: p.baseUrl, defaultModel: p.defaultModel, keyRequired: p.keyRequired, custom: p.custom,
  }));
}

module.exports = {
  PROVIDERS, DEFAULT_PROVIDER_ID, DEFAULT_MODEL,
  getProvider, isProviderId, resolveBaseUrl, defaultModel, inferProvider, listProvidersSafe,
};
