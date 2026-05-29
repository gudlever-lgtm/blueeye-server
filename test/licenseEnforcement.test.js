'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const { makeApp, makeAgentTokensRepo, makeAgentsRepo } = require('../test-support/fakes');
const { attachAgentWebSocket } = require('../src/ws/agentSocket');

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `timeout after ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Boots a server whose agent token is always valid, gated by `licenseGuard`.
async function withServer(licenseGuard, fn) {
  const agentTokensRepo = makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 9 }) });
  const agentsRepo = makeAgentsRepo();
  const server = http.createServer(makeApp({ agentTokensRepo, agentsRepo }));
  const handle = attachAgentWebSocket({ server, agentTokensRepo, agentsRepo, licenseGuard });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    return await fn({ port });
  } finally {
    handle.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a valid agent token is still rejected (403) when the license guard denies', async () => {
  await withServer(() => false, async ({ port }) => {
    const outcome = await withTimeout(
      new Promise((resolve) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
          headers: { Authorization: 'Bearer good' },
        });
        client.on('open', () => resolve('open'));
        client.on('unexpected-response', () => resolve('rejected'));
        client.on('error', () => resolve('rejected'));
      }),
      4000,
      'no outcome'
    );
    assert.notEqual(outcome, 'open'); // license gate blocked the connection
  });
});

test('a valid agent token connects when the license guard allows', async () => {
  await withServer(() => true, async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`, {
      headers: { Authorization: 'Bearer good' },
    });
    try {
      await withTimeout(
        new Promise((resolve, reject) => {
          client.on('open', resolve);
          client.on('error', reject);
          client.on('unexpected-response', () => reject(new Error('rejected')));
        }),
        4000,
        'did not open'
      );
    } finally {
      client.close();
    }
  });
});
