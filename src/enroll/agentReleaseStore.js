'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

  // Whether releases can actually be PERSISTED (a writable dir is configured).
  // Reads/serves still work without one, but add()/publish throws — so the UI can
  // explain "set AGENT_RELEASE_DIR" instead of surfacing a raw 500.
  function hasStorage() {
    return !!dir;
  }

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
    // Tarball first, through a temp file and a rename, then the sidecar. The
    // sidecar is what says which bytes were signed, so a half-written pair is
    // a release that can never verify on any agent: it downloads, hashes, and
    // reports "checksum mismatch" for ever. Rename is atomic on POSIX, so a
    // reader sees either the old file or the whole new one — never a partial.
    const tmp = `${tgzPath(version)}.tmp`;
    fsImpl.writeFileSync(tmp, buffer);
    fsImpl.renameSync(tmp, tgzPath(version));
    const meta = { version, sha256, size, signature, manifest, uploadedBy, createdAt: new Date().toISOString() };
    const metaTmp = `${metaPath(version)}.tmp`;
    fsImpl.writeFileSync(metaTmp, JSON.stringify(meta));
    fsImpl.renameSync(metaTmp, metaPath(version));
    index.set(version, meta);
    if (logger && typeof logger.info === 'function') {
      logger.info(`releases: stored agent ${version} (${size} bytes, sha256 ${String(sha256).slice(0, 12)}…).`);
    }
    return meta;
  }

  // Metadata + the tarball buffer for a version (read from disk), or null.
  //
  // The bytes are re-hashed and checked against the sha256 the sidecar says was
  // signed. An agent verifies the same thing after downloading and refuses to
  // install on a mismatch, so serving a pair that cannot agree only produces
  // "checksum mismatch — refusing to install" on every host, for ever, with
  // nothing in the server log. Better to answer "no release" and say why: the
  // next restart re-signs from source and repairs it. Cheap — a release is a
  // few MB and this runs once per download.
  function get(version) {
    const meta = index.get(version);
    if (!meta) return null;
    let buffer = null;
    try {
      buffer = fsImpl.readFileSync(tgzPath(version));
    } catch {
      return null; // sidecar present but tarball gone
    }
    const actual = crypto.createHash('sha256').update(buffer).digest('hex');
    if (meta.sha256 && actual !== meta.sha256) {
      if (logger && typeof logger.error === 'function') {
        logger.error(`releases: agent ${version} on disk does not match its signed manifest `
          + `(manifest ${String(meta.sha256).slice(0, 12)}…, file ${actual.slice(0, 12)}…). `
          + 'Refusing to serve it — no agent could install it. Restart the server to re-sign '
          + `the release from source, or re-upload it.`);
      }
      return null;
    }
    return { ...meta, buffer };
  }

  // Every stored release, checked against its sidecar. Returns the versions that
  // do NOT match, so the boot path can say so once rather than leaving it to
  // whichever agent tries to update first.
  function verify() {
    const bad = [];
    for (const version of index.keys()) {
      const meta = index.get(version);
      let buffer;
      try {
        buffer = fsImpl.readFileSync(tgzPath(version));
      } catch {
        bad.push({ version, reason: 'tarball missing' });
        continue;
      }
      const actual = crypto.createHash('sha256').update(buffer).digest('hex');
      if (meta.sha256 && actual !== meta.sha256) bad.push({ version, reason: 'sha256 does not match the signed manifest' });
    }
    return bad;
  }

  return { reload: load, add, has, list, latest, get, verify, hasStorage };
}

module.exports = { createAgentReleaseStore };
