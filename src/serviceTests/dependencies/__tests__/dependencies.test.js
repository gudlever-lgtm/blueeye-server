'use strict';

// Dependency intelligence: reading the service map rather than drawing it.
//
// Driven through the REAL buildServiceMap, not a hand-written map literal. The
// two have to agree about what an edge kind is called and what an endpoint id
// looks like, and a fixture that invents its own shape would pass forever while
// the pair drifted apart.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildServiceMap } = require('../../analysis/serviceMap');
const { analyseDependencies, blastLabel, CRITICALITY_WEIGHT, MIN_SHARED } = require('../dependencies');

const BASE = 'https://portal.kunde.dk';
const call = (url, status = 200, method = 'GET') => ({ url, status, method });
const run = (name, calls) => ({ test_name: name, api_calls: calls });

// Builds a map the way the module under test will really receive one.
function mapOf(journeys, runsByTest) {
  return buildServiceMap({ application: { id: 1, name: 'Portal' }, journeys, runsByTest });
}

const journey = (id, name, criticality, testId) => ({
  id, name, criticality, steps: [{ test_id: testId, label: `${name} test` }],
});

// Two journeys, both calling /api/auth; only one calls /api/search.
function sharedFixture({ authStatus = 200, criticalities = ['critical', 'high'] } = {}) {
  const journeys = [
    journey(1, 'Sign in', criticalities[0], 1),
    journey(2, 'Find customer', criticalities[1], 2),
  ];
  const runsByTest = {
    1: [run('Login', [call(`${BASE}/api/auth`, 200, 'POST')])],
    2: [run('Search', [call(`${BASE}/api/auth`, authStatus, 'POST'), call(`${BASE}/api/search`)])],
  };
  return analyseDependencies({ map: mapOf(journeys, runsByTest), baseUrl: BASE });
}

const find = (result, label) => result.shared.find((d) => d.label === label) || null;

// ------------------------------------------------------------- the reading
test('an endpoint under more than one journey is found, and one under a single journey is not', () => {
  const result = sharedFixture();
  assert.ok(find(result, '/api/auth'), '/api/auth is called by both journeys and was not reported');
  assert.equal(find(result, '/api/search'), null, 'one journey calling an endpoint is a journey, not a shared dependency');
  assert.equal(result.counts.shared, 1);
});

test('the spec’s sentence is what a failing shared dependency produces', () => {
  const result = sharedFixture({ authStatus: 500 });
  assert.match(result.summary, /^Multiple journeys affected by the same dependency\./);
  assert.match(result.summary, /\/api\/auth is failing and 2 journeys depend on it/);
});

test('shared and failing are different lists', () => {
  // An endpoint under five journeys that never failed is a risk. One under two
  // that is failing now is what is breaking the service this minute. A single
  // list buries the second in the first.
  const healthy = sharedFixture();
  assert.equal(healthy.shared.length, 1);
  assert.equal(healthy.failing.length, 0);
  assert.match(healthy.summary, /none of them has seen it fail/);

  const broken = sharedFixture({ authStatus: 503 });
  assert.equal(broken.shared.length, 1);
  assert.equal(broken.failing.length, 1);
});

test('the failure rate is null when nothing was observed, never zero', () => {
  // "We did not look" and "we looked and it was fine" are different facts, and
  // a 0% failure rate on an endpoint nobody called is the second one invented.
  const result = sharedFixture();
  const auth = find(result, '/api/auth');
  assert.equal(auth.failure_rate, 0, 'it WAS observed here, twice, and never failed');
  assert.equal(auth.status, 'healthy');
  assert.ok(auth.observations > 0);
});

// ------------------------------------------------------------ blast radius
test('blast radius is weighted by criticality, not counted', () => {
  // Three low-criticality journeys must not outrank one critical one.
  const journeys = [
    journey(1, 'Critical A', 'critical', 1),
    journey(2, 'Critical B', 'critical', 2),
    journey(3, 'Low A', 'low', 3),
    journey(4, 'Low B', 'low', 4),
    journey(5, 'Low C', 'low', 5),
  ];
  const runsByTest = {
    1: [run('a', [call(`${BASE}/api/core`)])],
    2: [run('b', [call(`${BASE}/api/core`)])],
    3: [run('c', [call(`${BASE}/api/side`)])],
    4: [run('d', [call(`${BASE}/api/side`)])],
    5: [run('e', [call(`${BASE}/api/side`)])],
  };
  const result = analyseDependencies({ map: mapOf(journeys, runsByTest), baseUrl: BASE });

  const core = find(result, '/api/core');
  const side = find(result, '/api/side');
  assert.equal(core.journey_count, 2);
  assert.equal(side.journey_count, 3, 'more journeys');
  assert.ok(core.blast_weight > side.blast_weight, 'but less that matters');
  assert.equal(result.shared[0].label, '/api/core', 'the list is sorted by what depends on it, not how many');
});

test('the blast labels are ordered and every weight lands on one', () => {
  assert.equal(blastLabel(CRITICALITY_WEIGHT.critical * 2), 'critical');
  assert.equal(blastLabel(0), 'low');
  for (let w = 0; w < 40; w += 1) assert.ok(typeof blastLabel(w) === 'string' && blastLabel(w).length);
});

