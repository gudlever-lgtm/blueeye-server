#!/usr/bin/env node
'use strict';

// BlueEye Service Assurance — the worker process.
//
//   npm run service-test-worker
//
// This is where Playwright runs, and it is a SEPARATE process from the API on
// purpose: a browser session holds memory and a CPU for seconds to minutes, and
// the dashboard must stay responsive (spec §23, docs/service-assurance.md §7).
//
// It claims queued runs and discoveries from the database with a conditional
// UPDATE, so several workers can run side by side without a lock server.
//
// The server image carries no browser. This process expects Chromium from the
// distro (PLAYWRIGHT_CHROMIUM_PATH, set by docker/Dockerfile.service-test-worker),
// which is why nothing is ever downloaded from a vendor CDN at build time.

require('dotenv').config();

const os = require('os');
const { createDb } = require('../src/db');
const { createSecretBox } = require('../src/lib/secretBox');
const { createLogger } = require('../src/logger');
const { config } = require('../src/config');
const { createServiceTestsModule } = require('../src/serviceTests');
const { createWorker } = require('../src/serviceTests/scheduler/worker');
const { createPlaywrightDriver, launchBrowser } = require('../src/serviceTests/runner/driver');
const { extractSnapshotScript } = require('../src/serviceTests/runner/pageSnapshot');

const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });

// One browser per job. Contexts are cheap and a launch is not, but a crashed
// page must never poison the next run — and a run that leaks a context would
// grow memory until the container is killed. Per-job is the honest trade.
function makeBrowserFactory({ executablePath, headless }) {
  return async function browserFactory({ policy, baseUrl, browser = 'chromium', timeoutMs, secrets = [] }) {
    const instance = await launchBrowser({ browser, executablePath, headless });
    const context = await instance.newContext({
      ignoreHTTPSErrors: false,
      viewport: { width: 1280, height: 720 },
      // A recognisable agent string: an operator seeing this in their access log
      // should be able to tell what it is without asking.
      userAgent: `BlueEyeServiceAssurance/1.0 (+synthetic monitoring)`,
    });
    const page = await context.newPage();

    const driver = createPlaywrightDriver({ page, policy, baseUrl, timeoutMs, secrets, logger });
    await driver.installPolicy();

    // The crawler port: navigate and hand back a plain snapshot. Everything that
    // interprets the snapshot is pure and lives in discovery/extract.js.
    const crawler = {
      async visit(url) {
        const started = Date.now();
        const res = await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
        const snapshot = await page.evaluate(extractSnapshotScript);
        return {
          ...snapshot,
          url: page.url(),
          status: res ? res.status() : null,
          redirectedTo: res && res.url() !== url ? res.url() : null,
          loadMs: Date.now() - started,
          consoleErrors: await driver.consoleErrors(),
          requests: await driver.networkErrors(),
        };
      },
    };

    return {
      driver,
      crawler,
      async close() {
        try { await context.close(); } catch { /* ignore */ }
        try { await instance.close(); } catch { /* ignore */ }
      },
    };
  };
}

async function main() {
  const workerId = process.env.SERVICE_TEST_WORKER_ID || `${os.hostname()}-${process.pid}`;
  // Same pool + same secret key as the API: the worker decrypts the credentials
  // the API stored, so a mismatched SECRET_ENCRYPTION_KEY must fail loudly here
  // rather than silently running every test without a login.
  const db = createDb(config);
  const secretBox = createSecretBox({ key: config.security.secretKey });

  const serviceTests = createServiceTestsModule({
    db,
    secrets: secretBox,
    logger,
    artifactRoot: process.env.SERVICE_TEST_ARTIFACT_ROOT || null,
  });

  const worker = createWorker({
    workerId,
    hostname: os.hostname(),
    version: require('../package.json').version,
    queue: serviceTests.queue,
    repositories: serviceTests.repositories,
    settings: serviceTests.settings,
    artifacts: serviceTests.artifacts,
    // No `resolve` override: production uses the real DNS lookup, which is what
    // closes the rebinding gap for a hostname on the allowlist.
    browserFactory: makeBrowserFactory({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || null,
      headless: process.env.SERVICE_TEST_HEADLESS !== 'false',
    }),
    logger,
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`service-tests worker: ${signal} — finishing the current job before exiting`);
    worker.stop();
    // Give an in-flight run a chance to persist its result rather than being
    // reaped as abandoned.
    const deadline = Date.now() + 30000;
    while (worker.running && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { const timer = setTimeout(r, 250); if (timer.unref) timer.unref(); });
    }
    try { await db.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info(`BlueEye Service Assurance worker ${workerId} — polling for work`);
  worker.start();
}

if (require.main === module) {
  main().catch((err) => {
    logger.error(`service-tests worker failed to start: ${err && err.message}`);
    process.exit(1);
  });
}

module.exports = { makeBrowserFactory };
