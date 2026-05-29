'use strict';

const { WebSocketServer } = require('ws');
const { createAgentAuthenticator } = require('../auth/agentAuth');

const silentLogger = { info() {}, warn() {}, error() {} };

// The agent presents its token either in the Authorization header or as a
// ?token= query parameter on the WebSocket URL.
function extractToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) return token;
  try {
    return new URL(req.url, 'http://localhost').searchParams.get('token');
  } catch {
    return null;
  }
}

function pathnameOf(req) {
  try {
    return new URL(req.url, 'http://localhost').pathname;
  } catch {
    return req.url;
  }
}

function safeSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* ignore send failures */
  }
}

// Attaches the agent WebSocket endpoint to an existing HTTP server. Agent-token
// auth is enforced during the upgrade handshake — a connection without a valid
// token is rejected hard (no WebSocket is ever established).
function attachAgentWebSocket({
  server,
  agentTokensRepo,
  agentsRepo,
  logger = silentLogger,
  path = '/ws/agent',
  heartbeatMs = 30000,
  // Capacity/licence gate. Receives the current connection count and returns
  // whether a new agent connection may be accepted. Defaults to always-allow.
  licenseGuard = () => true,
}) {
  const authenticator = createAgentAuthenticator({ agentTokensRepo });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (pathnameOf(req) !== path) {
      socket.destroy();
      return;
    }

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

    // Initial server -> agent message (also demonstrates the push channel).
    safeSend(ws, { type: 'connected', agentId: agent.agentId });

    ws.on('pong', () => {
      ws.isAlive = true;
      agentsRepo.touchLastSeen(agent.agentId).catch(() => {});
    });

    ws.on('message', () => {
      // Any inbound frame counts as a sign of life.
      agentsRepo.touchLastSeen(agent.agentId).catch(() => {});
    });

    ws.on('close', () => {
      agentsRepo
        .setStatus(agent.agentId, 'offline')
        .catch((err) => logger.error('Failed to mark agent offline:', err));
    });

    ws.on('error', (err) => logger.error('Agent WS connection error:', err));
  });

  // Heartbeat: ping every client; drop any that didn't answer the last ping.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, heartbeatMs);
  interval.unref();

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

  function close() {
    clearInterval(interval);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  // Current number of connected agents (used for license reporting/enforcement).
  function connectionCount() {
    return wss.clients.size;
  }

  return { wss, sendCommand, close, connectionCount };
}

module.exports = { attachAgentWebSocket };
