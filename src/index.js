import { fileURLToPath } from 'node:url';
import express from 'express';
import config from './config.js';
import routes from './api/routes.js';
import { authenticate } from './middleware.js';
import { initDb } from './db/database.js';
import { startWsServer } from './ws/server.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    res.on('finish', () => {
      console.log(`[api] ${req.method} ${req.originalUrl} ${res.statusCode}`);
    });
    next();
  });

  app.use(authenticate);
  app.use(routes);

  app.use((err, req, res, next) => {
    console.error(`[api] error: ${err.message}`);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

export function start() {
  initDb();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[api] REST API listening on ${config.port}`);
  });
  startWsServer(config.wsPort);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  start();
}
