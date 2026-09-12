'use strict';

const { incidentAnalysisContext, testSuggestionContext } = require('./context');

// The AI assistance layer (V3 Phase 4, docs/service-assurance-v3.md §"AI").
//
//     AI is an assistance layer, never an execution dependency.
//
// Four properties, and the code is arranged so that each is hard to break rather
// than merely true today:
//
//   1. THE SYSTEM WORKS FULLY WITHOUT IT. Nothing here is on the path of a run,
//      a sweep, an incident or an alert. Every entry point answers with a
//      "why not" rather than throwing, so a caller that forgets to handle the
//      unavailable case degrades to no analysis rather than to no page.
//   2. NO PROVIDER IS NAMED. The provider arrives as a port. Mistral, a local
//      model or an enterprise LLM are configuration, and this file cannot tell
//      which it is talking to.
//   3. IT EXPLAINS WHAT THE RULES CONCLUDED; IT DOES NOT REPLACE THEM. The
//      context it is given IS the rule-based analysis, and the answer is stored
//      beside the evidence it was given so a reader can check it. An answer that
//      cannot be checked is worse than none, because it will be believed.
//   4. IT CHANGES NOTHING. There is no path from here to a test, a selector, a
//      setting or a shell. The only thing it produces is text, attached to an
//      incident, labelled as a suggestion.
//
// The port, which the host satisfies (src/serviceTests/ports.js):
//
//   ai {
//     isEnabled() -> boolean
//     status()    -> { enabled, configured, provider, model }
//     analyse(task, context) -> Promise<{ answer, model }>
//   }

// Why an analysis is not available. Said in the operator's words, because
// "unavailable" on a screen with no reason is a bug report waiting to be filed.
const UNAVAILABLE = {
  NOT_WIRED: 'This deployment has no AI provider configured.',
  OFF: 'AI assistance is switched off.',
  NOT_CONFIGURED: 'AI assistance is on, but no provider key has been set.',
  NOTHING_TO_EXPLAIN: 'There is nothing recorded against this to explain.',
};

// The model is asked for prose, and prose is all it may produce. A cap, because
// an answer that runs to pages is one nobody reads and an unbounded amount of a
// provider's output landing in the database.
const MAX_ANSWER = 4000;

// How long to wait. An analysis is a convenience; a request that hangs would
// hold a connection on a page somebody opened during an outage.
const DEFAULT_TIMEOUT_MS = 30000;

