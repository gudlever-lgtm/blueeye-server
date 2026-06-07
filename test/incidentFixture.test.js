'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIncidentService } = require('../src/incidents/incidentService');
const { makeIncidentsRepo, makeIncidentThresholdsRepo, makeProbeResultsRepo, makeAgentsRepo } = require('../test-support/fakes');
const { incidentProbeFixture, fixtureAt } = require('../test-support/incidentFixture');

test('the seed fixture derives exactly one warning and one critical incident', async () => {
  const incidentsRepo = makeIncidentsRepo();
  const thresholdsRepo = makeIncidentThresholdsRepo(); // seeded global defaults
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h', location_id: 1 }) });
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => incidentProbeFixture.slice() });
  const svc = createIncidentService({ incidentsRepo, thresholdsRepo, agentsRepo, probeResultsRepo, now: () => fixtureAt(60) });

  const res = await svc.processAgent(9);
  assert.equal(res.opened, 2);

  const severities = incidentsRepo.rows.map((r) => r.severity).sort();
  assert.deepEqual(severities, ['critical', 'warning']);

  const warning = incidentsRepo.rows.find((r) => r.severity === 'warning');
  const critical = incidentsRepo.rows.find((r) => r.severity === 'critical');
  assert.equal(warning.metric, 'latency');
  assert.equal(warning.affected_target, 'edge-gw');
  assert.equal(critical.metric, 'reachability');
  assert.equal(critical.affected_target, '8.8.8.8');
});
