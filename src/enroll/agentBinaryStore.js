'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Architectures we build for and the corresponding @yao-pkg/pkg target names.
const TARGETS = [
  { arch: 'linux-x64',   pkgTarget: 'node22-linux-x64'  },
  { arch: 'linux-arm64', pkgTarget: 'node22-linux-arm64' },
];

// Builds self-contained agent binaries (one per arch) using @yao-pkg/pkg and
// caches them on disk.  The one-line installer can then download a ~60 MB
// binary instead of pulling a 500 MB node:22-alpine image or requiring Node.js
// on the target host.
//
// Build is asynchronous so the server starts accepting requests immediately;
// binaries are served once ready and the install script falls back gracefully
// to the source-bundle path until then.  On a cache hit (same agent version,
// file present) the build is skipped entirely.
//
// Missing requirements (no AGENT_SOURCE_DIR, @yao-pkg/pkg not installed, cache
// dir not writable, network error fetching the pkg base binaries) are logged as
// warnings and exposed via status() so operators can investigate without digging
// through logs.
//
// DI-friendly: inject spawnImpl and fsImpl for unit tests.
function createAgentBinaryStore({
  agentDir,
  cacheDir,
  spawnImpl = spawn,
  fsImpl = fs,
  // Injectable so tests can supply a fixed path without needing @yao-pkg/pkg
  // installed.  In production the default checks require.resolve() AND the file.
  findPkgBin: findPkgBinOverride = null,
  logger = console,
} = {}) {
  const state = new Map();
  for (const { arch } of TARGETS) state.set(arch, { status: 'pending' });

  let buildComplete = false;
  let topError = null;

  function info(msg) { if (logger && typeof logger.info  === 'function') logger.info(msg);  }
  function warn(msg) { if (logger && typeof logger.warn  === 'function') logger.warn(msg);  }

  // Locate the .bin/pkg symlink that npm creates after installing @yao-pkg/pkg.
  // Tests can inject a fixed path via findPkgBinOverride to avoid depending on
  // the real package.  In production the default verifies the package via
  // require.resolve() (catches package missing from package.json) and then
  // checks the symlink exists on disk.
  function findPkgBin() {
    if (findPkgBinOverride) return findPkgBinOverride();
    try {
      require.resolve('@yao-pkg/pkg');
    } catch {
      return null;
    }
    const serverRoot = path.resolve(__dirname, '..', '..');
    const p = path.join(serverRoot, 'node_modules', '.bin', 'pkg');
    try { fsImpl.accessSync(p); return p; } catch {}
    return null;
  }

  function readAgentVersion() {
    if (!agentDir) return null;
    try {
      return JSON.parse(fsImpl.readFileSync(path.join(agentDir, 'package.json'), 'utf8')).version || null;
    } catch { return null; }
  }

  function readCachedVersion(dir) {
    try {
      return fsImpl.readFileSync(path.join(dir, '.agent-version'), 'utf8').trim();
    } catch { return null; }
  }

  function buildOne(arch, pkgTarget, pkgBin, outFile) {
    return new Promise((resolve) => {
      state.set(arch, { status: 'building' });
      info(`enroll: building agent binary for ${arch} — this may take a few minutes while @yao-pkg/pkg fetches the Node.js base...`);

      const child = spawnImpl(process.execPath, [
        pkgBin,
        'src/index.js',
        '--target', pkgTarget,
        '--output', outFile,
        // Allow all packages so pkg doesn't hard-error on ws's optional native
        // add-ons (bufferutil / utf-8-validate) which are absent from the agent
        // dependencies and handled gracefully by ws at runtime.
        '--public-packages', '*',
      ], { cwd: agentDir, stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      if (child.stderr) child.stderr.on('data', (d) => { stderr += String(d); });

      child.on('error', (err) => {
        const msg = `spawn failed: ${err.message}`;
        state.set(arch, { status: 'error', error: msg });
        warn(`enroll: agent binary build failed for ${arch}: ${msg}`);
        resolve(false);
      });

      child.on('close', (code) => {
        if (code !== 0) {
          const why = stderr.trim().split('\n').slice(-8).join(' | ') || `exit ${code}`;
          state.set(arch, { status: 'error', error: why });
          warn(`enroll: agent binary build failed for ${arch}: ${why}`);
          resolve(false);
          return;
        }
        try {
          const stat = fsImpl.statSync(outFile);
          const buf = fsImpl.readFileSync(outFile);
          const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
          state.set(arch, {
            status: 'ready',
            path: outFile,
            size: stat.size,
            sha256,
            filename: `blueeye-agent-${arch}`,
            contentType: 'application/octet-stream',
          });
          info(`enroll: agent binary ready for ${arch} (${Math.round(stat.size / 1024 / 1024)} MB, sha256 ${sha256.slice(0, 12)}…)`);
          resolve(true);
        } catch (err) {
          const msg = `could not read built binary: ${err.message}`;
          state.set(arch, { status: 'error', error: msg });
          warn(`enroll: ${msg}`);
          resolve(false);
        }
      });
    });
  }

  async function _build() {
    if (!agentDir) {
      topError = 'AGENT_SOURCE_DIR not configured — agent binary build unavailable';
      warn(`enroll: ${topError}`);
      for (const { arch } of TARGETS) state.set(arch, { status: 'error', error: topError });
      buildComplete = true;
      return;
    }

    const pkgBin = findPkgBin();
    if (!pkgBin) {
      topError = '@yao-pkg/pkg not found — add it to the server: npm install --save-dev @yao-pkg/pkg';
      warn(`enroll: ${topError}`);
      for (const { arch } of TARGETS) state.set(arch, { status: 'error', error: topError });
      buildComplete = true;
      return;
    }

    const effectiveCacheDir = cacheDir || path.join(process.cwd(), 'agent-binaries');
    try {
      fsImpl.mkdirSync(effectiveCacheDir, { recursive: true });
    } catch (err) {
      topError = `cannot create binary cache dir (${effectiveCacheDir}): ${err.message}`;
      warn(`enroll: ${topError}`);
      for (const { arch } of TARGETS) state.set(arch, { status: 'error', error: topError });
      buildComplete = true;
      return;
    }

    const version = readAgentVersion();
    const cached = readCachedVersion(effectiveCacheDir);
    const hit = version && cached === version;

    const needBuild = [];
    for (const target of TARGETS) {
      const { arch } = target;
      const outFile = path.join(effectiveCacheDir, `blueeye-agent-${arch}`);
      if (hit) {
        try {
          const stat = fsImpl.statSync(outFile);
          if (stat.isFile && stat.isFile() && stat.size > 0) {
            const buf = fsImpl.readFileSync(outFile);
            const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
            state.set(arch, {
              status: 'ready',
              path: outFile,
              size: stat.size,
              sha256,
              filename: `blueeye-agent-${arch}`,
              contentType: 'application/octet-stream',
            });
            info(`enroll: agent binary for ${arch} loaded from cache (v${version}, sha256 ${sha256.slice(0, 12)}…)`);
            continue;
          }
        } catch {}
      }
      needBuild.push({ ...target, outFile });
    }

    // Build sequentially — pkg is CPU-intensive and downloading both base
    // binaries simultaneously could exhaust memory on small servers.
    for (const { arch, pkgTarget, outFile } of needBuild) {
      await buildOne(arch, pkgTarget, pkgBin, outFile);
    }

    // Write version stamp so restarts skip the build when nothing changed.
    if (version && Array.from(state.values()).some((s) => s.status === 'ready')) {
      try {
        fsImpl.writeFileSync(path.join(effectiveCacheDir, '.agent-version'), version, 'utf8');
      } catch {}
    }

    buildComplete = true;
  }

  let _buildPromise = _build().catch((err) => {
    warn(`enroll: binary build crashed unexpectedly: ${err.message}`);
    buildComplete = true;
  });

  return {
    // Trigger a fresh build (call after the agent source is updated).
    reload() {
      buildComplete = false;
      topError = null;
      for (const { arch } of TARGETS) state.set(arch, { status: 'pending' });
      _buildPromise = _build().catch((err) => {
        warn(`enroll: binary build crashed unexpectedly: ${err.message}`);
        buildComplete = true;
      });
    },

    // Build status for /system/version and operator alerting.  ready=false means
    // the build is still in progress; arches with built=false need attention.
    status() {
      const arches = {};
      for (const [arch, s] of state) {
        arches[arch] =
          s.status === 'ready'
            ? { built: true, sizeMb: Math.round(s.size / 1024 / 1024), sha256: s.sha256 }
            : { built: false, status: s.status, error: s.error || null };
      }
      return { ready: buildComplete, topError: topError || null, arches };
    },

    // True when a ready binary exists for this arch.
    available(arch) {
      return state.get(arch)?.status === 'ready';
    },

    // Full entry (incl. disk path) for serving, or null.
    get(arch) {
      const s = state.get(arch);
      return s?.status === 'ready' ? s : null;
    },

    // SHA-256 checksums for all ready arches.  Embedded into the generated
    // install script so the target host verifies its download before running.
    checksums() {
      const out = {};
      for (const [arch, s] of state) {
        if (s.status === 'ready') out[arch] = s.sha256;
      }
      return out;
    },
  };
}

module.exports = { createAgentBinaryStore };
