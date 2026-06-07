'use strict';

const crypto = require('crypto');
const { canonicalize } = require('../lib/canonicalize');
const { resolveReleasePublicKey } = require('../license/releaseKey');

// Manages the agent-release signing key — generated ON the server from Settings.
//
// The PRIVATE key never leaves the server: stored encrypted at rest (secretBox),
// held decrypted IN MEMORY only to sign releases. The PUBLIC key (not secret) is
// served to agents so they verify signed self-updates. Write-once + deletable.
//
// An in-memory cache keeps getPublicKey()/sign() synchronous for request handlers;
// it is loaded once at startup and refreshed on generate()/remove(). (Single-process
// on-prem server; a multi-instance deploy would reload() on change.) When no managed
// key is stored it falls back to the env/embedded key, so existing deployments that
// set AGENT_RELEASE_PUBLIC_KEY keep working unchanged.
function createReleaseKeyService({ repo, secretBox, env = process.env, logger = console } = {}) {
  let cache = null; // { publicPem, privateKey, fingerprint, createdAt, createdBy } | null

  function warn(msg) { if (logger && typeof logger.warn === 'function') logger.warn(msg); }

  // Load the managed key from the store into the in-memory cache (decrypting the
  // private key). Safe to call repeatedly.
  async function load() {
    cache = null;
    if (!repo) return;
    const row = await repo.getWithSecret();
    if (!row) return;
    let privateKey = null;
    try {
      const pem = secretBox.decrypt(row.private_pem_encrypted);
      privateKey = crypto.createPrivateKey({ key: pem, format: 'pem' });
    } catch (err) {
      warn(`release key: could not decrypt the stored private key (${err.message}) — signing disabled until it is regenerated.`);
    }
    cache = { publicPem: row.public_pem, privateKey, fingerprint: row.fingerprint, createdAt: row.created_at, createdBy: row.created_by };
  }

  // The public key to serve/verify with: the managed (DB) key wins, otherwise the
  // env/embedded key (backward compatibility). '' when neither is configured.
  function getPublicKey() {
    if (cache && cache.publicPem) return cache.publicPem;
    return resolveReleasePublicKey(env) || '';
  }

  function isConfigured() { return !!getPublicKey(); }

  // Can the server actually SIGN (i.e. is a managed PRIVATE key loaded)? An env-only
  // public key configures verification but not signing.
  function canSign() { return !!(cache && cache.privateKey); }

  // Status for the UI — never any private material, only the non-secret fingerprint.
  function status() {
    if (cache) {
      return { configured: true, source: 'managed', createdAt: cache.createdAt || null, createdBy: cache.createdBy ?? null, fingerprint: cache.fingerprint || null, canSign: !!cache.privateKey };
    }
    const envKey = resolveReleasePublicKey(env);
    if (envKey) {
      return { configured: true, source: 'env', createdAt: null, createdBy: null, fingerprint: crypto.createHash('sha256').update(envKey).digest('hex'), canSign: false };
    }
    return { configured: false, source: null, createdAt: null, createdBy: null, fingerprint: null, canSign: false };
  }

  // Generate + persist a NEW Ed25519 key pair. Write-once: throws code 'EXISTS' when
  // a managed key already exists. Returns the safe status (no private material).
  async function generate({ userId = null } = {}) {
    if (cache && cache.publicPem) { const e = new Error('A release signing key already exists'); e.code = 'EXISTS'; throw e; }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const fingerprint = crypto.createHash('sha256').update(publicPem).digest('hex');
    await repo.create({ publicPem, privatePemEncrypted: secretBox.encrypt(privatePem), fingerprint, createdBy: userId });
    await load();
    return status();
  }

  // Delete the managed key. After this the server can neither sign upgrades nor
  // (per the enrollment gate) onboard new agents — until a key is generated again.
  async function remove() {
    if (repo) await repo.remove();
    cache = null;
    return status();
  }

  // Sign a release manifest with the managed private key: Ed25519 over the canonical
  // JSON bytes — the exact bytes the agent and the upload verifier check. Throws
  // (code 'NO_KEY') when no signing key is loaded.
  function sign(manifest) {
    if (!cache || !cache.privateKey) { const e = new Error('No release signing key configured'); e.code = 'NO_KEY'; throw e; }
    return crypto.sign(null, Buffer.from(canonicalize(manifest)), cache.privateKey).toString('base64');
  }

  return { load, getPublicKey, isConfigured, canSign, status, generate, remove, sign };
}

module.exports = { createReleaseKeyService };
