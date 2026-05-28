import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import * as registry from './registry.js';
import { forwardToRca } from '../rca.js';
import licenseManager from '../license/manager.js';
import {
  upsertAgent,
  setAgentStatus,
  insertResult,
  setTestStatus,
} from '../db/queries.js';

const PING_INTERVAL_MS = 30000;
const PING_TIMEOUT_MS = 10000;

function handleRegister(ws, msg) {
  const agentId = msg.agentId ?? msg.id;
  if (!agentId) {
    console.error('[ws] register message missing agentId');
    return;
  }
  // License capacity gate: refuse NEW agents beyond max_agents. This is a
  // licensing limit enforced from the cached validation — NOT authentication.
  // Agent tokens are issued/validated locally (Flow 1) and never touched here.
  // Re-registration of an already-connected agent is always allowed.
  if (!registry.has(agentId)) {
    const decision = licenseManager.canAcceptAgent(registry.count());
    if (!decision.allowed) {
      console.warn(`[ws] rejecting agent ${agentId}: ${decision.reason}`);
      try {
        ws.send(JSON.stringify({ type: 'license_error', reason: decision.reason }));
      } catch {
        // socket may already be closing
      }
      ws.close(4003, 'license limit');
      return;
    }
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

export function startWsServer(port) {
  const wss = new WebSocketServer({ port });
  console.log(`[ws] WebSocket server listening on ${port}`);

  wss.on('connection', (ws) => {
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
