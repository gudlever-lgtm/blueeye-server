'use strict';

const { WebSocketServer } = require('ws');

const silentLogger = { info() {}, warn() {}, error() {} };

// The browser presents the user JWT either in the Authorization header or as a
// ?token= query parameter on the WebSocket URL (browsers can't set headers on a
// WebSocket, so the dashboard uses the query parameter).
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
  const wss = new WebSocketServer({ noServer: true });

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
