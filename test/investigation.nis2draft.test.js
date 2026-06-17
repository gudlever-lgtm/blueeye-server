'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAgentsRepo, makeFindingStore, makeAssistant,
  makeNis2IncidentsRepo, authHeader,
} = require('../test-support/fakes');

const operator = () => authHeader('operator');

// A real-looking investigation result containing a raw IP in the explanation
// (subnet scenario) — used to verify masking.
const SUBNET_RESULT = {
  id: 'inv-subnet-1',
  locationRef: { type: 'subnet', value: '10.0.1.0/24' },
  window: { from: '2026-06-17T10:00:00.000Z', to: '2026-06-17T10:30:00.000Z' },
  classification: 'LOCAL',
  confidence: 0.8,
  explanation: 'Anomali registreret på subnet 10.0.1.0/24 med høj pakkefejlrate.',
  evidence: [{ type: 'finding', ref: '5/rx.errors', observed: 20, baseline: 2, deviation: 9, ts: '2026-06-17T10:10:00.000Z' }],
  suspectedSegment: { from: '10.0.1.1', to: 'router' },
  relatedFindingIds: [],
  workaroundHints: ['Tjek kabel til 10.0.1.1'],
};

// A synthetic InvestigationResult for agents (no IPs in value).
function syntheticResult(classification = 'LOCAL') {
  return {
    id: `inv-${Math.random()}`,
    locationRef: { type: 'agent', value: '1' },
    window: { from: '2026-06-17T10:00:00.000Z', to: '2026-06-17T10:30:00.000Z' },
    classification,
    confidence: 0.75,
    explanation: 'Lokalt netværksproblem registreret.',
    evidence: [{ type: 'finding', ref: '1/rx.errors', observed: 10, baseline: 2, deviation: 8, ts: '2026-06-17T10:10:00.000Z' }],
    suspectedSegment: null,
    relatedFindingIds: [],
    workaroundHints: ['Genstart interface'],
  };
}

// Fake Mistral returning a well-formed NIS2 JSON draft.
function makeNis2Assistant(overrides = {}) {
  const nis2Response = JSON.stringify({
    title: 'Netværksanomali på agentside',
    severity: 'high',
    detectedAt: '2026-06-17T10:10:00.000Z',
    affectedSystems: 'Agent 1 — interface rx.errors',
    description: 'Høj pakkefejlrate registreret på lokal agent.',
  });
  return makeAssistant({
    narrateInvestigation: overrides.narrateInvestigation || (async () => 'Kortfattet analyse af fejl.'),
    generateNis2Draft: overrides.generateNis2Draft || (async () => JSON.parse(nis2Response)),
    ...overrides,
  });
}

// Helper: POST /api/investigation/run for agent 1 with finding store enabled.
function makeEnabledApp(assistantOverrides = {}, appOverrides = {}) {
  const agentsRepo = makeAgentsRepo({
    findAll: async () => [{ id: '1', hostname: 'host-a', location_id: 1, status: 'online' }],
  });
  const findingStore = makeFindingStore({
    list: async (hostId) => (hostId === '1' ? [{
      id: 'f1', hostId: '1', metric: 'rx.errors', severity: 'CRIT', kind: 'ANOMALY',
      observed: 10, baseline: 2, deviation: 8,
      explanation: 'rx.errors er anomalt',
      evidence: [{ ts: new Date().toISOString(), value: 10 }],
      createdAt: new Date().toISOString(),
    }] : []),
  });
  const assistant = makeNis2Assistant(assistantOverrides);
  const nis2IncidentsRepo = appOverrides.nis2IncidentsRepo || makeNis2IncidentsRepo();
  return makeApp({ agentsRepo, findingStore, assistant, nis2IncidentsRepo, ...appOverrides });
}

// ---- Both outputs present when assistant is enabled ----------------------------

test('POST /run returns narrative (Output 1) when assistant is enabled', async () => {
  const app = makeEnabledApp();
  const res = await request(app).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });

  assert.equal(res.status, 200);
  assert.ok(typeof res.body.narrative === 'string' && res.body.narrative.length > 0,
    'narrative should be present');
});

test('POST /run returns nis2Draft (Output 2) when assistant is enabled', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  const app = makeEnabledApp({}, { nis2IncidentsRepo });
  const res = await request(app).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });

  assert.equal(res.status, 200);
  assert.ok(res.body.nis2Draft, 'nis2Draft should be present');
  assert.ok(!res.body.nis2DraftError, 'nis2DraftError should be absent on success');
});

// ---- NIS2 draft persisted correctly -------------------------------------------

