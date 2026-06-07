'use strict';

const crypto = require('crypto');

// AES-256-GCM authenticated encryption for secrets stored at rest — integration
// credentials and the LDAP bind password. This is REVERSIBLE on purpose, unlike
// the one-way SHA-256 used for agent tokens (src/auth/tokens.js): these secrets
// must be decrypted to be USED (to authenticate to ServiceNow/Nautobot/LDAP), so
// a hash is not an option. The stored form is self-describing:
//
//   v1.gcm.<ivB64url>.<tagB64url>.<ciphertextB64url>
//
// so a future scheme can be introduced without a data migration. A single 256-bit
// data key is derived once (scrypt) from one app secret — there is no per-secret
// key management — and every encryption uses a fresh random 96-bit IV. The GCM
// auth tag means a tampered ciphertext fails closed (decrypt throws) instead of
// returning wrong plaintext.

const VERSION = 'v1';
const SCHEME = 'gcm';
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // 96-bit nonce (recommended for GCM)
const PREFIX = `${VERSION}.${SCHEME}.`;
// Fixed KDF salt: the key material is a single long app secret, so a per-value
// salt would buy nothing here and would need storing alongside each value.
const KDF_SALT = Buffer.from('blueeye-secret-box/v1', 'utf8');

// Derives the 256-bit data key from the configured app secret. Exported so the
// derivation can be unit-tested and reused.
function deriveKey(secret) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('secretBox requires a non-empty key');
  }
  return crypto.scryptSync(secret, KDF_SALT, KEY_LEN);
}

// Builds a secret box bound to one app key. Injected wherever secrets are written
// (routes) or read for use (the integrations dispatcher, the LDAP auth service).
function createSecretBox({ key } = {}) {
  const dataKey = deriveKey(key);

  // Encrypts a UTF-8 string. An empty/nullish value encrypts to '' (there is
  // nothing to protect), so "no credentials configured" needs no special case.
  function encrypt(plaintext) {
    if (plaintext === null || plaintext === undefined || plaintext === '') return '';
    const text = typeof plaintext === 'string' ? plaintext : String(plaintext);
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
    const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, SCHEME, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  }

  // Decrypts a value produced by encrypt(). Returns '' for an empty value;
  // throws on a malformed or tampered token (the caller treats that as a hard
  // failure rather than ever returning wrong plaintext).
  function decrypt(token) {
    if (token === null || token === undefined || token === '') return '';
    if (typeof token !== 'string') throw new Error('secretBox: token must be a string');
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION || parts[1] !== SCHEME) {
      throw new Error('secretBox: unrecognized token format');
    }
    const iv = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    const ct = Buffer.from(parts[4], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  // True when a value looks like a secret-box token (vs. a legacy plaintext
  // value), so a caller can decrypt-or-passthrough during a migration window.
  function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
  }

  // Convenience for the common case of an object secret (credentials are a small
  // JSON object). decryptJson tolerates an empty/garbled token by returning {}.
  function encryptJson(obj) {
    return encrypt(JSON.stringify(obj == null ? {} : obj));
  }
  function decryptJson(token) {
    const s = decrypt(token);
    if (!s) return {};
    try { return JSON.parse(s); } catch { return {}; }
  }

  return { encrypt, decrypt, isEncrypted, encryptJson, decryptJson };
}

module.exports = { createSecretBox, deriveKey };
