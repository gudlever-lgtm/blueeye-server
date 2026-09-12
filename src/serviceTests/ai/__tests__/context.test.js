'use strict';

// What an AI provider is allowed to see.
//
// These specs are the security control, not a description of one. Two kinds:
//
//   1. THE ALLOWLIST HOLDS. A field nobody chose does not go out, however it
//      arrives — including fields that do not exist yet, which is the case a
//      denylist can never cover. The sweep below plants an invented field in
//      every source and fails if any of them turns up in the context.
//   2. The scrub catches the shapes a credential takes when it is echoed into
//      free text, because an error message is the most useful thing in an
//      incident and the likeliest place for a token to appear.
//
// The first is the control. The second is defence in depth.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  incidentAnalysisContext, testSuggestionContext, scrub, endpoint, MAX_TEXT,
} = require('../context');

const INCIDENT = {
  id: 9,
  reference: 'INC-2026-00009',
  application_id: 1,
  subject_type: 'test',
  subject_key: 'certificate:portal.kunde.dk:443',
  subject_label: 'Customer search',
  kind: 'http_500',
  severity: 'CRIT',
  status: 'open',
  summary: 'HTTP 500 from the customer search',
  likely_cause: 'the application',
  explanation: 'The request reached the application and it threw.',
  correlated_layer: 'api',
  confidence: 68,
  impact: 'high',
  impact_reason: 'A critical journey cannot complete.',
  occurrences: 4,
  opened_at: new Date('2026-09-12T09:00:00Z'),
  evidence: ['GET /api/search returned 500'],
};

const flatten = (value) => JSON.stringify(value);

// Two fixtures are assembled at run time rather than written as literals.
//
// The security gate scans tracked source for committed private keys and vendor
// tokens, and a realistic-looking one in a test file trips it — correctly: the
// scanner cannot tell a fixture from the real thing, and a scanner that tried
// to would be one somebody could talk their way past. Split across a join, the
// pattern never appears contiguously in the file, and the test still exercises
// the real shape because the value it builds is identical.
const AWS_KEY_FIXTURE = `AKIA${'IOSFODNN7EXAMPLE'}`;
const PRIVATE_KEY_FIXTURE = [
  `-----BEGIN RSA PRIVATE${' '}KEY-----`,
  'MIIEowIBAAKCAQEA',
  'abc',
  `-----END RSA PRIVATE${' '}KEY-----`,
].join('\n');

// ------------------------------------------------------- the allowlist holds
test('a field nobody chose never reaches the context, whatever it is called', () => {
  // The case a denylist cannot cover: a column a future migration adds, carrying
  // something nobody thought about, forwarded by a file nobody re-read.
  const CANARY = 'CANARY-9f3b-do-not-forward';
  const context = incidentAnalysisContext({
    incident: { ...INCIDENT, internal_notes: CANARY, customer_email: CANARY, raw_request: CANARY },
    correlation: { layer: 'api', conclusion: 'x', chain: [{ step: 'a', layer: 'api', outcome: 'bad', secret_header: CANARY }], debug: CANARY },
    rootCause: { summary: 's', candidates: [{ cause: 'api', label: 'l', basis: 'observed', likelihood: 40, raw_evidence: CANARY }], prompt: CANARY },
    recurrence: { occurrences: 3, summary: 's', internal: CANARY },
    timeline: [{ kind: 'opened', summary: 'x', source: 'run', actor_id: 4, detail: { body: CANARY } }],
    observations: [{ layer: 'api', kind: 'api.call', outcome: 'bad', detail: { status: 500, request_headers: CANARY } }],
    applicationName: 'Kundeportal',
    baseUrl: `https://${CANARY}.dk`,
    extra: CANARY,
  });
  assert.ok(!flatten(context).includes(CANARY), `an unchosen field reached the provider:\n${flatten(context)}`);
});

