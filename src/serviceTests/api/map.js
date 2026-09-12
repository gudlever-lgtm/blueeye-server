'use strict';

const express = require('express');
const { asyncHandler, parseId } = require('./helpers');
const { buildServiceMap } = require('../analysis/serviceMap');
const { journeyHealth } = require('../journeys/health');

// Service Map (V2 §11, P2 #10).
//
//     Application → User Journey → Web page → API → Endpoint
//
// Computed on read, never stored. That is the line between this and the CMDB
// the spec warns against: a stored map is a claim about the world that somebody
// has to maintain and that quietly rots, while this one can only ever show what
// the runs actually observed. A relation that stops being observed stops being
// drawn, without anybody having to remember to delete it.
//
// Read-only by design. There is no route here to add, edit or annotate a node —
// the moment one exists, the map has opinions of its own and the rot starts.

// How many tests one map walks. Beyond this the picture is unreadable anyway,
// and the response says it was truncated rather than pretending otherwise.
const MAX_TESTS = 200;

function createMapRouter({ repositories, requireRole, roles }) {
  const router = express.Router();
  const { applications, journeys, runs, tests } = repositories;
  const read = requireRole(roles.VIEWER, roles.OPERATOR, roles.ADMIN);

  router.get('/', read, asyncHandler(async (req, res) => {
    const applicationId = parseId(req.query.application_id);
    if (applicationId === null) return res.status(400).json({ error: 'application_id is required' });
    const application = await applications.findById(applicationId);
    if (!application) return res.status(404).json({ error: 'Application not found' });

    // How much history to look at. A map built from one run is a map of one
    // afternoon; a map built from everything is slow and says the same thing.
    const perTest = Math.min(Math.max(parseId(req.query.runs) || 10, 1), 50);

    const journeyList = journeys ? await journeys.list({ applicationId }) : [];
    const byJourney = journeys && journeyList.length
      ? await journeys.stepsForMany(journeyList.map((j) => j.id))
      : new Map();

    const shaped = journeyList.map((j) => {
      const steps = byJourney.get(j.id) || [];
      return {
        id: j.id,
        name: j.name,
        criticality: j.criticality,
        // The verdict comes from the same place the Journeys screen gets it, so
        // the map and the list can never disagree about whether something works.
        health: journeyHealth(steps),
        steps: steps.map((s) => ({
          test_id: s.test_id,
          label: s.label || (s.test && s.test.name) || null,
          required: s.required,
        })),
      };
    });

    // Every test of this application, so ones nobody has grouped into a journey
    // still appear. Hiding them because nobody got round to grouping them would
    // make the map lie by omission — they are monitoring that exists.
    const allTests = await tests.list({ applicationId });
    // One query per test, so it is bounded rather than open-ended: an
    // application with three hundred tests would otherwise hold a connection
    // while it made three hundred round trips, and the map is a page somebody
    // opens while something is already wrong.
    const walked = allTests.slice(0, MAX_TESTS);
    const runsByTest = new Map();
    for (const test of walked) {
      const list = await runs.list({ testId: test.id, limit: perTest });
      // The test's name rides along so an ungrouped node can be labelled.
      runsByTest.set(test.id, list.map((r) => ({ ...r, test_name: test.name })));
    }

    const map = buildServiceMap({
      application: { id: application.id, name: application.name },
      journeys: shaped,
      runsByTest,
    });

    return res.json({
      application: { id: application.id, name: application.name },
      ...map,
      // Said out loud in the response, because the first question anyone asks of
      // a map like this is "is this everything".
      observed_from: {
        runs_per_test: perTest,
        tests: walked.length,
        // Said out loud when the map is not the whole picture. A map that
        // quietly shows two thirds of an estate is worse than one that says so.
        tests_total: allTests.length,
        truncated: allTests.length > walked.length,
        note: 'Built only from what runs observed. Nothing here is inferred or entered by hand.',
      },
    });
  }));

  return router;
}

module.exports = { createMapRouter };
