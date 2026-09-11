'use strict';

// Service Map (V2 §11).
//
// The spec's warning is the design constraint: *det skal ikke blive en ny CMDB*.
// So most of these specs are about what the map refuses to contain — anything
// nobody observed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildServiceMap, endpointOf } = require('../serviceMap');

const kinds = (map, kind) => map.nodes.filter((n) => n.kind === kind);
const labels = (map, kind) => kinds(map, kind).map((n) => n.label).sort();

test('identifiers in a path collapse, so a map has endpoints rather than URLs', () => {
  // Ten thousand observed URLs are not ten thousand endpoints, and a map that
  // thinks they are is unreadable at exactly the size where it would be useful.
  assert.deepEqual(endpointOf('https://api.kunde.dk/customers/4711/cases?open=1').path, '/customers/{id}/cases');
  assert.equal(
    endpointOf('https://api.kunde.dk/customers/4711/cases').id,
    endpointOf('https://api.kunde.dk/customers/4712/cases').id
  );
  assert.equal(endpointOf('https://x.dk/items/550e8400-e29b-41d4-a716-446655440000').path, '/items/{id}');
  assert.equal(endpointOf('https://x.dk/blob/a1b2c3d4e5f60718').path, '/blob/{id}');
  // The query string is dropped entirely: it is where identifiers and secrets
  // live, and a filter does not make a different endpoint.
  assert.equal(endpointOf('https://x.dk/a?token=secret').id, 'x.dk/a');
});

test('only http(s) URLs become endpoints', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'not a url', '', null, undefined, 'file:///etc/passwd']) {
    assert.equal(endpointOf(bad), null, `${JSON.stringify(bad)} must not become a node`);
  }
});

test('the map is application → journey → test → page/endpoint, from observations', () => {
  const map = buildServiceMap({
    application: { id: 1, name: 'Customer Portal' },
    journeys: [{ id: 1, name: 'Customer login', criticality: 'high', steps: [{ test_id: 1, label: 'Login', required: true }] }],
    runsByTest: new Map([[1, [{
      id: 1,
      status: 'pass',
      steps: [{ detail: { url: 'https://kunde.dk/login' } }],
      api_calls: [
        { method: 'POST', url: 'https://api.kunde.dk/auth/login', status: 200 },
        { method: 'GET', url: 'https://api.kunde.dk/customers/4711', status: 500 },
      ],
    }]]]),
  });

  assert.deepEqual(map.counts, { journeys: 1, tests: 1, pages: 1, endpoints: 2, failing_endpoints: 1 });
  assert.deepEqual(labels(map, 'endpoint'), ['/auth/login', '/customers/{id}']);
  assert.deepEqual(map.edges.map((e) => e.kind).sort(), ['calls', 'calls', 'contains', 'verified-by', 'visits']);
});

test('nothing is invented: no runs, no pages and no endpoints', () => {
  const map = buildServiceMap({
    application: { id: 1, name: 'Customer Portal' },
    journeys: [{ id: 1, name: 'Customer login', steps: [{ test_id: 1, label: 'Login' }] }],
    runsByTest: new Map(),
  });
  // The journey and its test exist because somebody defined them. The pages and
  // endpoints do not, because nobody has observed any.
  assert.equal(map.counts.journeys, 1);
  assert.equal(map.counts.tests, 1);
  assert.equal(map.counts.pages, 0);
  assert.equal(map.counts.endpoints, 0);
});

test('a test nobody grouped into a journey still appears', () => {
  // Hiding it because nobody got round to grouping it would make the map lie by
  // omission — it is monitoring that exists and runs.
  const map = buildServiceMap({
    application: { id: 1, name: 'Customer Portal' },
    journeys: [],
    runsByTest: new Map([[9, [{ id: 1, status: 'pass', test_name: 'Availability', steps: [], api_calls: [] }]]]),
  });
  const test9 = kinds(map, 'test')[0];
  assert.equal(test9.label, 'Availability');
  assert.equal(test9.ungrouped, true);
  assert.ok(map.edges.some((e) => e.from === 'application:1' && e.to === test9.id));
});

