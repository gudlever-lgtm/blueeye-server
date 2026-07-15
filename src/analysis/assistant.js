'use strict';

const { computeAgentHealth } = require('../health/probeHealth');
const { resolveBaseUrl, defaultModel, inferProvider, getProvider } = require('./assistantProviders');

// IPv4 address / CIDR masker — applied before sending any context to the provider.
// Replaces recognisable IPv4 literals (with optional /prefix-len) with [host].
const ANY_IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g;
function maskIps(s) {
  return typeof s === 'string' ? s.replace(ANY_IP_RE, '[host]') : s;
}

// Optional, opt-in LLM assistant. OFF by default; an admin enables it and sets
// its API key in Settings → AI assistant (env defaults still apply at boot).
// When enabled it answers questions / summarizes a location using ONLY a small,
// local context the analysis module already produced — recent findings (each
// already carrying a plain-language explanation) plus, for a location summary,
// each agent's status + probe-health verdict. It never ships raw metric history,
// credentials, or payload to the provider. Speaks the OpenAI-compatible
// chat-completions API — the provider (Mistral by default, or another EU /
// self-hosted endpoint chosen in Settings) is selected at runtime; the network
// call is injected (fetchImpl) so tests run offline.
//
//   const assistant = createAssistant({ config, findingStore, agentsRepo, locationsRepo, probeResultsRepo });
//   const { answer } = await assistant.explain('why is cpu high?', hostId);
//   const { answer } = await assistant.summarizeLocation(locationId);

