'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { compareVersions, isValidVersion, isNewer } = require('../src/lib/version');

test('compareVersions orders release cores numerically', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1); // not lexicographic
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  // A pre-release/build suffix is ignored — same as the dashboard's comparison.
  assert.equal(compareVersions('1.2.3-rc.1', '1.2.3'), 0);
});

test('isValidVersion accepts package.json versions and rejects the rest', () => {
  assert.equal(isValidVersion('0.99.0'), true);
  assert.equal(isValidVersion('1.2.3-rc.1'), true);
  assert.equal(isValidVersion('latest'), false);
  assert.equal(isValidVersion('1.2'), false);
  assert.equal(isValidVersion(''), false);
  assert.equal(isValidVersion(null), false);
});

test('isNewer only fires on a strictly newer, well-formed version', () => {
  assert.equal(isNewer('1.0.0', '0.99.0'), true);
  assert.equal(isNewer('0.99.0', '0.99.0'), false);
  assert.equal(isNewer('0.98.0', '0.99.0'), false);
  // Garbage must never produce a phantom "update available".
  assert.equal(isNewer('latest', '0.99.0'), false);
  assert.equal(isNewer('1.0.0', ''), false);
  assert.equal(isNewer(undefined, '1.0.0'), false);
});
