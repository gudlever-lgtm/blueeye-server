'use strict';

// Optional, opt-in LLM assistant. OFF by default (ANALYSIS_ASSISTANT_ENABLED).
// When enabled it answers a natural-language question about a host using ONLY a
// small, local context — the recent findings the analysis module already
// produced (each already carries a plain-language explanation). It never ships
// raw metric history, credentials, or anything beyond that compact slice to the
// provider. Uses Mistral's chat-completions API over fetch; the network call is
// injected (fetchImpl) so tests run fully offline.
//
//   const assistant = createAssistant({ config, findingStore });
//   const { answer } = await assistant.explain('hvorfor er cpu høj?', hostId);

// Thrown by explain() when the feature is disabled. The route maps the name
// 'FeatureDisabled' to HTTP 403.
class FeatureDisabledError extends Error {
  constructor(message = 'AI-assistenten er slået fra (sæt ANALYSIS_ASSISTANT_ENABLED=true for at aktivere)') {
    super(message);
    this.name = 'FeatureDisabled';
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function createAssistant({
  config = {},
  findingStore,
  fetchImpl = (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null),
  now = () => new Date(),
  logger = { info() {}, warn() {}, error() {} },
} = {}) {
  const enabled = Boolean(config.assistantEnabled);
  const apiKey = config.assistantApiKey || '';
  const model = config.assistantModel || 'mistral-small-latest';
  const baseUrl = config.assistantBaseUrl || 'https://api.mistral.ai/v1/chat/completions';
  const maxFindings = Number.isFinite(config.assistantMaxFindings) ? config.assistantMaxFindings : 20;
  const timeoutMs = Number.isFinite(config.assistantTimeoutMs) ? config.assistantTimeoutMs : 20000;

  function isEnabled() {
    return enabled;
  }

  // Compact, explainable context: only the fields the model needs, capped. No
  // raw samples or evidence payloads — just the human-readable summary.
  async function buildContext(hostId) {
    const since = new Date(now().getTime() - ONE_DAY_MS); // last 24h
    let findings = [];
    try {
      findings = await findingStore.list(hostId, since);
    } catch (err) {
      logger.warn(`assistant: could not load findings for context (${err.message})`);
      findings = [];
    }
    return (Array.isArray(findings) ? findings : []).slice(0, maxFindings).map((f) => ({
      metric: f.metric,
      severity: f.severity,
      kind: f.kind,
      observed: f.observed,
      baseline: f.baseline,
      deviation: f.deviation,
      explanation: f.explanation,
      correlatedWith: f.correlatedWith,
      at: f.createdAt,
    }));
  }

  // Answers a question about a host. Throws FeatureDisabled when off,
  // InvalidQuestion on an empty question, AssistantMisconfigured when enabled but
  // not configured, and AssistantUpstreamError when the provider call fails.
  async function explain(question, hostId) {
    if (!enabled) throw new FeatureDisabledError();

    if (typeof question !== 'string' || question.trim() === '') {
      const e = new Error('question must be a non-empty string');
      e.name = 'InvalidQuestion';
      throw e;
    }
    if (!apiKey) {
      const e = new Error('assistant is enabled but no API key is configured (ANALYSIS_ASSISTANT_API_KEY)');
      e.name = 'AssistantMisconfigured';
      throw e;
    }
    if (typeof fetchImpl !== 'function') {
      const e = new Error('assistant has no fetch implementation available');
      e.name = 'AssistantMisconfigured';
      throw e;
    }

    const findings = await buildContext(hostId);
    const system =
      'Du er en hjælpsom netværks- og driftsassistent for BlueEye. Svar kort og ' +
      'konkret på dansk. Brug KUN den medsendte kontekst (findings) — gæt ikke, og ' +
      'hvis konteksten ikke rækker, så sig det.';
    const user = JSON.stringify({ question: question.trim(), hostId: hostId ?? null, findings });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetchImpl(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.2,
          max_tokens: 500,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const e = new Error(`assistant request failed: ${err.message}`);
      e.name = 'AssistantUpstreamError';
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (!res || !res.ok) {
      const e = new Error(`assistant provider returned status ${res ? res.status : 'none'}`);
      e.name = 'AssistantUpstreamError';
      throw e;
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      const e = new Error('assistant provider returned a non-JSON body');
      e.name = 'AssistantUpstreamError';
      throw e;
    }

    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const content = choice && choice.message ? choice.message.content : '';
    return {
      answer: typeof content === 'string' ? content.trim() : '',
      model,
      usedFindings: findings.length,
    };
  }

  return { isEnabled, explain, buildContext };
}

module.exports = { createAssistant, FeatureDisabledError };
