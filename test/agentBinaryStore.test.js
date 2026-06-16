'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');

const { createAgentBinaryStore } = require('../src/enroll/agentBinaryStore');

const quiet = { info() {}, warn() {} };

// Minimal fake FS that supports the operations agentBinaryStore uses.
function makeFakeFs(initial = {}) {
  const files = { ...initial };
  const dirs = new Set();
  return {
    readFileSync(p, opts) {
      if (!(p in files)) { const e = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }); throw e; }
      const buf = Buffer.isBuffer(files[p]) ? files[p] : Buffer.from(files[p]);
      const enc = typeof opts === 'string' ? opts : (opts && opts.encoding) || null;
      return enc ? buf.toString(enc) : buf;
    },
    writeFileSync(p, data) { files[p] = data; },
    statSync(p) {
      if (p in files) {
        const v = files[p];
        const size = Buffer.isBuffer(v) ? v.length : Buffer.byteLength(String(v));
        return { isFile: () => true, isDirectory: () => false, size };
      }
      if (dirs.has(p)) return { isFile: () => false, isDirectory: () => true };
      const e = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }); throw e;
    },
    accessSync(p) {
      if (!(p in files) && !dirs.has(p)) {
        const e = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }); throw e;
      }
    },
    mkdirSync(p) { dirs.add(p); },
    existsSync(p) { return (p in files) || dirs.has(p); },
    _files: files,
    _dirs: dirs,
  };
}

// Returns a fake spawn that writes `binaryContent` to the --output arg on close.
function makeSpawnSuccess(binaryContent = Buffer.from('FAKE_BINARY_DATA'), fakeFs = null) {
  return (cmd, args) => {
    const ee = new EventEmitter();
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    const outIdx = args.indexOf('--output');
    const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
    setImmediate(() => {
      if (outFile && fakeFs) fakeFs._files[outFile] = binaryContent;
      ee.stderr.emit('data', '');
      ee.emit('close', 0);
    });
    return ee;
  };
}

// Returns a fake spawn that exits with a non-zero code and stderr.
function makeSpawnFailure(message = 'pkg: build error') {
  return () => {
    const ee = new EventEmitter();
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    setImmediate(() => {
      ee.stderr.emit('data', message);
      ee.emit('close', 1);
    });
    return ee;
  };
}

