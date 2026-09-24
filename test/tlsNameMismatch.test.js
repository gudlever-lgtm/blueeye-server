'use strict';

// A certificate for the wrong NAME is not an untrusted CHAIN.
//
// In a real end-to-end run a tls probe of 203.0.113.2:8443 asking for
// "wrong.blueeye-e2e.test" got a certificate whose chain validated and whose
// name did not. node reports that as authorized:false +
// ERR_TLS_CERT_ALTNAME_INVALID — it checks the chain FIRST, so the code only
// ever means "chain fine, name wrong" — and the finding read it as "the chain
// does not validate (ERR_TLS_CERT_ALTNAME_INVALID)", naming the address and
// not the name that was asked for. The fix for one is to reissue or re-point
// the name; for the other it is to install an intermediate.
//
// And (N6): two probes of one host:port with different SNI names shared a
// target, so the valid one and the mismatched one overwrote each other's
// finding. The agent (0.40+) now reports `name@host:port` for an explicit name.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateProbeResults } = require('../src/validation/probeValidation');
const { evaluateProbeFindings } = require('../src/analysis/probeFindings');

const at = new Date('2026-09-24T09:30:00Z');
const iso = at.toISOString();

const CERT = {
  protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', expiryDays: 30, expired: false, notYetValid: false,
  subject: 'right.blueeye-e2e.test', issuer: 'BlueEye E2E CA',
  altNames: ['DNS:right.blueeye-e2e.test'], chainLength: 2, selfSigned: false,
};

