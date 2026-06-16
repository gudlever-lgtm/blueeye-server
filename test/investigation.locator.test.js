'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createLocator } = require('../src/investigation/locator');
const { makeFindingStore, makeAgentsRepo } = require('../test-support/fakes');

// ---- helpers ----------------------------------------------------------------

function makeLocator(agentsOverrides = {}, findingStoreOverrides = {}) {
  return createLocator({
    agentsRepo: makeAgentsRepo(agentsOverrides),
    findingStore: makeFindingStore(findingStoreOverrides),
  });
}

function nowISO() { return new Date().toISOString(); }

function fakeFinding(hostId, metric, severity = 'CRIT', deviation = 8, offsetMs = 0) {
  return {
    id: `f-${hostId}-${metric}-${Date.now()}-${Math.random()}`,
    hostId: String(hostId),
    metric,
    severity,
    kind: 'ANOMALY',
    observed: 10,
    baseline: 2,
    deviation,
    explanation: `${metric} er ${deviation}σ over baseline`,
    evidence: [{ ts: new Date().toISOString(), value: 10 }],
    createdAt: new Date(Date.now() + offsetMs).toISOString(),
  };
}

// ---- guarantee: every result has non-empty explanation and evidence ---------

test('guarantee: all classifications produce non-empty explanation and evidence', async () => {
  const AGENT_ID = '1';
  const NEIGHBOR_ID = '2';

  // LOCAL
  const localFinding = fakeFinding(AGENT_ID, 'rx.errors');
  const localLocator = createLocator({
    agentsRepo: makeAgentsRepo({
      findAll: async () => [
        { id: AGENT_ID, hostname: 'local-host', location_id: 1, status: 'online' },
      ],
    }),
    findingStore: makeFindingStore({ list: async (hostId) => (hostId === AGENT_ID ? [localFinding] : []) }),
  });
  const localResult = await localLocator.runInvestigation({ locationRef: { type: 'agent', value: AGENT_ID } });
  assert.ok(typeof localResult.explanation === 'string' && localResult.explanation.length > 0, 'LOCAL explanation non-empty');
  assert.ok(Array.isArray(localResult.evidence) && localResult.evidence.length > 0, 'LOCAL evidence non-empty');

  // UPSTREAM
  const localFinding2 = fakeFinding(AGENT_ID, 'rx.errors', 'CRIT', 8, 0); // fires NOW
  const neighborFinding = fakeFinding(NEIGHBOR_ID, 'rx.errors', 'CRIT', 9, -5 * 60 * 1000); // 5 min earlier

  const upstreamLocator = createLocator({
    agentsRepo: makeAgentsRepo({
      findAll: async () => [
        { id: AGENT_ID, hostname: 'local-host', location_id: 1, status: 'online' },
        { id: NEIGHBOR_ID, hostname: 'upstream-host', location_id: 2, status: 'online' },
      ],
    }),
    findingStore: makeFindingStore({
      list: async (hostId) => {
        if (hostId === AGENT_ID) return [localFinding2];
        if (hostId === NEIGHBOR_ID) return [neighborFinding];
        return [];
      },
    }),
  });
  const upstreamResult = await upstreamLocator.runInvestigation({ locationRef: { type: 'agent', value: AGENT_ID } });
  assert.ok(upstreamResult.explanation.length > 0, 'UPSTREAM explanation non-empty');
  assert.ok(upstreamResult.evidence.length > 0, 'UPSTREAM evidence non-empty');

  // APP_NOT_NET
  const appFinding = fakeFinding(AGENT_ID, 'tcp.retransmits', 'WARN', 5);
  const appLocator = createLocator({
    agentsRepo: makeAgentsRepo({
      findAll: async () => [{ id: AGENT_ID, hostname: 'app-host', location_id: 1, status: 'online' }],
    }),
    findingStore: makeFindingStore({ list: async (hostId) => (hostId === AGENT_ID ? [appFinding] : []) }),
  });
  const appResult = await appLocator.runInvestigation({ locationRef: { type: 'agent', value: AGENT_ID } });
  assert.ok(appResult.explanation.length > 0, 'APP_NOT_NET explanation non-empty');
  assert.ok(appResult.evidence.length > 0, 'APP_NOT_NET evidence non-empty');

  // INSUFFICIENT_DATA (no agents)
  const emptyLocator = createLocator({
    agentsRepo: makeAgentsRepo({ findAll: async () => [] }),
    findingStore: makeFindingStore(),
  });
  const emptyResult = await emptyLocator.runInvestigation({ locationRef: { type: 'agent', value: '99' } });
  assert.ok(emptyResult.explanation.length > 0, 'INSUFFICIENT_DATA explanation non-empty');
  assert.ok(emptyResult.evidence.length > 0, 'INSUFFICIENT_DATA evidence non-empty');
});

// ---- LOCAL classification ---------------------------------------------------

test('classifies LOCAL when anomalies are only on the local agent', async () => {
  const AGENT_ID = '1';
  const finding = fakeFinding(AGENT_ID, 'rx.errors');
  const locator = createLocator({
    agentsRepo: makeAgentsRepo({
      findAll: async () => [
        { id: AGENT_ID, hostname: 'local', location_id: 1, status: 'online' },
        { id: '2', hostname: 'neighbor', location_id: 2, status: 'online' },
      ],
    }),
    findingStore: makeFindingStore({
      list: async (hostId) => (hostId === AGENT_ID ? [finding] : []),
    }),
  });

  const result = await locator.runInvestigation({ locationRef: { type: 'agent', value: AGENT_ID } });
  assert.equal(result.classification, 'LOCAL');
  assert.ok(result.confidence > 0.5);
  assert.ok(result.explanation.includes('lokalt'));
  assert.ok(result.evidence.length > 0);
});

