'use strict';

// The Service Assurance worker image carries a HAND-PICKED subset of the repo
// (docker/Dockerfile.service-test-worker) — the module's files, not the server's,
// so a deployment that never enables the feature pulls no browser image and the
// worker stays extractable.
//
// A hand-picked list can go stale in one direction only: a file the entrypoint
// requires stops being copied, and the container dies at boot with
// MODULE_NOT_FOUND. Docker reports that as "Started" and restarts it forever,
// and the dashboard just says no worker is connected. That shipped once —
// src/config.js was copied while the three licensing/fingerprint files IT
// requires were not.
//
// So: walk the require graph from the entrypoint and assert every file in it is
// covered by a COPY line. Static, no Docker, no build.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const DOCKERFILE = path.join(REPO_ROOT, 'docker/Dockerfile.service-test-worker');
const ENTRYPOINT = path.join(REPO_ROOT, 'scripts/service-test-worker.js');

// The repo-relative source paths of every COPY in the Dockerfile. A COPY line is
// `COPY <src>... <dest>`, so the last token is the destination.
function copiedPaths(dockerfile) {
  const paths = [];
  for (const line of dockerfile.split('\n')) {
    const m = /^\s*COPY\s+(.+)$/i.exec(line);
    if (!m) continue;
    const parts = m[1].trim().split(/\s+/).filter((p) => !p.startsWith('--'));
    for (const src of parts.slice(0, -1)) paths.push(src.replace(/^\.\//, ''));
  }
  return paths;
}

// Every relative require reachable from a file, resolved to a real path.
// node_modules is out of scope: `npm ci` in the image installs those.
function requireGraph(entry) {
  const seen = new Set();
  const unresolved = [];
  (function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    const re = /require\(\s*'(\.[^']*)'\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      let resolved;
      try {
        resolved = require.resolve(path.resolve(path.dirname(file), m[1]));
      } catch {
        unresolved.push(`${path.relative(REPO_ROOT, file)} → ${m[1]}`);
        continue;
      }
      if (resolved.includes('node_modules')) continue;
      walk(resolved);
    }
  }(entry));
  return { files: [...seen].map((f) => path.relative(REPO_ROOT, f)), unresolved };
}

test('every file the worker requires is copied into its image', () => {
  const copied = copiedPaths(fs.readFileSync(DOCKERFILE, 'utf8'));
  const { files, unresolved } = requireGraph(ENTRYPOINT);

  assert.deepEqual(unresolved, [], 'a relative require in the worker graph does not resolve');

  const covered = (rel) => copied.some((c) => {
    if (c.includes('*')) {
      // `package*.json` and friends — match the glob's directory + prefix.
      const re = new RegExp(`^${c.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      return re.test(rel);
    }
    return rel === c || rel.startsWith(`${c}/`);
  });

  const missing = files.filter((f) => !covered(f)).sort();
  assert.deepEqual(missing, [], `these files are required at runtime but are NOT in the worker image:\n  ${missing.join('\n  ')}`);
});

test('the worker does not require the server config module', () => {
  // src/config.js reaches licensing, the trust anchor and the machine
  // fingerprint. The worker needs a database and a secret key; it reads them
  // from src/lib/coreEnv.js, which the server uses too.
  const { files } = requireGraph(ENTRYPOINT);
  assert.ok(!files.includes('src/config.js'), 'the worker requires src/config.js again — it drags the server\'s licensing chain into a container that has none of it');
  assert.ok(files.includes('src/lib/coreEnv.js'), 'the worker no longer reads the shared db/secret configuration');
});
