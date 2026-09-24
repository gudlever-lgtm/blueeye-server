'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const { makeApp, makeAgentTokensRepo, makeAgentsRepo, makeTransactionsRepo, makeFindingStore, makeEventCasesRepo } = require('../test-support/fakes');
const { attachAgentWebSocket } = require('../src/ws/agentSocket');
const { createDeviceFindingSink } = require('../src/devices/findingSink');
const { createEventCaseService } = require('../src/eventCases/eventCaseService');

// The connected agent's id (encoded in the fake token).
const AGENT_ID = 9;
const validTokens = () => makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: AGENT_ID }) });

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message || `timeout ${ms}ms`)), ms); timer.unref(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// DELIBERATE CHANGE (audit §8): a crossed threshold used to be handed straight
// to the alert dispatcher — no finding, no event case, no integrations. It is
// now a finding raised through the finding sink (the same one the switch rules
// use), which is what alerts. So the socket gets a SINK, and these tests wire
// a real one over fakes: `dispatched` is what the sink sent, `findingStore`
// what it stored, `eventCasesRepo` where it was grouped.
async function withWs({ transactionsRepo, alertDispatcher = null, alertingEnabled = false, assistant = null, transactionRefireMs }, fn) {
  const agentsRepo = makeAgentsRepo({ setStatus: async () => {} });
  const app = makeApp({ agentTokensRepo: validTokens(), agentsRepo, transactionsRepo });
  const server = http.createServer(app);
  const findingStore = makeFindingStore();
  const eventCasesRepo = makeEventCasesRepo();
  const transactionFindingSink = createDeviceFindingSink({
    findingStore,
    eventCaseService: createEventCaseService({ eventCasesRepo, findingStore }),
    dispatcher: alertDispatcher,
    alertingEnabled,
  });
  const handle = attachAgentWebSocket({
    server, agentTokensRepo: validTokens(), agentsRepo, transactionsRepo, transactionFindingSink, assistant,
    ...(transactionRefireMs !== undefined ? { transactionRefireMs } : {}),
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try { return await fn({ port, handle, findingStore, eventCasesRepo }); }
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
  await repo.create({ name: 'DB', type: 'tcp', target: 'db', config: { port: 5432, thresholds: { consecutive_fails: 2 } } }); // id 1
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

test('a crossed consecutive_fails threshold is a stored FINDING in an event case, alerted once', async () => {
  const repo = await seedRepo(); // consecutive_fails: 2
  const dispatched = [];
  const alertDispatcher = { dispatch: async (f) => { dispatched.push(f); } };
  await withWs({ transactionsRepo: repo, alertDispatcher, alertingEnabled: true }, async ({ port, findingStore, eventCasesRepo }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      // Two fails in one flush → streak of 2 → CRIT finding.
      client.send(JSON.stringify({ type: 'transaction_result', results: [
        { test_id: 1, status: 'fail' },
        { test_id: 1, status: 'fail', detail: { phase: 'connect', errno: 'ECONNREFUSED' } },
      ] }));
      const f = await poll(() => dispatched[0]);
      assert.equal(f.metric, 'transaction.fail');
      assert.equal(f.severity, 'CRIT');
      assert.equal(f.kind, 'THRESHOLD'); // the findings ENUM
      assert.equal(f.hostId, String(AGENT_ID));
      assert.match(f.explanation, /phase connect, errno ECONNREFUSED/);
      assert.equal(f.evidence[0].testId, 1);
      assert.equal(f.evidence[0].errno, 'ECONNREFUSED');
      // Stored and grouped — the same object the sink alerted on.
      assert.equal(findingStore.rows.length, 1);
      assert.equal(findingStore.rows[0].id, f.id);
      assert.equal(eventCasesRepo.rows.length, 1);
      assert.equal(eventCasesRepo.rows[0].host_id, String(AGENT_ID));
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(dispatched.length, 1, 'alerted twice');
    } finally { client.close(); }
  });
});

test('alerting disabled: the finding is still stored and grouped, but nothing is dispatched', async () => {
  const repo = await seedRepo();
  const dispatched = [];
  const alertDispatcher = { dispatch: async (f) => { dispatched.push(f); } };
  await withWs({ transactionsRepo: repo, alertDispatcher, alertingEnabled: false }, async ({ port, findingStore }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'fail' }, { test_id: 1, status: 'fail' }] }));
      await poll(() => findingStore.rows.length === 1);
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(dispatched.length, 0);
    } finally { client.close(); }
  });
});

test('a persisting failure is raised again only after the refire cooldown (≤ the event-case window)', async () => {
  const { TRANSACTION_REFIRE_MS } = require('../src/analysis/transactionAlerts');
  const { EVENT_ACTIVITY_WINDOW_MS } = require('../src/eventCases/activityWindow');
  assert.ok(TRANSACTION_REFIRE_MS < EVENT_ACTIVITY_WINDOW_MS, 'a recurring failure would open a new event case each time');
  const repo = await seedRepo();
  await withWs({ transactionsRepo: repo }, async ({ port, findingStore }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'fail' }, { test_id: 1, status: 'fail' }] }));
      await poll(() => findingStore.rows.length === 1);
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'fail' }] }));
      await poll(() => repo.resultRows.length === 3);
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(findingStore.rows.length, 1, 'the same ongoing failure was raised twice inside the cooldown');
    } finally { client.close(); }
  });
  // With no hold, the next failing result is a new finding.
  const repo2 = await seedRepo();
  await withWs({ transactionsRepo: repo2, transactionRefireMs: 0 }, async ({ port, findingStore }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'fail' }, { test_id: 1, status: 'fail' }] }));
      await poll(() => findingStore.rows.length === 1);
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'fail' }] }));
      await poll(() => findingStore.rows.length === 2);
    } finally { client.close(); }
  });
});

