'use strict';

// Plumbing shared by the agent and dashboard WebSocket servers. Both attach to
// the same HTTP server and share the same upgrade/handshake/heartbeat mechanics;
// only the auth check and the per-connection wiring differ.

// Pulls the bearer token from the Authorization header, falling back to a
// ?token= query parameter (browsers can't set headers on a WebSocket).
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

// Sends a JSON message, swallowing send failures (the socket may be closing).
function safeSend(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* ignore send failures */
  }
}

// Pings every client on an interval and drops any that didn't answer the
// previous ping. Returns the (unref'd) timer so the caller can clearInterval it.
function startHeartbeat(wss, heartbeatMs) {
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
  return interval;
}

module.exports = { extractToken, pathnameOf, safeSend, startHeartbeat };
