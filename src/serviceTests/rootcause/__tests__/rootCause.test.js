'use strict';

// Root cause analysis: does it rank the right things, and does it admit what it
// cannot see?
//
// The tests are written against the two ways this module can be wrong, and they
// are not equally bad. Ranking the wrong cause first sends somebody to the wrong
// place for an hour. Presenting a supposition as a sighting costs the whole
// feature its credibility, because the operator who checks once and finds
// nothing there stops reading the rest.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  analyseRootCause, CAUSE, BASIS, CEILING, CATALOGUE, LISTING_FLOOR, DECISIVE_GAP,
} = require('../rootCause');

const BASE = 'https://portal.kunde.dk';

const obs = (over = {}) => ({
  layer: 'api', kind: 'api.call', subject: null, outcome: 'bad',
  value: null, unit: null, summary: null, detail: null, observed_at: null, ...over,
});

const apiCall = (status, path, outcome) => obs({
  layer: 'api', kind: 'api.call', subject: `${BASE}${path}`,
  outcome: outcome || (status >= 400 ? 'bad' : 'ok'),
  summary: `GET ${path} → HTTP ${status}`, detail: { status },
});

const runOutcome = (failureKind, summary) => obs({
  layer: 'browser', kind: 'run.outcome', outcome: 'bad',
  summary: summary || 'The test failed', detail: { failure_kind: failureKind },
});

const correlation = (over = {}) => ({
  layer: 'api', conclusion: 'Likely an application or API problem', confidence: 60,
  failed: ['api'], ruled_out: [], not_checked: [], ...over,
});

const analyse = (observations, over = {}) => analyseRootCause({
  correlation: correlation(over.correlation || {}), observations, baseUrl: BASE, ...over,
});

const causeOf = (result, cause) => result.candidates.find((x) => x.cause === cause) || null;
const ranks = (result) => result.candidates.map((x) => x.cause);

// -------------------------------------------------------------- the rules
test('no correlation means no ranking — a healthy service gets no list at all', () => {
  // An empty ranking on a service with nothing wrong reads as a finding.
  assert.equal(analyseRootCause({ correlation: null, observations: [apiCall(200, '/api/me')] }), null);
  assert.equal(analyseRootCause({}), null);
});

test('it never throws, whatever it is handed', () => {
  for (const input of [null, undefined, 'nope', 42, true, [], {}, { correlation: 'x' },
    { correlation: correlation(), observations: 'not a list' },
    { correlation: correlation(), observations: [null, undefined, 7, {}] }]) {
    assert.doesNotThrow(() => analyseRootCause(input), JSON.stringify(input));
  }
});

test('a failure nothing recognises says so instead of inventing a ranking', () => {
  const result = analyse([obs({ layer: 'application', outcome: 'bad', summary: 'something odd happened' })]);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.top, null);
  assert.equal(result.decisive, false);
  assert.match(result.summary, /none of the known causes matches/);
});

// ------------------------------------------------------ observed vs supposed
test('a database is never ranked as though it had been seen', () => {
  // The rule this module exists for. BlueEyes observes DNS, TLS, status and
  // timing from a browser. It never observes a database, and ranking one beside
  // a directly observed failure as if both were sightings is the most
  // misleading thing it could do.
  const result = analyse([
    runOutcome('timeout', 'Timeout 30000ms exceeded'),
    apiCall(500, '/api/search'),
  ]);
  const db = causeOf(result, CAUSE.DATABASE);
  assert.ok(db, 'the database was not offered as a place to look at all');
  assert.equal(db.basis, BASIS.UNOBSERVABLE);
  assert.ok(db.likelihood <= CEILING[BASIS.UNOBSERVABLE]);
  assert.deepEqual(result.supposed, [CAUSE.DATABASE]);
  assert.match(db.next_step, /cannot see a database/);
});

test('a supposition never outranks a sighting, however many signatures fire', () => {
  // Piling evidence onto the database — including the layer agreement that
  // would otherwise push it past its ceiling — must not overtake the TLS
  // failure somebody actually watched happen.
  const result = analyse([
    runOutcome('tls_failure', 'ERR_CERT_DATE_INVALID certificate expired, query deadlock, connection pool exhausted'),
    apiCall(500, '/api/search'),
  ], {
    certificate: { status: 'expired' },
    correlation: { layer: 'application', failed: ['application'] },
  });

  const tls = causeOf(result, CAUSE.TLS);
  const db = causeOf(result, CAUSE.DATABASE);
  assert.ok(tls && db);
  assert.ok(tls.likelihood > db.likelihood, `tls ${tls.likelihood} did not beat database ${db.likelihood}`);
  assert.equal(db.likelihood, CEILING[BASIS.UNOBSERVABLE], 'the ceiling did not hold');
  assert.equal(db.capped, true, 'the cap is not said out loud, so the number has to carry it alone');
  // And the correlation agreeing with it is exactly what should NOT be enough.
  assert.equal(result.top.cause, CAUSE.TLS);
});

