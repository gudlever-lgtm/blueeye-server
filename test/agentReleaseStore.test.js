'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAgentReleaseStore } = require('../src/enroll/agentReleaseStore');
const { silentLogger } = require('../src/logger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-releases-'));
}

test('release store persists, retrieves, and picks the latest by numeric version', () => {
  const dir = tmpDir();
  try {
    const store = createAgentReleaseStore({ dir, logger: silentLogger });
    const add = (version, body) =>
      store.add({ version, buffer: Buffer.from(body), sha256: `sha-${version}`, size: body.length, signature: `sig-${version}`, manifest: { version }, uploadedBy: 1 });

    add('0.2.0', 'a');
    add('0.10.0', 'bb'); // must sort ABOVE 0.9.0/0.3.0 numerically, not as a string
    add('0.3.0', 'ccc');

    assert.equal(store.has('0.2.0'), true);
    assert.equal(store.has('9.9.9'), false);
    assert.equal(store.latest().version, '0.10.0');
    assert.deepEqual(store.list().map((r) => r.version), ['0.2.0', '0.3.0', '0.10.0']);

    const got = store.get('0.3.0');
    assert.equal(got.buffer.toString(), 'ccc');
    assert.equal(got.sha256, 'sha-0.3.0');
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
