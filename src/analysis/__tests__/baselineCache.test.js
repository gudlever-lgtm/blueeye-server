'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBaselineFileCache } = require('../baselineCache');
const { waitFor } = require('../../../test-support/waitFor');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-')), 'baselines.json');
}

test('read returns the plain windows object (not gated on a license envelope)', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ 'h1|cpu|3': [1, 2, 3] }));
  const cache = createBaselineFileCache(file);
  const data = cache.read();
  assert.deepEqual(data, { 'h1|cpu|3': [1, 2, 3] });
});

test('read returns null when the file is missing or malformed', () => {
  const cache = createBaselineFileCache(path.join(os.tmpdir(), 'does-not-exist-xyz.json'));
  assert.equal(cache.read(), null);

  const file = tmpFile();
  fs.writeFileSync(file, 'not json');
  assert.equal(createBaselineFileCache(file).read(), null);
});

test('flushSync persists synchronously and round-trips via read', () => {
  const file = tmpFile();
  const cache = createBaselineFileCache(file);
  cache.flushSync({ 'h1|mem|0': [9, 9, 9] });
  assert.deepEqual(createBaselineFileCache(file).read(), { 'h1|mem|0': [9, 9, 9] });
});

test('async write eventually lands on disk', async () => {
  const file = tmpFile();
  const cache = createBaselineFileCache(file);
  cache.write({ 'h1|cpu|1': [5] });
  // write() is fire-and-forget (mkdir + writeFile), so "eventually" is the whole
  // claim — poll for it rather than guessing how long the machine needs.
  const reader = createBaselineFileCache(file);
  await waitFor(() => reader.read() !== null, 'the async write to reach disk');
  assert.deepEqual(reader.read(), { 'h1|cpu|1': [5] });
});
