'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createArtifactStore, platformFromFilename } = require('../src/enroll/artifactStore');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-artifacts-'));
}

test('platformFromFilename accepts agent binaries and rejects junk', () => {
  assert.equal(platformFromFilename('blueeye-agent-linux-amd64'), 'linux-amd64');
  assert.equal(platformFromFilename('blueeye-agent-windows-amd64.exe'), 'windows-amd64');
  assert.equal(platformFromFilename('blueeye-agent-linux-arm64'), 'linux-arm64');
  assert.equal(platformFromFilename('README.md'), null);
  assert.equal(platformFromFilename('blueeye-agent-'), null);
  assert.equal(platformFromFilename('blueeye-agent-LINUX-amd64'), null); // case-sensitive
});

test('createArtifactStore scans a dir and caches SHA-256 per platform', () => {
  const dir = tmpDir();
  const linux = Buffer.from('fake-linux-binary');
  const win = Buffer.from('fake-windows-binary');
  fs.writeFileSync(path.join(dir, 'blueeye-agent-linux-amd64'), linux);
  fs.writeFileSync(path.join(dir, 'blueeye-agent-windows-amd64.exe'), win);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');

  const store = createArtifactStore({ dir, logger: { info() {}, warn() {} } });
  assert.equal(store.size, 2);

  const got = store.get('linux-amd64');
  assert.equal(got.platform, 'linux-amd64');
  assert.equal(got.sha256, crypto.createHash('sha256').update(linux).digest('hex'));
  assert.equal(got.size, linux.length);
  assert.equal(got.contentType, 'application/octet-stream');

  const winEntry = store.get('windows-amd64');
  assert.equal(winEntry.contentType, 'application/vnd.microsoft.portable-executable');

  assert.equal(store.has('linux-amd64'), true);
  assert.equal(store.has('darwin-arm64'), false);
  assert.equal(store.get('darwin-arm64'), null);

  const checksums = store.checksums();
  assert.equal(checksums['linux-amd64'], got.sha256);
  assert.equal(Object.keys(checksums).length, 2);

  // list() omits the filesystem path and is platform-sorted.
  const list = store.list();
  assert.deepEqual(list.map((e) => e.platform), ['linux-amd64', 'windows-amd64']);
  assert.ok(!('path' in list[0]));
});

test('createArtifactStore tolerates a missing dir (size 0, no throw)', () => {
  const store = createArtifactStore({ dir: path.join(os.tmpdir(), 'does-not-exist-blueeye'), logger: { info() {}, warn() {} } });
  assert.equal(store.size, 0);
  assert.equal(store.get('linux-amd64'), null);
  assert.deepEqual(store.list(), []);
});

test('reload() picks up newly published binaries', () => {
  const dir = tmpDir();
  const store = createArtifactStore({ dir, logger: { info() {}, warn() {} } });
  assert.equal(store.size, 0);
  fs.writeFileSync(path.join(dir, 'blueeye-agent-linux-arm64'), Buffer.from('later'));
  store.reload();
  assert.equal(store.size, 1);
  assert.ok(store.get('linux-arm64'));
});
