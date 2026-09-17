'use strict';

// Sends scheduled reports when they fall due.
//
// Same shape as the test-package scheduler, and deliberately so: one interval
// ticks, each enabled schedule is asked whether its next calendar slot has
// passed (src/schedule/recurrence.js), and the ones that are due are built and
// mailed. Last-run times are kept in memory but seeded from the stored
// last_run_at, so a restart does not re-send everything that was due while the
// process was down.
//
// A send that fails is RECORDED, not thrown: one unreachable SMTP server must
// not stop the next schedule, and a schedule that has been failing for weeks has
// to say so on the screen that created it.

const { nextRunAt } = require('../schedule/recurrence');
const { buildReport, REPORTS } = require('../reports/definitions');

const DAY_MS = 24 * 60 * 60 * 1000;

function createReportScheduler({
  repo, mailer, probeResultsRepo, probeOutagesRepo,
  intervalMs = 60000, logger = console, now = () => Date.now(),
}) {
  let timer = null;
  const lastRun = new Map();

  function isDue(schedule, last, t) {
    if (!schedule.schedule_spec) return false;
    const due = nextRunAt(schedule.schedule_spec, last);
    return due !== null && t >= due;
  }

  // Builds one schedule's report over its RELATIVE window and mails it. Exposed
  // so "Send now" on the screen runs exactly what the schedule runs.
  async function runOne(schedule, at = now()) {
    const def = REPORTS[schedule.report];
    if (!def) return { ok: false, detail: `unknown report: ${schedule.report}` };
    const to = new Date(at);
    const from = new Date(at - (Number(schedule.window_days) || 7) * DAY_MS);
    let built;
    try {
      built = await buildReport({
        report: schedule.report,
        format: schedule.format,
        deps: { probeResultsRepo, probeOutagesRepo },
        params: schedule.params || {},
        from,
        to,
      });
    } catch (err) {
      return { ok: false, detail: `report failed: ${err.message}` };
    }
    const result = await mailer.send({
      to: schedule.recipients || [],
      subject: `${built.title} — ${built.subtitle}`,
      text: [
        `${built.title}`,
        `Period: ${built.subtitle} (last ${schedule.window_days} day(s))`,
        `Rows: ${built.rowCount}`,
        '',
        `Sent by the BlueEyes schedule "${schedule.name}".`,
      ].join('\n'),
      filename: built.filename,
      contentType: built.contentType,
      body: built.body,
    });
    return { ...result, rowCount: built.rowCount };
  }

  async function tick() {
    let schedules;
    try {
      schedules = await repo.findEnabled();
    } catch (err) {
      logger.warn(`report scheduler: could not load schedules (${err.message})`);
      return;
    }
    const t = now();
    for (const schedule of schedules) {
      let last = lastRun.get(schedule.id);
      if (last === undefined) {
        last = schedule.last_run_at ? new Date(schedule.last_run_at).getTime() : t;
        lastRun.set(schedule.id, last);
      }
      if (!isDue(schedule, last, t)) continue;
      lastRun.set(schedule.id, t);
      let outcome;
      try {
        // eslint-disable-next-line no-await-in-loop
        outcome = await runOne(schedule, t);
      } catch (err) {
        outcome = { ok: false, detail: err.message };
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await repo.setLastRun(schedule.id, outcome.ok ? `ok — ${outcome.detail}` : `failed — ${outcome.detail}`);
      } catch (err) {
        logger.warn(`report scheduler: could not record the run of "${schedule.name}" (${err.message})`);
      }
      if (!outcome.ok) logger.warn(`report schedule "${schedule.name}" failed: ${outcome.detail}`);
      else logger.info(`report schedule "${schedule.name}": ${outcome.detail}`);
    }
    const live = new Set(schedules.map((s) => s.id));
    for (const id of [...lastRun.keys()]) if (!live.has(id)) lastRun.delete(id);
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch((err) => logger.warn(`report scheduler tick: ${err.message}`)); }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    tick,
    runOne,
  };
}

module.exports = { createReportScheduler };
