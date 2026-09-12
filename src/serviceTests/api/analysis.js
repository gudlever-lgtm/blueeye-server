'use strict';

const express = require('express');
const { asyncHandler, notFound, invalidId, parseId, auditor, userId } = require('./helpers');
const { observationsFromRun, layerSummary } = require('../observe/observations');
const { correlate, describeCorrelation } = require('../correlate/correlate');
const { analyseRootCause } = require('../rootcause/rootCause');
const { findRecurrence } = require('../history/recurrence');
const { referenceFor } = require('../incidents/lifecycle');
const { analyseDependencies } = require('../dependencies/dependencies');
const { detectAnomalies } = require('../anomaly/anomalies');
const { assessService } = require('../health/serviceHealth');
const { buildServiceMap } = require('../analysis/serviceMap');
const { journeyHealth } = require('../journeys/health');
const { baselineFrom } = require('../analysis/baseline');
const { ACTIVE: INCIDENT_ACTIVE } = require('../incidents/lifecycle');

// The V3 intelligence layer, over HTTP.
//
// Everything under here is COMPUTED ON READ. None of it is stored, and that is
// deliberate for the same reason the service map is not stored: an analysis
// written down is a claim about the world that somebody has to maintain and
// that quietly rots. These are derived from the observations and runs that ARE
// stored, so an analysis can never be more stale than its evidence.
//
// The one exception lives elsewhere, and it is the right exception: what the
// correlation engine concluded is stamped ON THE INCIDENT when the incident is
// opened, because that was a judgement made at a moment from the evidence
// available then. Recomputing it later against today's data would quietly
// rewrite what the operator was told during the outage.
//
// Read-only. There is no route here that changes anything — an analysis that can
// be edited is an analysis nobody can trust.

// How much history each analysis walks. Every one of these is a page somebody
// opens WHILE something is wrong, so none of them may be open-ended.
const RUNS_FOR_ANOMALY = 400;
const INCIDENTS_FOR_RECURRENCE = 200;
const RUNS_PER_TEST_FOR_MAP = 10;
const MAX_TESTS_FOR_MAP = 200;