// What agent 0.40+ sends for the mismatch.
const NEW_AGENT_MISMATCH = {
  type: 'tls', target: 'wrong.blueeye-e2e.test@203.0.113.2:8443', ok: false, lossPct: 0, certExpiryDays: 30, ts: iso,
  detail: 'expires in 30d · name mismatch — not valid for wrong.blueeye-e2e.test',
  tls: {
    ...CERT, authorized: false, authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID',
    chainTrusted: true, hostnameMatches: false, servername: 'wrong.blueeye-e2e.test',
  },
};
// What an older agent sent for the same handshake: no chainTrusted, no
// servername, and the address alone as the target.
const OLD_AGENT_MISMATCH = {
  type: 'tls', target: 'shop.example.dk:443', ok: false, lossPct: 0, certExpiryDays: 30, ts: iso,
  tls: { ...CERT, authorized: false, authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID', hostnameMatches: false },
};

const ingest = (r) => validateProbeResults({ results: [r] }).value.results[0];
const tlsFindings = (rows) => evaluateProbeFindings('7', rows, { now: () => at }).filter((f) => f.metric === 'probe.tls');

test('the stored block keeps chain trust and the SNI name apart from `authorized`', () => {
  const t = ingest(NEW_AGENT_MISMATCH).tls;
  assert.equal(t.authorized, false, 'node\'s verdict is kept as sent');
  assert.equal(t.authorizationError, 'ERR_TLS_CERT_ALTNAME_INVALID');
  assert.equal(t.chainTrusted, true);
  assert.equal(t.hostnameMatches, false);
  assert.equal(t.servername, 'wrong.blueeye-e2e.test');

  // An older agent's row is read the same way: refused only for the name is
  // a chain that validated. Anything else refused is not.
  const old = ingest(OLD_AGENT_MISMATCH).tls;
  assert.equal(old.chainTrusted, true);
  assert.equal(old.servername, null, 'optional: an older agent does not send it');
  const selfSigned = ingest({ ...OLD_AGENT_MISMATCH, tls: { ...CERT, authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }).tls;
  assert.equal(selfSigned.chainTrusted, false);
  assert.equal(ingest({ ...OLD_AGENT_MISMATCH, tls: { ...CERT, authorized: true } }).tls.chainTrusted, true);
  // An explicit chainTrusted from the agent wins; a non-boolean is not a verdict.
  assert.equal(ingest({ ...NEW_AGENT_MISMATCH, tls: { ...NEW_AGENT_MISMATCH.tls, chainTrusted: false } }).tls.chainTrusted, false);
  assert.equal(ingest({ ...OLD_AGENT_MISMATCH, tls: { ...OLD_AGENT_MISMATCH.tls, chainTrusted: 'yes' } }).tls.chainTrusted, true);
  // The name is held to the hostname rule before it is stored.
  assert.equal(ingest({ ...NEW_AGENT_MISMATCH, tls: { ...NEW_AGENT_MISMATCH.tls, servername: 'a b<script>' } }).tls.servername, null);
});

test('a name mismatch on a trusted chain is a "not valid for <name>" finding, never "the chain does not validate"', () => {
  const [f] = tlsFindings([ingest(NEW_AGENT_MISMATCH)]);
  assert.ok(f, 'no probe.tls finding');
  assert.equal(f.severity, 'CRIT');
  assert.match(f.explanation, /TLS certificate on 203\.0\.113\.2:8443 is not valid for wrong\.blueeye-e2e\.test/);
  assert.match(f.explanation, /the chain validates/);
  assert.match(f.explanation, /issued for right\.blueeye-e2e\.test/);
  assert.doesNotMatch(f.explanation, /does not validate|cannot be trusted|ALTNAME/);
  const ev = f.evidence[0];
  assert.equal(ev.servername, 'wrong.blueeye-e2e.test');
  assert.equal(ev.chainTrusted, true);
  assert.equal(ev.hostnameMatches, false);
  assert.deepEqual(ev.faults, ['name']);
});

test('an older agent\'s mismatch row reads the same way, naming the host it asked for', () => {
  const [f] = tlsFindings([ingest(OLD_AGENT_MISMATCH)]);
  assert.match(f.explanation, /TLS certificate on shop\.example\.dk:443 is not valid for shop\.example\.dk/);
  assert.doesNotMatch(f.explanation, /does not validate/);
  // Rows already stored before this change carry no chainTrusted at all.
  const stored = { ...OLD_AGENT_MISMATCH, tls: { ...OLD_AGENT_MISMATCH.tls } };
  assert.doesNotMatch(tlsFindings([stored])[0].explanation, /does not validate/);
});

test('an untrusted chain AND a wrong name are both named, and the SNI name with them', () => {
  const both = ingest({
    ...NEW_AGENT_MISMATCH,
    tls: { ...NEW_AGENT_MISMATCH.tls, authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', chainTrusted: false },
  });
  const [f] = tlsFindings([both]);
  assert.match(f.explanation, /on 203\.0\.113\.2:8443 for wrong\.blueeye-e2e\.test cannot be trusted/);
  assert.match(f.explanation, /it is not valid for wrong\.blueeye-e2e\.test/);
  assert.match(f.explanation, /the chain does not validate \(UNABLE_TO_VERIFY_LEAF_SIGNATURE\)/);
  assert.deepEqual(f.evidence[0].faults, ['name', 'chain']);
});

test('two SNI names on one host:port are two findings, not one that flips between them', () => {
  // Newest first, interleaved the way two probes on one schedule land.
  const good = {
    ...NEW_AGENT_MISMATCH, target: 'right.blueeye-e2e.test@203.0.113.2:8443', ok: true,
    tls: { ...CERT, authorized: true, authorizationError: null, chainTrusted: true, hostnameMatches: true, servername: 'right.blueeye-e2e.test' },
  };
  const rows = [good, NEW_AGENT_MISMATCH, good, NEW_AGENT_MISMATCH].map(ingest);
  const found = tlsFindings(rows);
  assert.equal(found.length, 1, 'the valid name raised a finding, or the mismatch was hidden by it');
  assert.equal(found[0].evidence[0].target, 'wrong.blueeye-e2e.test@203.0.113.2:8443');
  // The finding identity (probePipeline keyOf / dispatcher subjectOf) is the
  // evidence target, so the two names never throttle each other either.
  assert.notEqual(found[0].evidence[0].target, good.target);

  // And the mismatch is still raised when the valid probe is the newest row.
  assert.equal(tlsFindings([ingest(good), ingest(NEW_AGENT_MISMATCH)]).length, 1);
});
