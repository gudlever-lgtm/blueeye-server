'use strict';

// A failed TLS handshake is not a bad certificate.
//
// In a real end-to-end run a tls probe pointed at a plain-HTTP port
// (203.0.113.2:8080) failed with ERR_SSL_WRONG_VERSION_NUMBER, and the server
// raised a CRIT "TLS certificate on 203.0.113.2:8080 cannot be trusted: the
// chain does not validate (unknown reason)" — about a certificate the port
// never presented. Three steps made it: the validator ALWAYS built a TLS block,
// the block turned an absent `authorized` into false, and the finding read
// false as "untrusted". The same validator also read the verdict from the ROW
// while the agent nests it under `tls`, so a real, valid certificate read as
// untrusted too.
//
// And (item 7) the diagnostic probe types never count toward the generic
// "N/M targets not responding" verdict.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateProbeResults } = require('../src/validation/probeValidation');
const { evaluateProbeFindings } = require('../src/analysis/probeFindings');
const { computeAgentHealth } = require('../src/health/probeHealth');

const at = new Date('2026-09-24T08:30:00Z');
const iso = at.toISOString();

// What the agent sends for a handshake that failed (blueeye-agent
// src/probes/tls.js → stats.fail): no certificate fields at all.
const HANDSHAKE_FAILED = {
  type: 'tls', target: '203.0.113.2:8080', ok: false, attempts: 0, success: 0,
  rttMs: null, minMs: null, maxMs: null, jitterMs: null, lossPct: 100,
  error: 'tls handshake failed: ERR_SSL_WRONG_VERSION_NUMBER', ts: iso,
};
// What it sends for a certificate it received: the verdict NESTED under tls.
const GOOD_CERT = {
  type: 'tls', target: 'example.com:443', ok: true, attempts: 1, success: 1, rttMs: 12, lossPct: 0,
  certExpiryDays: 80, detail: 'expires in 80d · issuer R3 · TLSv1.3', ts: iso,
  tls: {
    protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', authorized: true, authorizationError: null,
    hostnameMatches: true, expiryDays: 80, expired: false, notYetValid: false,
    validFrom: '2026-07-01T00:00:00.000Z', validTo: '2026-12-13T00:00:00.000Z',
    subject: 'example.com', issuer: 'R3', altNames: ['DNS:example.com'], chainLength: 2, selfSigned: false,
  },
};

test('a handshake that failed stores NO certificate block, and keeps the error', () => {
  const { value } = validateProbeResults({ results: [HANDSHAKE_FAILED] });
  const row = value.results[0];
  assert.equal(row.tls, null, 'a certificate verdict was invented for a port that presented none');
  assert.match(row.detail, /ERR_SSL_WRONG_VERSION_NUMBER/);
});

test('the agent\'s NESTED certificate verdict is read, not coerced to "untrusted"', () => {
  const { value } = validateProbeResults({ results: [GOOD_CERT] });
  const t = value.results[0].tls;
  assert.equal(t.authorized, true);
  assert.equal(t.hostnameMatches, true);
  assert.equal(t.subject, 'example.com');
  assert.equal(t.protocol, 'TLSv1.3');
  assert.deepEqual(t.altNames, ['DNS:example.com']);
});

test('a handshake failure is a handshake finding that names the error — never "cannot be trusted"', () => {
  const [row] = validateProbeResults({ results: [HANDSHAKE_FAILED] }).value.results;
  const found = evaluateProbeFindings('7', [row], { now: () => at });
  assert.equal(found.filter((f) => f.metric === 'probe.tls').length, 0, found.map((f) => f.explanation).join(' | '));
  const hs = found.find((f) => f.metric === 'probe.tls.handshake');
  assert.ok(hs, `no handshake finding: ${found.map((f) => f.metric).join(', ')}`);
  assert.equal(hs.severity, 'WARN');
  assert.match(hs.explanation, /TLS handshake with 203\.0\.113\.2:8080 failed/);
  assert.match(hs.explanation, /not with TLS/);
  assert.match(hs.explanation, /ERR_SSL_WRONG_VERSION_NUMBER/);
  assert.doesNotMatch(hs.explanation, /cannot be trusted|unknown reason/);
  assert.equal(hs.evidence[0].errorCode, 'ERR_SSL_WRONG_VERSION_NUMBER');
  // Diagnostic: it does not ALSO read as a target that stopped responding.
  assert.equal(found.filter((f) => f.metric === 'probe.reachability').length, 0);
});

