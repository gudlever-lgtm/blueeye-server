'use strict';

const fs = require('fs');
const path = require('path');

// Persistent store of SIGNED agent release tarballs.
//
// Unlike agentSourceStore (which packages the local source tree at startup), a
// release is built + Ed25519-signed OFF the server and UPLOADED via
// POST /agents/releases. The route verifies the signature + checksum BEFORE
// calling add(); this store only persists/retrieves — it never trusts unverified
// input on its own. Tarball bytes live on disk under `dir`; each release has a
// sidecar `<name>.release.json` holding the signed manifest + signature (NO
// secrets, the signature is public). DI-friendly: inject fsImpl for tests.
function createAgentReleaseStore({ dir, fsImpl = fs, logger = console } = {}) {
  const index = new Map(); // version -> { version, sha256, size, signature, manifest, uploadedBy, createdAt }

  const safeName = (v) => `blueeye-agent-${String(v).replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const tgzPath = (v) => path.join(dir, `${safeName(v)}.tgz`);
  const metaPath = (v) => path.join(dir, `${safeName(v)}.release.json`);

  // Numeric, dotted-version compare (1.2.10 > 1.2.9); non-numeric parts fall back
  // to a string compare so it never throws on an odd version string.
  function compareVersions(a, b) {
    const pa = String(a).split('.');
    const pb = String(b).split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const na = parseInt(pa[i], 10);
      const nb = parseInt(pb[i], 10);
      if (Number.isNaN(na) || Number.isNaN(nb)) {
        const c = String(pa[i] || '').localeCompare(String(pb[i] || ''));
        if (c !== 0) return c;
      } else if (na !== nb) {
        return na - nb;
      }
    }
    return 0;
  }

  function load() {
    index.clear();
    if (!dir) return;
    let entries;
    try {
      entries = fsImpl.readdirSync(dir);
    } catch {
      return; // dir not created yet / unreadable — treated as "no releases"
    }
    for (const name of entries) {
      if (!name.endsWith('.release.json')) continue;
      try {
        const meta = JSON.parse(fsImpl.readFileSync(path.join(dir, name), 'utf8'));
        if (meta && meta.version) index.set(meta.version, meta);
      } catch {
        /* skip an unreadable/corrupt sidecar rather than failing startup */
      }
    }
  }

  if (dir) {
    try { fsImpl.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  }
  load();

  function list() {
    return Array.from(index.values()).sort((a, b) => compareVersions(a.version, b.version));
  }

  function latest() {
    const all = list();
    return all.length ? all[all.length - 1] : null;
  }

  function has(version) {
    return index.has(version);
  }

  // Persists a release whose signature + checksum the CALLER has already verified.
  function add({ version, buffer, sha256, size, signature, manifest, uploadedBy = null }) {
    if (!dir) throw new Error('release store has no directory configured');
    fsImpl.writeFileSync(tgzPath(version), buffer);
    const meta = { version, sha256, size, signature, manifest, uploadedBy, createdAt: new Date().toISOString() };
    fsImpl.writeFileSync(metaPath(version), JSON.stringify(meta));
    index.set(version, meta);
    if (logger && typeof logger.info === 'function') {
      logger.info(`releases: stored agent ${version} (${size} bytes, sha256 ${String(sha256).slice(0, 12)}…).`);
    }
    return meta;
  }

  // Metadata + the tarball buffer for a version (read from disk), or null.
  function get(version) {
    const meta = index.get(version);
    if (!meta) return null;
    let buffer = null;
    try {
      buffer = fsImpl.readFileSync(tgzPath(version));
    } catch {
      return null; // sidecar present but tarball gone
    }
    return { ...meta, buffer };
  }

  return { reload: load, add, has, list, latest, get };
}

module.exports = { createAgentReleaseStore };
