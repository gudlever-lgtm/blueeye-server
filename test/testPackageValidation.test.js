'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateTestPackageInput, MIN_SCHEDULE_MS } = require('../src/validation/testPackageValidation');

const baseItems = [{ type: 'probe', probe: { type: 'ping', host: '1.1.1.1', count: 3 } }];

test('accepts a minimal valid package (all agents, manual, one probe)', () => {
  const { value, errors } = validateTestPackageInput({ name: 'Daily ping', targets: { mode: 'all' }, items: baseItems });
  assert.equal(errors, undefined);
  assert.equal(value.name, 'Daily ping');
  assert.equal(value.enabled, true);
  assert.equal(value.schedule_ms, 0);
  assert.equal(value.targets.mode, 'all');
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].probe.host, '1.1.1.1');
});

test('normalises probe items via validateProbeSpec (tcp needs a port)', () => {
  const { value, errors } = validateTestPackageInput({
    name: 'web', targets: { mode: 'all' },
    items: [{ type: 'probe', probe: { type: 'tcp', host: 'example.com', port: 443 } }],
  });
  assert.equal(errors, undefined);
  assert.equal(value.items[0].probe.port, 443);
});

test('rejects a tcp probe without a port', () => {
  const { errors } = validateTestPackageInput({
    name: 'web', targets: { mode: 'all' },
    items: [{ type: 'probe', probe: { type: 'tcp', host: 'example.com' } }],
  });
  assert.ok(errors && errors.items);
});

test('accepts a curl content-check probe item (URL + expectations round-trip)', () => {
  const { value, errors } = validateTestPackageInput({
    name: 'content', targets: { mode: 'all' },
    items: [{ type: 'probe', probe: { type: 'curl', url: 'example.com', expectStatus: 200, expectBody: '/healthy/i', expectHeader: 'content-type' } }],
  });
  assert.equal(errors, undefined);
  const p = value.items[0].probe;
  assert.equal(p.type, 'curl');
  assert.equal(p.host, 'https://example.com/'); // normalized URL (agent reads spec.host)
  assert.equal(p.expectStatus, 200);
  assert.equal(p.expectBody, '/healthy/i');
  assert.equal(p.expectHeader, 'content-type');
});

test('rejects a curl probe with an out-of-range expectStatus', () => {
  const { errors } = validateTestPackageInput({
    name: 'bad', targets: { mode: 'all' },
    items: [{ type: 'probe', probe: { type: 'curl', url: 'https://x/', expectStatus: 99 } }],
  });
  assert.ok(errors && errors.items);
});

test('accepts a pageload probe item (URL + maxElements round-trip)', () => {
  const { value, errors } = validateTestPackageInput({
    name: 'pageload', targets: { mode: 'all' },
    items: [{ type: 'probe', probe: { type: 'pageload', url: 'example.com', maxElements: 25 } }],
  });
  assert.equal(errors, undefined);
  const p = value.items[0].probe;
  assert.equal(p.type, 'pageload');
  assert.equal(p.host, 'https://example.com/');
  assert.equal(p.maxElements, 25);
});

test('accepts a run-test item', () => {
  const { value, errors } = validateTestPackageInput({ name: 't', targets: { mode: 'all' }, items: [{ type: 'run-test', intervalMs: 1000 }] });
  assert.equal(errors, undefined);
  assert.equal(value.items[0].type, 'run-test');
  assert.equal(value.items[0].intervalMs, 1000);
});

test('requires a name', () => {
  const { errors } = validateTestPackageInput({ targets: { mode: 'all' }, items: baseItems });
  assert.ok(errors && errors.name);
});

test('requires a non-empty items array', () => {
  const { errors } = validateTestPackageInput({ name: 'x', targets: { mode: 'all' }, items: [] });
  assert.ok(errors && errors.items);
});

test('rejects an unknown target mode', () => {
  const { errors } = validateTestPackageInput({ name: 'x', targets: { mode: 'somewhere' }, items: baseItems });
  assert.ok(errors && errors.targets);
});

test('mode agents requires a non-empty agentIds array of positive ints', () => {
  assert.ok(validateTestPackageInput({ name: 'x', targets: { mode: 'agents', agentIds: [] }, items: baseItems }).errors);
  assert.ok(validateTestPackageInput({ name: 'x', targets: { mode: 'agents', agentIds: [0] }, items: baseItems }).errors);
  const ok = validateTestPackageInput({ name: 'x', targets: { mode: 'agents', agentIds: [3, 7] }, items: baseItems });
  assert.equal(ok.errors, undefined);
  assert.deepEqual(ok.value.targets.agentIds, [3, 7]);
});

test('rejects a schedule below the floor but accepts 0 and a valid interval', () => {
  assert.ok(validateTestPackageInput({ name: 'x', schedule_ms: 1000, targets: { mode: 'all' }, items: baseItems }).errors);
  assert.equal(validateTestPackageInput({ name: 'x', schedule_ms: 0, targets: { mode: 'all' }, items: baseItems }).value.schedule_ms, 0);
  assert.equal(validateTestPackageInput({ name: 'x', schedule_ms: MIN_SCHEDULE_MS, targets: { mode: 'all' }, items: baseItems }).value.schedule_ms, MIN_SCHEDULE_MS);
});

test('rejects an item with an unknown type', () => {
  const { errors } = validateTestPackageInput({ name: 'x', targets: { mode: 'all' }, items: [{ type: 'reboot' }] });
  assert.ok(errors && errors.items);
});
