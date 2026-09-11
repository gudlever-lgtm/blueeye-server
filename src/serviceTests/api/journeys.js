'use strict';

const express = require('express');
const { asyncHandler, invalid, notFound, makeLoader, auditor, userId, parseId } = require('./helpers');
const { validateJourney, validateJourneySteps } = require('../validation');
const { journeyHealth, applicationHealth, durationVerdict } = require('../journeys/health');

// User Journeys / Business Transactions — the central V2 object
// (docs/service-assurance-v2.md §2, P1 #1).
//
// A journey is what makes a set of tests mean something: not five green ticks,
// but "can a caseworker do their job". It orders tests that already exist and
// owns none of its own, so every V1 feature works inside a journey on day one
// without being taught about journeys at all.
//
// RBAC matches tests, deliberately: viewer reads, OPERATOR builds. Describing
// the journeys your service is made of is the same kind of work as building the
// tests under them, done by the same people.
function createJourneysRouter({ repositories, audit, requireRole, roles }) {
  const router = express.Router();
  const { journeys, applications, tests, environments } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);
  const write = requireRole(roles.OPERATOR, roles.ADMIN);
  const load = makeLoader(journeys, 'Journey');
  const record = auditor(audit);

  // A journey plus its verdict. Never one without the other: a status with no
  // evidence is the thing this feature exists to replace.
  const withHealth = (journey, steps) => {
    const health = journeyHealth(steps);
    return {
      ...journey,
      step_count: steps.length,
      health,
      // Only when the operator stated an expectation. An unstated one produces
      // no verdict rather than a made-up baseline.
      duration: durationVerdict(health.duration_ms, journey.expected_duration_ms),
    };
  };

  router.get('/', read, asyncHandler(async (req, res) => {
    const applicationId = req.query.application_id !== undefined ? parseId(req.query.application_id) : null;
    if (req.query.application_id !== undefined && applicationId === null) {
      return res.status(400).json({ error: 'Invalid application_id' });
    }
    const list = await journeys.list({ applicationId, criticality: req.query.criticality || null });
    // One query for every journey's steps rather than one per journey: the list
    // screen shows every verdict, and N+1 here would be slowest exactly when an
    // estate is big enough to need this screen.
    const byJourney = await journeys.stepsForMany(list.map((j) => j.id));
    const enriched = list.map((j) => withHealth(j, byJourney.get(j.id) || []));
    return res.json({
      journeys: enriched,
      // The application-level roll-up the Health screen reads: the worst journey
      // decides, and the counts say how widespread it is.
      summary: applicationHealth(enriched.map((j) => j.health)),
    });
  }));

  router.post('/', write, asyncHandler(async (req, res) => {
    const { value, errors } = validateJourney(req.body);
    if (errors) return invalid(res, errors);
    const app = await applications.findById(value.application_id);
    if (!app) return invalid(res, { application_id: 'that application does not exist' });
    const envError = await checkEnvironment(value, app.id);
    if (envError) return invalid(res, envError);

    const created = await journeys.create({ ...value, created_by: userId(req) });
    record(req, 'journey_create', created.id, `app=${app.id} name=${created.name} criticality=${created.criticality}`);
    return res.status(201).json(withHealth(created, []));
  }));

  router.get('/:id', read, asyncHandler(async (req, res) => {
    const journey = await load(req, res);
    if (!journey) return undefined;
    return res.json(withHealth(journey, await journeys.stepsFor(journey.id)));
  }));

  router.put('/:id', write, asyncHandler(async (req, res) => {
    const journey = await load(req, res);
    if (!journey) return undefined;
    const { value, errors } = validateJourney(req.body, { partial: true });
    if (errors) return invalid(res, errors);
    const envError = await checkEnvironment(value, journey.application_id);
    if (envError) return invalid(res, envError);

    const saved = await journeys.save(journey.id, { ...value, updated_by: userId(req) });
    if (!saved) return notFound(res, 'Journey not found');
    record(req, 'journey_update', journey.id, Object.keys(value).join(','));
    return res.json(withHealth(saved, await journeys.stepsFor(saved.id)));
  }));

  // The membership, as the whole ordered list. See validateJourneySteps for why
  // it is whole-list rather than add/remove.
  router.put('/:id/steps', write, asyncHandler(async (req, res) => {
    const journey = await load(req, res);
    if (!journey) return undefined;
    const { value, errors } = validateJourneySteps(req.body);
    if (errors) return invalid(res, errors);

    // Every test must exist AND belong to this journey's application. A journey
    // is about one service; a step pointing at another application's test would
    // make its verdict a statement about something else.
    const problems = {};
    for (let i = 0; i < value.steps.length; i += 1) {
      const test = await tests.findById(value.steps[i].test_id);
      if (!test) problems[`steps.${i}`] = 'that test does not exist';
      else if (test.application_id !== journey.application_id) {
        problems[`steps.${i}`] = 'that test belongs to a different application';
      }
    }
    if (Object.keys(problems).length) return invalid(res, problems);

    const steps = await journeys.setSteps(journey.id, value.steps);
    record(req, 'journey_steps', journey.id, `steps=${steps.length}`);
    return res.json(withHealth(journey, steps));
  }));

  router.delete('/:id', write, asyncHandler(async (req, res) => {
    const journey = await load(req, res);
    if (!journey) return undefined;
    await journeys.remove(journey.id);
    record(req, 'journey_delete', journey.id, journey.name);
    // The tests survive. A journey is a way of reading them, not their owner —
    // deleting the description of a service must not delete the monitoring.
    return res.status(204).end();
  }));

  async function checkEnvironment(value, applicationId) {
    if (value.environment_id === undefined || value.environment_id === null) return null;
    const env = await environments.findById(value.environment_id);
    if (!env) return { environment_id: 'that environment does not exist' };
    if (env.application_id !== applicationId) {
      return { environment_id: 'that environment belongs to a different application' };
    }
    return null;
  }

  return router;
}

module.exports = { createJourneysRouter };
