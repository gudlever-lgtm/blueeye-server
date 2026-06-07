'use strict';

// Embedded Ed25519 PUBLIC key used to verify SIGNED agent release tarballs
// (uploaded via POST /agents/releases, then pushed to agents). This is the
// agent-release trust anchor — DISTINCT from the license public key, so a
// release-signing key compromise can't mint licenses (and vice-versa). It is
// generated with the SAME tool as the license key (blueeye-licens
// scripts/generate-signing-key.js) but a SEPARATE key pair.
//
// INSTALLATION: set AGENT_RELEASE_PUBLIC_KEY (PEM or base64-of-PEM) in the server
// environment, or replace the placeholder below. The public key is not secret.
// Until configured, POST /agents/releases returns 503 and no release publishes.
const EMBEDDED_RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
REPLACE_WITH_BLUEEYE_AGENT_RELEASE_PUBLIC_KEY
-----END PUBLIC KEY-----`;

function looksLikePem(value) {
  return typeof value === 'string' && value.includes('BEGIN PUBLIC KEY');
}

// True once a real key has been configured (not the placeholder).
function isReleaseKeyConfigured(publicKey) {
  return looksLikePem(publicKey) && !publicKey.includes('REPLACE_WITH_BLUEEYE_AGENT_RELEASE_PUBLIC_KEY');
}

// Resolves the release public key: AGENT_RELEASE_PUBLIC_KEY (PEM or base64) wins,
// otherwise the embedded constant. Returns '' when only the placeholder is
// present, so callers can treat "not configured" uniformly (a falsy key).
function resolveReleasePublicKey(env = process.env) {
  const raw = env.AGENT_RELEASE_PUBLIC_KEY;
  let key = EMBEDDED_RELEASE_PUBLIC_KEY;
  if (raw && raw.trim()) {
    if (looksLikePem(raw)) {
      key = raw;
    } else {
      try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        key = looksLikePem(decoded) ? decoded : raw;
      } catch {
        key = raw;
      }
    }
  }
  return isReleaseKeyConfigured(key) ? key : '';
}

module.exports = { EMBEDDED_RELEASE_PUBLIC_KEY, resolveReleasePublicKey, isReleaseKeyConfigured };
