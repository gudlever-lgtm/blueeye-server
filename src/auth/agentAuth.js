'use strict';

const { hashToken } = require('./tokens');

// Verifies an opaque agent token: hash it, look it up in agent_tokens, and
// reject anything that is missing, revoked, or not linked to an agent. Stateless
// and side-effect free — shared by both the REST middleware and the WebSocket
// handshake. This is deliberately separate from the user JWT auth.
function createAgentAuthenticator({ agentTokensRepo }) {
  async function verifyToken(rawToken) {
    if (typeof rawToken !== 'string' || rawToken.length === 0) return null;
    const record = await agentTokensRepo.findActiveByHash(hashToken(rawToken));
    if (!record || record.agent_id == null) return null;
    return { agentId: record.agent_id, tokenId: record.id };
  }
  return { verifyToken };
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

// Express middleware enforcing agent-token auth on a REST route. On success it
// attaches req.agent = { agentId, tokenId } and best-effort updates
// last_used_at (token) and last_seen (agent).
function createAgentTokenMiddleware({ authenticator, agentTokensRepo, agentsRepo }) {
  // Throttle liveness writes: agents hit REST frequently, and last_used/last_seen
  // don't need sub-minute precision. Keyed by agentId; bounded by fleet size.
  const TOUCH_THROTTLE_MS = 60000;
  const lastTouched = new Map();
  return async (req, res, next) => {
    let agent;
    try {
      const token = bearerToken(req);
      if (!token) {
        return res.status(401).json({ error: 'Agent authentication required' });
      }
      agent = await authenticator.verifyToken(token);
    } catch (err) {
      return next(err); // unexpected lookup failure -> 500
    }

    if (!agent) {
      return res.status(401).json({ error: 'Invalid agent token' });
    }

    req.agent = agent;

    // Liveness bookkeeping is best-effort and throttled: never fail the request
    // on it, and skip the writes when this agent was touched recently.
    const now = Date.now();
    if (now - (lastTouched.get(agent.agentId) || 0) >= TOUCH_THROTTLE_MS) {
      lastTouched.set(agent.agentId, now);
      try {
        await Promise.all([
          agentTokensRepo.touchLastUsed(agent.tokenId),
          agentsRepo.touchLastSeen(agent.agentId),
        ]);
      } catch {
        /* ignore */
      }
    }

    return next();
  };
}

module.exports = { createAgentAuthenticator, createAgentTokenMiddleware, bearerToken };