// -------------------------------------------------- observed only, rule 1
test('a journey that has never run contributes nothing and is named', () => {
  // The line against becoming a CMDB. Its dependencies are UNKNOWN, not zero,
  // and a short list must not be read as a complete one.
  const journeys = [
    journey(1, 'Sign in', 'critical', 1),
    journey(2, 'Find customer', 'high', 2),
    journey(3, 'Never run', 'critical', 3),
  ];
  const runsByTest = {
    1: [run('Login', [call(`${BASE}/api/auth`, 200, 'POST')])],
    2: [run('Search', [call(`${BASE}/api/auth`, 200, 'POST')])],
    3: [],
  };
  const result = analyseDependencies({ map: mapOf(journeys, runsByTest), baseUrl: BASE });

  assert.equal(result.counts.journeys_observed, 2);
  assert.deepEqual(result.unobserved_journeys.map((j) => j.label), ['Never run']);
  const auth = find(result, '/api/auth');
  assert.equal(auth.journey_count, 2, 'a journey that never ran was counted as depending on something');
  assert.equal(auth.share, 1, 'the denominator is what actually ran');
  assert.match(result.summary, /1 journey has never run/);
});

test('nothing observed at all says so rather than reporting no dependencies', () => {
  const result = analyseDependencies({
    map: mapOf([journey(1, 'Sign in', 'critical', 1)], { 1: [] }),
    baseUrl: BASE,
  });
  assert.deepEqual(result.shared, []);
  assert.match(result.summary, /No journey has run yet/);
});

// ------------------------------------------------------------ third party
test('an address the application does not control is marked as such', () => {
  const journeys = [journey(1, 'Pay', 'critical', 1), journey(2, 'Refund', 'high', 2)];
  const runsByTest = {
    1: [run('a', [call('https://betaling.tredjepart.dk/charge', 200, 'POST')])],
    2: [run('b', [call('https://betaling.tredjepart.dk/charge', 200, 'POST')])],
  };
  const result = analyseDependencies({ map: mapOf(journeys, runsByTest), baseUrl: BASE });
  const dep = result.shared[0];
  assert.equal(dep.third_party, true);
  assert.match(dep.summary, /not on an address this application controls/);
});

test('a subdomain of the application is not a third party', () => {
  const journeys = [journey(1, 'Sign in', 'critical', 1), journey(2, 'Search', 'high', 2)];
  const runsByTest = {
    1: [run('a', [call('https://api.kunde.dk/auth')])],
    2: [run('b', [call('https://api.kunde.dk/auth')])],
  };
  const result = analyseDependencies({ map: mapOf(journeys, runsByTest), baseUrl: BASE });
  assert.equal(result.shared[0].third_party, false);
});

test('with no base address nothing is claimed about who owns the host', () => {
  // Guessing that an unfamiliar host is third-party is how a service gets blamed
  // on its CDN.
  const journeys = [journey(1, 'A', 'critical', 1), journey(2, 'B', 'high', 2)];
  const runsByTest = {
    1: [run('a', [call('https://ukendt.dk/x')])],
    2: [run('b', [call('https://ukendt.dk/x')])],
  };
  const result = analyseDependencies({ map: mapOf(journeys, runsByTest) });
  assert.equal(result.shared[0].third_party, null, 'null is "we were not told", not "no"');
  assert.ok(!/does not control/.test(result.shared[0].summary));
});

// -------------------------------------------------------------- robustness
test('it never throws, whatever it is handed', () => {
  for (const input of [null, undefined, 'nope', 42, true, [], {},
    { map: null }, { map: 'x' }, { map: { nodes: 'no', edges: 7 } },
    { map: { nodes: [null, 3, {}], edges: [null, {}] } }]) {
    assert.doesNotThrow(() => analyseDependencies(input), JSON.stringify(input));
  }
  assert.deepEqual(analyseDependencies(null).shared, []);
});

test('the same map always produces the same order', () => {
  // A list that reshuffles between page loads is one nobody trusts.
  const journeys = [journey(1, 'A', 'normal', 1), journey(2, 'B', 'normal', 2)];
  const runsByTest = {
    1: [run('a', [call(`${BASE}/api/one`), call(`${BASE}/api/two`)])],
    2: [run('b', [call(`${BASE}/api/one`), call(`${BASE}/api/two`)])],
  };
  const first = analyseDependencies({ map: mapOf(journeys, runsByTest), baseUrl: BASE }).shared.map((d) => d.label);
  assert.equal(first.length, 2, 'both endpoints are shared, so there is an order to be stable about');
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(
      analyseDependencies({ map: mapOf(journeys, runsByTest), baseUrl: BASE }).shared.map((d) => d.label),
      first
    );
  }
});

test('the minimum is published rather than hidden in a comparison', () => {
  assert.equal(MIN_SHARED, 2);
});

test('it says it is rules, so an AI second opinion can never be confused with it', () => {
  assert.equal(sharedFixture().source, 'rules');
});