// Thrown by explain()/summarizeLocation() when the feature is disabled. The route
// maps the name 'FeatureDisabled' to HTTP 403.
class FeatureDisabledError extends Error {
  constructor(message = 'The AI assistant is disabled (enable it in Settings → AI assistant)') {
    super(message);
    this.name = 'FeatureDisabled';
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// The exact answer the incident assistant must return when the context does not
// contain enough information — also used by the route to short-circuit (no data
// at all → this reply without a provider call).
const INCIDENT_INSUFFICIENT_ANSWER = 'There is not enough data to reach a conclusion.';

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
  const maxFindings = Number.isFinite(config.assistantMaxFindings) ? config.assistantMaxFindings : 20;
  const timeoutMs = Number.isFinite(config.assistantTimeoutMs) ? config.assistantTimeoutMs : 20000;

  // enabled / provider / apiKey / model / baseUrl are read live from `config` on
  // every call. The server passes its analysis-config object, which Settings → AI
  // assistant mutates, so an admin can enable the assistant, switch provider or
  // set its key at runtime with no restart. Only the limits stay env-driven
  // (captured once above). When no provider is set explicitly it is inferred from
  // the configured base URL, so env-only installs keep working unchanged.
  const currentEnabled = () => Boolean(config.assistantEnabled);
  const currentApiKey = () => config.assistantApiKey || '';
  const currentProvider = () => config.assistantProvider || inferProvider(config.assistantBaseUrl);
  const currentModel = () => config.assistantModel || defaultModel(currentProvider());
  const currentBaseUrl = () => resolveBaseUrl(currentProvider(), config.assistantBaseUrl);

  function isEnabled() {
    return currentEnabled();
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
    const apiKey = currentApiKey();
    const model = currentModel();
    const provider = getProvider(currentProvider());
    // Hosted providers need a key; self-hosted ones (e.g. Ollama) do not. Only
    // demand a key when the selected provider requires one — a preset with
    // keyRequired, or an unknown/custom provider that still supplied no key would
    // otherwise be un-testable. Custom endpoints may run without auth.
    const keyRequired = provider ? provider.keyRequired : true;
    if (!apiKey && keyRequired) {
      const e = new Error('assistant is enabled but no API key is configured (set one in Settings → AI assistant)');
      e.name = 'AssistantMisconfigured';
      throw e;
    }
    if (typeof fetchImpl !== 'function') {
      const e = new Error('assistant has no fetch implementation available');
      e.name = 'AssistantMisconfigured';
      throw e;
    }

    // Only send Authorization when a key is present; auth-less self-hosted
    // endpoints reject an empty bearer token.
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(currentBaseUrl(), {
        method: 'POST',
        headers,
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
    if (!currentEnabled()) throw new FeatureDisabledError();
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
    return { answer, model: currentModel(), usedFindings: findings.length };
  }

  // Produces a brief "what's going on at this location?" summary from the
  // location's agents, their probe-health verdicts and recent findings. Throws
  // FeatureDisabled when off, AssistantMisconfigured when the repos aren't wired,
  // LocationNotFound for an unknown id, and AssistantUpstreamError on provider
  // failure.
  async function summarizeLocation(locationId) {
    if (!currentEnabled()) throw new FeatureDisabledError();
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
    return { answer, model: currentModel(), location: location.name, agents: agentCount, findings: findingCount };
  }

  // Explains a flow-pipeline diagnostic snapshot (from POST /agents/:id/diagnose)
  // in plain language, correlating with the host's recent findings + probe-health
  // verdict when an id is given. Bounded context: only the KNOWN diagnostic fields
  // are forwarded (never arbitrary client input). Same error taxonomy as explain().
  async function explainDiagnostic(diagnostic, hostId) {
    if (!currentEnabled()) throw new FeatureDisabledError();
    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
      const e = new Error('a diagnostic snapshot is required');
      e.name = 'InvalidQuestion';
      throw e;
    }
    // Sanitise to a known shape so the prompt context stays small and trusted.
    const c = diagnostic.collector && typeof diagnostic.collector === 'object' ? diagnostic.collector : null;
    const snapshot = {
      source: diagnostic.source ?? null,
      sources: Array.isArray(diagnostic.sources) ? diagnostic.sources : null,
      managed: diagnostic.managed ?? null,
      agentVersion: diagnostic.agentVersion ?? null,
      lastReportAt: diagnostic.lastReportAt ?? null,
      collector: c ? {
        kind: c.kind ?? null,
        listening: !!c.listening,
        datagrams: Number(c.datagrams) || 0,
        decodedFlows: Number(c.decodedFlows) || 0,
        bufferedFlows: Number(c.bufferedFlows) || 0,
        lastDatagramAt: c.lastDatagramAt ?? null,
      } : null,
      hsflowd: diagnostic.hsflowd && typeof diagnostic.hsflowd === 'object'
        ? { state: diagnostic.hsflowd.state ?? null, detail: diagnostic.hsflowd.detail ?? null }
        : null,
    };
    const findings = hostId != null ? await buildContext(hostId) : [];
    const probeHealth = hostId != null ? await probeVerdict(hostId) : null;
    const system =
      'You are a network operations assistant for BlueEye. In 2-4 sentences, explain what this ' +
      "agent's flow-pipeline diagnostic means — the most likely reason flows are or are not " +
      'arriving — then the single most useful next step. The collector receives sFlow/NetFlow ' +
      'datagrams and decodes flow records: 0 datagrams means no exporter is sending to it; ' +
      'datagrams but 0 decoded means the samples are not being parsed. Use ONLY the provided ' +
      'context and do not invent specifics that are not present in it.';
    const user = JSON.stringify({ diagnostic: snapshot, hostId: hostId ?? null, findings, probeHealth });
    const answer = await chat(system, user);
    return { answer, model: currentModel(), usedFindings: findings.length };
  }

  // Generates a short English plain-language narrative for an InvestigationResult.
  // Sends ONLY aggregated evidence fields (metric, deviation, classification) —
  // never raw packet/payload data. Returns the narrative string, or throws on error.
  async function narrateInvestigation(result) {
    if (!currentEnabled()) throw new FeatureDisabledError();
    if (!result || typeof result !== 'object') {
      const e = new Error('a valid InvestigationResult is required');
      e.name = 'InvalidQuestion';
      throw e;
    }
    // Sanitise to known fields only — never forward arbitrary client data.
    const ctx = {
      classification: result.classification,
      confidence: result.confidence,
      locationRef: result.locationRef,
      window: result.window,
      suspectedSegment: result.suspectedSegment || null,
      evidenceSummary: (Array.isArray(result.evidence) ? result.evidence : []).slice(0, 8).map((e) => ({
        ref: e.ref,
        metric: e.ref ? e.ref.split('/')[1] || e.ref : null,
        deviation: e.deviation,
        observed: e.observed,
        baseline: e.baseline,
      })),
      workaroundHints: Array.isArray(result.workaroundHints) ? result.workaroundHints : [],
    };
    const system =
      'You are a network operations assistant for BlueEye. Write a short, clear summary in ENGLISH ' +
      '(3-5 sentences) of this network troubleshooting analysis: what was found, what is the ' +
      'likely cause, and what is the next step. Use ONLY the provided context. ' +
      'Avoid technical jargon that does not appear in the context.';
    return chat(system, JSON.stringify(ctx));
  }

  // Map investigation classification → a NIS2 severity suggestion.
  const CLASSIFICATION_SEVERITY = {
    LOCAL: 'high', UPSTREAM: 'medium', DOWNSTREAM: 'medium',
    APP_NOT_NET: 'low', INSUFFICIENT_DATA: 'low',
  };
  const VALID_NIS2_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

  // Build a masked, NIS2-suitable context from an InvestigationResult.
  // IPs in locationRef.value, explanation and suspectedSegment are replaced
  // with [host] before the payload leaves the process.
  function buildNis2Context(result) {
    const lr = result.locationRef || {};
    return {
      classification: result.classification,
      confidence: result.confidence,
      locationRef: { type: lr.type, value: maskIps(String(lr.value || '')) },
      window: result.window,
      explanation: maskIps(result.explanation || ''),
      suspectedSegment: result.suspectedSegment
        ? { from: maskIps(result.suspectedSegment.from), to: maskIps(result.suspectedSegment.to) }
        : null,
      evidenceSummary: (Array.isArray(result.evidence) ? result.evidence : [])
        .slice(0, 6).map((e) => ({ type: e.type, ref: e.ref, deviation: e.deviation, ts: e.ts })),
      workaroundHints: (Array.isArray(result.workaroundHints) ? result.workaroundHints : []).map(maskIps),
    };
  }

  // Parse Mistral's response for a NIS2 draft. Tries JSON first; strips markdown
  // fences when present. Falls back to empty fields so the caller can decide.
  function parseNis2Response(raw, classification, windowTo) {
    let parsed = {};
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    } catch { /* best-effort */ }
    return {
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 200) : '',
      severity: VALID_NIS2_SEVERITIES.has(parsed.severity)
        ? parsed.severity
        : (CLASSIFICATION_SEVERITY[classification] || 'medium'),
      detectedAt: (typeof parsed.detectedAt === 'string' && parsed.detectedAt)
        ? parsed.detectedAt
        : (windowTo || null),
      affectedSystems: typeof parsed.affectedSystems === 'string'
        ? maskIps(parsed.affectedSystems.slice(0, 500))
        : null,
      description: typeof parsed.description === 'string'
        ? parsed.description.slice(0, 500)
        : maskIps(raw.slice(0, 500)),
    };
  }