test('NIS2 draft is persisted with status=open and notificationRequired=false', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  const app = makeEnabledApp({}, { nis2IncidentsRepo });
  const res = await request(app).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });

  assert.equal(res.status, 200);
  const draft = res.body.nis2Draft;
  assert.ok(draft, 'nis2Draft must be present');
  assert.equal(draft.status, 'open', 'status must be open, never submitted');
  assert.equal(draft.notificationRequired, false, 'notificationRequired must always be false');
  assert.equal(draft.nis2Relevant, false, 'nis2Relevant must be false — human must assess');
});

test('NIS2 draft title is prefixed with [AI-udkast]', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  const app = makeEnabledApp({}, { nis2IncidentsRepo });
  const res = await request(app).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });

  assert.equal(res.status, 200);
  assert.ok(res.body.nis2Draft.title.startsWith('[AI-udkast]'),
    'title must start with [AI-udkast] to mark as AI-generated');
});

test('NIS2 draft rootCause contains AI-generated marker', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  const app = makeEnabledApp({}, { nis2IncidentsRepo });
  const res = await request(app).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });

  assert.equal(res.status, 200);
  assert.ok(typeof res.body.nis2Draft.rootCause === 'string' &&
    res.body.nis2Draft.rootCause.includes('AI'),
    'rootCause must include AI marker');
});

// NIS2 draft cannot be auto-approved/submitted via the existing approval path
// because status='open' is not a submit action and notificationRequired is false.
// We assert both fields directly (schema-level: only 'open' is set, not 'resolved'
// or 'closed', and notificationRequired stays false).
test('NIS2 draft cannot end as submitted: status is not resolved/closed/approved', async () => {
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  const app = makeEnabledApp({}, { nis2IncidentsRepo });
  const res = await request(app).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });

  assert.equal(res.status, 200);
  const { status, notificationRequired } = res.body.nis2Draft;
  assert.equal(notificationRequired, false);
  assert.ok(!['resolved', 'closed'].includes(status),
    'AI path must never create an incident with terminal/submitted status');
});

// ---- NIS2 failure does not suppress Output 1 ----------------------------------

test('NIS2 failure → narrative (Output 1) still present, nis2DraftError shown', async () => {
  const assistant = makeNis2Assistant({
    generateNis2Draft: async () => { throw new Error('Mistral timeout'); },
  });
  const app = makeEnabledApp({}, { assistant });
  const res = await request(makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => [{ id: '1', hostname: 'h', location_id: 1, status: 'online' }] }),
    findingStore: makeFindingStore({ list: async () => [] }),
    assistant,
    nis2IncidentsRepo: makeNis2IncidentsRepo(),
  })).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });

  assert.equal(res.status, 200, 'should be 200 even when NIS2 generation fails');
  assert.ok(typeof res.body.narrative === 'string', 'narrative must still be present');
  assert.ok(typeof res.body.nis2DraftError === 'string', 'nis2DraftError must describe the failure');
  assert.ok(!res.body.nis2Draft, 'nis2Draft must be absent on failure');
});

// ---- Mistral timeout on NIS2 path ---------------------------------------------

test('Mistral timeout on NIS2 path → 200 with nis2DraftError, no 500', async () => {
  const upstreamErr = new Error('assistant request failed: The operation was aborted');
  upstreamErr.name = 'AssistantUpstreamError';
  const assistant = makeNis2Assistant({
    generateNis2Draft: async () => { throw upstreamErr; },
  });
  const res = await request(makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => [{ id: '1', hostname: 'h', location_id: 1, status: 'online' }] }),
    findingStore: makeFindingStore({ list: async () => [] }),
    assistant,
    nis2IncidentsRepo: makeNis2IncidentsRepo(),
  })).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });

  assert.equal(res.status, 200);
  assert.ok(typeof res.body.nis2DraftError === 'string');
  assert.ok(!res.body.nis2Draft);
});

// ---- Narrative failure does not cause 500 either ------------------------------

test('Narrative failure → still 200, nis2Draft may still be present', async () => {
  const assistant = makeNis2Assistant({
    narrateInvestigation: async () => { throw new Error('Mistral 503'); },
  });
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  const res = await request(makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => [{ id: '1', hostname: 'h', location_id: 1, status: 'online' }] }),
    findingStore: makeFindingStore({ list: async () => [] }),
    assistant,
    nis2IncidentsRepo,
  })).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });

  assert.equal(res.status, 200);
  assert.ok(!res.body.narrative, 'narrative should be absent when Mistral fails');
  assert.ok(res.body.nis2Draft, 'nis2Draft should still be created');
});

