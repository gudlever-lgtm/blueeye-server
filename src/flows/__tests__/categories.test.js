'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CATEGORIES, listCategories, buildIndex, classifyPort, classifyAsn,
} = require('../categories');

test('listCategories returns copies of the defaults', () => {
  const a = listCategories();
  assert.ok(a.length >= 10);
  a[0].label = 'mutated';
  assert.notEqual(listCategories()[0].label, 'mutated'); // defaults untouched
});

test('listCategories accepts an override array', () => {
  const custom = [{ id: 'x', label: 'X', kind: 'port', ports: [9999] }];
  const list = listCategories(custom);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'x');
});

test('classifyPort maps well-known service ports to categories', () => {
  const index = buildIndex(DEFAULT_CATEGORIES);
  assert.equal(classifyPort(53, index), 'dns');
  assert.equal(classifyPort(443, index), 'web');
  assert.equal(classifyPort(80, index), 'web');
  assert.equal(classifyPort(22, index), 'ssh');
});

test('classifyPort returns null for unknown or invalid ports', () => {
  const index = buildIndex(DEFAULT_CATEGORIES);
  assert.equal(classifyPort(49152, index), null);
  assert.equal(classifyPort(0, index), null);
  assert.equal(classifyPort('nope', index), null);
});

test('classifyAsn maps known organisation ASNs', () => {
  const index = buildIndex(DEFAULT_CATEGORIES);
  assert.equal(classifyAsn(32934, index), 'facebook');
  assert.equal(classifyAsn(15169, index), 'google');
  assert.equal(classifyAsn(13335, index), 'cloudflare');
});

test('classifyAsn returns null for unknown or invalid ASNs', () => {
  const index = buildIndex(DEFAULT_CATEGORIES);
  assert.equal(classifyAsn(64500, index), null);
  assert.equal(classifyAsn(0, index), null);
  assert.equal(classifyAsn(null, index), null);
});
