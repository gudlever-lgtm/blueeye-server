'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { createAgentSourceStore } = require('../src/enroll/agentSourceStore');

const quiet = { info() {}, warn() {} };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-src-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"blueeye-agent"}');
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log(1)');
  // Should be excluded from the bundle:
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'x');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=do-not-ship');
  fs.writeFileSync(path.join(dir, 'agent.token'), 'super-secret-token');
  return dir;
}

test('packages the source dir into a checksummed gzip, excluding node_modules', () => {
  const store = createAgentSourceStore({ dir: fixture(), logger: quiet });
  assert.equal(store.available(), true);
  assert.equal(store.sha256.length, 64);

  const meta = store.meta();
  assert.equal(meta.filename, 'blueeye-agent-source.tgz');
  assert.equal(meta.contentType, 'application/gzip');
  assert.equal(meta.sha256, store.sha256);
  assert.equal(meta.size, store.buffer().length);

  // It's valid gzip, and the served sha matches the served bytes.
  const buf = store.buffer();
  assert.ok(zlib.gunzipSync(buf).length > 0);
  assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), store.sha256);

  // Extract with the system tar and confirm contents + the exclusion.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-out-'));
  const tgz = path.join(out, 'a.tgz');
  fs.writeFileSync(tgz, buf);
  execFileSync('tar', ['-xzf', tgz, '-C', out]);
  assert.ok(fs.existsSync(path.join(out, 'package.json')));
  assert.ok(fs.existsSync(path.join(out, 'src', 'index.js')));
  assert.equal(fs.existsSync(path.join(out, 'node_modules')), false, 'node_modules excluded');
  assert.equal(fs.existsSync(path.join(out, '.env')), false, 'secrets excluded');
  assert.equal(fs.existsSync(path.join(out, 'agent.token')), false, 'tokens excluded');
});

test('tolerates a missing dir (unavailable, no throw)', () => {
  const store = createAgentSourceStore({ dir: path.join(os.tmpdir(), `nope-blueeye-${Date.now()}`), logger: quiet });
  assert.equal(store.available(), false);
  assert.equal(store.sha256, null);
  assert.equal(store.buffer(), null);
  assert.equal(store.meta(), null);
  assert.equal(store.size, 0);
});

test('unavailable (no throw) when no dir is configured', () => {
  const store = createAgentSourceStore({ logger: quiet });
  assert.equal(store.available(), false);
});

test('unavailable when tar fails (injected exec)', () => {
  const fakeExec = () => ({ status: 1, stderr: 'tar: boom' });
  const store = createAgentSourceStore({ dir: fixture(), exec: fakeExec, logger: quiet });
  assert.equal(store.available(), false);
});

test('reload() re-packages after the source changes', () => {
  const dir = fixture();
  const store = createAgentSourceStore({ dir, logger: quiet });
  const first = store.sha256;
  fs.writeFileSync(path.join(dir, 'src', 'extra.js'), 'console.log(2)');
  store.reload();
  assert.notEqual(store.sha256, first);
});
