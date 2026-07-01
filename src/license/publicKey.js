'use strict';

const { isKeyOverrideAllowed } = require('./trustAnchorGuard');

// Embedded Ed25519 public key used to verify license proofs from blueeye-licens.
//
// INSTALLATION: replace the placeholder below with the public key printed by
// `node scripts/generate-signing-key.js` in blueeye-licens (also recorded in
// that repo's docs/public-key.md). This embedded constant is the ONLY trust
// anchor honoured in production. The public key is not secret, so committing
// the real one here is safe — and it's the only way to keep the anchor out of
// the operator's own hands (see trustAnchorGuard.js). Until a real key is
// configured, every proof fails to verify and the server treats itself as
// offline (relying on a cached license, if any).
//
// LICENSE_PUBLIC_KEY (PEM or base64-of-PEM) remains available as a convenience
// override for local dev, tests and the demo docker-compose stack; in
// production it is ignored unless TRUST_ANCHOR_OVERRIDE_ACK is also set (see
// trustAnchorGuard.js and docs/licensing.md).
const EMBEDDED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
REPLACE_WITH_BLUEEYE_LICENS_PUBLIC_KEY
-----END PUBLIC KEY-----`;

function looksLikePem(value) {
  return typeof value === 'string' && value.includes('BEGIN PUBLIC KEY');
}

// Resolves the public key: LICENSE_PUBLIC_KEY (PEM or base64) wins when the
// override is allowed (see isKeyOverrideAllowed), otherwise the embedded
// constant — always the embedded constant in production without the ack.
function resolvePublicKey(env = process.env) {
  const raw = env.LICENSE_PUBLIC_KEY;
  if (raw && raw.trim() && isKeyOverrideAllowed(env)) {
    if (looksLikePem(raw)) return raw;
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      if (looksLikePem(decoded)) return decoded;
    } catch {
      /* fall through */
    }
    return raw;
  }
  return EMBEDDED_PUBLIC_KEY;
}

// 'embedded' | 'env' | 'blocked' — for boot-time logging (never affects trust
// itself, resolvePublicKey is the single source of truth).
function publicKeySource(env = process.env) {
  const raw = env.LICENSE_PUBLIC_KEY;
  if (!raw || !raw.trim()) return 'embedded';
  return isKeyOverrideAllowed(env) ? 'env' : 'blocked';
}

// True once a real key has been configured (not the placeholder).
function isConfigured(publicKey) {
  return looksLikePem(publicKey) && !publicKey.includes('REPLACE_WITH_BLUEEYE_LICENS_PUBLIC_KEY');
}

module.exports = { EMBEDDED_PUBLIC_KEY, resolvePublicKey, publicKeySource, isConfigured };
