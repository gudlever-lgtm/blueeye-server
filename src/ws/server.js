import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import * as registry from './registry.js';
import config from '../config.js';
import { verifyAgentToken, extractAgentToken } from '../auth.js';
import { forwardToRca } from '../rca.js';
import {
  upsertAgent,
  setAgentStatus,
  insertResult,
  setTestStatus,
} from '../db/queries.js';

const PING_INTERVAL_MS = 30000;
const PING_TIMEOUT_MS = 10000;

// Close code for an authenticated socket that then tries to register as a
// different agent than its token authorises.
const WS_IDENTITY_MISMATCH = 4003;

function handleRegister(ws, msg) {
  const requestedId = msg.agentId ?? msg.id;
  // The token's agentId is authoritative. Reject attempts to register under a
  // different id than the one the token was signed for.
  if (requestedId && ws.agentAuth?.agentId && requestedId !== ws.agentAuth.agentId) {
    console.error(
      `[ws] register identity mismatch: token=${ws.agentAuth.agentId} requested=${requestedId}`
    );
    ws.close(WS_IDENTITY_MISMATCH, 'identity mismatch');
    return;
  }
  const agentId = ws.agentAuth?.agentId ?? requestedId;
  if (!agentId) {
    console.error('[ws] register message missing agentId');
    return;
  }
  ws.agentId = agentId;
  upsertAgent({
    id: agentId,
    hostname: msg.hostname,
    platform: msg.platform,
    arch: msg.arch,
    nodeVersion: msg.nodeVersion,
    lastSeen: Date.now(),
    status: 'online',
  });
  registry.register(agentId, ws);
  console.log(`[ws] agent connected: ${agentId}`);
}

function handleTestResult(msg) {
  const result = {
    id: msg.id ?? randomUUID(),
    testId: msg.testId,
    agentId: msg.agentId,
    type: msg.type,
    target: msg.target,
    status: msg.status,
    result: msg.result,
    error: msg.error ?? null,
    durationMs: msg.durationMs,
    createdAt: Date.now(),
  };
  insertResult(result);
  if (msg.testId) {
    setTestStatus(msg.testId, msg.status ?? 'done');
  }
  console.log(`[ws] test_result received for test ${msg.testId} from ${msg.agentId}`);
  forwardToRca(result).catch((err) =>
    console.error(`[rca] Forward failed: ${err.message}`)
  );
}

export function startWsServer(port, { secret = config.wsAgentSecret } = {}) {
  if (!secret) {
    console.error('[ws] WS_AGENT_SECRET not set — all agent connections will be rejected');
  }

  const wss = new WebSocketServer({
    port,
    // Reject unauthenticated agents during the HTTP upgrade, before a
    // WebSocket is established (the client receives a 401).
    verifyClient: (info, cb) => {
      const token = extractAgentToken(info.req);
      const result = verifyAgentToken(token, secret);
      if (!result.ok) {
        console.error(`[ws] rejected connection: ${result.reason}`);
        cb(false, 401, 'Unauthorized');
        return;
      }
      // Stash the verified identity on the request so the `connection`
      // handler (same req object) can read it.
      info.req.agentAuth = { agentId: result.agentId, exp: result.exp };
      cb(true);
    },
  });
  console.log(`[ws] WebSocket server listening on ${port}`);

  wss.on('connection', (ws, req) => {
    ws.agentAuth = req.agentAuth;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.error('[ws] received non-JSON message');
        return;
      }
      switch (msg.type) {
        case 'register':
          handleRegister(ws, msg);
          break;
        case 'test_result':
          handleTestResult(msg);
          break;
        default:
          console.error(`[ws] unknown message type: ${msg.type}`);
      }
    });

    ws.on('close', () => {
      if (ws.agentId) {
        setAgentStatus(ws.agentId, 'offline');
        registry.unregister(ws.agentId);
        console.log(`[ws] agent disconnected: ${ws.agentId}`);
      }
    });

    ws.on('error', (err) => {
      console.error(`[ws] socket error: ${err.message}`);
    });
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      ws.isAlive = false;
      ws.ping();
    }
    console.log(`[ws] pinged ${wss.clients.size} agent(s)`);
    setTimeout(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) {
          if (ws.agentId) {
            setAgentStatus(ws.agentId, 'offline');
            registry.unregister(ws.agentId);
            console.log(`[ws] agent timed out: ${ws.agentId}`);
          }
          ws.terminate();
        }
      }
    }, PING_TIMEOUT_MS).unref?.();
  }, PING_INTERVAL_MS);

  interval.unref?.();
  wss.on('close', () => clearInterval(interval));

  return wss;
}
