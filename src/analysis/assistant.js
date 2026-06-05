'use strict';

const { computeAgentHealth } = require('../health/probeHealth');

// Optional, opt-in LLM assistant. OFF by default (ANALYSIS_ASSISTANT_ENABLED).
// When enabled it answers questions / summarizes a location using ONLY a small,
// local context the analysis module already produced — recent findings (each
// already carrying a plain-language explanation) plus, for a location summary,
// each agent's status + probe-health verdict. It never ships raw metric history,
// credentials, or payload to the provider. Uses Mistral's (EU) chat-completions
// API over fetch; the network call is injected (fetchImpl) so tests run offline.
//
//   const assistant = createAssistant({ config, findingStore, agentsRepo, locationsRepo, probeResultsRepo });
//   const { answer } = await assistant.explain('why is cpu high?', hostId);
//   const { answer } = await assistant.summarizeLocation(locationId);

// Thrown by explain()/summarizeLocation() when the feature is disabled. The route
// maps the name 'FeatureDisabled' to HTTP 403.
class FeatureDisabledError extends Error {
  constructor(message = 'The AI assistant is disabled (set ANALYSIS_ASSISTANT_ENABLED=true to enable)') {
    super(message);
    this.name = 'FeatureDisabled';
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function createAssistant({
  config = {},
  findingStore,
  agentsRepo = null,
  locationsRepo = null,
  probeResultsRepo = null,
  agentHealth = computeAgentHealth,
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

  // Compact, explainable per-host context: only the fields the model needs,
  // capped. No raw samples or evidence payloads — just the human-readable summary.
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

  // The agent's recent probe-health verdict ({ status, reason }) or null when
  // there is no probe data / no repo wired. Cheap + explainable (median+MAD).
  async function probeVerdict(agentId) {
    if (!probeResultsRepo || typeof probeResultsRepo.findByAgent !== 'function') return null;
    try {
      const since = new Date(now().getTime() - ONE_DAY_MS);
      const asc = await probeResultsRepo.findByAgent({ agentId, from: since, limit: 500 });
      const rows = Array.isArray(asc) ? asc.slice().reverse() : []; // newest-first
      if (!rows.length) return null;
      const h = agentHealth(rows, { now: now().getTime() });
      return { status: h.status, reason: h.reason };
    } catch (err) {
      logger.warn(`assistant: could not load probe health for ${agentId} (${err.message})`);
      return null;
    }
  }

  // Compact per-location context: the location, each of its agents (status +
  // probe-health verdict + recent findings), and roll-up counts. Throws
  // LocationNotFound (route -> 404) for an unknown location.
  async function buildLocationContext(locationId) {
    const location = await locationsRepo.findById(locationId);
    if (!location) {
      const e = new Error('location not found');
      e.name = 'LocationNotFound';
      throw e;
    }
    const all = await agentsRepo.findAll();
    const agents = (Array.isArray(all) ? all : []).filter((a) => String(a.location_id) === String(locationId));
    const since = new Date(now().getTime() - ONE_DAY_MS);

    const agentCtx = [];
    let online = 0;
    let withFindings = 0;
    let findingTotal = 0;
    for (const a of agents) {
      if (a.status === 'online') online += 1;
      let findings = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        findings = await findingStore.list(String(a.id), since);
      } catch {
        findings = [];
      }
      const compact = (Array.isArray(findings) ? findings : []).slice(0, maxFindings).map((f) => ({
        metric: f.metric, severity: f.severity, explanation: f.explanation, at: f.createdAt,
      }));
      if (compact.length) { withFindings += 1; findingTotal += compact.length; }
      // eslint-disable-next-line no-await-in-loop
      const health = await probeVerdict(a.id);
      agentCtx.push({ name: a.display_name || a.hostname, status: a.status, health, findings: compact });
    }

    const context = {
      location: { id: location.id, name: location.name },
      agents: agentCtx,
      counts: { agents: agents.length, online, withFindings },
    };
    return { context, location, agentCount: agents.length, findingCount: findingTotal };
  }

  // Single chat-completion call shared by explain()/summarizeLocation(). Throws
  // AssistantMisconfigured (enabled but not configured) and AssistantUpstreamError
  // (provider call failed). Returns the answer string.
  async function chat(system, user) {
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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
    return typeof content === 'string' ? content.trim() : '';
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

    const findings = await buildContext(hostId);
    const system =
      'You are a helpful network and operations assistant for BlueEye. Answer briefly and ' +
      'concretely in English. Use ONLY the provided context (findings) — do not guess, and ' +
      'if the context is insufficient, say so.';
    const user = JSON.stringify({ question: question.trim(), hostId: hostId ?? null, findings });
    const answer = await chat(system, user);
    return { answer, model, usedFindings: findings.length };
  }

  // Produces a brief "what's going on at this location?" summary from the
  // location's agents, their probe-health verdicts and recent findings. Throws
  // FeatureDisabled when off, AssistantMisconfigured when the repos aren't wired,
  // LocationNotFound for an unknown id, and AssistantUpstreamError on provider
  // failure.
  async function summarizeLocation(locationId) {
    if (!enabled) throw new FeatureDisabledError();
    if (!agentsRepo || !locationsRepo) {
      const e = new Error('location summary requires agents and locations repositories');
      e.name = 'AssistantMisconfigured';
      throw e;
    }

    const { context, location, agentCount, findingCount } = await buildLocationContext(locationId);
    const system =
      'You are a network operations assistant for BlueEye. In 2-4 sentences, give a brief, ' +
      'concrete status of THIS location: what looks healthy, what is wrong, and the most likely ' +
      'cause. Use ONLY the provided context (per-agent status, probe-health verdicts and recent ' +
      'findings, each already explained in plain language). If there are no agents or no findings, ' +
      'say there is not enough data yet. If everything looks healthy, say so plainly. Do not invent ' +
      'specifics or hostnames that are not in the context.';
    const user = JSON.stringify(context);
    const answer = await chat(system, user);
    return { answer, model, location: location.name, agents: agentCount, findings: findingCount };
  }

  return { isEnabled, explain, summarizeLocation, buildContext, buildLocationContext };
}

module.exports = { createAssistant, FeatureDisabledError };