function createAnalysisRouter({ repositories, requireRole, roles, aiAnalysis = null, audit = null }) {
  const router = express.Router();
  const {
    runs, tests, applications, journeys, incidents, observations, certificates, aiAnalyses,
  } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  // Asking a provider costs money and sends data outward. That is an operator's
  // decision, not a viewer's, even though the ANSWER is readable by anyone.
  const write = requireRole(roles.OPERATOR, roles.ADMIN);
  const record = auditor(audit);

  // ------------------------------------------------------------- one run
  //
  // What happened, and the best available answer to why. This is the endpoint
  // the run detail screen opens with.
  router.get('/runs/:id', read, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const run = await runs.findById(id);
    if (!run) return notFound(res, 'Run not found');

    // Stored observations when the run has them, derived when it does not.
    //
    // The fallback is not a convenience: every run from before this shipped has
    // no stored observations, and a "Why did this fail?" that answers "no data"
    // on last week's outage is worse than not having the button.
    let facts = observations ? await observations.forRun(run.id) : [];
    let source = 'stored';
    if (!facts.length) {
      const test = run.test_id ? await tests.findById(run.test_id) : null;
      facts = observationsFromRun({ ...run, test_name: test ? test.name : null });
      source = 'derived';
    }

    const test = run.test_id ? await tests.findById(run.test_id) : null;
    const application = test && test.application_id ? await applications.findById(test.application_id) : null;

    // Has this failed before? Repetition is what separates a real fault from a
    // blip, and the correlation engine's confidence depends on it.
    const history = run.test_id
      ? { sameFailureCount: await countRecentFailures(run) }
      : null;

    const correlation = correlate({ observations: facts, history });
    const rootCause = analyseRootCause({
      correlation,
      observations: facts,
      baseUrl: application ? application.base_url : null,
      certificate: await certificateFor(application, run),
    });

    return res.json({
      run: { id: run.id, test_id: run.test_id, status: run.status, ended_at: run.ended_at },
      observations: facts,
      layers: layerSummary(facts),
      correlation,
      // The one sentence a screen shows before anybody expands anything.
      correlation_summary: describeCorrelation(correlation),
      root_cause: rootCause,
      // Said out loud: a derived analysis was reconstructed from the run row
      // rather than read from what the worker recorded, and the two can differ
      // if the observation model has changed since.
      observations_from: source,
    });
  }));

  // How many times this same test failed the same way, recently. Bounded and
  // cheap: the correlation engine only asks whether it repeated, not for a
  // history.
  async function countRecentFailures(run) {
    if (!run.test_id) return 0;
    const recent = await runs.list({ testId: run.test_id, limit: 20 });
    return recent.filter((r) => (r.status === 'fail' || r.status === 'error')
      && (r.failure_kind || null) === (run.failure_kind || null)).length;
  }

  // The stored certificate verdict for this application's host, when there is
  // one. Root cause reads it as EVIDENCE — it never probes anything itself.
  async function certificateFor(application, run) {
    if (!application || !certificates) return null;
    try {
      const list = await certificates.list({ applicationId: application.id });
      if (!list.length) return null;
      // The one the run would have used, by host. Falling back to the first is
      // wrong when an application has several hosts, so it does not.
      let host = null;
      try { host = new URL(application.base_url).hostname; } catch { host = null; }
      return list.find((c) => c.host === host) || null;
    } catch {
      // A certificate lookup that fails costs one line of evidence, never the
      // page that explains the outage.
      return null;
    }
  }

  // -------------------------------------------------------- one incident
  //
  // Is this new? The timeline says what happened; this says whether it has
  // happened before and whether anybody ever fixed it.
  router.get('/incidents/:id/recurrence', read, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const incident = await incidents.findById(id);
    if (!incident) return notFound(res, 'Incident not found');

    const history = await incidents.list({ limit: INCIDENTS_FOR_RECURRENCE });
    const recurrence = findRecurrence({ incident, history });
    return res.json({
      incident_id: incident.id,
      // Null is a real answer here: most incidents are not recurrences, and an
      // empty report dressed up as a finding would make the ones that matter
      // invisible.
      recurrence,
      looked_at: history.length,
    });
  }));

  // ------------------------------------------------------- one application
  //
  // What does this service depend on, and is any of it shared?
  router.get('/applications/:id/dependencies', read, asyncHandler(async (req, res) => {
    const application = await loadApplication(req, res);
    if (!application) return undefined;

    const map = await mapFor(application);
    return res.json({
      application: { id: application.id, name: application.name },
      ...analyseDependencies({ map, baseUrl: application.base_url }),
    });
  }));

  // Service Health 2.0 — the number, in its published parts.
  router.get('/applications/:id/health', read, asyncHandler(async (req, res) => {
    const application = await loadApplication(req, res);
    if (!application) return undefined;

    const journeyList = journeys ? await journeys.list({ applicationId: application.id }) : [];
    const byJourney = journeys && journeyList.length
      ? await journeys.stepsForMany(journeyList.map((j) => j.id))
      : new Map();

    // `health`, not `status`. assessService reads `j.health`, and a journey
    // shaped with the wrong key is not an error — it is a journey that reads as
    // UNKNOWN, so a failing critical journey would quietly stop counting.
    const shaped = journeyList.map((j) => {
      const steps = byJourney.get(j.id) || [];
      const verdict = journeyHealth(steps);
      return {
        id: j.id,
        name: j.name,
        criticality: j.criticality,
        health: verdict.status,
        reason: verdict.reason,
        duration_ms: verdict.duration_ms ?? null,
      };
    });

    // The observations behind the API and availability parts. A window rather
    // than everything: health is a statement about now.
    const since = new Date(Date.now() - windowHours(req) * 3600000);
    const facts = observations
      ? await observations.list({ applicationId: application.id, since, limit: 2000 })
      : [];

    // The layer summary, not the raw facts: `assessService` reasons over what
    // each LAYER said, and handing it a list of observations would have it
    // silently see nothing.
    const layers = layerSummary(facts);

    // Performance comes from the durations the runs recorded, judged against the
    // same baseline the run screen uses — not a second opinion formed here.
    const durations = facts
      .filter((o) => o.kind === 'performance.duration' && o.value !== null)
      .map((o) => o.value);
    const performance = durations.length
      ? { current_ms: durations[0], baseline: baselineFrom(durations.slice(1)) }
      : null;

    const active = (await incidents.list({ applicationId: application.id, limit: 100 }))
      .filter((i) => INCIDENT_ACTIVE.includes(i.status));

    const health = assessService({
      journeys: shaped,
      layers,
      performance,
      // A COUNT, not the rows. `Number([])` is 0 and `Number([x])` is NaN, so
      // handing over the array would read as "no open incidents" either way.
      openIncidents: active.length,
      // How often this service failed in the window. Repetition is a fact about
      // the service, not about one run.
      recentFailures: facts.filter((o) => o.kind === 'run.outcome' && o.outcome === 'bad').length,
    });

    return res.json({
      application: { id: application.id, name: application.name },
      ...health,
      layers,
      // `open_incidents` is NOT set here. assessService already computes it from
      // what it was handed, and a second copy written over the top means two
      // sources for one number — the route's would always look right even when
      // the argument reaching the module was wrong, which is precisely what it
      // was hiding.
      observed_from: {
        window_hours: windowHours(req),
        observations: facts.length,
        journeys: shaped.length,
        note: 'Computed from what runs observed in this window. Nothing here is entered by hand.',
      },
    });
  }));

  // ------------------------------------------------------------- one test
  //
  // Is anything about this test's recent behaviour out of the ordinary?
  router.get('/tests/:id/anomalies', read, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const test = await tests.findById(id);
    if (!test) return notFound(res, 'Test not found');

    const history = await runs.list({ testId: test.id, limit: RUNS_FOR_ANOMALY });
    return res.json({
      test: { id: test.id, name: test.name },
      ...detectAnomalies({
        runs: history,
        recentWindowMs: windowHours(req) * 3600000,
      }),
    });
  }));

  // ------------------------------------------------------------------- AI
  //
  // Every route here answers 200 whether or not a provider is configured. "AI is
  // switched off" is not an error — it is the default state of the product, and
  // a 4xx would make every screen treat the normal case as a failure.

  router.get('/ai/status', read, asyncHandler(async (req, res) => {
    // The spec's own picture, as a response:
    //     Rule-based analysis:  AVAILABLE
    //     AI analysis:          UNAVAILABLE
    // The first line is why the second is not alarming.
    return res.json(aiAnalysis ? aiAnalysis.status()
      : { rules: 'available', ai: 'unavailable', reason: 'This deployment has no AI provider configured.', provider: null, model: null });
  }));

  // What a provider has already said about this incident. Read separately from
  // asking, so a screen shows an existing answer rather than buying another.
  router.get('/incidents/:id/ai', read, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const incident = await incidents.findById(id);
    if (!incident) return notFound(res, 'Incident not found');
    const analyses = aiAnalyses ? await aiAnalyses.forIncident(incident.id) : [];
    return res.json({
      incident_id: incident.id,
      status: aiAnalysis ? aiAnalysis.status() : { rules: 'available', ai: 'unavailable', reason: null },
      analyses,
    });
  }));

  // Ask for one.
  //
  // Synchronous from the caller's point of view — a button press waits for an
  // answer — but NOTHING else waits on this: no run, no sweep, no incident and
  // no alert reaches this route. That is what the spec means by asynchronous:
  // the analysis is off the critical path, not that the HTTP call returns early
  // and leaves the operator watching a spinner with nothing behind it.
  router.post('/incidents/:id/ai', write, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return invalidId(res);
    const incident = await incidents.findById(id);
    if (!incident) return notFound(res, 'Incident not found');
    if (!aiAnalysis) {
      return res.json({ available: false, reason: 'This deployment has no AI provider configured.', analysis: null });
    }

    // Everything the rule layer already worked out, gathered here and handed to
    // the allowlist. The model explains what the operator was shown; it is not
    // given a second, different view of the same incident to form its own
    // opinion from.
    const application = incident.application_id ? await applications.findById(incident.application_id) : null;
    const timeline = typeof incidents.timeline === 'function'
      ? await incidents.timeline(incident.id).catch(() => [])
      : [];
    const facts = observations && incident.test_id
      ? await observations.list({ testId: incident.test_id, limit: 100 }).catch(() => [])
      : [];
    const history = await incidents.list({ limit: INCIDENTS_FOR_RECURRENCE }).catch(() => []);

    const correlation = correlate({ observations: facts, history: { sameFailureCount: incident.occurrences || 0 } });
    const result = await aiAnalysis.explainIncident({
      incident: { ...incidentFacts(incident), reference: referenceFor(incident) },
      applicationName: application ? application.name : null,
      applicationId: incident.application_id ?? null,
      correlation,
      rootCause: analyseRootCause({
        correlation,
        observations: facts,
        baseUrl: application ? application.base_url : null,
      }),
      recurrence: findRecurrence({ incident, history }),
      timeline,
      observations: facts,
    });

    // Audited: an AI request sends a customer's data to a third party, and who
    // asked for it is the sort of thing somebody will need to answer later.
    record(req, 'service_ai_analysis', incident.id, `${incident.subject_key} → ${result.available ? 'answered' : 'unavailable'}`);
    return res.json(result);
  }));

  // The incident's fields, by name.
  //
  // Not a security control — context.js is, and it would strip a spread here
  // just as well; a mutation that replaced this with `{...incident}` leaked
  // nothing, which is the allowlist doing its job. What this buys is legibility:
  // the route says on its face what it hands outward, so a reviewer reading the
  // diff that sends data to a third party can see the payload without opening a
  // second file.
  function incidentFacts(incident) {
    return {
      id: incident.id,
      subject_label: incident.subject_label,
      subject_type: incident.subject_type,
      kind: incident.kind,
      severity: incident.severity,
      status: incident.status,
      summary: incident.summary,
      likely_cause: incident.likely_cause,
      explanation: incident.explanation,
      correlated_layer: incident.correlated_layer,
      confidence: incident.confidence,
      impact: incident.impact,
      impact_reason: incident.impact_reason,
      occurrences: incident.occurrences,
      opened_at: incident.opened_at,
      evidence: incident.evidence,
    };
  }

  // ------------------------------------------------------------- plumbing
  async function loadApplication(req, res) {
    const id = parseId(req.params.id);
    if (id === null) { invalidId(res); return null; }
    const application = await applications.findById(id);
    if (!application) { notFound(res, 'Application not found'); return null; }
    return application;
  }

  // The window, bounded. An unbounded one is a query that reads the whole
  // observation table, which is the largest in the module.
  function windowHours(req) {
    const asked = parseId(req.query.hours);
    if (asked === null) return 24;
    return Math.min(24 * 30, Math.max(1, asked));
  }

  // The same map the Service Map screen draws, so an analysis of dependencies
  // and the picture of them can never disagree.
  async function mapFor(application) {
    const journeyList = journeys ? await journeys.list({ applicationId: application.id }) : [];
    const byJourney = journeys && journeyList.length
      ? await journeys.stepsForMany(journeyList.map((j) => j.id))
      : new Map();

    const shaped = journeyList.map((j) => {
      const steps = byJourney.get(j.id) || [];
      return {
        id: j.id,
        name: j.name,
        criticality: j.criticality,
        health: journeyHealth(steps),
        steps: steps.map((s) => ({
          test_id: s.test_id,
          label: s.label || (s.test && s.test.name) || null,
          required: s.required,
        })),
      };
    });

    const allTests = await tests.list({ applicationId: application.id });
    const walked = allTests.slice(0, MAX_TESTS_FOR_MAP);
    // ONE statement, not one per test. This was a loop, and at the cap above it
    // was 200 round trips on a page somebody opens while something is already
    // wrong.
    const byTest = await runs.recentForTests(walked.map((t) => t.id), { perTest: RUNS_PER_TEST_FOR_MAP });
    const runsByTest = new Map();
    for (const test of walked) {
      runsByTest.set(test.id, (byTest.get(test.id) || []).map((r) => ({ ...r, test_name: test.name })));
    }
    return buildServiceMap({
      application: { id: application.id, name: application.name },
      journeys: shaped,
      runsByTest,
    });
  }

  return router;
}

module.exports = { createAnalysisRouter };
