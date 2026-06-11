'use strict';

const { WebSocketServer } = require('ws');
const { extractToken, pathnameOf, safeSend, startHeartbeat } = require('./wsCommon');

const silentLogger = { info() {}, warn() {}, error() {} };

// Browser-facing live channel for analysis findings. Authenticated with the same
// user JWT the dashboard uses for the REST API (verified during the upgrade
// handshake — an invalid token never establishes a socket). Unlike the agent
// socket this is push-only from the server's point of view: it streams 'finding'
// events to connected dashboards, which also read history over REST.
function attachDashboardWebSocket({
  server,
  verifyToken,
  logger = silentLogger,
  path = '/ws/dashboard',
  heartbeatMs = 30000,
}) {
  if (typeof verifyToken !== 'function') {
    throw new Error('attachDashboardWebSocket requires a verifyToken(token) function');
  }
  // Cap inbound frames at 1 MB (aligns with the Express body limit); ws defaults to 100 MB.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    // Cooperative: only claim our path, ignore others (see agentSocket).
    if (pathnameOf(req) !== path) return;

    let user = null;
    try {
      user = verifyToken(extractToken(req));
    } catch {
      user = null;
    }

    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, user);
    });
  });

  wss.on('connection', (ws, req, user) => {
    ws.isAlive = true;
    ws.user = { id: Number(user.sub) || user.id, role: user.role };
    safeSend(ws, { type: 'connected' });

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (err) => logger.error('Dashboard WS connection error:', err));
  });

  // Heartbeat: drop clients that stopped answering pings.
  const interval = startHeartbeat(wss, heartbeatMs);

  // Pushes a message to every connected dashboard. Returns how many received it.
  function broadcast(message) {
    let sent = 0;
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) {
        safeSend(ws, message);
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

  function connectionCount() {
    return wss.clients.size;
  }

  return { wss, broadcast, close, connectionCount };
}

module.exports = { attachDashboardWebSocket };
