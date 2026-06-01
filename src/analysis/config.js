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

function loadConfig(env = process.env) {
  return {
    analysisEnabled: toBool(env.ANALYSIS_ENABLED, true),
    assistantEnabled: toBool(env.ANALYSIS_ASSISTANT_ENABLED, false),
    critSigma: toNum(env.ANALYSIS_CRIT_SIGMA, 4.0),
    warnSigma: toNum(env.ANALYSIS_WARN_SIGMA, 3.0),
    baselineDays: toInt(env.ANALYSIS_BASELINE_DAYS, 7),
    minSamples: toInt(env.ANALYSIS_MIN_SAMPLES, 200),
  };
}

module.exports = { loadConfig };