// Fake fs that has @yao-pkg/pkg's .bin/pkg accessible.
function fakeWithPkg(additionalFiles = {}) {
  const serverRoot = path.resolve(__dirname, '..'); // test runs from server root
  const pkgBinPath = path.join(serverRoot, 'node_modules', '.bin', 'pkg');
  return makeFakeFs({
    [path.join(__dirname, '..', 'dummy-agent', 'package.json')]: '{"name":"blueeye-agent","version":"1.2.3"}',
    [pkgBinPath]: '#!/usr/bin/env node\n// fake pkg',
    ...additionalFiles,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('reports error and no arches when agentDir is missing', async () => {
  const warnings = [];
  const store = createAgentBinaryStore({
    logger: { info() {}, warn(m) { warnings.push(m); } },
  });
  // Wait for the async build to settle
  await new Promise((r) => setTimeout(r, 50));
  const st = store.status();
  assert.equal(st.topError !== null, true, 'topError should be set');
  assert.match(st.topError, /AGENT_SOURCE_DIR/);
  assert.equal(warnings.some((w) => /AGENT_SOURCE_DIR/.test(w)), true);
  assert.equal(store.available('linux-x64'), false);
  assert.equal(store.available('linux-arm64'), false);
  assert.deepEqual(store.checksums(), {});
});

test('reports error when @yao-pkg/pkg is not installed', async () => {
  const warnings = [];
  const fakeFs = makeFakeFs({
    '/fake-agent/package.json': '{"name":"blueeye-agent","version":"1.0.0"}',
  });
  const store = createAgentBinaryStore({
    agentDir: '/fake-agent',
    cacheDir: '/fake-cache',
    fsImpl: fakeFs,
    findPkgBin: () => null,  // simulate pkg not installed
    spawnImpl: makeSpawnFailure(),
    logger: { info() {}, warn(m) { warnings.push(m); } },
  });
  await new Promise((r) => setTimeout(r, 50));
  const st = store.status();
  assert.equal(st.topError !== null, true);
  assert.match(st.topError, /@yao-pkg\/pkg/);
});

test('loads binaries from cache when version matches — no build', async () => {
  const FAKE_BIN = Buffer.from('FAKE_BINARY_BYTES_FOR_TESTING_X64');
  const sha = crypto.createHash('sha256').update(FAKE_BIN).digest('hex');

  const cacheDir = '/fake-cache';
  const fakeFs = makeFakeFs({
    '/fake-agent/package.json': '{"name":"blueeye-agent","version":"5.6.7"}',
    [path.join(cacheDir, '.agent-version')]: '5.6.7',
    [path.join(cacheDir, 'blueeye-agent-linux-x64')]: FAKE_BIN,
    [path.join(cacheDir, 'blueeye-agent-linux-arm64')]: FAKE_BIN,
  });
  fakeFs._dirs.add(cacheDir);

  const buildCalled = [];
  const store = createAgentBinaryStore({
    agentDir: '/fake-agent',
    cacheDir,
    fsImpl: fakeFs,
    findPkgBin: () => '/fake/node_modules/.bin/pkg',
    spawnImpl: (...a) => { buildCalled.push(a); return makeSpawnFailure()(); },
    logger: quiet,
  });

  await new Promise((r) => setTimeout(r, 100));

  assert.equal(buildCalled.length, 0, 'should not spawn pkg on cache hit');
  assert.equal(store.available('linux-x64'), true);
  assert.equal(store.available('linux-arm64'), true);
  assert.equal(store.checksums()['linux-x64'], sha);
  assert.equal(store.get('linux-x64').size, FAKE_BIN.length);
});

test('builds and caches binaries when cache is stale', async () => {
  const FAKE_BIN = Buffer.from('BUILT_BINARY_CONTENT');
  const sha = crypto.createHash('sha256').update(FAKE_BIN).digest('hex');

  const cacheDir = '/cache-stale';
  const fakeFs = makeFakeFs({
    '/agent-stale/package.json': '{"name":"blueeye-agent","version":"2.0.0"}',
    // .agent-version absent → stale → triggers build
  });
  fakeFs._dirs.add(cacheDir);

  const store = createAgentBinaryStore({
    agentDir: '/agent-stale',
    cacheDir,
    fsImpl: fakeFs,
    findPkgBin: () => '/fake/node_modules/.bin/pkg',
    spawnImpl: makeSpawnSuccess(FAKE_BIN, fakeFs),
    logger: quiet,
  });

  await new Promise((r) => setTimeout(r, 200));

  assert.equal(store.available('linux-x64'), true);
  assert.equal(store.available('linux-arm64'), true);
  assert.equal(store.checksums()['linux-x64'], sha);
  // Version stamp should have been written
  const written = fakeFs._files[path.join(cacheDir, '.agent-version')];
  assert.equal(written !== undefined, true, '.agent-version stamp should be written');
  assert.equal(Buffer.from(written).toString().trim(), '2.0.0');
});

test('marks arch as error when build exits non-zero', async () => {
  const cacheDir = '/cache-fail';
  const fakeFs = makeFakeFs({
    '/agent-fail/package.json': '{"name":"blueeye-agent","version":"3.0.0"}',
  });
  fakeFs._dirs.add(cacheDir);

  const store = createAgentBinaryStore({
    agentDir: '/agent-fail',
    cacheDir,
    fsImpl: fakeFs,
    findPkgBin: () => '/fake/node_modules/.bin/pkg',
    spawnImpl: makeSpawnFailure('Cannot resolve module ws'),
    logger: quiet,
  });

  await new Promise((r) => setTimeout(r, 200));

  const st = store.status();
  assert.equal(st.arches['linux-x64'].built, false);
  assert.match(st.arches['linux-x64'].error || '', /Cannot resolve module ws/);
  assert.equal(store.available('linux-x64'), false);
  assert.equal(store.get('linux-x64'), null);
});

test('status() reflects pending state before build completes', () => {
  const store = createAgentBinaryStore({ logger: quiet });
  const st = store.status();
  // build should be pending or complete (topError when no dir) — not throwing
  assert.equal(typeof st.ready, 'boolean');
  assert.equal(typeof st.arches, 'object');
});

test('checksums() returns empty object when nothing is ready', async () => {
  const store = createAgentBinaryStore({ logger: quiet });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(store.checksums(), {});
});
