'use strict';

// Embedded Ed25519 public key used to verify license proofs from blueeye-licens.
//
// INSTALLATION: replace the placeholder below with the public key printed by
// `node scripts/generate-signing-key.js` in blueeye-licens (also recorded in
// that repo's docs/public-key.md). Alternatively, provide it at runtime via the
// LICENSE_PUBLIC_KEY environment variable (PEM or base64-of-PEM). The public key
// is not secret. Until a real key is configured, every proof fails to verify and
// the server treats itself as offline (relying on a cached license, if any).
const EMBEDDED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
REPLACE_WITH_BLUEEYE_LICENS_PUBLIC_KEY
-----END PUBLIC KEY-----`;

function looksLikePem(value) {
  return typeof value === 'string' && value.includes('BEGIN PUBLIC KEY');
}

// Resolves the public key: LICENSE_PUBLIC_KEY (PEM or base64) wins, otherwise the
// embedded constant.
function resolvePublicKey(env = process.env) {
  const raw = env.LICENSE_PUBLIC_KEY;
  if (raw && raw.trim()) {
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

// True once a real key has been configured (not the placeholder).
function isConfigured(publicKey) {
  return looksLikePem(publicKey) && !publicKey.includes('REPLACE_WITH_BLUEEYE_LICENS_PUBLIC_KEY');
}

module.exports = { EMBEDDED_PUBLIC_KEY, resolvePublicKey, isConfigured };