test('a run of failed handshakes is critical, and the common errors are named', () => {
  const rows = [0, 1, 2].map((i) => ({ ...HANDSHAKE_FAILED, error: undefined, detail: 'tls handshake failed: ECONNREFUSED', tls: null, ts: new Date(at - i * 60000).toISOString() }));
  const hs = evaluateProbeFindings('7', rows, { now: () => at }).find((f) => f.metric === 'probe.tls.handshake');
  assert.equal(hs.severity, 'CRIT');
  assert.match(hs.explanation, /nothing is listening/);
  assert.match(hs.explanation, /3 checks in a row/);
});

test('a valid certificate raises nothing; an untrusted one still does, with its real reason', () => {
  const [good] = validateProbeResults({ results: [GOOD_CERT] }).value.results;
  assert.deepEqual(evaluateProbeFindings('7', [good], { now: () => at }).filter((f) => /^probe\.tls/.test(f.metric)), []);

  const bad = { ...GOOD_CERT, ok: false, tls: { ...GOOD_CERT.tls, authorized: false, authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } };
  const [row] = validateProbeResults({ results: [bad] }).value.results;
  const trust = evaluateProbeFindings('7', [row], { now: () => at }).find((f) => f.metric === 'probe.tls');
  assert.match(trust.explanation, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
});

// ------------------------------------------------------------------ item 7
test('diagnostic probes (dhcp, tls, rdns, path_mtu) are not targets in the generic reachability verdict', () => {
  const ping = (target, ok) => ({ type: 'ping', target, ok, rttMs: ok ? 2 : null, lossPct: ok ? 0 : 100, ts: iso });
  const rows = [
    ping('10.0.0.1', true),
    ping('10.0.0.2', true),
    { type: 'dhcp', target: 'eth0', ok: false, lossPct: 100, ts: iso, dhcp: { offers: [] } },
    { type: 'tls', target: '203.0.113.2:8080', ok: false, lossPct: 100, ts: iso, tls: null },
    { type: 'rdns', target: '10.0.0.9', ok: false, ts: iso },
    { type: 'path_mtu', target: '10.0.0.9', ok: true, ts: iso },
  ];
  const h = computeAgentHealth(rows, { now: at.getTime() });
  assert.equal(h.metrics.targets, 2, 'the target count includes a diagnostic probe');
  assert.equal(h.metrics.unreachable, 0);
  assert.equal(h.status, 'ok');
  assert.doesNotMatch(h.reason, /not responding/);

  // A real outage still reads as one, with the diagnostic rows beside it.
  const down = computeAgentHealth([ping('10.0.0.1', false), ...rows.slice(1)], { now: at.getTime() });
  assert.match(down.reason, /1\/2 targets not responding \(e\.g\. 10\.0\.0\.1\)/);

  // Only diagnostics: no reachability verdict at all, rather than a false one.
  assert.equal(computeAgentHealth(rows.slice(2), { now: at.getTime() }).status, 'unknown');
});

test('a DHCP no-offer on its own yields the DHCP finding and no reachability finding', () => {
  const rows = [
    { type: 'ping', target: '10.0.0.1', ok: true, rttMs: 2, lossPct: 0, ts: iso },
    { type: 'dhcp', target: 'eth0', ok: false, ts: iso, dhcp: { iface: 'eth0', timeoutMs: 3000, offers: [] } },
  ];
  const found = evaluateProbeFindings('7', rows, { now: () => at });
  assert.deepEqual(found.map((f) => f.metric), ['probe.dhcp.no_offer']);
});
