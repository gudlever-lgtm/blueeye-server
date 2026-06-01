'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const { makeApp, tokenFor } = require('../test-support/fakes');
const { attachDashboardWebSocket } = require('../src/ws/dashboardSocket');
const { verifyToken } = require('../src/auth/jwt');

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `timeout after ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Boots an HTTP server with the dashboard WebSocket attached, runs fn, cleans up.
async function withWsServer(fn) {
  const server = http.createServer(makeApp());
  const handle = attachDashboardWebSocket({ server, verifyToken });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    return await fn({ port, handle });
  } finally {
    handle.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function nextMessage(client) {
  return new Promise((resolve, reject) => {
    client.on('message', (data) => resolve(JSON.parse(data.toString())));
    client.on('error', reject);
    client.on('unexpected-response', () => reject(new Error('rejected')));
  });
}

test('attachDashboardWebSocket requires a verifyToken function', () => {
  assert.throws(() => attachDashboardWebSocket({ server: {} }), /verifyToken/);
});

test('dashboard WS connects with a valid JWT (query param) and gets a hello', async () => {
  await withWsServer(async ({ port }) => {
    const t = tokenFor('viewer');
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard?token=${t}`);
    try {
      const hello = await withTimeout(nextMessage(client), 4000, 'no hello');
      assert.equal(hello.type, 'connected');
    } finally {
      client.close();
    }
  });
});

test('dashboard WS connects with a valid JWT in the Authorization header', async () => {
  await withWsServer(async ({ port }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`, {
      headers: { Authorization: `Bearer ${tokenFor('admin')}` },
    });
    try {
      const hello = await withTimeout(nextMessage(client), 4000, 'no hello');
      assert.equal(hello.type, 'connected');
    } finally {
      client.close();
    }
  });
});

test('broadcast pushes a finding event to a connected dashboard', async () => {
  await withWsServer(async ({ port, handle }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard?token=${tokenFor('viewer')}`);
    try {
      await withTimeout(nextMessage(client), 4000, 'no hello'); // consume the hello

      const finding = { id: 'f1', metric: 'cpu', severity: 'CRIT', explanation: 'cpu spike' };
      const msg = await withTimeout(
        new Promise((resolve) => {
          client.on('message', (data) => {
            const m = JSON.parse(data.toString());
            if (m.type === 'finding') resolve(m);
          });
          const sent = handle.broadcast({ type: 'finding', payload: finding });
          assert.equal(sent, 1);
        }),
        4000,
        'no finding received'
      );
      assert.equal(msg.payload.metric, 'cpu');
      assert.equal(msg.payload.severity, 'CRIT');
    } finally {
      client.close();
    }
  });
});

test('dashboard WS is rejected with an invalid token', async () => {
  await withWsServer(async ({ port }) => {
    const outcome = await withTimeout(
      new Promise((resolve) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard?token=not-a-jwt`);
        client.on('open', () => resolve('open'));
        client.on('unexpected-response', () => resolve('rejected'));
        client.on('error', () => resolve('rejected'));
      }),
      4000,
      'no outcome'
    );
    assert.notEqual(outcome, 'open');
  });
});

test('dashboard WS is rejected without a token', async () => {
  await withWsServer(async ({ port }) => {
    const outcome = await withTimeout(
      new Promise((resolve) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`);
        client.on('open', () => resolve('open'));
        client.on('unexpected-response', () => resolve('rejected'));
        client.on('error', () => resolve('rejected'));
      }),
      4000,
      'no outcome'
    );
    assert.notEqual(outcome, 'open');
  });
});
