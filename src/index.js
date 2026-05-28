import { fileURLToPath } from 'node:url';
import express from 'express';
import config from './config.js';
import routes from './api/routes.js';
import { initDb } from './db/database.js';
import { startWsServer } from './ws/server.js';
import { initLicense } from './license/manager.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    res.on('finish', () => {
      console.log(`[api] ${req.method} ${req.originalUrl} ${res.statusCode}`);
    });
    next();
  });

  app.use(routes);

  app.use((err, req, res, next) => {
    console.error(`[api] error: ${err.message}`);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

export function start() {
  initDb();

  // Validate the license at startup, then on a periodic timer. The startup
  // call is fire-and-forget: a cached validation (within grace) keeps the
  // server operational while the network call is in flight or unavailable.
  const license = initLicense();
  license
    .validateNow()
    .then((s) => console.log(`[license] startup status: ${s.status}`))
    .catch((err) => console.error(`[license] startup error: ${err.message}`));
  license.startPeriodic();

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
