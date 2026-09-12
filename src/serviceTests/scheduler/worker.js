'use strict';

const { executeDefinition } = require('../runner/execute');
const { createRedactor } = require('../engine/redact');
const { createHostPolicy } = require('../security/hostPolicy');
const { crawl } = require('../discovery/crawl');
const { canSignInWith, signInStepsFromDetectedLogin, describeAuthentication } = require('../discovery/authenticate');
const { observationsFromRun } = require('../observe/observations');
const { suggestTests } = require('../suggest/rules');
const { suggestJourneys } = require('../suggest/journeys');

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
  const {
    applications, environments, credentials, allowedHosts, tests, runs, discovery,
    suggestions, healing, baselines,
    // V3: the typed facts a run produced. Optional, so a deployment that has not
    // migrated yet keeps running rather than failing every run on a missing table.
    observations = null,
  } = repositories;
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
      // Visual regression (V2 §8): only the steps somebody accepted a baseline
      // for, and only when the artifact store is wired — the comparison needs to
      // read the baseline image off disk.
      let visualBaselines = [];
      if (artifacts && baselines) {
        try {
          visualBaselines = await baselines.forRun(test.id, run.environment_id ?? null);
        } catch {
          // A baseline lookup that fails costs the visual check, never the run.
          visualBaselines = [];
        }
      }

      result = await executeDefinition(test.definition, {
        driver: browser.driver, credential, redact,
        accessibilityEnabled: runnerSettings.accessibility !== false,
        visualBaselines,
        readBaseline: (baseline) => artifacts.readScreenshot(baseline.image_path),
      });

      // The picture of anything that changed, so a person can look at it and
      // decide. Stored under the RUN, so retention sweeps it with everything
      // else from that execution — the baseline it was compared against lives
      // elsewhere and is not touched.
      if (artifacts && Array.isArray(result.visual)) {
        for (const visual of result.visual) {
          if (!visual.image) continue;
          try {
            // eslint-disable-next-line no-await-in-loop
            visual.image_path = await artifacts.saveScreenshot(run.id, visual.image, {
              format: 'png', index: `visual-${visual.step_index}`,
            });
          } catch { /* a stored picture is a convenience, never the finding */ }
          delete visual.image;
        }
      }

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
      api_calls: result.api_calls,
      steps: result.steps,
      ended_at: now(),
    });
    // The typed facts this run observed (V3 Phase 1). Derived from the result
    // that was just stored, not from a second pass over the browser — the run
    // already knows all of it, and until now it was scattered across four
    // columns in three shapes for every reader to re-interpret.
    //
    // A failure here costs the ANALYSIS, never the run. The run has its real
    // result already, and an observation table that cannot be written is a
    // degraded dashboard rather than a monitoring outage.
    if (observations) {
      try {
        const facts = observationsFromRun({
          ...result,
          id: run.id,
          test_id: test.id,
          test_name: test.name,
          ended_at: now(),
          started_at: startedAt,
        });
        await observations.recordMany({
          run_id: run.id,
          test_id: test.id,
          application_id: test.application_id,
          environment_id: run.environment_id ?? null,
        }, facts);
      } catch (err) {
        logger.warn(`service-tests: could not record observations for run ${run.id} (${redact.text(err.message)})`);
      }
    }

    // Self-healing (V2 §5): the element was gone and the engine found something
    // on the page it thinks the operator meant. Recorded as a PROPOSAL — nothing
    // here changes the test, which is the entire feature. An operator accepts it
    // from the run, or never does.
    if (result.healing && healing) {
      try {
        await healing.propose({
          test_id: test.id,
          run_id: run.id,
          step_path: result.healing.step_path,
          step_type: result.healing.step_type,
          original_target: result.healing.original,
          proposed_target: result.healing.target,
          confidence: result.healing.confidence,
          reason: result.healing.reason,
          score: result.healing.score,
        });
      } catch (err) {
        // A proposal that cannot be stored must not fail a run that already has
        // its real result. The failure is reported either way.
        logger.warn(`service-tests: could not record a healing proposal for run ${run.id} (${err.message})`);
      }
    }

    logger.info(`service-tests: run ${run.id} (${test.name}) → ${result.status}`);
  }

  // Signs the crawler in before a discovery, if the job asked for it.
  //
  // Never throws and never fails the discovery: a public-site map is still worth
  // having. It returns what happened so the record can say so plainly, because
  // the one unacceptable outcome is reporting the public site as the
  // authenticated one.
  async function signIn(job, browser) {
    const requested = Boolean(job.login_test_id || job.credential_id);
    if (!requested) return { requested: false, authenticated: false, note: null, loginUrl: null };

    try {
      let steps = null;
      let credentialId = job.credential_id ?? null;
      let loginUrl = null;

      if (job.login_test_id) {
        // The reliable route: an existing test already encodes how to sign into
        // THIS application, quirks included.
        const test = await tests.findById(job.login_test_id);
        const usable = canSignInWith(test, { applicationId: job.application_id });
        if (!usable.ok) return { requested, authenticated: false, note: usable.reason, loginUrl: null };
        steps = test.definition.steps;
        credentialId = test.credential_id;
      } else {
        // No test yet — which is the normal state of a brand new application.
        // The anonymous pass found the login form; this fills it in.
        const detected = await discovery.lastDetectedLogin(job.application_id);
        steps = signInStepsFromDetectedLogin(detected);
        if (!steps) {
          return {
            requested,
            authenticated: false,
            note: 'no login form has been found on this application yet — run a discovery without a login first',
            loginUrl: null,
          };
        }
        loginUrl = detected.url;
      }

      const credential = credentialId ? await credentials.findByIdWithSecret(credentialId) : null;
      if (!credential) return { requested, authenticated: false, note: 'that login could not be read', loginUrl };

      // Same seam a test run uses: the credential is decrypted here and NOWHERE
      // else, and its values seed the redactor before a single step runs. None
      // of it reaches the discovery record.
      const redact = createRedactor([credential.secret].filter(Boolean));
      // The SAME browser the crawl will use. A sign-in in a separate context
      // would leave its cookies there and the crawl still anonymous — the
      // feature would appear to work and map the public site.
      const outcome = await executeDefinition({ version: 1, name: 'sign in', steps }, {
        driver: browser.driver,
        credential,
        redact,
        // A sign-in is not the thing being measured, so none of the V2 checks
        // run against it.
        accessibilityEnabled: false,
      });
      if (outcome.status !== 'pass') {
        return { requested, authenticated: false, note: redact.text(outcome.error_message || 'the sign-in did not complete'), loginUrl };
      }
      return { requested, authenticated: true, note: null, loginUrl };
    } catch (err) {
      return { requested, authenticated: false, note: String(err && err.message).slice(0, 400), loginUrl: null };
    }
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

      // Sign in first, if asked to.
      //
      // Discovery has always crawled what a logged-out visitor sees. Everything
      // behind the login — where the actual user journeys live — was invisible.
      // Two ways in, because on a brand new application there is no login test
      // yet: replay an existing one, or fill in the login form the anonymous
      // pass already found.
      //
      // A failure here does NOT fail the discovery. It falls back to an
      // anonymous crawl and says so — a public-site map is still worth having,
      // and it must never be reported as the authenticated one.
      const auth = await signIn(job, browser);
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
        // So the crawl can notice it has been logged out and stop rather than
        // mapping the public site while reporting it as authenticated.
        signedIn: auth.authenticated,
        loginUrl: auth.loginUrl || null,
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
      // And the journeys those tests add up to (V2 §3). Derived FROM the test
      // suggestions rather than from the crawl again, so there is one place that
      // knows how to turn a discovered element into a step — a journey
      // suggestion only groups what has already been proposed.
      const journeyProposals = suggestJourneys(proposals).map((j) => ({
        kind: 'journey',
        name: j.name,
        description: j.description,
        confidence: j.confidence,
        reason: j.reason,
        proposed_journey: { criticality: j.criticality, expected_duration_ms: null, steps: j.steps },
      }));
      const all = [...proposals, ...journeyProposals];
      if (all.length) await suggestions.createMany(job.id, job.application_id, all);

      await discovery.finish(job.id, {
        status: 'complete',
        ...result.summary,
        // What actually happened about signing in. `authenticated` is whether it
        // got IN, not whether it was asked to — a discovery that requested a
        // sign-in and could not must never be read as a map of the private site.
        login_test_id: job.login_test_id ?? null,
        credential_id: job.credential_id ?? null,
        authenticated: auth.authenticated ? 1 : 0,
        authenticated_page_count: result.summary.authenticated_page_count ?? 0,
        session_lost_at_page: result.sessionLostAtPage ?? null,
        auth_note: describeAuthentication({
          requested: auth.requested,
          authenticated: auth.authenticated,
          note: auth.note,
          pages: result.pages.length,
          authenticatedPages: result.summary.authenticated_page_count ?? 0,
          sessionLostAtPage: result.sessionLostAtPage ?? null,
        }),
      });
      logger.info(`service-tests: discovery ${job.id} → ${result.summary.page_count} pages, `
        + `${proposals.length} test + ${journeyProposals.length} journey suggestions (${result.stopped})`);
    } catch (err) {
      await discovery.finish(job.id, { status: 'failed', error_message: String(err && err.message).slice(0, 1000) });
      logger.error(`service-tests: discovery ${job.id} failed (${err && err.message})`);
    } finally {
      if (browser && typeof browser.close === 'function') {
        try { await browser.close(); } catch { /* ignore */ }
      }
    }
  }

  // Runs ONE claimed job to completion. A job that blows up outside its own
  // handler must not kill the loop or leave the row stuck at `running` — the
  // queue would only free it when the claim times out, minutes later.
  async function runJob(claimed) {
    try {
      if (claimed.kind === 'run') await processRun(claimed.job);
      else await processDiscovery(claimed.job);
    } catch (err) {
      logger.error(`service-tests worker: ${claimed.kind} ${claimed.job.id} threw (${err && err.message})`);
      if (claimed.kind === 'run') {
        await runs.complete(claimed.job.id, { status: 'error', error_message: 'The worker failed while running this test', steps: [] })
          .catch(() => {});
      } else {
        await discovery.finish(claimed.job.id, { status: 'failed', error_message: 'The worker failed during discovery' })
          .catch(() => {});
      }
    }
  }

  // ------------------------------------------------------------------ loop
  // One iteration: enqueue what is due, reap what was abandoned, then take up to
  // `runner.concurrency` jobs and run them side by side.
  //
  // The setting used to be stored, validated, shown in Settings — and read by
  // nothing: the loop claimed exactly one job per tick whatever it said. It is
  // the dial it looks like now. Each job builds its own browser through
  // browserFactory (per-job already, so a crashed page can never poison the
  // next), which is also why the number matters: every extra lane is another
  // Chromium, and the bound belongs in the operator's hands rather than in a
  // constant.
  //
  // Claiming is a conditional UPDATE, so N lanes on one worker race each other
  // exactly as N workers do — the same guarantee, no new locking.
  //
  // The tick AWAITS every job it started. A fire-and-forget lane would make the
  // loop faster to write and impossible to reason about: no back-pressure, no
  // deterministic shutdown, and a spec could not assert that a run finished.
  // Returns true when work was done, so the loop can poll faster while there is
  // a backlog and idle politely when there is not.
  async function tick() {
    // First, before anything can fail: an operator watching the dashboard needs
    // to see that the worker is alive even on a tick where the queue is empty
    // or a schedule lookup throws.
    if (typeof queue.heartbeat === 'function') await queue.heartbeat({ workerId, hostname, version });
    await queue.enqueueDue();
    await queue.reapStale();

    // Read per tick, not per boot: raising the dial in Settings takes effect on
    // the next tick rather than on a restart. A settings read that fails must
    // not stop the worker from working — one lane is the safe floor.
    let limit = 1;
    try {
      const runnerSettings = await settings.get('runner');
      if (runnerSettings && Number.isFinite(runnerSettings.concurrency)) limit = runnerSettings.concurrency;
    } catch (err) {
      logger.warn(`service-tests worker: could not read concurrency (${err && err.message}) — running one job`);
    }
    limit = Math.max(1, limit);

    const claimed = [];
    while (claimed.length < limit && !stopped) {
      // eslint-disable-next-line no-await-in-loop
      const next = await queue.claimNext(workerId);
      if (!next) break;
      claimed.push(next);
    }
    if (!claimed.length) return false;
    if (claimed.length > 1) logger.info(`service-tests worker: running ${claimed.length} jobs in parallel`);
    await Promise.all(claimed.map(runJob));
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
