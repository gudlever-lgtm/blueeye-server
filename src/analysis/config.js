'use strict';

// Analysis-module configuration. Reads overrides from the same mechanism the
// server already uses — environment variables (loaded via dotenv in
// src/config.js, which runs at startup) — rather than introducing a new config
// style. loadConfig() returns a fresh object so tests can stub process.env.

function toNum(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

const { inferProvider } = require('./assistantProviders');

function loadConfig(env = process.env) {
  return {
    analysisEnabled: toBool(env.ANALYSIS_ENABLED, true),
    assistantEnabled: toBool(env.ANALYSIS_ASSISTANT_ENABLED, false),
    critSigma: toNum(env.ANALYSIS_CRIT_SIGMA, 4.0),
    warnSigma: toNum(env.ANALYSIS_WARN_SIGMA, 3.0),
    baselineDays: toInt(env.ANALYSIS_BASELINE_DAYS, 7),
    minSamples: toInt(env.ANALYSIS_MIN_SAMPLES, 200),

    // AI assistant (opt-in, off by default). Speaks the OpenAI-compatible
    // chat-completions API; the provider defaults to Mistral (EU) but can be
    // switched to another EU / self-hosted endpoint. The key is never logged or
    // sent anywhere but the provider. When ANALYSIS_ASSISTANT_PROVIDER is unset it
    // is inferred from the base URL (a preset match, else 'custom'), so existing
    // env-only installs keep working. All of these are runtime-overridable from
    // Settings → Analysis → AI assistant.
    assistantProvider: env.ANALYSIS_ASSISTANT_PROVIDER || inferProvider(env.ANALYSIS_ASSISTANT_URL || ''),
    assistantApiKey: env.ANALYSIS_ASSISTANT_API_KEY || env.MISTRAL_API_KEY || '',
    assistantModel: env.ANALYSIS_ASSISTANT_MODEL || 'mistral-small-latest',
    assistantBaseUrl: env.ANALYSIS_ASSISTANT_URL || 'https://api.mistral.ai/v1/chat/completions',
    assistantMaxFindings: toInt(env.ANALYSIS_ASSISTANT_MAX_FINDINGS, 20),
    assistantTimeoutMs: toInt(env.ANALYSIS_ASSISTANT_TIMEOUT_MS, 20000),
  };
}

module.exports = { loadConfig };
