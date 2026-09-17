'use strict';

// The server half of the TLS/certificate and reverse-DNS probes: what may be
// dispatched, what is stored, what the analysis makes of it, and what the
// Connection test now offers.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { makeApp, makeAgentsRepo, makeAgentCommander, authHeader } = require('../test-support/fakes');
const { validateProbeSpec, validateProbeResults, PROBE_TYPES } = require('../src/validation/probeValidation');
const { DIAGNOSTIC_TYPES } = require('../src/repositories/probeResultsRepository');
const { catalogue, specsFor } = require('../src/connectionTest/checks');

const operator = () => authHeader('operator');
const agentsRepo = () => makeAgentsRepo({ findById: async (id) => (Number(id) === 1 ? { id: 1, hostname: 'probe-01' } : null) });

// ---------------------------------------------------------------- the spec
test('a tls probe takes a port and an optional SNI name, and both are held to the target rule', () => {
  assert.ok(PROBE_TYPES.includes('tls') && PROBE_TYPES.includes('rdns'));
  // The port defaults rather than being required: a certificate lives on 443
  // far more often than anywhere else, but 465/993/636 is the reason this probe
  // exists at all.
  assert.deepEqual(validateProbeSpec({ type: 'tls', host: 'example.com' }).value, { type: 'tls', host: 'example.com', port: 443 });
  assert.equal(validateProbeSpec({ type: 'tls', host: '10.0.0.5', port: 993, servername: 'mail.example.dk' }).value.servername, 'mail.example.dk');
  for (const bad of [{}, { host: '' }, { host: '-rf' }, { host: 'a;rm -rf /' }]) {
    assert.ok(validateProbeSpec({ type: 'tls', ...bad }).errors, JSON.stringify(bad));
  }
  for (const port of [0, -1, 70000, 'abc', 1.5]) {
    assert.ok(validateProbeSpec({ type: 'tls', host: 'example.com', port }).errors, String(port));
  }
  // The SNI name reaches a TLS handshake as a hostname; it gets the same guard.
  for (const sni of ['-rf', 'a b', 'a;b', 'x'.repeat(300)]) {
    assert.ok(validateProbeSpec({ type: 'tls', host: 'example.com', servername: sni }).errors, sni);
  }
  assert.deepEqual(validateProbeSpec({ type: 'rdns', host: '93.184.216.34' }).value, { type: 'rdns', host: '93.184.216.34' });
  assert.ok(validateProbeSpec({ type: 'rdns', host: '-rf' }).errors);
});

// ---------------------------------------------------------------- the result
test('the certificate block is copied field by field, and the tri-state name verdict survives', () => {
  const { value } = validateProbeResults({
    results: [{
      type: 'tls', target: 'example.com:443', ok: false, certExpiryDays: -3,
      protocol: 'TLSv1.2', cipher: 'ECDHE-RSA-AES128-GCM-SHA256',
      authorized: false, authorizationError: 'CERT_HAS_EXPIRED', hostnameMatches: true,
      expiryDays: -3, expired: true, notYetValid: false,
      validTo: '2026-05-29T09:00:00.000Z', subject: 'example.com', issuer: 'Example CA',
      altNames: ['DNS:example.com', 'DNS:www.example.com'], chainLength: 2, selfSigned: false,
      invented: 'a field a future agent added',
    }],
  });
  const row = value.results[0];
  assert.equal(row.tls.authorized, false);
  assert.equal(row.tls.authorizationError, 'CERT_HAS_EXPIRED');
  assert.equal(row.tls.expired, true);
  assert.equal(row.tls.expiryDays, -3);
  assert.deepEqual(row.tls.altNames, ['DNS:example.com', 'DNS:www.example.com']);
  assert.equal(row.tls.invented, undefined, 'a key the agent invented reached the database');
  assert.equal(row.rdns, null, 'only a tls row carries a certificate');

  // null is "there was no name to check" and false is "it is the wrong name".
  const ip = validateProbeResults({ results: [{ type: 'tls', target: '10.0.0.5:443', ok: true, hostnameMatches: null }] });
  assert.equal(ip.value.results[0].tls.hostnameMatches, null);
  const wrong = validateProbeResults({ results: [{ type: 'tls', target: 'x:443', ok: false, hostnameMatches: false }] });
  assert.equal(wrong.value.results[0].tls.hostnameMatches, false);
  const garbage = validateProbeResults({ results: [{ type: 'tls', target: 'x:443', ok: true, hostnameMatches: 'yes please' }] });
  assert.equal(garbage.value.results[0].tls.hostnameMatches, null, 'a value that is not a verdict must not become one');
});

test('the reverse-DNS block keeps the confirmation apart from the names', () => {
  const { value } = validateProbeResults({
    results: [{ type: 'rdns', target: '93.184.216.34', ok: true, address: '93.184.216.34', ptrNames: ['host.example.com', 'alias.example.com'], forwardConfirmed: false }],
  });
  const row = value.results[0];
  assert.deepEqual(row.rdns.ptrNames, ['host.example.com', 'alias.example.com']);
  assert.equal(row.rdns.forwardConfirmed, false);
  assert.equal(row.tls, null);
  // Anything that is not an explicit true is not a confirmation.
  for (const v of ['true', 1, {}, undefined]) {
    const r = validateProbeResults({ results: [{ type: 'rdns', target: 'x', ok: true, forwardConfirmed: v }] });
    assert.equal(r.value.results[0].rdns.forwardConfirmed, false, JSON.stringify(v));
  }
});

