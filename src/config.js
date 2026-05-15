const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  wsPort: parseInt(process.env.WS_PORT ?? '4000', 10),
  dbPath: process.env.DB_PATH ?? '/data/blueeye.db',
  rcaUrl: process.env.RCA_URL ?? 'http://blueeye-rca:5000',
  rcaEnabled: (process.env.RCA_ENABLED ?? 'true') !== 'false',
};

export default config;
