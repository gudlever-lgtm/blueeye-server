'use strict';

const { WebSocketServer } = require('ws');
const { createAgentAuthenticator } = require('../auth/agentAuth');
const { extractToken, pathnameOf, safeSend, startHeartbeat } = require('./wsCommon');

const silentLogger = { info() {}, warn() {}, error() {} };

// The hsflowd exporter states an agent may report (mirrors the agent's vocabulary).
const HSFLOWD_STATES = ['active', 'inactive', 'failed', 'not_installed', 'install_failed', 'permission_denied', 'unknown'];

// Attaches the agent WebSocket endpoint to an existing HTTP server. Agent-token
// auth is enforced during the upgrade handshake — a connection without a valid
// token is rejected hard (no WebSocket is ever established).
function attachAgentWebSocket({
  server,
  agentTokensRepo,
  agentsRepo,
  // Optional: completes the audit row for a server-initiated action when the
  // agent reports its result (upgrade/delete/install-tool).
  auditRepo = null,
  // Optional: the unified audit trail — records the OUTCOME of an install-tool
  // so operators see it (and why) under Reporting → Audit.
  auditEventsRepo = null,
  logger = silentLogger,
  path = '/ws/agent',
  heartbeatMs = 30000,
  // Capacity/licence gate. Receives the current connection count and returns
  // whether a new agent connection may be accepted. Defaults to always-allow.
  licenseGuard = () => true,
  // Optional: pushes live agent online/offline events to the dashboard channel.
  notifyDashboard = null,
}) {
  const authenticator = createAgentAuthenticator({ agentTokensRepo });
  const wss = new WebSocketServer({ noServer: true });

  // Correlated server -> agent requests: sendCommandAndWait() stores a waiter
  // keyed by a command id; the agent echoes that id back in an 'ack' frame and
  // we resolve it. Powers the dashboard "Ping" (liveness) and "Update" buttons.
  const pending = new Map(); // id -> { resolve, timer, delivered }
  let seq = 0;

  // Latest hsflowd exporter state each agent has reported. In-memory: agents
  // re-report on every reconnect (their reconcile runs on WS open), so this
  // repopulates after a server restart without needing a DB column.
  const sflowStatus = new Map(); // agentId -> { state, detail, at }

  server.on('upgrade', (req, socket, head) => {
    // Cooperative: only claim our path and ignore the rest, so sibling WS
    // servers on the same HTTP server (e.g. the dashboard socket) can handle
    // theirs. Truly unknown paths are rejected by a fallback in server.js.
    if (pathnameOf(req) !== path) return;

    authenticator
      .verifyToken(extractToken(req))
      .then((agent) => {
        if (!agent) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        // License/capacity gate (token is valid; this is a separate concern).
        if (!licenseGuard(wss.clients.size)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          logger.warn('Rejected agent connection: license invalid or agent limit reached.');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, agent);
        });
      })
      .catch((err) => {
        logger.error('Agent WS auth failed:', err);
        try {
          socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
        } catch {
          /* socket may already be gone */
        }
        socket.destroy();
      });
  });

  wss.on('connection', (ws, req, agent) => {
    ws.agentId = agent.agentId;
    ws.isAlive = true;

    agentsRepo
      .setStatus(agent.agentId, 'online')
      .catch((err) => logger.error('Failed to mark agent online:', err));
    if (typeof notifyDashboard === 'function') {
      try { notifyDashboard({ type: 'agent-status', payload: { agentId: agent.agentId, status: 'online' } }); } catch { /* best-effort */ }
    }

    // Initial server -> agent message (also demonstrates the push channel).
    safeSend(ws, { type: 'connected', agentId: agent.agentId });

    ws.on('pong', () => {
      ws.isAlive = true;
      agentsRepo.touchLastSeen(agent.agentId).catch(() => {});
    });

    ws.on('message', (data) => {
      // Any inbound frame counts as a sign of life.
      agentsRepo.touchLastSeen(agent.agentId).catch(() => {});
      // Resolve a correlated request: the agent echoes the command id in an
      // 'ack' (or 'command-result') frame. Heartbeats and other frames are
      // ignored here. Parsing is defensive — a bad frame must not crash the hub.
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if ((msg.type === 'ack' || msg.type === 'command-result') && msg.id != null) {
        const waiter = pending.get(msg.id);
        if (waiter) {
          pending.delete(msg.id);
          clearTimeout(waiter.timer);
          waiter.resolve({ delivered: waiter.delivered, acked: true, reply: msg });
        }
      }
      // agent -> server: hsflowd exporter status (the enable/disable feedback loop).
      if (msg.type === 'sflow.status') {
        const state = HSFLOWD_STATES.includes(msg.state) ? msg.state : 'unknown';
        const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, 300) : null;
        sflowStatus.set(ws.agentId, { state, detail, at: new Date().toISOString() });
        if (typeof notifyDashboard === 'function') {
          try { notifyDashboard({ type: 'sflow-status', payload: { agentId: ws.agentId, state, detail } }); } catch { /* best-effort */ }
        }
      }
      // agent -> server: result of a server-initiated action (upgrade/delete).
      // Completes the audit row, and on a CONFIRMED self-delete drops the agent
      // record (its tokens cascade) so the fleet list reflects reality.
      if (msg.type === 'action-result' && msg.auditId != null) {
        const ok = !!msg.ok;
        const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, 300)
          : (msg.version ? `version ${msg.version}` : null);
        if (auditRepo && typeof auditRepo.complete === 'function') {
          auditRepo.complete(msg.auditId, { state: ok ? 'completed' : 'failed', resultDetail: detail })
            .catch((err) => logger.error('Failed to complete audit row:', err));
        }
        // Surface an install-tool outcome in the unified audit trail (the
        // request was already audited when the operator/auto-trigger sent it).
        if (msg.action === 'install-tool' && auditEventsRepo && typeof auditEventsRepo.record === 'function') {
          const tool = typeof msg.tool === 'string' ? msg.tool : null;
          auditEventsRepo.record({
            actorType: 'agent', actorId: ws.agentId,
            action: 'agent.install-tool', targetType: 'tool', targetLabel: tool,
            detail: { ok, tool, reason: detail, package: msg.package || null },
          }).catch((err) => logger.error('Failed to record install-tool audit event:', err));
        }
        if (msg.action === 'delete' && ok && agentsRepo && typeof agentsRepo.remove === 'function') {
          agentsRepo.remove(ws.agentId)
            .then(() => {
              if (typeof notifyDashboard === 'function') {
                try { notifyDashboard({ type: 'agent-status', payload: { agentId: ws.agentId, status: 'deleted' } }); } catch { /* best-effort */ }
              }
            })
            .catch((err) => logger.error('Failed to remove self-deleted agent:', err));
        }
      }
    });

    ws.on('close', () => {
      agentsRepo
        .setStatus(agent.agentId, 'offline')
        .catch((err) => logger.error('Failed to mark agent offline:', err));
      if (typeof notifyDashboard === 'function') {
        try { notifyDashboard({ type: 'agent-status', payload: { agentId: agent.agentId, status: 'offline' } }); } catch { /* best-effort */ }
      }
    });

    ws.on('error', (err) => logger.error('Agent WS connection error:', err));
  });

  // Heartbeat: ping every client; drop any that didn't answer the last ping.
  const interval = startHeartbeat(wss, heartbeatMs);

  // server -> agent: send a command to every live connection of an agent.
  // Returns how many sockets received it.
  function sendCommand(agentId, command) {
    let sent = 0;
    for (const ws of wss.clients) {
      if (ws.agentId === agentId && ws.readyState === ws.OPEN) {
        safeSend(ws, { type: 'command', command });
        sent += 1;
      }
    }
    return sent;
  }

  // server -> agent request/response: sends a command carrying a correlation id
  // and resolves when the agent echoes it back (or on timeout / if the agent is
  // not connected). Resolves with { delivered, acked, reply, timedOut? } — never
  // rejects, so callers can branch on the shape.
  function sendCommandAndWait(agentId, command, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve) => {
      const id = `s${Date.now().toString(36)}-${(seq += 1)}`;
      const delivered = sendCommand(agentId, { ...command, id });
      if (delivered === 0) {
        resolve({ delivered: 0, acked: false, reply: null });
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ delivered, acked: false, reply: null, timedOut: true });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pending.set(id, { resolve, timer, delivered });
    });
  }

  function close() {
    clearInterval(interval);
    for (const { timer } of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  // Current number of connected agents (used for license reporting/enforcement).
  function connectionCount() {
    return wss.clients.size;
  }

  // Pushes a message to the connections of one host (e.g. an analysis 'finding'
  // event). Uses the SAME WebSocket server — not a new channel. Returns how many
  // sockets received it. (UI clients that connect for a host receive these; the
  // dashboard also reads findings over REST.)
  function broadcast(hostId, message) {
    let sent = 0;
    const target = String(hostId);
    for (const ws of wss.clients) {
      if (String(ws.agentId) === target && ws.readyState === ws.OPEN) {
        safeSend(ws, message);
        sent += 1;
      }
    }
    return sent;
  }

  // Latest hsflowd exporter status an agent reported, or null. Read by the
  // agents list so the dashboard can show the result of an enable/disable.
  function getSflowStatus(agentId) {
    return sflowStatus.get(agentId) || null;
  }

  return { wss, sendCommand, sendCommandAndWait, broadcast, close, connectionCount, getSflowStatus };
}

module.exports = { attachAgentWebSocket };
