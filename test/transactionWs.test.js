'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const { makeApp, makeAgentTokensRepo, makeAgentsRepo, makeTransactionsRepo } = require('../test-support/fakes');
const { attachAgentWebSocket } = require('../src/ws/agentSocket');

// The connected agent's id (encoded in the fake token).
const AGENT_ID = 9;
const validTokens = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: AGENT_ID }) });

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message || `timeout ${ms}ms`)), ms); timer.unref(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withWs({ transactionsRepo, alertDispatcher = null, alertingEnabled = false }, fn) {
  const agentsRepo = makeAgentsRepo({ setStatus: async () => {} });
  const app = makeApp({ agentTokensRepo: validTokens(), agentsRepo, transactionsRepo });
  const server = http.createServer(app);
  const handle = attachAgentWebSocket({
    server, agentTokensRepo: validTokens(), agentsRepo, transactionsRepo, alertDispatcher, alertingEnabled,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try { return await fn({ port, handle }); }
  finally { handle.close(); await new Promise((resolve) => server.close(resolve)); }
}

function connect(port) {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, { headers: { Authorization: 'Bearer good' } });
}
function waitOpen(client) {
  return new Promise((resolve, reject) => { client.on('open', resolve); client.on('error', reject); client.on('unexpected-response', () => reject(new Error('rejected'))); });
}
async function poll(fn, ms = 2000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('poll timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function seedRepo() {
  const repo = makeTransactionsRepo();
  await repo.create({ name: 'DB', type: 'tcp', config: { host: 'db', port: 5432 }, thresholds: { consecutive_fails: 2 } }); // id 1
  await repo.setAgents(1, [AGENT_ID]);
  return repo;
}

test('pushes transaction_config to the agent on connect', async () => {
  const repo = await seedRepo();
  await withWs({ transactionsRepo: repo }, async ({ port }) => {
    const client = connect(port);
    try {
      const cfg = await withTimeout(new Promise((resolve, reject) => {
        client.on('message', (data) => { const m = JSON.parse(data.toString()); if (m.type === 'transaction_config') resolve(m); });
        client.on('error', reject);
      }), 4000, 'no transaction_config');
      assert.ok(Array.isArray(cfg.tests));
      assert.equal(cfg.tests.length, 1);
      assert.equal(cfg.tests[0].id, 1);
      assert.equal(cfg.tests[0].type, 'tcp');
    } finally { client.close(); }
  });
});

test('ingests a valid transaction_result batch (inserts)', async () => {
  const repo = await seedRepo();
  await withWs({ transactionsRepo: repo }, async ({ port }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [
        { test_id: 1, status: 'ok', latency_ms: 120 },
        { test_id: 1, status: 'fail', latency_ms: 90 },
      ] }));
      await poll(() => repo.resultRows.length === 2);
      assert.equal(repo.resultRows[0].agent_id, AGENT_ID);
      assert.equal(repo.resultRows[0].test_id, 1);
    } finally { client.close(); }
  });
});

test('drops results for tests the agent is not assigned (no insert)', async () => {
  const repo = await seedRepo(); // agent assigned to test 1 only
  await withWs({ transactionsRepo: repo }, async ({ port }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [
        { test_id: 1, status: 'ok', latency_ms: 50 },   // assigned → inserted
        { test_id: 2, status: 'ok', latency_ms: 50 },   // NOT assigned → dropped
      ] }));
      await poll(() => repo.resultRows.length >= 1);
      // Give any erroneous second insert a moment; only the assigned one persists.
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(repo.resultRows.length, 1);
      assert.equal(repo.resultRows[0].test_id, 1);
    } finally { client.close(); }
  });
});

test('rejects an invalid ingest payload (bad status) with no insert', async () => {
  const repo = await seedRepo();
  let inserted = false;
  const guardRepo = { ...repo, insertResults: async (b) => { inserted = true; return repo.insertResults(b); } };
  await withWs({ transactionsRepo: guardRepo }, async ({ port }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'weird' }] }));
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(inserted, false, 'validation should reject before any insert');
      assert.equal(repo.resultRows.length, 0);
    } finally { client.close(); }
  });
});

test('dispatches an alert when consecutive_fails threshold is crossed', async () => {
  const repo = await seedRepo(); // consecutive_fails: 2
  const dispatched = [];
  const alertDispatcher = { dispatch: async (f) => { dispatched.push(f); } };
  await withWs({ transactionsRepo: repo, alertDispatcher, alertingEnabled: true }, async ({ port }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      // Two fails in one flush → streak of 2 → CRIT finding.
      client.send(JSON.stringify({ type: 'transaction_result', results: [
        { test_id: 1, status: 'fail' },
        { test_id: 1, status: 'fail' },
      ] }));
      const f = await poll(() => dispatched[0]);
      assert.equal(f.metric, 'transaction.fail');
      assert.equal(f.severity, 'CRIT');
      assert.equal(f.hostId, String(AGENT_ID));
    } finally { client.close(); }
  });
});

test('does not dispatch when alerting is disabled', async () => {
  const repo = await seedRepo();
  const dispatched = [];
  const alertDispatcher = { dispatch: async (f) => { dispatched.push(f); } };
  await withWs({ transactionsRepo: repo, alertDispatcher, alertingEnabled: false }, async ({ port }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'fail' }, { test_id: 1, status: 'fail' }] }));
      await poll(() => repo.resultRows.length === 2);
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(dispatched.length, 0);
    } finally { client.close(); }
  });
});