  // Generates a NIS2 incident draft structure from an InvestigationResult.
  // Uses a separate Mistral call with a NIS2-focused system prompt.
  // Throws FeatureDisabled when off, AssistantMisconfigured when not wired,
  // AssistantUpstreamError on provider failure.
  async function generateNis2Draft(result) {
    if (!currentEnabled()) throw new FeatureDisabledError();
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      const e = new Error('an InvestigationResult object is required');
      e.name = 'InvalidQuestion';
      throw e;
    }
    const ctx = buildNis2Context(result);
    const system =
      'You are a cybersecurity advisor helping with NIS2 incident reporting in Denmark. ' +
      'Analyze the attached network analysis and fill in the fields for a NIS2 incident draft. ' +
      'Reply ONLY with valid JSON, without explanation or markdown formatting. ' +
      'JSON format: {"title":"Short incident description (max 100 chars)",' +
      '"severity":"low|medium|high|critical","detectedAt":"ISO timestamp from window.to or null",' +
      '"affectedSystems":"Affected systems, max 300 chars — NO IP addresses",' +
      '"description":"Plain-text incident description for NIS2, max 400 chars"} ' +
      'Use ONLY the provided context. NEVER insert raw IP addresses, hostnames with IP, or PII.';
    const windowTo = result.window && result.window.to ? result.window.to : null;
    const raw = await chat(system, JSON.stringify(ctx));
    return parseNis2Response(raw, result.classification, windowTo);
  }

  // Non-secret status for the admin "Test area" screening: whether it is enabled +
  // configured (an API key is present), plus the (non-secret) base URL and model.
  // Never returns the key itself.
  function status() {
    const provider = getProvider(currentProvider());
    const configured = currentApiKey() !== '' || (provider && !provider.keyRequired);
    return { enabled: currentEnabled(), configured, provider: currentProvider(), baseUrl: currentBaseUrl(), model: currentModel() };
  }

  // Formulates a short English diagnosis for a failed/deviating transaction test
  // from structured, non-sensitive facts (failure phase, step, cross-agent check,
  // latency deviation). Throws FeatureDisabled when off; callers fall back to a
  // template. Facts carry no IPs/payload, so no masking is needed.
  async function diagnoseTransaction(facts) {
    if (!currentEnabled()) throw new FeatureDisabledError();
    const system =
      'You are a network and operations assistant for BlueEye. Formulate a SHORT, ' +
      'concrete diagnosis in English (at most 2 sentences) of a failed or deviating ' +
      'transaction test based on the given facts (failure phase, step, cross-check between ' +
      'agents, latency deviation). Do not guess beyond the facts.';
    const answer = await chat(system, JSON.stringify(facts || {}));
    return answer;
  }

  // Answers a free-text question about a specific incident using ONLY the
  // already-masked/aggregated context the caller assembled (askContext). The
  // system prompt forbids inventing anything and pins the exact fallback string
  // when the context is insufficient. Throws FeatureDisabled when off,
  // InvalidQuestion on empty input, AssistantMisconfigured/UpstreamError on
  // provider problems. The context is NOT re-masked here — masking already
  // happened before it reached this method.
  async function askIncident(question, context) {
    if (!currentEnabled()) throw new FeatureDisabledError();
    if (typeof question !== 'string' || question.trim() === '') {
      const e = new Error('question must be a non-empty string');
      e.name = 'InvalidQuestion';
      throw e;
    }
    const system =
      'You are a network operations assistant for BlueEye, answering a question about ONE specific ' +
      'incident. Answer briefly and concretely in the language of the question. Use ONLY the provided ' +
      'context (incident, timeline, config changes, similar incidents). NEVER invent facts, causes, ' +
      'hostnames or addresses that are not present in the context. If the context does not contain ' +
      `enough information to answer, reply EXACTLY with: "${INCIDENT_INSUFFICIENT_ANSWER}"`;
    const user = JSON.stringify({ question: question.trim(), context });
    const answer = await chat(system, user);
    return { answer, model: currentModel() };
  }

  // Proposes a remediation for ONE incident from the SAME already-masked context
  // askIncident uses (no re-masking here — masking happened before it reached this
  // method). The fallback recommendation surface calls this only after a playbook
  // + historical match both came up empty (or an operator forced it). The system
  // prompt forbids inventing a fix and pins the exact insufficient-context string,
  // so the caller can detect "the model had nothing concrete to offer". Throws
  // FeatureDisabled when off; AssistantMisconfigured/UpstreamError on provider
  // problems.
  async function suggestRemediation(context) {
    if (!currentEnabled()) throw new FeatureDisabledError();
    const system =
      'You are a network operations assistant for BlueEye, proposing a remediation for ONE specific ' +
      'incident. Use ONLY the provided masked context (incident, timeline, config changes, similar ' +
      'incidents). Propose at most a few concrete, actionable steps, in the language of the incident ' +
      'title. This is a SUGGESTION, never verified fact. NEVER invent facts, causes, hostnames, ' +
      'addresses or fixes that are not supported by the context. If the context does not contain ' +
      `enough information to suggest anything concrete, reply EXACTLY with: "${INCIDENT_INSUFFICIENT_ANSWER}"`;
    const user = JSON.stringify({ task: 'suggest_remediation', context });
    const answer = await chat(system, user);
    return { answer, model: currentModel() };
  }

  // Proposes a likely COMMON root cause + troubleshooting steps for a cross-agent
  // incident CLUSTER — findings from several agents that fired together. The prompt
  // is built from the cluster's member findings (not a single finding), each already
  // carrying a plain-language explanation; IPs in explanations are masked here before
  // anything leaves the process. Same contract as suggestRemediation: it is a
  // SUGGESTION, never invents facts, and pins the exact insufficient-context string
  // so the caller can tell "the model had nothing concrete" and NOT surface it as
  // advice. Throws FeatureDisabled when off; AssistantMisconfigured/UpstreamError on
  // provider problems. Returns { answer, model, usedFindings }.
  async function suggestClusterCause(cluster = {}, members = []) {
    if (!currentEnabled()) throw new FeatureDisabledError();
    const findings = (Array.isArray(members) ? members : []).slice(0, maxFindings).map((f) => ({
      host: f.hostId,
      metric: f.metric,
      severity: f.severity,
      deviation: f.deviation,
      explanation: maskIps(f.explanation || ''),
      at: f.createdAt,
    }));
    const context = {
      confidence: cluster.confidence ?? null,
      signals: cluster.signals ?? null,
      site: cluster.site ?? null,
      commonType: cluster.commonType ?? null,
      agents: Array.isArray(cluster.hostIds) ? cluster.hostIds.length : findings.length,
      localHint: maskIps(cluster.suspectedCommonCause || ''),
      findings,
    };
    const system =
      'You are a network operations assistant for BlueEye, analyzing ONE incident that spans MULTIPLE ' +
      'agents (a cross-agent cluster). Propose the single most likely COMMON root cause and a few ' +
      'concrete troubleshooting steps, in the language of the findings. Focus on what the agents share ' +
      '(same site, same anomaly type, same time). This is a SUGGESTION, never verified fact. Use ONLY ' +
      'the provided context (per-agent findings, each already explained). NEVER invent facts, causes, ' +
      'hostnames or addresses that are not present in the context. If the context does not contain enough ' +
      `information to suggest a common cause, reply EXACTLY with: "${INCIDENT_INSUFFICIENT_ANSWER}"`;
    const user = JSON.stringify({ task: 'cluster_common_cause', context });
    const answer = await chat(system, user);
    return { answer, model: currentModel(), usedFindings: findings.length };
  }

  return { isEnabled, status, explain, explainDiagnostic, summarizeLocation, narrateInvestigation, generateNis2Draft, diagnoseTransaction, askIncident, suggestRemediation, suggestClusterCause, buildContext, buildLocationContext };
}

module.exports = { createAssistant, FeatureDisabledError, INCIDENT_INSUFFICIENT_ANSWER };
