'use strict';

const crypto = require('crypto');

// Signs the CURRENT agent source bundle into a signed release using the managed
// signing key and stores it, so GET /enroll/agent-release(.tgz) and "Update agents"
// serve it. This IS the server-side signing path — no external build host.
//
// No-op (returns null) when there's no signing key, no source bundle, or no release
// store, so the caller stays usable: unsigned source still installs, and upgrades
// simply wait until a key is generated. Idempotent: re-running re-signs the same
// bytes (a fresh manifest/signature), overwriting the same version in the store.
function publishSignedReleaseFromSource({ sourceStore, releaseStore, releaseKeyService, logger = console } = {}) {
  if (!releaseKeyService || !releaseKeyService.canSign()) return null;
  if (!sourceStore || !releaseStore || typeof releaseStore.add !== 'function') return null;

  const buffer = typeof sourceStore.buffer === 'function' ? sourceStore.buffer() : null;
  const version = typeof sourceStore.sourceVersion === 'function' ? sourceStore.sourceVersion() : null;
  if (!buffer || !version) {
    if (logger && logger.warn) logger.warn('release: no source bundle/version available to sign.');
    return null;
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const manifest = { version, sha256, size: buffer.length, created_at: new Date().toISOString() };
  let signature;
  try {
    signature = releaseKeyService.sign(manifest);
  } catch (err) {
    if (logger && logger.warn) logger.warn(`release: could not sign the source bundle (${err.message}).`);
    return null;
  }

  const meta = releaseStore.add({ version, buffer, sha256, size: buffer.length, signature, manifest, uploadedBy: null });
  if (logger && logger.info) logger.info(`release: published signed agent ${version} from source (sha256 ${sha256.slice(0, 12)}…).`);
  return meta;
}

module.exports = { publishSignedReleaseFromSource };
