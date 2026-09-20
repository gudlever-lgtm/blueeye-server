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
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"blueeye-agent","version":"9.9.9"}');
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log(1)');
  // Should be excluded from the bundle:
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'x');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=do-not-ship');
  fs.writeFileSync(path.join(dir, 'agent.token'), 'super-secret-token');
  fs.writeFileSync(path.join(dir, 'uninstall.sh'), '#!/bin/sh\necho bye\n');
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

  // The uninstall helper is exposed for the /enroll/uninstall.sh one-liner.
  assert.match(store.uninstallScript(), /echo bye/);
  // The served agent version is exposed for update checks.
  assert.equal(store.sourceVersion(), '9.9.9');
});

test('tolerates a missing dir (unavailable, no throw)', () => {
  const store = createAgentSourceStore({ dir: path.join(os.tmpdir(), `nope-blueeye-${Date.now()}`), logger: quiet });
  assert.equal(store.available(), false);
  assert.equal(store.sha256, null);
  assert.equal(store.buffer(), null);
  assert.equal(store.meta(), null);
  assert.equal(store.size, 0);
  assert.equal(store.uninstallScript(), null);
  assert.equal(store.sourceVersion(), null);
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

// ==================================================== reproducibility
// The checksum is embedded in the install script when that script is GENERATED;
// the tarball is downloaded in a separate request afterwards. If packaging the
// same source twice gives different bytes, the two disagree and the host
// refuses to update — which is exactly what happened in the field.

test('the same source packaged twice produces the same bytes', () => {
  const dir = fixture();
  const first = createAgentSourceStore({ dir, logger: quiet });
  const second = createAgentSourceStore({ dir, logger: quiet });
  assert.equal(first.sha256, second.sha256);
  assert.ok(first.buffer().equals(second.buffer()), 'byte-for-byte, not just the same length');
});

test('fresh mtimes do not change the checksum — a redeploy is not a new archive', () => {
  // `git clone` and most deploy tooling rewrite mtimes, so the SAME COMMIT
  // checked out twice used to hash differently. That made the checksum a
  // property of when the server packaged rather than of what the source is,
  // and it is why a second replica could never validate the first one's script.
  const dir = fixture();
  const before = createAgentSourceStore({ dir, logger: quiet }).sha256;

  const later = new Date(Date.now() + 120_000);
  for (const f of ['package.json', path.join('src', 'index.js')]) {
    fs.utimesSync(path.join(dir, f), later, later);
  }
  const after = createAgentSourceStore({ dir, logger: quiet }).sha256;

  assert.equal(after, before, 'the mtimes moved and the checksum must not have');
});

test('a real content change DOES change the checksum', () => {
  // The other half of the property: reproducible must not mean constant.
  const dir = fixture();
  const before = createAgentSourceStore({ dir, logger: quiet }).sha256;
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'console.log(2)');
  assert.notEqual(createAgentSourceStore({ dir, logger: quiet }).sha256, before);
});

test('a tar that cannot do it falls back rather than serving nothing', () => {
  // busybox tar (a bare alpine image) rejects --sort/--mtime/--owner. An
  // unstable checksum is bad; no agent source at all is worse, because then
  // nothing can enrol or update. So it retries without the flags and says so.
  const warnings = [];
  const realExec = require('node:child_process').spawnSync;
  const pickyExec = (cmd, args, opts) => {
    if (args.includes('--sort=name')) return { status: 2, stderr: 'tar: unrecognized option: sort' };
    return realExec(cmd, args, opts);
  };
  const store = createAgentSourceStore({
    dir: fixture(),
    exec: pickyExec,
    logger: { info() {}, warn: (m) => warnings.push(m) },
  });

  assert.equal(store.available(), true, 'the bundle must still be served');
  assert.equal(store.sha256.length, 64);
  assert.ok(zlib.gunzipSync(store.buffer()).length > 0, 'and it must still be a valid archive');
  assert.match(warnings.join(' '), /reproducible/i);
  assert.match(warnings.join(' '), /apk add tar/, 'the warning has to say how to fix it');
});

test('the gzip header carries no timestamp', () => {
  // Bytes 4..8 of a gzip stream are MTIME. The gzip BINARY writes now() there
  // by default; zlib.gzipSync writes zero, which is why the compression happens
  // in Node rather than through tar -z.
  const buf = createAgentSourceStore({ dir: fixture(), logger: quiet }).buffer();
  assert.deepEqual([...buf.subarray(4, 8)], [0, 0, 0, 0]);
});
