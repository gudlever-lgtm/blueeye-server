'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A platform slug looks like "linux-amd64", "windows-amd64", "linux-arm64".
// Two-or-more lowercase-alphanumeric segments joined by '-'.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

// Maps an artifact filename to its platform slug. Accepted shapes:
//   blueeye-agent-linux-amd64
//   blueeye-agent-windows-amd64.exe
// Returns the slug, or null when the file isn't a recognised agent binary.
function platformFromFilename(name) {
  const m = /^blueeye-agent-([a-z0-9-]+?)(?:\.exe)?$/.exec(name);
  if (!m) return null;
  return SLUG_RE.test(m[1]) ? m[1] : null;
}

// Scans a local directory for agent binaries and caches each file's SHA-256 at
// startup, so the binary is always served from the BlueEye server itself (no
// external download — works in air-gapped networks). Reads happen once; call
// reload() if binaries are published while the server is running.
//
// DI-friendly: pass a fake `fsImpl` in tests, or point `dir` at a temp folder.
function createArtifactStore({ dir, fsImpl = fs, logger = console } = {}) {
  const byPlatform = new Map();

  function scan() {
    byPlatform.clear();
    let names;
    try {
      names = fsImpl.readdirSync(dir);
    } catch (err) {
      // A missing artifacts dir is not fatal — the endpoints just 404 until
      // binaries are published. Log once so operators notice in production.
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`enroll: artifacts dir unavailable (${dir}): ${err.message}`);
      }
      return;
    }
    for (const name of names) {
      const platform = platformFromFilename(name);
      if (!platform) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fsImpl.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      let buf;
      try {
        buf = fsImpl.readFileSync(full);
      } catch {
        continue;
      }
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      byPlatform.set(platform, {
        platform,
        filename: name,
        path: full,
        size: stat.size,
        sha256,
        contentType: name.endsWith('.exe')
          ? 'application/vnd.microsoft.portable-executable'
          : 'application/octet-stream',
      });
    }
    if (logger && typeof logger.info === 'function' && byPlatform.size > 0) {
      logger.info(`enroll: ${byPlatform.size} agent artifact(s) available (${Array.from(byPlatform.keys()).join(', ')}).`);
    }
  }

  scan();

  return {
    reload: scan,
    // Metadata for all artifacts (no filesystem path), platform-sorted.
    list() {
      return Array.from(byPlatform.values())
        .map(({ path: _omit, ...rest }) => rest)
        .sort((a, b) => a.platform.localeCompare(b.platform));
    },
    // Full entry (incl. path) for one platform, or null.
    get(platform) {
      return byPlatform.get(String(platform || '')) || null;
    },
    has(platform) {
      return byPlatform.has(String(platform || ''));
    },
    // { platform: sha256, … } — embedded into the install script.
    checksums() {
      const out = {};
      for (const e of byPlatform.values()) out[e.platform] = e.sha256;
      return out;
    },
    get size() {
      return byPlatform.size;
    },
  };
}

module.exports = { createArtifactStore, platformFromFilename };
