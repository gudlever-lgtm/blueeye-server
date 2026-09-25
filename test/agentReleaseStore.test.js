'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createAgentReleaseStore } = require('../src/enroll/agentReleaseStore');
const { silentLogger } = require('../src/logger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-releases-'));
}

const sha = (body) => crypto.createHash('sha256').update(Buffer.from(body)).digest('hex');

test('release store persists, retrieves, and picks the latest by numeric version', () => {
  const dir = tmpDir();
  try {
    const store = createAgentReleaseStore({ dir, logger: silentLogger });
    // The sha256 must be the real one: get() re-hashes the bytes and refuses to
    // serve a release that does not match the manifest it was signed with.
    const add = (version, body) =>
      store.add({ version, buffer: Buffer.from(body), sha256: sha(body), size: body.length, signature: `sig-${version}`, manifest: { version }, uploadedBy: 1 });

    add('0.2.0', 'a');
    add('0.10.0', 'bb'); // must sort ABOVE 0.9.0/0.3.0 numerically, not as a string
    add('0.3.0', 'ccc');

    assert.equal(store.has('0.2.0'), true);
    assert.equal(store.has('9.9.9'), false);
    assert.equal(store.latest().version, '0.10.0');
    assert.deepEqual(store.list().map((r) => r.version), ['0.2.0', '0.3.0', '0.10.0']);

    const got = store.get('0.3.0');
    assert.equal(got.buffer.toString(), 'ccc');
    assert.equal(got.sha256, sha('ccc'));
    assert.equal(store.get('0.99.0'), null);

    // A fresh store over the same dir rebuilds its index from the sidecars.
    const reopened = createAgentReleaseStore({ dir, logger: silentLogger });
    assert.equal(reopened.latest().version, '0.10.0');
    assert.equal(reopened.get('0.2.0').buffer.toString(), 'a');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release store with no dir is inert (no releases, never throws)', () => {
  const store = createAgentReleaseStore({ dir: '', logger: silentLogger });
  assert.equal(store.latest(), null);
  assert.deepEqual(store.list(), []);
  assert.equal(store.has('1.0.0'), false);
  assert.throws(() => store.add({ version: '1.0.0', buffer: Buffer.from('x'), sha256: 's', size: 1, signature: 'g', manifest: {} }));
});

// An agent re-hashes a downloaded release and refuses to install when it does
// not match the signed manifest. A release whose stored bytes have drifted from
// its sidecar can therefore never be installed by anyone — it only produces
// "checksum mismatch — refusing to install" on every host, repeatably, with
// nothing on the server saying why. So the store refuses to hand it out.
test('release store refuses to serve bytes that do not match the signed manifest', () => {
  const dir = tmpDir();
  try {
    const store = createAgentReleaseStore({ dir, logger: silentLogger });
    const body = 'the-signed-release';
    store.add({ version: '0.4.0', buffer: Buffer.from(body), sha256: sha(body), size: body.length, signature: 'sig', manifest: { version: '0.4.0', sha256: sha(body) } });
    assert.equal(store.get('0.4.0').buffer.toString(), body);
    assert.deepEqual(store.verify(), []);

    // Something rewrote the tarball without touching its sidecar.
    fs.writeFileSync(path.join(dir, 'blueeye-agent-0.4.0.tgz'), 'not-what-was-signed');
    assert.equal(store.get('0.4.0'), null, 'must not serve it');
    assert.equal(store.latest().version, '0.4.0', 'still indexed, so the route can explain');
    const bad = store.verify();
    assert.equal(bad.length, 1);
    assert.equal(bad[0].version, '0.4.0');
    assert.match(bad[0].reason, /sha256/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release store reports a release whose tarball has gone', () => {
  const dir = tmpDir();
  try {
    const store = createAgentReleaseStore({ dir, logger: silentLogger });
    const body = 'bytes';
    store.add({ version: '0.5.0', buffer: Buffer.from(body), sha256: sha(body), size: body.length, signature: 'sig', manifest: { version: '0.5.0' } });
    fs.rmSync(path.join(dir, 'blueeye-agent-0.5.0.tgz'));
    assert.equal(store.get('0.5.0'), null);
    assert.deepEqual(store.verify(), [{ version: '0.5.0', reason: 'tarball missing' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The write that caused the drift in the first place: tarball and sidecar are
// two files, and a crash between them leaves a release that can never verify.
test('release store writes the tarball and its sidecar through renames', () => {
  const dir = tmpDir();
  try {
    const renamed = [];
    const store = createAgentReleaseStore({
      dir,
      logger: silentLogger,
      fsImpl: {
        ...fs,
        renameSync: (a, b) => { renamed.push(path.basename(b)); return fs.renameSync(a, b); },
      },
    });
    const body = 'atomic';
    store.add({ version: '0.6.0', buffer: Buffer.from(body), sha256: sha(body), size: body.length, signature: 'sig', manifest: { version: '0.6.0' } });
    assert.deepEqual(renamed, ['blueeye-agent-0.6.0.tgz', 'blueeye-agent-0.6.0.release.json']);
    assert.equal(store.get('0.6.0').buffer.toString(), body);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
