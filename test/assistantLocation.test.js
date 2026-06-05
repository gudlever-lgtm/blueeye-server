'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAssistant } = require('../src/analysis/assistant');

// A fake Mistral chat-completions endpoint that echoes a canned answer.
function fakeFetch(answer) {
  return async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: answer } }] }) });
}
const cfg = { assistantEnabled: true, assistantApiKey: 'k', assistantModel: 'm' };

test('summarizeLocation throws FeatureDisabled when off', async () => {
  const a = createAssistant({ config: { assistantEnabled: false }, findingStore: { list: async () => [] }, locationsRepo: {}, agentsRepo: {} });
  await assert.rejects(() => a.summarizeLocation(1), (e) => e.name === 'FeatureDisabled');
});

test('summarizeLocation throws LocationNotFound for an unknown location', async () => {
  const a = createAssistant({
    config: cfg,
    findingStore: { list: async () => [] },
    locationsRepo: { findById: async () => null },
    agentsRepo: { findAll: async () => [] },
    fetchImpl: fakeFetch('x'),
  });
  await assert.rejects(() => a.summarizeLocation(1), (e) => e.name === 'LocationNotFound');
});

test('summarizeLocation summarizes a location from its agents + findings only', async () => {
  const a = createAssistant({
    config: cfg,
    findingStore: { list: async (hostId) => (hostId === '1' ? [{ metric: 'cpu', severity: 'WARN', explanation: 'cpu high', createdAt: '2026-06-01T00:00:00Z' }] : []) },
    locationsRepo: { findById: async (id) => ({ id, name: 'HQ' }) },
    agentsRepo: { findAll: async () => [
      { id: 1, hostname: 'a1', status: 'online', location_id: 5 },
      { id: 2, hostname: 'a2', status: 'offline', location_id: 9 }, // different location — excluded
    ] },
    probeResultsRepo: { findByAgent: async () => [] },
    fetchImpl: fakeFetch('All good at HQ.'),
  });
  const res = await a.summarizeLocation(5);
  assert.equal(res.answer, 'All good at HQ.');
  assert.equal(res.location, 'HQ');
  assert.equal(res.agents, 1); // only the agent in location 5
  assert.equal(res.findings, 1);
});

test('summarizeLocation is AssistantMisconfigured when repos are not wired', async () => {
  const a = createAssistant({ config: cfg, findingStore: { list: async () => [] }, fetchImpl: fakeFetch('x') });
  await assert.rejects(() => a.summarizeLocation(1), (e) => e.name === 'AssistantMisconfigured');
});