test('neither probe votes on uptime or fleet health', () => {
  // A certificate that expired yesterday and an address with no PTR are real
  // faults and neither is a REACHABILITY fault — the host answers.
  for (const type of ['tls', 'rdns', 'path_mtu']) assert.ok(DIAGNOSTIC_TYPES.includes(type), type);
});

// ---------------------------------------------------------------- findings
test('a certificate that cannot be trusted is its own finding, separate from the expiry countdown', () => {
  const { evaluateProbeFindings } = require('../src/analysis/probeFindings');
  const at = new Date();
  const rows = [
    {
      type: 'tls', target: 'mail.example.dk:993', ok: false, ts: at.toISOString(), certExpiryDays: 200,
      tls: { authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', selfSigned: true, hostnameMatches: true, expired: false, issuer: 'mail.example.dk', subject: 'mail.example.dk', expiryDays: 200 },
    },
  ];
  const found = evaluateProbeFindings('agent-1', rows, { now: () => at });
  const trust = found.find((f) => f.metric === 'probe.tls');
  assert.ok(trust, `no trust finding: ${found.map((f) => f.metric).join(', ')}`);
  assert.equal(trust.severity, 'CRIT');
  assert.match(trust.explanation, /self-signed/);
  // 200 days is not an expiry problem, so there is no expiry finding beside it.
  assert.equal(found.filter((f) => f.metric === 'probe.cert').length, 0);
});

test('the expiry countdown now reads the tls probe too, and one target raises one finding', () => {
  const { evaluateProbeFindings } = require('../src/analysis/probeFindings');
  const at = new Date();
  const rows = [
    { type: 'tls', target: 'example.com:443', ok: true, ts: at.toISOString(), certExpiryDays: 4, tls: { authorized: true, hostnameMatches: true, expired: false, expiryDays: 4, issuer: 'CA', subject: 'example.com' } },
    { type: 'tls', target: 'example.com:443', ok: true, ts: at.toISOString(), certExpiryDays: 5, tls: { authorized: true, hostnameMatches: true, expired: false, expiryDays: 5, issuer: 'CA', subject: 'example.com' } },
  ];
  const found = evaluateProbeFindings('agent-1', rows, { now: () => at }).filter((f) => f.metric === 'probe.cert');
  assert.equal(found.length, 1, 'the same target raised more than one expiry finding');
  // 4 days is inside the warning band and outside the critical one — the same
  // thresholds the http probe's expiry has always used.
  const { CERT_WARN_DAYS, CERT_CRIT_DAYS } = require('../src/analysis/probeFindings');
  assert.ok(CERT_CRIT_DAYS < 4 && 4 <= CERT_WARN_DAYS, `thresholds moved: ${CERT_CRIT_DAYS}/${CERT_WARN_DAYS}`);
  assert.equal(found[0].severity, 'WARN');
  assert.match(found[0].explanation, /expires in 4 day/);
  assert.equal(found[0].evidence[0].type, 'tls', 'the evidence does not say which probe measured it');
});

// ---------------------------------------------------------------- the screen
test('the Connection test now offers both, and dispatches them as ordinary probes', async () => {
  const ids = catalogue('example.com').filter((c) => c.available).map((c) => c.id);
  assert.ok(ids.includes('tls') && ids.includes('rdns'), `catalogue: ${ids.join(', ')}`);
  // Reverse DNS applies to an IP literal — that is exactly when it is asked.
  assert.equal(catalogue('1.1.1.1').find((c) => c.id === 'rdns').applies, true);
  assert.deepEqual(specsFor('example.com', ['tls', 'rdns']).skipped, []);

  const sent = [];
  const app = makeApp({ agentsRepo: agentsRepo(), agentCommander: makeAgentCommander({ sendCommand: (id, cmd) => { sent.push(cmd); return 1; } }) });
  const res = await request(app).post('/api/connection-test/run').set('Authorization', operator())
    .send({ agentId: 1, host: 'example.com', checks: ['tls', 'rdns'] });
  assert.equal(res.status, 202);
  assert.deepEqual(res.body.dispatched.map((d) => d.id), ['rdns', 'tls']);
  assert.deepEqual(sent.map((c) => c.probe.type).sort(), ['rdns', 'tls']);
  assert.equal(sent.find((c) => c.probe.type === 'tls').probe.port, 443);
});

test('a probe pushed straight from the agents route accepts the new types', async () => {
  const sent = [];
  const app = makeApp({ agentsRepo: agentsRepo(), agentCommander: makeAgentCommander({ sendCommand: (id, cmd) => { sent.push(cmd); return 1; } }) });
  for (const body of [{ type: 'tls', host: 'mail.example.dk', port: 993 }, { type: 'rdns', host: '93.184.216.34' }]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).post('/agents/1/probe').set('Authorization', operator()).send(body);
    assert.equal(res.status, 202, JSON.stringify(body));
  }
  assert.equal(sent[0].probe.port, 993);
  assert.equal(sent[1].probe.type, 'rdns');
});