test('the ceilings are ordered, so the basis can never be worked around', () => {
  assert.ok(CEILING[BASIS.OBSERVED] > CEILING[BASIS.INFERRED]);
  assert.ok(CEILING[BASIS.INFERRED] > CEILING[BASIS.UNOBSERVABLE]);
  // And every catalogue entry declares one, or the cap silently becomes NaN.
  for (const entry of CATALOGUE) {
    assert.ok(CEILING[entry.basis], `${entry.cause} has no ceiling`);
    assert.ok(entry.next_step && entry.next_step.length > 20, `${entry.cause} has no usable next step`);
    assert.ok(entry.label, `${entry.cause} has no label`);
  }
});

// --------------------------------------------------- telling causes apart
test('BlueEyes refusing an address is its OWN configuration, not a customer firewall', () => {
  // The distinction that decides which building somebody walks to. A blocked
  // request here means the allowlist refused it, and nothing at the other end
  // was ever contacted.
  const result = analyse([
    obs({ layer: 'network', kind: 'network.blocked', subject: 'https://cdn.andet.dk/x.js', outcome: 'bad', summary: 'blocked: refused by policy' }),
    runOutcome('blocked_by_policy'),
  ]);
  assert.equal(result.top.cause, CAUSE.CONFIGURATION);
  assert.equal(causeOf(result, CAUSE.FIREWALL), null, 'a customer firewall was blamed for our own allowlist');
  assert.match(result.top.next_step, /allowed hosts/);
});

test('one endpoint failing while its neighbours answer is a narrower fault than the tier', () => {
  const narrow = analyse([
    apiCall(500, '/api/search'),
    apiCall(200, '/api/me'),
    apiCall(200, '/api/settings'),
  ]);
  assert.equal(narrow.top.cause, CAUSE.API);
  assert.match(narrow.top.why.join(' '), /answered normally/);

  // Everything failing is the application, not one endpoint.
  const wide = analyse([
    apiCall(500, '/api/search'),
    apiCall(500, '/api/me'),
    apiCall(500, '/api/settings'),
  ]);
  assert.equal(wide.top.cause, CAUSE.APPLICATION);
  assert.equal(causeOf(wide, CAUSE.API), null, 'nothing answered, so "one endpoint" cannot be the shape of it');
});

test('a gateway answering for a dead upstream is not the application', () => {
  const result = analyse([apiCall(502, '/api/search')], { correlation: { layer: 'infrastructure', failed: ['infrastructure'] } });
  assert.equal(result.top.cause, CAUSE.LOAD_BALANCER);
  assert.equal(result.top.basis, BASIS.INFERRED, 'no proxy was inspected — this is deduced from who answered');
  assert.match(result.top.next_step, /application may be fine/);
});

test('a 503 is a server that is up and refusing, not one that is down', () => {
  const result = analyse([apiCall(503, '/api/search')], { correlation: { layer: 'server', failed: ['server'] } });
  assert.equal(result.top.cause, CAUSE.WEB_SERVER);
});

test('a 401 is authentication, and it outranks the application', () => {
  const result = analyse([apiCall(401, '/api/customers')]);
  assert.equal(result.top.cause, CAUSE.AUTHENTICATION);
  assert.match(result.top.why.join(' '), /refused this caller/);
});

test('a failing third-party host is not the customer’s application', () => {
  const result = analyse([
    obs({ layer: 'api', subject: 'https://betaling.tredjepart.dk/charge', outcome: 'bad', summary: 'POST /charge → HTTP 500', detail: { status: 500 } }),
    apiCall(200, '/api/me'),
  ]);
  assert.equal(ranks(result)[0], CAUSE.DEPENDENCY);
  assert.match(result.top.next_step, /that provider’s status/);
});

test('a subdomain of the application is not a third party', () => {
  // api.kunde.dk and portal.kunde.dk are one service. Calling the customer's own
  // API a third-party dependency sends them to the wrong supplier.
  const result = analyse([
    obs({ layer: 'api', subject: 'https://api.kunde.dk/search', outcome: 'bad', summary: 'HTTP 500', detail: { status: 500 } }),
  ]);
  assert.equal(causeOf(result, CAUSE.DEPENDENCY), null);
  assert.equal(result.top.cause, CAUSE.APPLICATION);
});

test('with no base address nothing is claimed about whose host failed', () => {
  // Guessing that an unfamiliar host is third-party is how a service gets blamed
  // on its CDN.
  const result = analyseRootCause({
    correlation: correlation(),
    observations: [obs({ layer: 'api', subject: 'https://ukendt.dk/x', outcome: 'bad', summary: 'HTTP 500', detail: { status: 500 } })],
  });
  assert.equal(causeOf(result, CAUSE.DEPENDENCY), null);
});