test('the same endpoint seen by two tests is one node with two edges', () => {
  // That shared node is the entire point: it is what makes "which journeys does
  // this endpoint break" answerable.
  const runs = new Map([
    [1, [{ id: 1, status: 'pass', steps: [], api_calls: [{ method: 'GET', url: 'https://api.kunde.dk/customers/1', status: 200 }] }]],
    [2, [{ id: 2, status: 'pass', steps: [], api_calls: [{ method: 'GET', url: 'https://api.kunde.dk/customers/2', status: 500 }] }]],
  ]);
  const map = buildServiceMap({
    application: { id: 1, name: 'App' },
    journeys: [
      { id: 1, name: 'A', steps: [{ test_id: 1, label: 'One' }] },
      { id: 2, name: 'B', steps: [{ test_id: 2, label: 'Two' }] },
    ],
    runsByTest: runs,
  });
  const endpoints = kinds(map, 'endpoint');
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].observations, 2);
  assert.equal(endpoints[0].failures, 1, 'a 500 seen once is one failure, not a failing endpoint forever');
  assert.equal(map.edges.filter((e) => e.to === endpoints[0].id).length, 2);
});

test('a request that never completed counts as a failure', () => {
  // Status 0 is a DNS failure, a refused connection or a blocked host, and it
  // reads as "fine" to anything comparing with >= 400.
  const map = buildServiceMap({
    application: { id: 1, name: 'App' },
    journeys: [{ id: 1, name: 'A', steps: [{ test_id: 1, label: 'One' }] }],
    runsByTest: new Map([[1, [{ id: 1, steps: [], api_calls: [{ method: 'GET', url: 'https://api.kunde.dk/x', status: 0 }] }]]]),
  });
  assert.equal(map.counts.failing_endpoints, 1);
});

test('a journey carries its criticality and its verdict, so the map agrees with the list', () => {
  const map = buildServiceMap({
    application: { id: 1, name: 'App' },
    journeys: [{ id: 1, name: 'A', criticality: 'critical', health: { status: 'failed' }, steps: [] }],
    runsByTest: new Map(),
  });
  const journey = kinds(map, 'journey')[0];
  assert.equal(journey.criticality, 'critical');
  assert.equal(journey.health, 'failed');
});

test('junk in, empty map out — never a crash', () => {
  assert.deepEqual(buildServiceMap().counts,
    { journeys: 0, tests: 0, pages: 0, endpoints: 0, failing_endpoints: 0 });
  assert.deepEqual(buildServiceMap({ journeys: 'nope', runsByTest: 'nope' }).nodes, []);
  const junk = buildServiceMap({
    application: { id: 1, name: 'App' },
    journeys: [null, 42, {}, { id: 2, name: 'Real', steps: [null, {}, { test_id: 3, label: 'T' }] }],
    runsByTest: new Map([[3, [null, 'x', { id: 1, steps: [null], api_calls: [null, { url: 'nope' }] }]]]),
  });
  assert.equal(junk.counts.journeys, 2, 'a journey with an id survives; the junk does not');
  assert.equal(junk.counts.endpoints, 0);
});

test('the method is recorded per endpoint, without duplicates', () => {
  const map = buildServiceMap({
    application: { id: 1, name: 'App' },
    journeys: [{ id: 1, name: 'A', steps: [{ test_id: 1, label: 'One' }] }],
    runsByTest: new Map([[1, [{
      id: 1,
      steps: [],
      api_calls: [
        { method: 'GET', url: 'https://api.kunde.dk/x', status: 200 },
        { method: 'GET', url: 'https://api.kunde.dk/x', status: 200 },
        { method: 'POST', url: 'https://api.kunde.dk/x', status: 201 },
      ],
    }]]]),
  });
  assert.deepEqual(kinds(map, 'endpoint')[0].methods.sort(), ['GET', 'POST']);
});
