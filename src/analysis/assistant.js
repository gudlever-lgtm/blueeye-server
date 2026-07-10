'use strict';

const { computeAgentHealth } = require('../health/probeHealth');

// IPv4 address / CIDR masker — applied before sending any context to Mistral.
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
// credentials, or payload to the provider. Uses Mistral's (EU) chat-completions
// API over fetch; the network call is injected (fetchImpl) so tests run offline.
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
const INCIDENT_INSUFFICIENT_ANSWER = 'Der findes ikke tilstrækkelige data til at konkludere.';

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
  const baseUrl = config.assistantBaseUrl || 'https://api.mistral.ai/v1/chat/completions';
  const maxFindings = Number.isFinite(config.assistantMaxFindings) ? config.assistantMaxFindings : 20;
  const timeoutMs = Number.isFinite(config.assistantTimeoutMs) ? config.assistantTimeoutMs : 20000;

  // enabled / apiKey / model are read live from `config` on every call. The
  // server passes its analysis-config object, which Settings → AI assistant
  // mutates, so an admin can enable the assistant or set its key at runtime with
  // no restart. baseUrl + limits stay env-driven (captured once above).
  const currentEnabled = () => Boolean(config.assistantEnabled);
  const currentApiKey = () => config.assistantApiKey || '';
  const currentModel = () => config.assistantModel || 'mistral-small-latest';

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
    if (!apiKey) {
      const e = new Error('assistant is enabled but no API key is configured (set one in Settings → AI assistant)');
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

  // Generates a short Danish plain-language narrative for an InvestigationResult.
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
      'Du er en netværksdriftsassistent for BlueEye. Skriv et kort, klart resumé på DANSK ' +
      '(3-5 sætninger) af denne netværksfejlfindingsanalyse: hvad blev fundet, hvad er den ' +
      'sandsynlige årsag, og hvad er næste skridt. Brug KUN den angivne kontekst. ' +
      'Undgå teknisk jargon der ikke fremgår af konteksten.';
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
  // Uses a separate Mistral call with a NIS2-focused Danish system prompt.
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
      'Du er en cybersikkerhedsrådgiver der hjælper med NIS2-hændelsesindberetning i Danmark. ' +
      'Analysér den vedlagte netværksanalyse og udfyld felterne til et NIS2-hændelsesudkast. ' +
      'Svar KUN med gyldig JSON uden forklaring eller markdown-formatering. ' +
      'JSON-format: {"title":"Kort hændelsesbeskrivelse (maks 100 tegn)",' +
      '"severity":"low|medium|high|critical","detectedAt":"ISO-tidsstempel fra window.to eller null",' +
      '"affectedSystems":"Berørte systemer maks 300 tegn — INGEN IP-adresser",' +
      '"description":"Klartekst hændelsesbeskrivelse til NIS2 maks 400 tegn"} ' +
      'Brug KUN den angivne kontekst. Indsæt ALDRIG rå IP-adresser, hostnavne med IP eller PII.';
    const windowTo = result.window && result.window.to ? result.window.to : null;
    const raw = await chat(system, JSON.stringify(ctx));
    return parseNis2Response(raw, result.classification, windowTo);
  }

  // Non-secret status for the admin "Test area" screening: whether it is enabled +
  // configured (an API key is present), plus the (non-secret) base URL and model.
  // Never returns the key itself.
  function status() {
    return { enabled: currentEnabled(), configured: currentApiKey() !== '', baseUrl, model: currentModel() };
  }

  // Formulates a short Danish diagnosis for a failed/deviating transaction test
  // from structured, non-sensitive facts (failure phase, step, cross-agent check,
  // latency deviation). Throws FeatureDisabled when off; callers fall back to a
  // template. Facts carry no IPs/payload, so no masking is needed.
  async function diagnoseTransaction(facts) {
    if (!currentEnabled()) throw new FeatureDisabledError();
    const system =
      'Du er en dansk netværks- og driftsassistent for BlueEye. Formulér en KORT, ' +
      'konkret diagnose på dansk (højst 2 sætninger) af en fejlet eller afvigende ' +
      'transaktionstest ud fra de givne fakta (fejlfase, trin, krydscheck mellem ' +
      'agenter, latens-afvigelse). Gæt ikke ud over fakta.';
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

  return { isEnabled, status, explain, explainDiagnostic, summarizeLocation, narrateInvestigation, generateNis2Draft, diagnoseTransaction, askIncident, buildContext, buildLocationContext };
}

module.exports = { createAssistant, FeatureDisabledError, INCIDENT_INSUFFICIENT_ANSWER };