test('a selector that did not resolve is the test only when nothing underneath failed', () => {
  const alone = analyse([runOutcome('element_not_found', 'Could not find "Search"')], {
    correlation: { layer: null, failed: ['browser'] },
  });
  assert.equal(alone.top.cause, CAUSE.CLIENT);
  assert.match(alone.top.why.join(' '), /nothing underneath/);

  // The same selector failure while the API is returning 500 is a SYMPTOM.
  const withCause = analyse([
    runOutcome('element_not_found', 'Could not find "Search"'),
    apiCall(500, '/api/search'),
  ], { correlation: { layer: 'api', failed: ['api', 'browser'] } });
  const client = causeOf(withCause, CAUSE.CLIENT);
  assert.ok(client.likelihood < alone.top.likelihood, 'the page was blamed just as hard with a 500 underneath it');
});

test('DNS and TLS are told apart, and neither is read as a firewall', () => {
  const dns = analyse([runOutcome('dns_failure', 'getaddrinfo ENOTFOUND portal.kunde.dk')],
    { correlation: { layer: 'network', failed: ['network'] } });
  assert.equal(dns.top.cause, CAUSE.DNS);

  const tls = analyse([runOutcome('tls_failure', 'ERR_CERT_DATE_INVALID')],
    { correlation: { layer: 'infrastructure', failed: ['infrastructure'] } });
  assert.equal(tls.top.cause, CAUSE.TLS);

  const refused = analyse([runOutcome('connection_refused', 'connect ECONNREFUSED 10.0.0.4:443')],
    { correlation: { layer: 'network', failed: ['network'] } });
  assert.equal(refused.top.cause, CAUSE.FIREWALL);
  assert.equal(refused.top.basis, BASIS.INFERRED, 'no firewall was seen — a stopped service looks identical');
});

// ------------------------------------------------------------ the ranking
test('a close second is published, and the answer hedges accordingly', () => {
  // Rule 1. A leader a few points clear is an artefact of the arithmetic, and
  // presenting it as the conclusion would be dishonest about what was known.
  const result = analyse([apiCall(500, '/api/search'), apiCall(200, '/api/me')]);
  assert.ok(result.runner_up, 'only one candidate — this spec is testing nothing');
  assert.ok(result.gap < DECISIVE_GAP);
  assert.equal(result.decisive, false);
  assert.match(result.summary, /fits the same evidence/);
});

test('a clear leader says so plainly, and still calls itself an assessment', () => {
  const result = analyse([
    obs({ layer: 'network', kind: 'network.blocked', outcome: 'bad', summary: 'blocked: refused by policy' }),
    runOutcome('blocked_by_policy'),
  ]);
  assert.equal(result.decisive, true);
  assert.ok(result.gap >= DECISIVE_GAP);
  assert.match(result.summary, /an assessment, not a fact/);
});

test('the same evidence always produces the same order', () => {
  // A tie broken by whatever the sort happened to do is a list that shuffles
  // between page loads, and a list that shuffles is one nobody trusts.
  const observations = [apiCall(500, '/api/search'), apiCall(502, '/api/pay'), apiCall(200, '/api/me')];
  const first = ranks(analyse(observations));
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(ranks(analyse([...observations])), first);
  }
});

test('a candidate with one weak signature is left off rather than padding the list', () => {
  const result = analyse([apiCall(404, '/api/old')]);
  for (const candidate of result.candidates) {
    assert.ok(candidate.likelihood >= LISTING_FLOOR, `${candidate.cause} is below the listing floor`);
  }
});

test('the holes in the evidence are carried through to the ranking', () => {
  const result = analyse([apiCall(500, '/api/search')], {
    correlation: { layer: 'api', failed: ['api'], not_checked: ['network', 'infrastructure'] },
  });
  assert.deepEqual(result.not_checked, ['network', 'infrastructure']);
  assert.match(result.summary, /network, infrastructure were not checked/);
});

test('every candidate carries the evidence that put it there', () => {
  // Rule 4. A ranking without its reasons is a number to argue with and nothing
  // to check.
  const result = analyse([apiCall(500, '/api/search'), apiCall(401, '/api/me'), runOutcome('timeout', 'Timeout 30000ms exceeded')]);
  assert.ok(result.candidates.length > 1);
  for (const candidate of result.candidates) {
    assert.ok(Array.isArray(candidate.why) && candidate.why.length, `${candidate.cause} has no evidence`);
    for (const line of candidate.why) assert.ok(typeof line === 'string' && line.length > 10);
    assert.ok(candidate.next_step, `${candidate.cause} says nothing about what to do`);
  }
});

test('it says it is rules, so an AI second opinion can never be confused with it', () => {
  assert.equal(analyse([apiCall(500, '/api/search')]).source, 'rules');
});
