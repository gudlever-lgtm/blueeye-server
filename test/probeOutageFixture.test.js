'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createProbeOutageService } = require('../src/probeOutages/probeOutageService');
const { makeProbeOutagesRepo, makeProbeThresholdsRepo, makeProbeResultsRepo, makeAgentsRepo } = require('../test-support/fakes');
const { probeOutageFixture, fixtureAt } = require('../test-support/probeOutageFixture');

test('the seed fixture derives exactly one warning and one critical outage', async () => {
  const probeOutagesRepo = makeProbeOutagesRepo();
  const thresholdsRepo = makeProbeThresholdsRepo(); // seeded global defaults
  const agentsRepo = makeAgentsRepo({ findById: async (id) => ({ id, hostname: 'h', location_id: 1 }) });
  const probeResultsRepo = makeProbeResultsRepo({ findByAgent: async () => probeOutageFixture.slice() });
  const svc = createProbeOutageService({ probeOutagesRepo, thresholdsRepo, agentsRepo, probeResultsRepo, now: () => fixtureAt(60) });

  const res = await svc.processAgent(9);
  assert.equal(res.opened, 2);

  const severities = probeOutagesRepo.rows.map((r) => r.severity).sort();
  assert.deepEqual(severities, ['critical', 'warning']);

  const warning = probeOutagesRepo.rows.find((r) => r.severity === 'warning');
  const critical = probeOutagesRepo.rows.find((r) => r.severity === 'critical');
  assert.equal(warning.metric, 'latency');
  assert.equal(warning.affected_target, 'edge-gw');
  assert.equal(critical.metric, 'reachability');
  assert.equal(critical.affected_target, '8.8.8.8');
});
