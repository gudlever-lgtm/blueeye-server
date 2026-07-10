'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyConfigDiff, classifyLine } = require('../src/config/risk');
const { computeConfigDiff } = require('../src/config/diff');

test('classifyLine categorises ACL/routing/interface as high', () => {
  assert.equal(classifyLine('ip access-list extended BLOCK').risk, 'high');
  assert.equal(classifyLine('ip route 0.0.0.0 0.0.0.0 10.0.0.1').risk, 'high');
  assert.equal(classifyLine('interface Gi0/1').risk, 'high');
  assert.equal(classifyLine(' shutdown').risk, 'high');
});

test('classifyLine categorises comments/descriptions as low', () => {
  assert.equal(classifyLine('! this is a comment').risk, 'low');
  assert.equal(classifyLine(' description uplink to core').risk, 'low');
  assert.equal(classifyLine('snmp-server location DC1').risk, 'low');
});

test('classifyLine defaults to medium for anything else', () => {
  assert.equal(classifyLine('ntp server 10.0.0.1').risk, 'medium');
  assert.equal(classifyLine('hostname r1').risk, 'medium');
});

test('no change → risk none', () => {
  assert.deepEqual(classifyConfigDiff({ changed: false, changedLines: [] }), { risk: 'none', reasons: [] });
  assert.deepEqual(classifyConfigDiff(null), { risk: 'none', reasons: [] });
});

test('a diff touching an ACL is classified high with the reason', () => {
  const diff = computeConfigDiff('hostname r1\n', 'hostname r1\nip access-list permit any\n');
  const r = classifyConfigDiff(diff);
  assert.equal(r.risk, 'high');
  assert.ok(r.reasons.includes('acl'));
});

test('a purely cosmetic diff is classified low', () => {
  const diff = computeConfigDiff('interface Gi0/1\n description a\n', 'interface Gi0/1\n description b\n');
  // only the description line changed
  const r = classifyConfigDiff(diff);
  assert.equal(r.risk, 'low');
  assert.deepEqual(r.reasons, ['description']);
});

test('the highest risk among mixed changes wins, reasons scoped to that level', () => {
  const oldC = 'hostname r1\n';
  const newC = 'hostname r1\n! a comment\nntp server 1.1.1.1\nip route 0.0.0.0 0.0.0.0 2.2.2.2\n';
  const r = classifyConfigDiff(computeConfigDiff(oldC, newC));
  assert.equal(r.risk, 'high');
  assert.deepEqual(r.reasons, ['routing']); // only the top-level reasons
});
