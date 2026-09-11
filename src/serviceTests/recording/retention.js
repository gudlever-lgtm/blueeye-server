'use strict';

// Sweeps recordings nobody finished.
//
// A recording that expired is not merely clutter: it is a row holding whatever
// the operator typed into the application before they closed the tab. It has no
// further use — the token that could write to it stopped working at the same
// moment — so it is deleted rather than archived.
function createRecordingRetention({ recordingsRepo, logger = null, intervalMs = 15 * 60 * 1000 }) {
  let timer = null;

  async function runOnce() {
    try {
      const removed = await recordingsRepo.purgeExpired();
      if (removed && logger && typeof logger.info === 'function') {
        logger.info(`Service Assurance: purged ${removed} expired recording(s)`);
      }
      return removed;
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`Service Assurance: recording purge failed (${err.message})`);
      }
      return 0;
    }
  }

  return {
    name: 'service-test-recording-retention',
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => { runOnce(); }, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

module.exports = { createRecordingRetention };