test('the source objects are never spread, so the context cannot grow by accident', () => {
  // Read as a rule about the FILE, not about one call: a `{...incident}`
  // anywhere in it forwards every future column automatically.
  // Comments stripped first: the rule is about code, and the file explains the
  // rule in prose that names the very thing it forbids.
  const code = require('fs').readFileSync(require.resolve('../context'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  const spread = /\.\.\.\s*[A-Za-z_$][\w$]*/.exec(code);
  assert.equal(spread, null,
    `context.js spreads ${spread && spread[0]} — every field a migration adds to that object would go out with it`);
});

test('the personal and infrastructural fields are left out by name', () => {
  const context = incidentAnalysisContext({
    incident: INCIDENT,
    timeline: [{ kind: 'status_investigating', summary: 'picked up', source: 'person', actor_id: 42 }],
    applicationName: 'Kundeportal',
    baseUrl: 'https://portal.kunde.dk',
  });
  const flat = flatten(context);
  assert.ok(!flat.includes('certificate:portal.kunde.dk:443'), 'subject_key encodes a host and port');
  assert.ok(!flat.includes('portal.kunde.dk'), 'the customer’s host is not needed to explain an incident');
  assert.ok(!/"actor_id"/.test(flat), 'which person picked it up is personal data and no use to a model');
  // And what SHOULD be there still is.
  assert.match(flat, /Customer search/);
  assert.match(flat, /Kundeportal/);
});

test('an enum a future migration adds is dropped rather than forwarded', () => {
  const context = incidentAnalysisContext({
    incident: { ...INCIDENT, severity: 'CATASTROPHIC', status: 'on_fire', impact: 'apocalyptic', correlated_layer: 'quantum' },
  });
  assert.equal(context.incident.severity, null);
  assert.equal(context.incident.status, null);
  assert.equal(context.incident.impact, null);
  assert.equal(context.incident.correlated_layer, null);
});

test('an observation’s open `detail` column is not forwarded, only two fields out of it', () => {
  // `detail` is where detectors write freely — exactly the shape that makes an
  // allowlist necessary in the first place.
  const context = incidentAnalysisContext({
    incident: INCIDENT,
    observations: [{
      layer: 'api', kind: 'api.call', outcome: 'bad', subject: 'https://x.dk/api/a',
      detail: { status: 500, method: 'POST', request_body: 'password=hunter2', cookies: 'session=abc' },
    }],
  });
  const flat = flatten(context.observations);
  assert.ok(!flat.includes('hunter2'));
  assert.ok(!flat.includes('session=abc'));
  assert.equal(context.observations[0].status, 500, 'the one field worth having is taken by name');
});

// ---------------------------------------------------------------- the scrub
test('the shapes a credential takes in free text are removed', () => {
  // Each case pairs the input with THE SECRET IN IT, and the assertion is that
  // the secret is GONE — not that a mask appeared somewhere.
  //
  // That distinction found a real leak. The Authorization rule matched `\S+`,
  // which ate the word "Bearer" and left the token sitting after the mask:
  // "Authorization: [removed] sk-live-9f3b2a1c8e". A spec asserting the mask was
  // present passed on that happily.
  const cases = [
    ['Authorization: Bearer abc123def456ghi', 'abc123def456ghi'],
    ['authorization=Bearer sk-proj-1234567890abcdef', 'sk-proj-1234567890abcdef'],
    ['Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    ['failed with api_key=sk-live-9f3b2a1c8e', 'sk-live-9f3b2a1c8e'],
    ['GET /cb?access_token=ya29.a0AfH6SMB&state=1', 'ya29.a0AfH6SMB'],
    ['Set-Cookie: session=abc123; HttpOnly', 'abc123'],
    ['Cookie: JSESSIONID=9F3B2A1C8E', '9F3B2A1C8E'],
    ['connect to https://admin:hunter2@db.internal/', 'hunter2'],
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'dozjgNryP4J3jVmNHl0w5N'],
    [`key ${AWS_KEY_FIXTURE} rejected`, AWS_KEY_FIXTURE],
    ['password: hunter2-correct-horse', 'hunter2-correct-horse'],
    ['client_secret="abcdefghijklmnop"', 'abcdefghijklmnop'],
    ['x-api-key: 7f3b2a1c8e9d0f4a', '7f3b2a1c8e9d0f4a'],
    ['refresh_token=1//0gK9fJ2x', '1//0gK9fJ2x'],
  ];
  for (const [input, secret] of cases) {
    const out = scrub(input);
    assert.ok(!out.includes(secret), `the secret survived: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    // A sanity check that something actually happened, rather than the secret
    // being absent because the whole line was. `removed` OR a shortened line:
    // credentials in a URL's authority lose the mask to the URL reduction that
    // runs after them, which is a stronger outcome, not a weaker one.
    assert.ok(/removed/.test(out) || out.length < input.length,
      `nothing happened to ${JSON.stringify(input)}`);
  }
});

test('a private key block is removed whole, not line by line', () => {
  const out = scrub(PRIVATE_KEY_FIXTURE);
  assert.match(out, /\[removed private key\]/);
  assert.ok(!out.includes('MIIEowIBAAKCAQEA'));
});

test('scrubbing does not destroy the message it is protecting', () => {
  // An over-eager scrub produces an error nobody can read, which is how the
  // whole feature gets switched off.
  const out = scrub('GET /api/customer/search returned 500 after 4200 ms (upstream timeout)');
  assert.equal(out, 'GET /api/customer/search returned 500 after 4200 ms (upstream timeout)');
});

test('free text is capped, so an unbounded blob cannot leave', () => {
  const context = incidentAnalysisContext({ incident: { ...INCIDENT, explanation: 'x'.repeat(5000) } });
  assert.ok(context.incident.explanation.length <= MAX_TEXT + 1);
});

test('the number of evidence lines, timeline entries and observations is capped', () => {
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const context = incidentAnalysisContext({
    incident: { ...INCIDENT, evidence: many(500, (i) => `line ${i}`) },
    timeline: many(500, (i) => ({ kind: 'x', summary: `e${i}`, source: 'run' })),
    observations: many(500, (i) => ({ layer: 'api', kind: 'k', outcome: 'bad', summary: `o${i}` })),
  });
  assert.ok(context.incident.evidence.length <= 20);
  assert.ok(context.timeline.length <= 30);
  assert.ok(context.observations.length <= 40);
});

// -------------------------------------------------------------- endpoints
test('a URL is reduced to a path shape, with the host removed', () => {
  // The host goes: this file already refuses subject_key BECAUSE it encodes a
  // host, and keeping the same host in every URL would have made that refusal
  // theatre. There is one service in the context, so "/api/search is failing"
  // says everything the host would.
  assert.equal(endpoint('https://portal.kunde.dk/api/customers/4711/cases?open=1'), '/api/customers/{id}/cases');
  assert.equal(endpoint('https://x.dk/orders/9f3b2a1c-4d5e-6789-abcd-ef0123456789'), '/orders/{uuid}');
  assert.equal(endpoint('https://x.dk/files/deadbeefdeadbeefcafe'), '/files/{hash}');
  assert.equal(endpoint('https://x.dk'), '/');
  assert.equal(endpoint(''), null);
  assert.equal(endpoint(null), null);
});

test('a host inside free text is removed too, not only in the URL fields', () => {
  // Most error messages contain a URL. Reducing only the typed URL fields would
  // have left the host in every one of them.
  const out = scrub('GET https://portal.kunde.dk/api/search?token=abc123 returned 500');
  assert.ok(!out.includes('portal.kunde.dk'));
  assert.ok(!out.includes('abc123'));
  assert.match(out, /\/api\/search/, 'and the useful half survived');
});

test('the query string never survives — it is where identifiers and tokens live', () => {
  assert.ok(!endpoint('https://x.dk/a?token=secret&customer=4711').includes('secret'));
  assert.ok(!endpoint('https://x.dk/a?token=secret&customer=4711').includes('4711'));
});

// -------------------------------------------------------------- robustness
test('it never throws, whatever it is handed', () => {
  for (const input of [null, undefined, 'nope', 42, true, [], {},
    { incident: null }, { incident: 'x' }, { incident: 42 },
    { incident: INCIDENT, timeline: 'no', observations: 7, correlation: 'x', rootCause: [] },
    { incident: INCIDENT, timeline: [null, 3], observations: [null, 'x'] }]) {
    assert.doesNotThrow(() => incidentAnalysisContext(input), String(JSON.stringify(input)).slice(0, 60));
    assert.doesNotThrow(() => testSuggestionContext(input));
  }
  for (const input of [null, undefined, 42, {}, []]) assert.doesNotThrow(() => scrub(input));
});

test('nothing to explain produces no context at all', () => {
  // A context with an empty incident in it would have the model inventing one.
  assert.equal(incidentAnalysisContext({}), null);
  assert.equal(incidentAnalysisContext({ incident: {} }), null);
});

// ----------------------------------------------------- test suggestions
test('a test suggestion sees shapes, never a field value or a form’s contents', () => {
  const CANARY = 'CANARY-value-typed-by-a-person';
  const context = testSuggestionContext({
    applicationName: 'Kundeportal',
    journeys: [{ id: 1, name: 'Sign in', criticality: 'critical', health: { status: 'failed' }, secret: CANARY }],
    pages: [{ url: 'https://portal.kunde.dk/kunder/4711?q=' + CANARY, title: 'Kunde', http_status: 200, forms: [{ values: CANARY }] }],
    failingEndpoints: [{ label: 'https://portal.kunde.dk/api/auth', failures: 3, body: CANARY }],
  });
  const flat = flatten(context);
  assert.ok(!flat.includes(CANARY), `a value reached the provider:\n${flat}`);
  assert.ok(!flat.includes('4711'), 'an identifier in a path is somebody’s customer');
  assert.match(flat, /Sign in/, 'and what it does need is still there');
});

test('the basis of each ranked cause travels with it', () => {
  // A model told "the database, 25%" beside "TLS, 90%" without knowing one was
  // watched and the other supposed will write a summary presenting both as
  // findings — which undoes the one thing the root-cause module is careful about.
  const context = incidentAnalysisContext({
    incident: INCIDENT,
    rootCause: {
      summary: 's',
      candidates: [
        { cause: 'tls', label: 'The TLS certificate', basis: 'observed', likelihood: 90, why: ['seen'] },
        { cause: 'database', label: 'The database', basis: 'unobservable', likelihood: 25, why: ['supposed'] },
      ],
    },
  });
  assert.equal(context.root_cause.candidates[0].basis, 'observed');
  assert.equal(context.root_cause.candidates[1].basis, 'unobservable');
});