// ---- baseline deviation ----

async function seedWithBaseline(thresholds) {
  const repo = makeTransactionsRepo();
  await repo.create({ name: 'DB', type: 'tcp', target: 'db', config: { port: 5432, ...(thresholds ? { thresholds } : {}) } });
  await repo.setAgents(1, [AGENT_ID]);
  await repo.upsertBaseline({ test_id: 1, agent_id: AGENT_ID, step: 0, median_ms: 100, mad_ms: 10, sample_count: 30 });
  return repo;
}

test('classifies baseline deviation on insert (>3 MAD → slower)', async () => {
  const repo = await seedWithBaseline();
  await withWs({ transactionsRepo: repo }, async ({ port }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'ok', latency_ms: 300 }] }));
      await poll(() => repo.resultRows.length === 1);
      assert.equal(repo.resultRows[0].deviation, 'slower');
    } finally { client.close(); }
  });
});

test('no deviation verdict when the baseline has too few samples', async () => {
  const repo = makeTransactionsRepo();
  await repo.create({ name: 'DB', type: 'tcp', target: 'db', config: { port: 5432 } });
  await repo.setAgents(1, [AGENT_ID]);
  await repo.upsertBaseline({ test_id: 1, agent_id: AGENT_ID, step: 0, median_ms: 100, mad_ms: 10, sample_count: 5 });
  await withWs({ transactionsRepo: repo }, async ({ port }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'ok', latency_ms: 300 }] }));
      await poll(() => repo.resultRows.length === 1);
      assert.equal(repo.resultRows[0].deviation, null);
    } finally { client.close(); }
  });
});

test('deviation threshold dispatches a WARN', async () => {
  const repo = await seedWithBaseline({ deviation: 'slower' });
  const dispatched = [];
  await withWs({ transactionsRepo: repo, alertDispatcher: { dispatch: async (f) => dispatched.push(f) }, alertingEnabled: true }, async ({ port }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'ok', latency_ms: 300 }] }));
      const f = await poll(() => dispatched[0]);
      assert.equal(f.metric, 'transaction.deviation');
      assert.equal(f.severity, 'WARN');
    } finally { client.close(); }
  });
});

// ---- cross-check ----

async function seedCrossCheck(otherAgentStatus) {
  const repo = makeTransactionsRepo();
  await repo.create({ name: 'DB', type: 'tcp', target: 'db', config: { port: 5432, thresholds: { consecutive_fails: 1 } } });
  await repo.setAgents(1, [AGENT_ID, 5]);
  repo.resultRows.push({ time: new Date(), test_id: 1, agent_id: 5, status: otherAgentStatus, detail: { phase: 'connect' } });
  return repo;
}

test('cross-check: all assigned agents failing → "the system is down"', async () => {
  const repo = await seedCrossCheck('fail');
  const dispatched = [];
  await withWs({ transactionsRepo: repo, alertDispatcher: { dispatch: async (f) => dispatched.push(f) }, alertingEnabled: true }, async ({ port }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'fail', detail: { phase: 'connect' } }] }));
      const f = await poll(() => dispatched[0]);
      assert.match(f.explanation, /the system is down/);
      assert.equal(f.evidence[0].crosscheck, 'system');
    } finally { client.close(); }
  });
});

test('cross-check: only this agent failing → site scope', async () => {
  const repo = await seedCrossCheck('ok');
  const dispatched = [];
  await withWs({ transactionsRepo: repo, alertDispatcher: { dispatch: async (f) => dispatched.push(f) }, alertingEnabled: true }, async ({ port }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'fail', detail: { phase: 'connect' } }] }));
      const f = await poll(() => dispatched[0]);
      assert.match(f.explanation, /only agent 9 fails/);
      assert.equal(f.evidence[0].crosscheck, 'site');
    } finally { client.close(); }
  });
});

test('Mistral diagnosis is appended when the assistant is enabled (the template always stands)', async () => {
  const repo = await seedCrossCheck('fail');
  const dispatched = [];
  const assistant = { isEnabled: () => true, diagnoseTransaction: async () => 'AI: hele systemet er utilgængeligt.' };
  await withWs({ transactionsRepo: repo, alertDispatcher: { dispatch: async (f) => dispatched.push(f) }, alertingEnabled: true, assistant }, async ({ port }) => {
    const client = connect(port);
    try {
      await withTimeout(waitOpen(client), 4000, 'no open');
      client.send(JSON.stringify({ type: 'transaction_result', results: [{ test_id: 1, status: 'fail', detail: { phase: 'connect' } }] }));
      const f = await poll(() => dispatched[0]);
      // DELIBERATE CHANGE: the assistant text is APPENDED to the deterministic
      // diagnosis (phase + verdict are always there), no longer a replacement.
      assert.match(f.explanation, /TCP connection failed .*\(phase connect\)/);
      assert.match(f.explanation, /the system is down/);
      assert.match(f.explanation, /\nAssistant: AI: hele systemet er utilgængeligt\.$/);
    } finally { client.close(); }
  });
});
