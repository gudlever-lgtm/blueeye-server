// Parse "key1:admin,key2:operator,key3:viewer" into { key1: 'admin', ... }.
// Unknown roles and malformed pairs are ignored.
const VALID_ROLES = new Set(['viewer', 'operator', 'admin']);

function parseApiKeys(raw) {
  const map = {};
  for (const pair of (raw ?? '').split(',')) {
    const [key, role] = pair.split(':').map((s) => s.trim());
    if (key && VALID_ROLES.has(role)) {
      map[key] = role;
    }
  }
  return map;
}

const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  wsPort: parseInt(process.env.WS_PORT ?? '4000', 10),
  dbPath: process.env.DB_PATH ?? '/data/blueeye.db',
  rcaUrl: process.env.RCA_URL ?? 'http://blueeye-rca:5000',
  rcaEnabled: (process.env.RCA_ENABLED ?? 'true') !== 'false',
  apiKeys: parseApiKeys(process.env.API_KEYS),
};

export default config;
