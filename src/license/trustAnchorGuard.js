'use strict';

// Shared guard for overriding a cryptographic trust anchor (currently just the
// license public key) via environment variable.
//
// The env-var override exists for legitimate convenience (local dev, the demo
// docker-compose stack, CI). But in a real production install, the operator
// setting that env var is the SAME party the license is meant to constrain —
// letting them freely point verification at a public key of their own choosing
// (matching a private key only they hold) lets them self-sign an arbitrarily
// generous license, entirely without touching the tracked source. That defeats
// the whole point of asymmetric verification.
//
// So in production the override is blocked unless an explicit, hard-to-set-by-
// accident acknowledgement is also present. Without it, production always
// falls back to the embedded key in src/license/publicKey.js — which is the
// only place the real vendor key belongs (public keys aren't secret, so
// committing the real one is safe; see docs/licensing.md).
const OVERRIDE_ACK_TOKEN = 'i-accept-the-risk';

function isProduction(env) {
  return (env.NODE_ENV || 'development') === 'production';
}

function isKeyOverrideAllowed(env = process.env) {
  if (!isProduction(env)) return true;
  return String(env.TRUST_ANCHOR_OVERRIDE_ACK || '').trim().toLowerCase() === OVERRIDE_ACK_TOKEN;
}

module.exports = { isKeyOverrideAllowed, OVERRIDE_ACK_TOKEN };
