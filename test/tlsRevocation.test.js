'use strict';

// The server half of the revocation check (agent 0.47+): what a tls spec may
// ask for, what is stored, and what the analysis makes of a revoked
// certificate.
//
// The point of every case here is the same: a revocation answer is either
// believed or named as a gap, and a gap is never stored or read as "fine". A
// certificate that was revoked this morning is still signed, still in date and
// still for the right name — so if anything here rounds "we could not tell"
// up to "good", the fault disappears.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateProbeSpec, validateProbeResults } = require('../src/validation/probeValidation');
const { evaluateProbeFindings } = require('../src/analysis/probeFindings');
const { buildFacts, isKnownFactPath } = require('../src/diagnose/facts');

const tlsRow = (tls, extra = {}) => ({ type: 'tls', target: 'example.com:443', ok: true, ...extra, ...tls });

// ---------------------------------------------------------------- the spec
test('a tls probe can be told how hard to ask about revocation, and nothing else', () => {
  // Nothing said = the stapled answer, which rides the handshake. It is not
  // written into the spec, so an existing probe does not look changed.
  assert.deepEqual(validateProbeSpec({ type: 'tls', host: 'example.com' }).value, { type: 'tls', host: 'example.com', port: 443 });
  assert.equal(validateProbeSpec({ type: 'tls', host: 'example.com', ocsp: 'staple' }).value.ocsp, undefined);
  // 'fetch' is the one that costs an outbound request, so it is asked for.
  assert.equal(validateProbeSpec({ type: 'tls', host: 'example.com', ocsp: 'fetch' }).value.ocsp, 'fetch');
  assert.equal(validateProbeSpec({ type: 'tls', host: 'example.com', ocsp: true }).value.ocsp, 'fetch');
  assert.equal(validateProbeSpec({ type: 'tls', host: 'example.com', ocsp: 'off' }).value.ocsp, 'off');
  assert.equal(validateProbeSpec({ type: 'tls', host: 'example.com', ocsp: false }).value.ocsp, 'off');
  assert.equal(validateProbeSpec({ type: 'tls', host: 'example.com', ocsp: 'FETCH' }).value.ocsp, 'fetch');
  // A word nobody recognises is a mistake, not a mode: reading it as 'off'
  // would silently stop checking.
  for (const bad of ['yes', 'crl', 'none-of-it', 1, {}]) {
    assert.ok(validateProbeSpec({ type: 'tls', host: 'example.com', ocsp: bad }).errors, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- storage
test('the revocation answer is stored whole, field by field, and never widened', () => {
  const { value } = validateProbeResults({
    results: [tlsRow({
      authorized: true,
      revoked: true,
      revocation: {
        checked: true, source: 'staple', status: 'revoked', revoked: true,
        revokedAt: '2026-09-30T08:00:00.000Z', reason: 'keyCompromise',
        responder: 'http://ocsp.example-ca.test/', signatureVerified: true,
        thisUpdate: '2026-10-01T00:00:00.000Z', nextUpdate: '2026-10-08T00:00:00.000Z',
        stale: false, error: null, invented: 'a field a future agent added',
      },
    }, { ok: false })],
  });
  const c = value.results[0].tls;
  assert.equal(c.revoked, true);
  assert.equal(c.revocation.status, 'revoked');
  assert.equal(c.revocation.reason, 'keyCompromise');
  assert.equal(c.revocation.source, 'staple');
  assert.equal(c.revocation.signatureVerified, true);
  assert.equal(c.revocation.invented, undefined, 'a key the agent invented reached the database');
});

test('an older agent says nothing about revocation, and silence is not a clean bill of health', () => {
  const { value } = validateProbeResults({ results: [tlsRow({ authorized: true, hostnameMatches: true, expiryDays: 90 })] });
  const c = value.results[0].tls;
  assert.equal(c.revocation, null, 'a block was invented for an agent that sent none');
  assert.equal(c.revoked, false, 'and the flag must not claim anything either way');
});

test('a status nobody recognises is kept as unchecked rather than becoming a verdict', () => {
  for (const status of ['fine', 'REVOKED', 42, null, undefined]) {
    const { value } = validateProbeResults({ results: [tlsRow({ authorized: true, revocation: { checked: true, status } })] });
    const rev = value.results[0].tls.revocation;
    assert.equal(rev.status, 'unchecked', JSON.stringify(status));
    assert.equal(rev.revoked, false, 'and it certainly does not become a fault');
  }
  // Only the word itself is the fault — not the flag beside it.
  const { value } = validateProbeResults({ results: [tlsRow({ authorized: true, revoked: true, revocation: { checked: true, status: 'good' } })] });
  assert.equal(value.results[0].tls.revoked, false, 'the block carries the reason, so the block decides');
});

test('a good answer that could not be verified is stored as unverified, which is not good', () => {
  const { value } = validateProbeResults({
    results: [tlsRow({ authorized: true, revocation: { checked: true, source: 'ocsp', status: 'unverified', signatureVerified: null, signatureNote: 'unsupported signature algorithm 1.2.840.113549.1.1.10' } })],
  });
  const rev = value.results[0].tls.revocation;
  assert.equal(rev.status, 'unverified');
  assert.equal(rev.signatureVerified, null, 'tri-state: null is "nothing to check it with"');
  assert.match(rev.signatureNote, /unsupported signature algorithm/);
});

test('a source the agent did not ask through is dropped rather than guessed', () => {
  const { value } = validateProbeResults({ results: [tlsRow({ authorized: true, revocation: { checked: true, status: 'good', source: 'crl-maybe' } })] });
  assert.equal(value.results[0].tls.revocation.source, null);
});

// ---------------------------------------------------------------- findings
test('a revoked certificate is a critical finding that says reissue, not renew', () => {
  const at = new Date();
  const rows = [{
    type: 'tls', target: 'example.com:443', ok: false, ts: at.toISOString(), certExpiryDays: 200,
    tls: {
      authorized: true, chainTrusted: true, hostnameMatches: true, expired: false, expiryDays: 200,
      issuer: 'Example CA', subject: 'example.com', revoked: true,
      revocation: { checked: true, source: 'staple', status: 'revoked', revoked: true, revokedAt: '2026-09-30T08:00:00.000Z', reason: 'keyCompromise', signatureVerified: true },
    },
  }];
  const found = evaluateProbeFindings('agent-1', rows, { now: () => at });
  const f = found.find((x) => x.metric === 'probe.tls');
  assert.ok(f, `no revocation finding: ${found.map((x) => x.metric).join(', ')}`);
  assert.equal(f.severity, 'CRIT');
  assert.match(f.explanation, /REVOKED on 2026-09-30/);
  assert.match(f.explanation, /keyCompromise/);
  assert.match(f.explanation, /NEW key/, 'a compromised key has to be replaced, and the finding has to say so');
  assert.deepEqual(f.evidence[0].faults, ['revoked']);
  assert.equal(f.evidence[0].revocation.source, 'staple');
  // 200 days left: the expiry countdown has nothing to say, which is exactly
  // the trap this check exists for.
  assert.equal(found.filter((x) => x.metric === 'probe.cert').length, 0);
});

test('not knowing whether a certificate was revoked raises nothing at all', () => {
  const at = new Date();
  const base = {
    authorized: true, chainTrusted: true, hostnameMatches: true, expired: false, expiryDays: 200,
    issuer: 'Example CA', subject: 'example.com',
  };
  for (const revocation of [
    null,
    { checked: false, status: 'unchecked', error: 'no stapled response' },
    { checked: false, status: 'error', error: 'connect ECONNREFUSED' },
    { checked: false, status: 'off' },
    { checked: true, status: 'unknown' },
    { checked: true, status: 'unverified', signatureVerified: null },
    { checked: true, status: 'good', signatureVerified: true },
  ]) {
    const rows = [{ type: 'tls', target: 'example.com:443', ok: true, ts: at.toISOString(), certExpiryDays: 200, tls: { ...base, revoked: false, revocation } }];
    const found = evaluateProbeFindings('agent-1', rows, { now: () => at }).filter((x) => x.metric === 'probe.tls');
    assert.equal(found.length, 0, `a gap became a finding: ${JSON.stringify(revocation)}`);
  }
});

test('a revoked certificate that is ALSO expired and misnamed names all three', () => {
  const at = new Date();
  const rows = [{
    type: 'tls', target: 'mail.example.dk:993', ok: false, ts: at.toISOString(), certExpiryDays: -2,
    tls: {
      authorized: false, chainTrusted: false, authorizationError: 'CERT_HAS_EXPIRED', hostnameMatches: false,
      expired: true, expiryDays: -2, issuer: 'Example CA', subject: 'other.example.dk', servername: 'mail.example.dk',
      revoked: true, revocation: { checked: true, source: 'ocsp', status: 'revoked', revoked: true, reason: 'superseded', signatureVerified: true },
    },
  }];
  const f = evaluateProbeFindings('agent-1', rows, { now: () => at }).find((x) => x.metric === 'probe.tls');
  assert.deepEqual(f.evidence[0].faults, ['revoked', 'expired', 'name']);
  // Revoked is said first: the others are mistakes, this one is a withdrawal.
  assert.match(f.explanation, /REVOKED[^.]*expired/);
});

// ---------------------------------------------------------------- diagnose
test('a playbook can read the revocation status, and tell "not revoked" from "nobody could say"', () => {
  assert.ok(isKnownFactPath('tls.revoked'));
  assert.ok(isKnownFactPath('tls.revocation_status'));

  const asked = buildFacts({ results: [{ type: 'tls', target: 'example.com:443', ok: true, tls: { revoked: false, revocation: { status: 'good' } } }] });
  assert.equal(asked.tls.revoked, false);
  assert.equal(asked.tls.revocation_status, 'good');

  const gap = buildFacts({ results: [{ type: 'tls', target: 'example.com:443', ok: true, tls: { revoked: false, revocation: { status: 'unchecked' } } }] });
  assert.equal(gap.tls.revocation_status, 'unchecked', 'a rule has to be able to tell a gap from a verdict');

  // An older agent reported neither, and an absent fact is absent — not false.
  const old = buildFacts({ results: [{ type: 'tls', target: 'example.com:443', ok: true, tls: { authorized: true } }] });
  assert.equal(old.tls.revoked, undefined);
  assert.equal(old.tls.revocation_status, undefined);
});
