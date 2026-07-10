'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeConfigDiff } = require('../src/config/diff');

test('identical configs report no change', () => {
  const d = computeConfigDiff('hostname r1\ninterface Gi0/1\n', 'hostname r1\ninterface Gi0/1\n');
  assert.equal(d.changed, false);
  assert.deepEqual(d.stats, { added: 0, removed: 0 });
  assert.deepEqual(d.changedLines, []);
  assert.equal(d.patch, '');
});

test('a single changed line yields one removed + one added', () => {
  const oldC = 'hostname r1\nip access-list permit 10.0.0.0/8\n';
  const newC = 'hostname r1\nip access-list deny 10.0.0.0/8\n';
  const d = computeConfigDiff(oldC, newC);
  assert.equal(d.changed, true);
  assert.deepEqual(d.stats, { added: 1, removed: 1 });
  assert.deepEqual(d.changedLines, [
    { op: '-', text: 'ip access-list permit 10.0.0.0/8' },
    { op: '+', text: 'ip access-list deny 10.0.0.0/8' },
  ]);
  assert.match(d.patch, /@@ /);
  assert.match(d.patch, /-ip access-list permit/);
  assert.match(d.patch, /\+ip access-list deny/);
});

test('pure additions count only added lines', () => {
  const d = computeConfigDiff('line1\n', 'line1\nline2\nline3\n');
  assert.deepEqual(d.stats, { added: 2, removed: 0 });
  assert.deepEqual(d.changedLines.map((l) => l.text), ['line2', 'line3']);
  assert.ok(d.changedLines.every((l) => l.op === '+'));
});

test('pure removals count only removed lines', () => {
  const d = computeConfigDiff('a\nb\nc\n', 'a\n');
  assert.deepEqual(d.stats, { added: 0, removed: 2 });
  assert.deepEqual(d.changedLines.map((l) => l.text), ['b', 'c']);
  assert.ok(d.changedLines.every((l) => l.op === '-'));
});

test('the first snapshot (null previous) diffs against empty', () => {
  const d = computeConfigDiff(null, 'hostname r1\n');
  assert.equal(d.changed, true);
  assert.deepEqual(d.stats, { added: 1, removed: 0 });
});

test('configs without a trailing newline do not produce a phantom blank line', () => {
  const d = computeConfigDiff('a\nb', 'a\nc');
  assert.deepEqual(d.stats, { added: 1, removed: 1 });
  assert.deepEqual(d.changedLines, [{ op: '-', text: 'b' }, { op: '+', text: 'c' }]);
});
