'use strict';

const crypto = require('crypto');
const { canonicalize } = require('../lib/canonicalize');

// Verifies an Ed25519 signature over the canonical bytes of `payload` using the
// embedded public key. This mirrors blueeye-licens' verifyPayload exactly. Any
// error (bad key, bad signature encoding, etc.) is treated as "not verified".
function verifyProof(payload, signatureBase64, publicKey) {
  try {
    if (!payload || typeof signatureBase64 !== 'string' || !publicKey) return false;
    const message = Buffer.from(canonicalize(payload), 'utf8');
    return crypto.verify(null, message, publicKey, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

module.exports = { verifyProof };
