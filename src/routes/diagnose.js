'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateDiagnoseRequest, validateDiagnoseRun } = require('../validation/diagnoseValidation');
const { validateProbeSpec } = require('../validation/probeValidation');
const { matchPlaybooks } = require('../diagnose/match');
const { selectPlaybooks } = require('../diagnose/llm');
const { buildPlan } = require('../diagnose/plan');
const { buildFacts } = require('../diagnose/facts');
const { evaluateSession } = require('../diagnose/evaluate');
const { buildWalkthrough } = require('../diagnose/walkthrough');
const { localize, DEFAULT_LOCALE } = require('../diagnose/catalog');
const { computeInterfaceHealth } = require('../health/interfaceHealth');
const { ecmpAnalysis, PATH_PROBE_TYPES } = require('../analysis/pathGraph');
const { pickReverseTarget } = require('../diagnose/reverseTarget');
const { silentLogger } = require('../logger');

// How far back, and how many runs, the ECMP check compares a fresh trace with.
// A day of the scheduled traceroute is enough to have seen every member of a
// group; twenty runs keeps it one small indexed read.
const ECMP_HISTORY_MS = 24 * 3600 * 1000;
const ECMP_HISTORY_RUNS = 20;

// Symptom-first diagnosis. Mounted at /api/diagnose and /api/playbooks.
//
// The operator writes what is wrong in their own words and gets back a plan:
// the likely causes ranked, the tests to run with their parameters already
// filled in, the views to open and what to look for in each, and the possible
// fixes. Run the tests, ask for an evaluation, and every cause comes back
// confirmed, ruled out or still open — with the rule and the measurement that
// decided it.
//
// RBAC, and the line it draws:
//   viewer+    read a plan, read the catalogue, read a session
//   operator+  RUN the tests and EVALUATE
// Running a test pushes a command to an agent and evaluation can send context to
// a third party, so both are writes even though neither changes a record. A
// viewer may read every conclusion; they may not make the network do something.
//
// NOT /api/diagnostics — that is the admin-only outbound-connectivity test area
// and has been since long before this. The names sit uncomfortably close and the
// two are unrelated; this one is the technician's, that one is the installer's.
function createDiagnoseRouter({
  catalog,
  sessionsRepo = null,
  agentsRepo = null,
  resultsRepo = null,
  probeResultsRepo = null,
  agentCommander = null,
  assistant = null,
  auditLogger = null,
  logger = silentLogger,
} = {}) {
  const router = express.Router();
  const reader = requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN);
  const writer = requireRole(ROLES.OPERATOR, ROLES.ADMIN);

  const notFound = (res, what) => res.status(404).json({ error: `${what} not found` });
  const unavailable = (res) => res.status(503).json({ error: 'Diagnosis sessions are not available' });

  function parseId(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  // ---------------------------------------------------------------- catalogue

  // GET /api/playbooks — the catalogue, in one locale.
  router.get('/playbooks', requireAuth, reader, asyncHandler(async (req, res) => {
    const locale = req.query.locale || DEFAULT_LOCALE;
    res.json({
      playbooks: catalog.list().map((pb) => {
        const v = localize(pb, locale);
        return { id: v.id, title: v.title, summary: v.summary, explanation: v.explanation, symptoms: v.symptoms, testTypes: [...new Set(v.tests.map((t) => t.type))] };
      }),
    });
  }));

  // GET /api/playbooks/:id — one playbook, whole.
  router.get('/playbooks/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const pb = catalog.get(req.params.id);
    if (!pb) return notFound(res, 'Playbook');
    res.json({ playbook: localize(pb, req.query.locale || DEFAULT_LOCALE) });
  }));

  // ----------------------------------------------------------------- sessions

  // POST /api/diagnose — describe the problem, get a plan.
  //   400 empty / too long / bad target · 404 unknown agent · 503 no storage
  router.post('/diagnose', requireAuth, reader, asyncHandler(async (req, res) => {
    const { value, errors } = validateDiagnoseRequest(req.body);
    if (errors) return res.status(400).json({ errors });
    if (!sessionsRepo) return unavailable(res);

    // An agent that does not exist is a 404, not a plan built around nothing.
    const found = {};
    for (const [field, id] of [['agentId', value.agentId], ['peerAgentId', value.peerAgentId]]) {
      if (id == null) continue;
      if (!agentsRepo) return unavailable(res);
      // eslint-disable-next-line no-await-in-loop
      const agent = await agentsRepo.findById(id);
      if (!agent) return notFound(res, field === 'agentId' ? 'Agent' : 'Peer agent');
      found[field] = agent;
    }

    const locale = value.locale;
    // The AI may narrow the choice; the keyword matcher is what guarantees there
    // is one. Run the local matcher FIRST so the fallback is already in hand and
    // a slow provider costs latency rather than an answer.
    const keywordMatches = matchPlaybooks(value.description, catalog, { locale });

    let matches = keywordMatches;
    let matchedBy = 'keywords';
    let entities = null;
    if (value.useAi !== false && assistant) {
      const ai = await selectPlaybooks({ assistant, catalog, description: value.description, locale, logger });
      if (ai && ai.playbooks.length) {
        matches = ai.playbooks;
        matchedBy = 'llm';
        entities = ai.entities;
      }
    }

    if (matches.length === 0) {
      // Nothing matched, and saying so is better than a plan built from the
      // three playbooks that happened to sort first.
      return res.status(200).json({
        session: null,
        matchedBy: 'keywords',
        usedAi: false,
        causes: [],
        message: 'Nothing in the playbook catalogue matches that description. Try naming the protocol, the symptom or what changed.',
      });
    }

    const target = value.target ?? (entities && entities.target) ?? null;
    // The reverse direction probes BACK to the origin agent (the return path),
    // at the address src/diagnose/reverseTarget.js picks and explains. No
    // origin agent, or none of its addresses known → the reverse tests are
    // skipped with that reason rather than aimed at the wrong target.
    const reverseTarget = value.peerAgentId != null
      ? (found.agentId
        ? pickReverseTarget({ origin: found.agentId, peer: found.peerAgentId, forwardTarget: target })
        : { address: null, reason: 'No origin agent was chosen, so there is nothing for the far end to probe back to.' })
      : null;
    const plan = buildPlan({
      matches, catalog, target,
      agentId: value.agentId ?? null,
      peerAgentId: value.peerAgentId ?? null,
      reverseTarget,
      locale, matchedBy,
    });

    const id = await sessionsRepo.create({
      description: value.description,
      locale, matchedBy,
      agentId: value.agentId ?? null,
      peerAgentId: value.peerAgentId ?? null,
      target, entities, plan,
      createdBy: (req.user && req.user.email) || null,
      // Only dispatchable tests become rows. A plan with no target is still a
      // useful plan — it says what to run — but there is nothing to run yet.
      // Each row carries its OWN target: a reverse row points at the origin
      // agent, not at the session's target.
      tests: target ? plan.tests.map((t) => ({
        playbookId: t.playbookId, agentId: t.agentId, direction: t.direction,
        probeType: t.probeType, target: t.target, params: t.params,
      })) : [],
    });

    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'diagnose', action: 'session_created', target: String(id),
        detail: `Diagnosis plan for "${value.description.slice(0, 120)}" — ${plan.causes.map((c) => c.id).join(', ')} (matched by ${matchedBy})`,
      });
    }

    res.status(201).json({ sessionId: id, ...plan });
  }));

  // GET /api/diagnose/:id — the plan, what each test is doing, and the last
  // evaluation if there is one.
  router.get('/diagnose/:id', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    if (!sessionsRepo) return unavailable(res);
    const session = await sessionsRepo.findById(id);
    if (!session) return notFound(res, 'Diagnosis session');
    const tests = await sessionsRepo.listTests(id);
    res.json({ session: { ...session, tests } });
  }));

  // GET /api/diagnose — recent sessions.
  router.get('/diagnose', requireAuth, reader, asyncHandler(async (req, res) => {
    if (!sessionsRepo) return unavailable(res);
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: 'limit must be 1..200' });
    const sessions = await sessionsRepo.list({ limit });
    // The plan is large and nobody reads it in a list; the detail endpoint has it.
    res.json({ sessions: sessions.map(({ plan, evaluation, ...s }) => ({ ...s, causeCount: (plan && plan.causes ? plan.causes.length : 0), evaluated: !!evaluation })) });
  }));

  // POST /api/diagnose/:id/run — push the plan's tests to their agents.
  //   403 viewer · 404 unknown session · 409 nothing to run
  router.post('/diagnose/:id/run', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    if (!sessionsRepo) return unavailable(res);
    const session = await sessionsRepo.findById(id);
    if (!session) return notFound(res, 'Diagnosis session');
    const { value: selection, errors: selErrors } = validateDiagnoseRun(req.body);
    if (selErrors) return res.status(400).json({ error: 'Validation failed', details: selErrors });
    const all = await sessionsRepo.listTests(id);
    if (all.length === 0) {
      return res.status(409).json({ error: 'This plan has no tests to run — it needs a target and an agent first' });
    }
    // A subset is intersected with the session's own tests, never trusted: an id
    // from somewhere else selects nothing rather than running something nobody
    // on this plan asked for.
    const tests = selection.testIds ? all.filter((t) => selection.testIds.includes(t.id)) : all;
    if (tests.length === 0) {
      return res.status(400).json({ error: 'None of the selected tests belong to this plan' });
    }

    let dispatched = 0;
    const results = [];
    for (const t of tests) {
      // Re-validated here rather than trusted from storage. The spec was built
      // from the catalogue, but it has been through the database since, and a
      // probe spec ends up in an agent's argv.
      const { value: spec, errors } = validateProbeSpec({ type: t.probeType, host: t.target, ...(t.params || {}) });
      if (errors) {
        // eslint-disable-next-line no-await-in-loop
        await sessionsRepo.markFailed(t.id, `invalid probe spec: ${Object.values(errors)[0]}`);
        results.push({ testId: t.id, status: 'failed', detail: Object.values(errors)[0] });
        continue;
      }
      if (t.agentId == null) {
        // eslint-disable-next-line no-await-in-loop
        await sessionsRepo.markFailed(t.id, 'no agent assigned to this test');
        results.push({ testId: t.id, status: 'failed', detail: 'no agent assigned' });
        continue;
      }
      const delivered = agentCommander ? agentCommander.sendCommand(t.agentId, { name: 'run-probe', probe: spec }) : 0;
      if (delivered === 0) {
        // eslint-disable-next-line no-await-in-loop
        await sessionsRepo.markFailed(t.id, 'agent is not connected');
        results.push({ testId: t.id, status: 'failed', detail: 'agent is not connected' });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await sessionsRepo.markDispatched(t.id, { at: new Date(), agentId: t.agentId });
      dispatched += 1;
      results.push({ testId: t.id, status: 'dispatched', probeType: t.probeType, agentId: t.agentId, direction: t.direction });
    }

    if (dispatched > 0) await sessionsRepo.setStatus(id, 'running');
    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'diagnose', action: 'tests_run', target: String(id),
        detail: `Dispatched ${dispatched}/${tests.length} of ${all.length} test(s) to ${new Set(results.filter((r) => r.status === 'dispatched').map((r) => r.agentId)).size} agent(s)`,
      });
    }
    res.status(202).json({ sessionId: id, dispatched, total: tests.length, planTotal: all.length, tests: results });
  }));

  // POST /api/diagnose/:id/evaluate — read the results, apply the reading rules,
  // and mark every cause.
  //   400 nothing has been run yet · 403 viewer · 404 unknown session
  router.post('/diagnose/:id/evaluate', requireAuth, writer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    if (!sessionsRepo) return unavailable(res);
    const session = await sessionsRepo.findById(id);
    if (!session) return notFound(res, 'Diagnosis session');
    const tests = await sessionsRepo.listTests(id);
    const dispatched = tests.filter((t) => t.dispatchedAt);
    if (dispatched.length === 0) {
      // Evaluating before anything ran would produce a page of "inconclusive"
      // that looks like a verdict. It is not; it is an empty form.
      return res.status(400).json({ error: 'No tests have been run for this session yet — run them first' });
    }

    // Collect each dispatched test's result, newest first per direction.
    const forward = [];
    const reverse = [];
    const forwardTraces = [];
    for (const t of dispatched) {
      // eslint-disable-next-line no-await-in-loop
      const row = await sessionsRepo.findResultFor(t);
      if (!row) continue;
      // Link the evidence permanently the first time we find it, so the next
      // evaluation is a read rather than another search.
      if (t.probeResultId == null && row.id != null) {
        // eslint-disable-next-line no-await-in-loop
        await sessionsRepo.attachResult(t.id, row.id);
      }
      const shaped = shapeResult(row);
      (t.direction === 'reverse' ? reverse : forward).push(shaped);
      if (t.direction !== 'reverse' && PATH_PROBE_TYPES.includes(shaped.type)) {
        forwardTraces.push({ test: t, row, shaped });
      }
    }

    const interfaces = await loadInterfaces(session.agentId);
    const ecmp = await ecmpFor(forwardTraces);
    const facts = buildFacts({ results: forward, reverse, interfaces, ecmp });

    const playbooks = (session.plan && Array.isArray(session.plan.causes) ? session.plan.causes : [])
      .map((c) => catalog.get(c.id))
      .filter(Boolean);
    const evaluated = evaluateSession(playbooks, facts, { locale: session.locale || DEFAULT_LOCALE });

    const summary = await maybeSummarize(session, evaluated, facts);
    const evaluation = {
      ...evaluated,
      facts,
      summary,
      resultsSeen: forward.length + reverse.length,
      testsDispatched: dispatched.length,
      evaluatedAt: new Date().toISOString(),
    };
    await sessionsRepo.saveEvaluation(id, evaluation);

    if (auditLogger) {
      await auditLogger.record(req, {
        category: 'diagnose', action: 'evaluated', target: String(id),
        detail: `${evaluated.counts.confirmed} confirmed, ${evaluated.counts.ruled_out} ruled out, ${evaluated.counts.inconclusive} inconclusive`,
      });
    }
    res.json({ sessionId: id, ...evaluation });
  }));

  // GET /api/diagnose/:id/walkthrough — the same session as ONE ORDERED LIST of
  // steps: what to do now, why, what the last step showed and what is left.
  //
  // A READ, so viewer+ like the plan itself. It dispatches nothing and decides
  // nothing: it arranges what POST /diagnose planned and POST /evaluate
  // concluded. The verdict stays the evaluation's, which is what keeps this
  // from becoming a second, quieter place where a cause gets confirmed.
  //   400 bad id · 404 unknown session · 503 no storage
  router.get('/diagnose/:id/walkthrough', requireAuth, reader, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    if (!sessionsRepo) return unavailable(res);
    const session = await sessionsRepo.findById(id);
    if (!session) return notFound(res, 'Diagnosis session');
    const tests = await sessionsRepo.listTests(id);
    const walkthrough = buildWalkthrough({
      session,
      tests,
      // The measurements behind the finished steps. Each step already knows
      // which probe_results row it produced (the evaluation attached it); this
      // reads those rows so the step can show the numbers next to the verdict
      // rather than asserting one and sending the reader elsewhere to check.
      //
      // Scoped to the test's OWN agent on every read: a result id that belongs
      // to another agent must read as absent, not as somebody else's
      // measurement rendered under this session's step.
      results: await loadStepResults(tests),
      // The LAST evaluation, or none. A walk-through before anything has been
      // evaluated is still a walk-through — it is the list of steps with none
      // of them answered yet, which is exactly what somebody starting out
      // needs — so a missing evaluation is not an error here.
      evaluation: session.evaluation || null,
      locale: req.query.locale || session.locale || DEFAULT_LOCALE,
    });
    res.json({ sessionId: id, target: session.target ?? null, agentId: session.agentId ?? null, ...walkthrough });
  }));

  // --- helpers ---------------------------------------------------------------

  // The stored results the finished walk-through steps produced, by id.
  //
  // Best effort, and bounded by the plan: a session has at most MAX_TESTS rows
  // and only the ones an evaluation has already linked are read, so this is a
  // handful of primary-key lookups rather than a scan. A read that fails costs
  // the numbers on one step, never the walk-through — the sequence and its
  // verdicts do not depend on them.
  async function loadStepResults(tests) {
    if (!probeResultsRepo || typeof probeResultsRepo.findRunById !== 'function') return [];
    const wanted = [];
    const seen = new Set();
    for (const t of tests || []) {
      if (!t || t.probeResultId == null || seen.has(t.probeResultId)) continue;
      seen.add(t.probeResultId);
      wanted.push(t);
    }
    const out = [];
    for (const t of wanted) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const row = await probeResultsRepo.findRunById(t.probeResultId, { agentId: t.agentId ?? null });
        if (row) out.push(row);
      } catch (err) {
        logger.warn(`diagnose: could not read probe result ${t.probeResultId} for the walk-through (${err.message})`);
      }
    }
    return out;
  }

  // A probe_results row in the shape buildFacts() reads. The repository's own
  // mapper is not used here because this endpoint reads raw rows straight out of
  // the correlation query.
  function shapeResult(row) {
    const parse = (v) => {
      if (v == null) return null;
      if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
      return v;
    };
    return {
      id: row.id,
      type: row.type,
      target: row.target,
      ok: !!row.ok,
      rttMs: row.rtt_ms, minMs: row.min_ms, maxMs: row.max_ms,
      jitterMs: row.jitter_ms, lossPct: row.loss_pct, status: row.status,
      hops: parse(row.hops), sizes: parse(row.sizes), mtu: parse(row.mtu),
      detail: row.detail,
      errorCode: row.error_code ?? null,
      failure: row.failure ?? null,
    };
  }

  // Interface health for the agent the session runs from. Best effort: an
  // interface read that fails must not take the whole evaluation down, because
  // the probe results are the main evidence and they are already in hand.
  async function loadInterfaces(agentId) {
    if (agentId == null || !resultsRepo || typeof resultsRepo.findByAgentId !== 'function') return null;
    try {
      const rows = await resultsRepo.findByAgentId(agentId, { limit: 1 });
      const traffic = rows && rows[0] && rows[0].payload && rows[0].payload.traffic;
      return traffic ? computeInterfaceHealth(traffic) : null;
    } catch (err) {
      logger.warn(`diagnose: could not read interface health for agent ${agentId} (${err.message})`);
      return null;
    }
  }

  // How many parallel paths a trace saw, and whether one of them has gone, for
  // the ECMP rules — from the path graph's own analysis (ecmpAnalysis in
  // src/analysis/pathGraph.js), over the session's trace AND the recent runs of
  // the same probe before it.
  //
  // It used to count distinct addresses per hop inside ONE result. An agent
  // reports one address per hop per run, so that was always 1, and every ECMP
  // cause was "ruled out" — including on paths that had it. Members show up
  // across runs (and, for agents that report `hop.ips`, within one run), so
  // both are read. History is best effort: without it the within-run count
  // still stands, and a failed read must not sink the evaluation.
  async function ecmpFor(traces) {
    const out = {};
    for (const { test, row, shaped } of traces) {
      if (out[shaped.type]) continue; // first (newest) result per type, as buildFacts reads it
      let history = [];
      if (probeResultsRepo && typeof probeResultsRepo.recentRuns === 'function' && test.agentId != null) {
        const at = row.ts ? new Date(row.ts) : new Date();
        try {
          // eslint-disable-next-line no-await-in-loop
          history = await probeResultsRepo.recentRuns({
            agentId: test.agentId, type: shaped.type, target: shaped.target,
            before: at, from: new Date(at.getTime() - ECMP_HISTORY_MS), limit: ECMP_HISTORY_RUNS,
          });
        } catch (err) {
          logger.warn(`diagnose: could not read earlier ${shaped.type} runs (${err.message}) — ECMP judged on this run alone`);
          history = [];
        }
      }
      out[shaped.type] = ecmpAnalysis(Array.isArray(history) ? history : [], { latest: shaped });
    }
    return out;
  }

  // The RCA paragraph. Optional in every sense: no assistant, assistant off, or
  // a provider that does not answer all give null, and the verdicts above are
  // unaffected — they were decided in code before this was called, and this is
  // told so in its own prompt.
  async function maybeSummarize(session, evaluated, facts) {
    if (!assistant || typeof assistant.analyseDiagnose !== 'function') return null;
    try {
      if (typeof assistant.isEnabled === 'function' && !assistant.isEnabled()) return null;
      const answer = await assistant.analyseDiagnose('summarize', {
        description: session.description,
        locale: session.locale || DEFAULT_LOCALE,
        target: session.target,
        causes: evaluated.causes.map((c) => ({
          id: c.playbookId, title: c.title, verdict: c.verdict, reason: c.reason,
          decidedBy: c.decidedBy,
          evidence: c.evidence.filter((e) => e.result === true).map((e) => e.because),
          missing: c.missingFacts,
        })),
        measurements: facts,
      });
      return { text: (answer && answer.answer) || null, model: (answer && answer.model) || null };
    } catch (err) {
      logger.warn(`diagnose: RCA summary unavailable (${err && err.message})`);
      return null;
    }
  }

  return router;
}

module.exports = { createDiagnoseRouter };