function createAiAnalysis(rawDeps = {}) {
  // A default parameter covers `undefined` and nothing else. This module's whole
  // point is that a deployment without AI keeps working, so it is the one place
  // that must not fall over on being constructed carelessly.
  const deps = (rawDeps && typeof rawDeps === 'object' && !Array.isArray(rawDeps)) ? rawDeps : {};
  const {
  // The provider port. Omitted entirely on a deployment with no AI at all, which
  // is the default and must stay a first-class case rather than an error path.
  ai = null,
  // Where an analysis is kept, so it is not re-requested and can be shown with
  // the evidence it rested on. Optional: without it an analysis is returned and
  // not remembered, which is degraded but not broken.
  store = null,
  logger = { info() {}, warn() {}, error() {} },
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps;
  // Property 1, as one function every entry point calls first.
  function availability() {
    if (!ai || typeof ai.analyse !== 'function') {
      return { available: false, reason: UNAVAILABLE.NOT_WIRED };
    }
    let status = {};
    try { status = (typeof ai.status === 'function' ? ai.status() : {}) || {}; } catch { status = {}; }
    const enabled = typeof ai.isEnabled === 'function' ? ai.isEnabled() === true : status.enabled === true;
    if (!enabled) return { available: false, reason: UNAVAILABLE.OFF, status };
    if (status.configured === false) return { available: false, reason: UNAVAILABLE.NOT_CONFIGURED, status };
    return { available: true, reason: null, status };
  }

  // What a screen shows before anybody presses anything.
  //
  //     Test:                 FAILED
  //     Rule-based analysis:  AVAILABLE
  //     AI analysis:          UNAVAILABLE
  //
  // The spec's own picture. The rule-based analysis is always available, and
  // saying so beside the AI line is what stops "AI unavailable" reading as
  // "no analysis".
  function status() {
    const state = availability();
    return {
      rules: 'available',
      ai: state.available ? 'available' : 'unavailable',
      reason: state.reason,
      provider: (state.status && state.status.provider) || null,
      model: (state.status && state.status.model) || null,
    };
  }

  // One call to the provider, bounded and caught.
  //
  // Never rethrows. A provider that is down, slow, misconfigured or answering
  // nonsense produces an unavailable analysis with a reason, which is the same
  // shape as "it is switched off" — so a caller has one case to handle and not
  // four.
  async function ask(task, context) {
    const started = now();
    let timer = null;
    try {
      const answered = await Promise.race([
        ai.analyse(task, context),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the provider did not answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
          if (timer.unref) timer.unref();
        }),
      ]);
      const answer = String((answered && answered.answer) || '').trim();
      if (!answer) return { ok: false, reason: 'The provider answered with nothing.' };
      return {
        ok: true,
        answer: answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}…` : answer,
        model: (answered && answered.model) || null,
        duration_ms: now().getTime() - started.getTime(),
      };
    } catch (err) {
      // The message is the provider's, and it is shown: "the key is invalid" and
      // "the provider is down" are different problems for whoever has to fix it.
      const message = String((err && err.message) || 'the provider could not be reached');
      logger.warn(`service-assurance ai: ${task} failed (${message})`);
      return { ok: false, reason: `The provider could not answer: ${message}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Explain one incident.
  //
  // `sources` is everything the rule layer already worked out. It is passed
  // through the allowlist in context.js — which is where the security argument
  // lives — and NOT re-derived here, so the model explains what the operator was
  // shown rather than forming a second opinion from different data.
  async function explainIncident(rawSources = {}) {
    const sources = (rawSources && typeof rawSources === 'object' && !Array.isArray(rawSources)) ? rawSources : {};
    const state = availability();
    if (!state.available) return { available: false, reason: state.reason, analysis: null };

    const context = incidentAnalysisContext(sources);
    if (!context) return { available: false, reason: UNAVAILABLE.NOTHING_TO_EXPLAIN, analysis: null };

    const result = await ask('explain_incident', context);
    if (!result.ok) return { available: false, reason: result.reason, analysis: null };

    const analysis = {
      kind: 'explain_incident',
      answer: result.answer,
      model: result.model,
      // Property 3: the evidence it was given, stored with the answer. Not a
      // link to today's data, which would drift — the exact context, so "why did
      // it say that" is answerable next month.
      context,
      // Property 4, said on the record: this is a suggestion. The rule-based
      // conclusion beside it is the one with evidence under it.
      is_suggestion: true,
      source: 'ai',
      created_at: now(),
      duration_ms: result.duration_ms,
    };

    if (store && typeof store.record === 'function') {
      try {
        const saved = await store.record({
          incident_id: context.incident.id,
          application_id: sources.applicationId ?? null,
          kind: analysis.kind,
          answer: analysis.answer,
          model: analysis.model,
          context: analysis.context,
          duration_ms: analysis.duration_ms,
        });
        if (saved && saved.id) analysis.id = saved.id;
      } catch (err) {
        // An analysis that cannot be stored is still an analysis. Losing the
        // answer because a table was full would be the worst of both.
        logger.warn(`service-assurance ai: could not store the analysis (${err && err.message})`);
      }
    }
    return { available: true, reason: null, analysis };
  }

  // Suggest tests worth having.
  //
  // The user approves before anything is created — there is no path from this
  // function to a test, and there must not be one. It returns prose.
  async function suggestTests(rawSources = {}) {
    const sources = (rawSources && typeof rawSources === 'object' && !Array.isArray(rawSources)) ? rawSources : {};
    const state = availability();
    if (!state.available) return { available: false, reason: state.reason, analysis: null };

    const context = testSuggestionContext(sources);
    const result = await ask('suggest_tests', context);
    if (!result.ok) return { available: false, reason: result.reason, analysis: null };

    return {
      available: true,
      reason: null,
      analysis: {
        kind: 'suggest_tests',
        answer: result.answer,
        model: result.model,
        context,
        is_suggestion: true,
        source: 'ai',
        created_at: now(),
        duration_ms: result.duration_ms,
      },
    };
  }

  return { status, availability, explainIncident, suggestTests, UNAVAILABLE };
}

module.exports = { createAiAnalysis, UNAVAILABLE, MAX_ANSWER, DEFAULT_TIMEOUT_MS };
