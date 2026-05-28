const agents = new Map();

export function register(agentId, ws) {
  agents.set(agentId, ws);
}

export function unregister(agentId) {
  agents.delete(agentId);
}

export function get(agentId) {
  return agents.get(agentId);
}

export function has(agentId) {
  return agents.has(agentId);
}

export function list() {
  return [...agents.keys()];
}

export function count() {
  return agents.size;
}

export function send(agentId, payload) {
  const ws = agents.get(agentId);
  if (!ws || ws.readyState !== ws.OPEN) {
    return false;
  }
  ws.send(JSON.stringify(payload));
  return true;
}
