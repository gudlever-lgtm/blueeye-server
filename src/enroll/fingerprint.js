'use strict';

// TLS certificate fingerprint helpers. A "fingerprint" here is the SHA-256 of
// the server's (or its reverse proxy's) leaf certificate, the value the agent
// pins against. We normalise to upper-case hex pairs joined by ':' so inputs
// like "ab:cd…", "ABCD…", or "sha256:AB:CD…" all compare equal.
function normalizeFingerprint(input) {
  if (!input) return '';
  let s = String(input).trim();
  const prefix = /^sha-?256[:/=\s]+/i.exec(s);
  if (prefix) s = s.slice(prefix[0].length);
  s = s.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (s.length !== 64) return ''; // not a SHA-256 digest
  return s.match(/.{2}/g).join(':');
}

// True only when both inputs are valid SHA-256 fingerprints AND equal.
function fingerprintsMatch(a, b) {
  const na = normalizeFingerprint(a);
  const nb = normalizeFingerprint(b);
  return na !== '' && na === nb;
}

module.exports = { normalizeFingerprint, fingerprintsMatch };
