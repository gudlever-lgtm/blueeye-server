'use strict';

const { executeDefinition } = require('../runner/execute');
const { createRedactor } = require('../engine/redact');
const { createHostPolicy } = require('../security/hostPolicy');
const { crawl } = require('../discovery/crawl');
const { suggestTests } = require('../suggest/rules');

// The worker loop: claim → run → persist → repeat.
//
// This runs in its OWN process (scripts/service-test-worker.js), never inside an
// Express request — a Playwright run holds a browser for seconds to minutes, and
// the API must stay responsive (spec §23).
//
// `browserFactory` is injected, so the whole loop — claiming, policy assembly,
// credential resolution, result persistence, discovery, suggestion generation —
// is tested against fakes with no browser anywhere near it.

const DEFAULT_POLL_MS = 5000;

function createWorker({
  workerId,
  // Reported with the heartbeat so the dashboard can name what is running.
  hostname = null,
  version = null,
  queue,
  repositories,
  settings,
  browserFactory,
  artifacts = null,
  // Injected DNS resolver for the host policy. Production leaves it unset and
  // gets the real lookup; specs pass a fake so the suite never touches the
  // network (repo convention: outbound calls are mocked).
  resolve = null,
  logger = console,
  now = () => new Date(),
  sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }),
}) {
  const { applications, environments, credentials, allowedHosts, tests, runs, discovery, suggestions } = repositories;
  let running = false;
  let stopped = false;

  // Assembles the host policy for one application: its own base URL, every
  // environment base URL, and the allowlist rows. Built per job so an allowlist
  // edit takes effect on the next run rather than on a worker restart.
  async function policyFor(applicationId, extraUrls = []) {
    const [app, envs, entries] = await Promise.all([
      applications.findById(applicationId),
      environments.list({ applicationId }),
      allowedHosts.listForApplication(applicationId),
    ]);
    const baseUrls = [
      ...(app && app.base_url ? [app.base_url] : []),
      ...envs.map((e) => e.base_url).filter(Boolean),
      ...extraUrls,
    ];
    return { app, envs, policy: createHostPolicy({ baseUrls, entries, resolve }) };
  }

  // ------------------------------------------------------------------ a run
  async function processRun(run) {
    const test = await tests.findById(run.test_id);
    if (!test) {
      await runs.complete(run.id, { status: 'error', error_message: 'The test no longer exists', steps: [] });
      return;
    }

    const { app, envs, policy } = await policyFor(test.application_id);
    const environment = run.environment_id
      ? envs.find((e) => e.id === run.environment_id)
      : envs.find((e) => e.type === 'production' && e.enabled) || envs.find((e) => e.enabled);
    const baseUrl = (environment && environment.base_url) || (app && app.base_url);
    if (!baseUrl) {
      await runs.complete(run.id, { status: 'error', error_message: 'No environment or base address is configured', steps: [] });
      return;
    }

    // The credential is decrypted here and NOWHERE else, and its values seed the
    // redactor before a single step runs.
    let credential = null;
    if (test.credential_id) {
      credential = await credentials.findByIdWithSecret(test.credential_id);
    }
    const redact = createRedactor([credential && credential.secret].filter(Boolean));
    const runnerSettings = await settings.get('runner');
    const artifactSettings = await settings.get('artifacts');

    const startedAt = now();
    let browser = null;
    let result;
    try {
      browser = await browserFactory({
        policy,
        baseUrl,
        browser: runnerSettings.browser,
        timeoutMs: runnerSettings.stepTimeoutMs,
        secrets: [credential && credential.secret].filter(Boolean),
      });
      result = await executeDefinition(test.definition, { driver: browser.driver, credential, redact });

      // A screenshot only on failure, and only when the settings allow it —
      // artefacts are the module's growth risk, not the image size.
      if (result.status === 'fail' && artifacts && artifactSettings.screenshotOnFailure) {
        try {
          const shot = await browser.driver.screenshot({
            fullPage: artifactSettings.fullPage,
            type: artifactSettings.format,
            quality: artifactSettings.quality,
          });
          result.screenshot_path = await artifacts.saveScreenshot(run.id, shot, {
            format: artifactSettings.format,
            index: result.failed_step ?? 0,
          });
        } catch (err) {
          logger.warn(`service-tests: screenshot failed for run ${run.id} (${redact.text(err.message)})`);
        }
      }
    } catch (err) {
      // The run never got off the ground — a browser that would not launch, a
      // policy refusal on the very first navigation.
      const masked = redact.error(err);
      result = {
        status: 'error',
        duration_ms: now().getTime() - startedAt.getTime(),
        steps: [],
        error_message: masked.message,
        failure_kind: err && err.missingPlaywright ? 'worker_misconfigured' : 'unknown',
      };
      logger.error(`service-tests: run ${run.id} could not start (${masked.message})`);
    } finally {
      if (browser && typeof browser.close === 'function') {
        try { await browser.close(); } catch { /* a browser that will not close must not fail the run */ }
      }
    }

    await runs.complete(run.id, {
      status: result.status,
      duration_ms: result.duration_ms,
      failed_step: result.failed_step,
      error_message: result.error_message,
      failure_kind: result.failure_kind,
      screenshot_path: result.screenshot_path || null,
      browser: runnerSettings.browser,
      console_errors: result.console_errors,
      network_errors: result.network_errors,
      steps: result.steps,
      ended_at: now(),
    });
    logger.info(`service-tests: run ${run.id} (${test.name}) → ${result.status}`);
  }

  // ------------------------------------------------------------ a discovery
  async function processDiscovery(job) {
    const { app, envs, policy } = await policyFor(job.application_id, [job.scope_url]);
    const environment = job.environment_id ? envs.find((e) => e.id === job.environment_id) : null;
    const startUrl = job.scope_url || (environment && environment.base_url) || (app && app.base_url);
    if (!startUrl) {
      await discovery.finish(job.id, { status: 'failed', error_message: 'No address to discover' });
      return;
    }

    const discoverySettings = await settings.get('discovery');
    const budgets = { ...discoverySettings, ...(job.budgets || {}) };
    let browser = null;
    try {
      browser = await browserFactory({ policy, baseUrl: startUrl, timeoutMs: discoverySettings.navigationTimeoutMs });
      const result = await crawl({
        browser: browser.crawler,
        startUrl,
        policy,
        budgets: {
          maxPages: budgets.maxPages,
          maxDepth: budgets.maxDepth,
          maxRequests: budgets.maxRequests,
          maxDurationMs: budgets.maxDurationMs,
        },
        logger,
      });

      // Pages first, so elements can reference the page row they were found on.
      const pageIds = new Map();
      for (const page of result.pages) {
        // eslint-disable-next-line no-await-in-loop
        pageIds.set(page.url, await discovery.addPage(job.id, page));
      }
      await discovery.addElements(job.id, result.elements.map((e) => ({ ...e, page_id: pageIds.get(e.pageUrl) || null })));

      // Rule-based suggestions, generated once per crawl. A re-run creates a NEW
      // discovery with new suggestions and never touches existing tests (§37).
      const proposals = suggestTests(result);
      if (proposals.length) await suggestions.createMany(job.id, job.application_id, proposals);

      await discovery.finish(job.id, { status: 'complete', ...result.summary });
      logger.info(`service-tests: discovery ${job.id} → ${result.summary.page_count} pages, ${proposals.length} suggestions (${result.stopped})`);
    } catch (err) {
      await discovery.finish(job.id, { status: 'failed', error_message: String(err && err.message).slice(0, 1000) });
      logger.error(`service-tests: discovery ${job.id} failed (${err && err.message})`);
    } finally {
      if (browser && typeof browser.close === 'function') {
        try { await browser.close(); } catch { /* ignore */ }
      }
    }
  }

  // ------------------------------------------------------------------ loop
  // One iteration: enqueue what is due, reap what was abandoned, take one job.
  // Returns true when work was done, so the loop can poll faster while there is
  // a backlog and idle politely when there is not.
  async function tick() {
    // First, before anything can fail: an operator watching the dashboard needs
    // to see that the worker is alive even on a tick where the queue is empty
    // or a schedule lookup throws.
    if (typeof queue.heartbeat === 'function') await queue.heartbeat({ workerId, hostname, version });
    await queue.enqueueDue();
    await queue.reapStale();
    const claimed = await queue.claimNext(workerId);
    if (!claimed) return false;
    try {
      if (claimed.kind === 'run') await processRun(claimed.job);
      else await processDiscovery(claimed.job);
    } catch (err) {
      // A job that blew up outside its own handler must not kill the loop.
      logger.error(`service-tests worker: ${claimed.kind} ${claimed.job.id} threw (${err && err.message})`);
      if (claimed.kind === 'run') {
        await runs.complete(claimed.job.id, { status: 'error', error_message: 'The worker failed while running this test', steps: [] })
          .catch(() => {});
      } else {
        await discovery.finish(claimed.job.id, { status: 'failed', error_message: 'The worker failed during discovery' })
          .catch(() => {});
      }
    }
    return true;
  }

  async function loop() {
    running = true;
    logger.info(`service-tests worker ${workerId} started`);
    while (!stopped) {
      let worked = false;
      try {
        // eslint-disable-next-line no-await-in-loop
        worked = await tick();
      } catch (err) {
        logger.error(`service-tests worker: tick failed (${err && err.message})`);
      }
      if (stopped) break;
      // eslint-disable-next-line no-await-in-loop
      const { pollIntervalMs } = await queue.queueSettings();
      // eslint-disable-next-line no-await-in-loop
      if (!worked) await sleep(pollIntervalMs || DEFAULT_POLL_MS);
    }
    running = false;
    logger.info(`service-tests worker ${workerId} stopped`);
  }

  return {
    tick,
    processRun,
    processDiscovery,
    start() { if (!running) loop().catch((err) => logger.error(`service-tests worker crashed: ${err && err.message}`)); },
    stop() { stopped = true; },
    get running() { return running; },
  };
}

module.exports = { createWorker, DEFAULT_POLL_MS };