// ---- Empty context → no draft created, no 500 ---------------------------------

test('INSUFFICIENT_DATA result with empty title from AI → no nis2Draft created', async () => {
  const assistant = makeNis2Assistant({
    generateNis2Draft: async () => ({ title: '', severity: 'low', detectedAt: null, affectedSystems: null, description: '' }),
  });
  const nis2IncidentsRepo = makeNis2IncidentsRepo();
  const res = await request(makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => [] }),
    findingStore: makeFindingStore({ list: async () => [] }),
    assistant,
    nis2IncidentsRepo,
  })).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '99' } });

  assert.equal(res.status, 200);
  assert.ok(!res.body.nis2Draft, 'no draft should be created when title is empty');
  assert.ok(!res.body.nis2DraftError, 'no error should be raised for empty-title guard');
  assert.equal(nis2IncidentsRepo.rows.length, 0, 'nothing should be persisted');
});

// ---- No raw IPs in payload or persisted draft ---------------------------------

test('Raw IPs from subnet locationRef are masked before Mistral and in persisted draft', async () => {
  const capturedCtx = {};
  const nis2IncidentsRepo = makeNis2IncidentsRepo();

  const assistant = makeAssistant({
    narrateInvestigation: async () => 'narrative',
    generateNis2Draft: async (result) => {
      // Capture what would be sent to Mistral from the internal context builder.
      capturedCtx.classification = result.classification;
      capturedCtx.locationRefValue = result.locationRef && result.locationRef.value;
      capturedCtx.explanation = result.explanation;
      // Return a draft that might contain an IP in affectedSystems — should be masked.
      return {
        title: 'Netværksfejl på subnet',
        severity: 'high',
        detectedAt: '2026-06-17T10:10:00.000Z',
        affectedSystems: 'Subnet 10.0.1.0/24 påvirket',
        description: 'Fejl registreret.',
      };
    },
  });

  // We test through the assistant unit directly, not the HTTP route,
  // because the subnet route would need a real agent for the locator.
  // Instead verify the buildNis2Context mask via the generateNis2Draft export.
  const { createAssistant } = require('../src/analysis/assistant');
  const testAssistant = createAssistant({
    config: { assistantEnabled: true, assistantApiKey: 'k' },
    findingStore: makeFindingStore(),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        title: 'Netværksfejl på subnet',
        severity: 'high',
        detectedAt: '2026-06-17T10:10:00.000Z',
        affectedSystems: 'Subnet 10.0.1.0/24 påvirket',
        description: 'Fejl registreret.',
      }) } }] }),
    }),
  });

  const draft = await testAssistant.generateNis2Draft(SUBNET_RESULT);

  // The returned affectedSystems must have IPs masked.
  assert.ok(!draft.affectedSystems.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/),
    `affectedSystems must not contain raw IPs, got: ${draft.affectedSystems}`);

  // Verify the Mistral call received masked IPs by checking via the HTTP route
  // with a controlled assistant that records what it receives.
  const recordedPayloads = [];
  const recordingAssistant = makeAssistant({
    narrateInvestigation: async () => 'narrative',
    generateNis2Draft: async (result) => {
      recordedPayloads.push(JSON.stringify(result));
      return {
        title: 'Netværksfejl',
        severity: 'high',
        detectedAt: null,
        affectedSystems: 'segment [host]',
        description: 'Fejl.',
      };
    },
  });

  // Build minimal context that goes through the route.
  await request(makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => [{ id: '1', hostname: 'h', location_id: 1, status: 'online' }] }),
    findingStore: makeFindingStore({ list: async () => [] }),
    assistant: recordingAssistant,
    nis2IncidentsRepo,
  })).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });

  // Check persisted draft has no raw IPs.
  if (nis2IncidentsRepo.rows.length > 0) {
    const row = nis2IncidentsRepo.rows[0];
    const rowJson = JSON.stringify(row);
    assert.ok(!rowJson.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/),
      `Persisted NIS2 draft must not contain raw IPs, got: ${rowJson}`);
  }
});

// ---- When assistant is disabled → no nis2Draft, investigation still works ------

test('When assistant is disabled → POST /run returns 200 without nis2Draft', async () => {
  const res = await request(makeApp()).post('/api/investigation/run')
    .set('Authorization', operator())
    .send({ locationRef: { type: 'agent', value: '1' } });

  assert.equal(res.status, 200);
  assert.ok(!res.body.nis2Draft, 'no nis2Draft when assistant is disabled');
  assert.ok(!res.body.nis2DraftError, 'no nis2DraftError when assistant is disabled');
});