// ---- UPSTREAM classification ------------------------------------------------

test('classifies UPSTREAM when neighbor anomaly predates local by >3 min', async () => {
  const AGENT_ID = '1';
  const NEIGHBOR_ID = '2';
  const neighborFinding = fakeFinding(NEIGHBOR_ID, 'rx.errors', 'CRIT', 9, -5 * 60 * 1000);
  const localFinding = fakeFinding(AGENT_ID, 'rx.drops', 'WARN', 4, 0);

  const locator = createLocator({
    agentsRepo: makeAgentsRepo({
      findAll: async () => [
        { id: AGENT_ID, hostname: 'edge', location_id: 1, status: 'online' },
        { id: NEIGHBOR_ID, hostname: 'core', location_id: 2, status: 'online' },
      ],
    }),
    findingStore: makeFindingStore({
      list: async (hostId) => {
        if (hostId === AGENT_ID) return [localFinding];
        if (hostId === NEIGHBOR_ID) return [neighborFinding];
        return [];
      },
    }),
  });

  const result = await locator.runInvestigation({ locationRef: { type: 'agent', value: AGENT_ID } });
  assert.equal(result.classification, 'UPSTREAM');
  assert.ok(result.suspectedSegment !== null);
  assert.ok(result.explanation.toLowerCase().includes('upstream') || result.explanation.includes('opstrøms'));
  assert.ok(result.evidence.length > 0);
  assert.ok(result.relatedFindingIds.length >= 2);
});

// ---- APP_NOT_NET classification ---------------------------------------------

test('classifies APP_NOT_NET when only TCP metrics anomalous, no net counters', async () => {
  const AGENT_ID = '1';
  const appFinding = fakeFinding(AGENT_ID, 'tcp.retransmits', 'WARN', 5);

  const locator = createLocator({
    agentsRepo: makeAgentsRepo({
      findAll: async () => [{ id: AGENT_ID, hostname: 'app-srv', location_id: 1, status: 'online' }],
    }),
    findingStore: makeFindingStore({
      list: async (hostId) => (hostId === AGENT_ID ? [appFinding] : []),
    }),
  });

  const result = await locator.runInvestigation({ locationRef: { type: 'agent', value: AGENT_ID } });
  assert.equal(result.classification, 'APP_NOT_NET');
  assert.ok(result.confidence >= 0.5);
  assert.ok(result.explanation.includes('applikation') || result.explanation.includes('Applikation'));
  assert.ok(result.evidence.length > 0);
  assert.equal(result.suspectedSegment, null);
});

// ---- INSUFFICIENT_DATA classification --------------------------------------

test('classifies INSUFFICIENT_DATA when no agents match the locationRef', async () => {
  const locator = createLocator({
    agentsRepo: makeAgentsRepo({ findAll: async () => [] }),
    findingStore: makeFindingStore(),
  });

  const result = await locator.runInvestigation({ locationRef: { type: 'agent', value: 'ghost' } });
  assert.equal(result.classification, 'INSUFFICIENT_DATA');
  assert.equal(result.confidence, 0);
  assert.ok(result.evidence.length > 0);
});

test('classifies INSUFFICIENT_DATA when no findings in window', async () => {
  const AGENT_ID = '1';
  const locator = createLocator({
    agentsRepo: makeAgentsRepo({
      findAll: async () => [{ id: AGENT_ID, hostname: 'quiet', location_id: 1, status: 'online' }],
    }),
    findingStore: makeFindingStore({ list: async () => [] }),
  });

  const result = await locator.runInvestigation({ locationRef: { type: 'agent', value: AGENT_ID } });
  assert.equal(result.classification, 'INSUFFICIENT_DATA');
  assert.ok(result.evidence.length > 0);
});

// ---- site / subnet locationRef resolution ----------------------------------

test('resolves agents by site (location_name match)', async () => {
  const locator = createLocator({
    agentsRepo: makeAgentsRepo({
      findAll: async () => [
        { id: '10', hostname: 'site-a-1', location_id: 5, location_name: 'Site A', status: 'online' },
        { id: '11', hostname: 'site-b-1', location_id: 6, location_name: 'Site B', status: 'online' },
      ],
    }),
    findingStore: makeFindingStore({ list: async (hostId) => (hostId === '10' ? [fakeFinding('10', 'rx.errors')] : []) }),
  });

  const result = await locator.runInvestigation({ locationRef: { type: 'site', value: 'Site A' } });
  // Should only look at agent 10 (Site A); classification depends on neighbors
  assert.ok(['LOCAL', 'INSUFFICIENT_DATA'].includes(result.classification));
  assert.ok(result.evidence.length > 0);
});

// ---- validation errors -----------------------------------------------------

test('throws on missing locationRef', async () => {
  const locator = makeLocator();
  await assert.rejects(
    () => locator.runInvestigation({}),
    { message: /locationRef/ }
  );
});

test('throws on unknown locationRef.type', async () => {
  const locator = makeLocator();
  await assert.rejects(
    () => locator.runInvestigation({ locationRef: { type: 'galaxy', value: 'x' } }),
    { message: /type/ }
  );
});
