'use strict';

const { numOrNull } = require('../storage/shape');

// Service Map (V2 §11, P2 #10).
//
//     Application → User Journey → Web page → API → Endpoint
//
// The spec's own warning is the design constraint: *det skal ikke blive en ny
// CMDB*. So this map has no inventory, no manual entry, no editing and no
// notion of a thing that ought to exist. Every node and every edge comes from
// something a run actually did:
//
//   * a journey is a journey somebody defined;
//   * a page is a page a test opened;
//   * an endpoint is a URL a page actually called, with its own path collapsed
//     to a shape;
//   * an edge exists because one was observed leading to the other.
//
// Nothing is inferred, nothing is assumed, and a relation that stops being
// observed stops being drawn — because the map is recomputed from the runs, not
// stored and maintained. That is the whole difference between this and a CMDB:
// a CMDB tells you what someone once said the world looked like.
//
// PURE: journeys, their tests, and the runs' observations in; nodes and edges
// out. No database, no clock.

// Path segments that are identifiers rather than structure. Collapsing them is
// what turns ten thousand observed URLs into the handful of ENDPOINTS a person
// can read — /api/customers/4711 and /api/customers/4712 are one endpoint.
const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEXISH = /^[0-9a-f]{16,}$/i;

// A URL reduced to the endpoint it belongs to.
//
//   https://api.kunde.dk/customers/4711/cases?open=1  ->  api.kunde.dk /customers/{id}/cases
//
// The query string is dropped entirely: it is where identifiers and secrets
// live, and an endpoint is not a different endpoint because it was called with
// a different filter.
function endpointOf(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const segments = url.pathname.split('/').filter(Boolean).map((seg) => {
    if (NUMERIC.test(seg) || UUID.test(seg) || HEXISH.test(seg)) return '{id}';
    return seg.length > 40 ? '{…}' : seg;
  });
  // More than six segments is a path nobody reads; the tail is the noisy part.
  const path = `/${segments.slice(0, 6).join('/')}`;
  return { host: url.host, path, id: `${url.host}${path}` };
}

const key = (kind, id) => `${kind}:${id}`;

// Builds the map.
//
//   buildServiceMap({ application, journeys, runsByTest })
//     -> { nodes: [...], edges: [...], counts }
//
// `journeys`   : [{ id, name, criticality, steps: [{ test_id, label, required }] }]
// `runsByTest` : Map(test_id -> [{ id, status, api_calls, steps }])
//
// A test that belongs to no journey still appears — it is monitoring somebody
// set up, and hiding it because nobody grouped it yet would make the map lie by
// omission.
function buildServiceMap({ application = null, journeys = [], runsByTest = new Map() } = {}) {
  const nodes = new Map();
  const edges = new Map();

  const addNode = (kind, id, label, extra = {}) => {
    const k = key(kind, id);
    if (!nodes.has(k)) nodes.set(k, { id: k, kind, key: String(id), label, observations: 0, ...extra });
    return nodes.get(k);
  };
  const addEdge = (from, to, kind) => {
    if (!from || !to) return;
    const k = `${from.id}->${to.id}`;
    if (!edges.has(k)) edges.set(k, { id: k, from: from.id, to: to.id, kind, observations: 0 });
    const edge = edges.get(k);
    edge.observations += 1;
    return edge;
  };

  const appNode = application
    ? addNode('application', application.id, application.name || `application ${application.id}`)
    : null;

  const getRuns = (testId) => {
    const list = runsByTest instanceof Map ? runsByTest.get(testId) : (runsByTest || {})[testId];
    return Array.isArray(list) ? list : [];
  };

  // Which tests a journey claims, so the loose ones can be found afterwards.
  const inJourney = new Set();

  for (const journey of (Array.isArray(journeys) ? journeys : [])) {
    if (!journey || typeof journey !== 'object') continue;
    const jNode = addNode('journey', journey.id, journey.name || `journey ${journey.id}`, {
      criticality: journey.criticality || 'normal',
      health: journey.health ? journey.health.status : null,
    });
    if (appNode) addEdge(appNode, jNode, 'contains');

    for (const step of (Array.isArray(journey.steps) ? journey.steps : [])) {
      if (!step || step.test_id === undefined) continue;
      inJourney.add(step.test_id);
      const tNode = addNode('test', step.test_id, step.label || `test ${step.test_id}`, {
        required: step.required !== false,
      });
      addEdge(jNode, tNode, 'verified-by');
      attachObservations(tNode, getRuns(step.test_id));
    }
  }

  // Tests nobody has grouped into a journey yet.
  const looseIds = [...(runsByTest instanceof Map ? runsByTest.keys() : Object.keys(runsByTest || {}))]
    .map((k) => (typeof k === 'string' && NUMERIC.test(k) ? Number(k) : k))
    .filter((id) => !inJourney.has(id));
  for (const testId of looseIds) {
    const runs = getRuns(testId);
    if (!runs.length) continue;
    const tNode = addNode('test', testId, runs[0].test_name || `test ${testId}`, { ungrouped: true });
    if (appNode) addEdge(appNode, tNode, 'contains');
    attachObservations(tNode, runs);
  }

  function attachObservations(testNode, runs) {
    for (const run of runs) {
      if (!run || typeof run !== 'object') continue;
      testNode.observations += 1;

      // The pages this test opened. From the step rows, because that is what was
      // actually navigated to rather than what the definition intended.
      for (const step of (Array.isArray(run.steps) ? run.steps : [])) {
        const url = step && step.detail && step.detail.url;
        const page = url ? endpointOf(url) : null;
        if (!page) continue;
        const pNode = addNode('page', page.id, page.path === '/' ? page.host : page.path, { host: page.host });
        pNode.observations += 1;
        addEdge(testNode, pNode, 'visits');

        // And the calls those pages made. Attached to the test rather than to a
        // particular page: a run records which calls happened, not which page
        // made each one, and pretending otherwise would be inventing a relation
        // nobody observed.
      }

      for (const call of (Array.isArray(run.api_calls) ? run.api_calls : [])) {
        const endpoint = call && call.url ? endpointOf(call.url) : null;
        if (!endpoint) continue;
        const status = numOrNull(call.status);
        const eNode = addNode('endpoint', endpoint.id, `${endpoint.path}`, {
          host: endpoint.host,
          methods: [],
          failures: 0,
        });
        eNode.observations += 1;
        if (call.method && !eNode.methods.includes(call.method)) eNode.methods.push(call.method);
        if (status === 0 || (status !== null && status >= 400)) eNode.failures += 1;
        addEdge(testNode, eNode, 'calls');
      }
    }
  }

  const nodeList = [...nodes.values()];
  return {
    nodes: nodeList,
    edges: [...edges.values()],
    counts: {
      journeys: nodeList.filter((n) => n.kind === 'journey').length,
      tests: nodeList.filter((n) => n.kind === 'test').length,
      pages: nodeList.filter((n) => n.kind === 'page').length,
      endpoints: nodeList.filter((n) => n.kind === 'endpoint').length,
      // The number an operator cares about: endpoints that have failed at least
      // once while a journey was watching.
      failing_endpoints: nodeList.filter((n) => n.kind === 'endpoint' && n.failures > 0).length,
    },
  };
}

module.exports = { buildServiceMap, endpointOf };
