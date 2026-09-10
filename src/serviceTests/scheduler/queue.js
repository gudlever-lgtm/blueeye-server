'use strict';

// The queue's policy layer over the runs/discovery repositories.
//
// The repositories own the atomic claim (a conditional UPDATE); this owns the
// decisions around it: what counts as stale, whether a worker is alive, and
// which schedules should be enqueued now. Keeping them apart means the storage
// contract can be tested against SQL and the policy against a clock.

function createQueue({ runsRepo, discoveryRepo, schedulesRepo, settings, logger = null, now = () => new Date() }) {
  async function queueSettings() {
    try { return await settings.get('queue'); } catch { return { claimTimeoutMs: 600000, pollIntervalMs: 5000 }; }
  }

  // Claims the next unit of work. Runs are preferred over discoveries: a
  // scheduled monitoring run is time-sensitive in a way a one-off crawl is not.
  async function claimNext(workerId) {
    const run = await runsRepo.claimNext(workerId);
    if (run) return { kind: 'run', job: run };
    if (discoveryRepo) {
      const discovery = await discoveryRepo.claimNext(workerId);
      if (discovery) return { kind: 'discovery', job: discovery };
    }
    return null;
  }

  // Returns claimed-but-abandoned work to a terminal state. A worker that was
  // killed mid-run leaves a row marked `running` forever otherwise, and the UI
  // would show a test that never finishes.
  async function reapStale() {
    const { claimTimeoutMs } = await queueSettings();
    const runs = await runsRepo.reapStale(claimTimeoutMs);
    const discoveries = discoveryRepo ? await discoveryRepo.reapStale(claimTimeoutMs) : 0;
    if ((runs || discoveries) && logger && logger.warn) {
      logger.warn(`service-tests: reaped ${runs} abandoned run(s) and ${discoveries} discovery(ies)`);
    }
    return { runs, discoveries };
  }

  // Enqueues every schedule that has come due, stamping last_run_at BEFORE the
  // run is created. Stamping first means a slow enqueue cannot double-fire the
  // same schedule; the cost is that a failed enqueue skips one cycle, which is
  // the better of the two failure modes for a monitoring tool.
  async function enqueueDue() {
    if (!schedulesRepo) return [];
    const at = now();
    let due;
    try { due = await schedulesRepo.findDue(at); } catch (err) {
      if (logger && logger.warn) logger.warn(`service-tests scheduler: could not load due schedules (${err.message})`);
      return [];
    }
    const enqueued = [];
    for (const schedule of due) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await schedulesRepo.markRun(schedule.id, at);
        // eslint-disable-next-line no-await-in-loop
        const run = await runsRepo.enqueue({
          test_id: schedule.test_id,
          environment_id: schedule.environment_id,
          trigger_source: 'schedule',
        });
        enqueued.push(run);
      } catch (err) {
        if (logger && logger.warn) logger.warn(`service-tests scheduler: schedule ${schedule.id} failed to enqueue (${err.message})`);
      }
    }
    return enqueued;
  }

  // "Is anything actually processing the queue?" — derived from the newest claim
  // rather than a heartbeat table, so there is no extra state to keep correct.
  // The UI uses it to say "no worker connected" instead of leaving a run to sit
  // at `queued` with no explanation.
  async function workerStatus() {
    const { claimTimeoutMs } = await queueSettings();
    const recent = await runsRepo.list({ limit: 20 });
    const claimed = recent.filter((r) => r.claimed_at).map((r) => new Date(r.claimed_at).getTime());
    const queued = recent.filter((r) => r.status === 'queued').length;
    const newest = claimed.length ? Math.max(...claimed) : null;
    const ageMs = newest ? now().getTime() - newest : null;
    return {
      // Never claimed anything = we cannot say a worker is connected.
      connected: newest !== null && ageMs < claimTimeoutMs,
      last_claim_at: newest ? new Date(newest) : null,
      queued,
    };
  }

  return { claimNext, reapStale, enqueueDue, workerStatus, queueSettings };
}

module.exports = { createQueue };
