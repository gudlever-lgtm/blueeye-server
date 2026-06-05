'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTestPackageRunner, resolveTargetIds, itemToCommand } = require('../src/services/testPackageRunner');

const quiet = { info() {}, warn() {} };

const AGENTS = [
  { id: 1, location_id: 10 },
  { id: 2, location_id: 20 },
  { id: 3, location_id: 10 },
];

test('resolveTargetIds: all returns every agent', () => {
  assert.deepEqual(resolveTargetIds({ targets: { mode: 'all' } }, AGENTS), [1, 2, 3]);
});

test('resolveTargetIds: agents returns the listed, existing ids', () => {
  assert.deepEqual(resolveTargetIds({ targets: { mode: 'agents', agentIds: [2, 99] } }, AGENTS), [2]);
});

test('resolveTargetIds: location returns agents in the chosen locations', () => {
  assert.deepEqual(resolveTargetIds({ targets: { mode: 'location', locationIds: [10] } }, AGENTS), [1, 3]);
});

test('itemToCommand maps probe and run-test items', () => {
  assert.deepEqual(itemToCommand({ type: 'probe', probe: { type: 'ping', host: 'x' } }), { name: 'run-probe', probe: { type: 'ping', host: 'x' } });
  assert.deepEqual(itemToCommand({ type: 'run-test', intervalMs: 500 }), { name: 'run-test', intervalMs: 500 });
  assert.deepEqual(itemToCommand({ type: 'run-test' }), { name: 'run-test' });
});

test('run() pushes every item to every connected target and records the run', async () => {
  const sent = [];
  const agentCommander = { sendCommand: (id, cmd) => { sent.push({ id, cmd }); return 1; } };
  const lastRuns = [];
  const repo = { setLastRun: async (id, summary) => { lastRuns.push({ id, summary }); } };
  const runner = createTestPackageRunner({
    agentsRepo: { findAll: async () => AGENTS },
    agentCommander,
    repo,
    logger: quiet,
  });

  const pkg = {
    id: 7,
    name: 'p',
    targets: { mode: 'location', locationIds: [10] }, // agents 1 and 3
    items: [
      { type: 'probe', probe: { type: 'ping', host: '1.1.1.1' } },
      { type: 'run-test' },
    ],
  };
  const summary = await runner.run(pkg);

  // 2 agents x 2 items = 4 commands.
  assert.equal(sent.length, 4);
  assert.equal(summary.targeted, 2);
  assert.equal(summary.reached, 2);
  assert.equal(summary.delivered, 4);
  assert.equal(summary.items, 2);
  assert.equal(lastRuns.length, 1);
  assert.equal(lastRuns[0].id, 7);
});

test('run() counts offline agents (delivered 0) as not reached', async () => {
  // sendCommand returns 0 for agent 2 (offline), 1 otherwise.
  const agentCommander = { sendCommand: (id) => (id === 2 ? 0 : 1) };
  const runner = createTestPackageRunner({
    agentsRepo: { findAll: async () => AGENTS },
    agentCommander,
    repo: { setLastRun: async () => {} },
    logger: quiet,
  });
  const summary = await runner.run({ id: 1, name: 'p', targets: { mode: 'all' }, items: [{ type: 'run-test' }] });
  assert.equal(summary.targeted, 3);
  assert.equal(summary.reached, 2); // agents 1 and 3
  assert.equal(summary.delivered, 2);
});
