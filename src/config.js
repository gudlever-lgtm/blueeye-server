// Parse API_KEYS="key1:admin,key2:operator,key3:viewer" into a key -> role map.
function parseApiKeys(raw) {
  const map = new Map();
  if (!raw) return map;
  for (const pair of raw.split(',')) {
    const sep = pair.indexOf(':');
    if (sep < 1) continue;
    const key = pair.slice(0, sep).trim();
    const role = pair.slice(sep + 1).trim();
    if (key && role) map.set(key, role);
  }
  return map;
}

const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  wsPort: parseInt(process.env.WS_PORT ?? '4000', 10),
  dbPath: process.env.DB_PATH ?? '/data/blueeye.db',
  rcaUrl: process.env.RCA_URL ?? 'http://blueeye-rca:5000',
  rcaEnabled: (process.env.RCA_ENABLED ?? 'true') !== 'false',
  // Shared HMAC secret used to verify agent WebSocket tokens. Unset => all
  // agent connections are rejected (fail closed).
  wsAgentSecret: process.env.WS_AGENT_SECRET ?? '',
  // API key -> role map for REST RBAC.
  apiKeys: parseApiKeys(process.env.API_KEYS),
};

export default config;
