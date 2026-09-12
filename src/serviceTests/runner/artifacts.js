'use strict';

const fs = require('fs').promises;
const path = require('path');

// Screenshot storage and retention.
//
// Artefacts are the module's unbounded-growth risk, not the container image: a
// 1280x720 PNG is 100-300 KB, and one five-minute test failing across a weekend
// produces ~576 failures a day. At PNG sizes that is ~115 MB/day for ONE test
// (docs/service-assurance.md §7). So: capture only on failure, lossy by default,
// viewport rather than full page, a per-run cap, and a retention sweep.
//
// Every knob is a DB-backed setting, never an env var.

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };

// Playwright's screenshot() emits png or jpeg. `webp` is accepted as a setting
// because it is the best size/quality trade-off and a future encoder may produce
// it; today it degrades to jpeg rather than failing a run over a file format.
function effectiveType(format) {
  return format === 'png' ? 'png' : 'jpeg';
}

function createArtifactStore({ root, fsImpl = fs, logger = null } = {}) {
  if (!root) throw new Error('serviceTests artifacts: a storage root is required');

  // Paths are built from integers we generated, never from user input, but the
  // guard stays: a path traversal here would write anywhere the worker can.
  function runDir(runId) {
    const id = String(runId);
    if (!SAFE_SEGMENT.test(id)) throw new Error('unsafe run id');
    // Shard by thousands so one directory never holds a million entries.
    const shard = String(Math.floor(Number(id) / 1000) * 1000);
    return path.join(root, shard, id);
  }

  // Writes one screenshot. Returns the stored path (relative to root, so the
  // root can move) or null when there was nothing to store.
  async function saveScreenshot(runId, buffer, { format = 'jpeg', index = 0 } = {}) {
    if (!buffer || !buffer.length) return null;
    const type = effectiveType(format);
    const dir = runDir(runId);
    await fsImpl.mkdir(dir, { recursive: true });
    const name = `step-${index}.${EXT[type]}`;
    const full = path.join(dir, name);
    await fsImpl.writeFile(full, buffer);
    return path.relative(root, full);
  }

  async function readScreenshot(relativePath) {
    const full = path.resolve(root, relativePath);
    // Refuse anything that escapes the root, whatever the stored value says.
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('screenshot path outside the artifact root');
    return fsImpl.readFile(full);
  }

  // Baselines (V2 §8) live OUTSIDE the run shards, under baselines/<test>/.
  //
  // Deliberately not in a run directory: retention deletes old runs, and a
  // baseline that vanished when the run it came from aged out would stop
  // watching the page without anybody being told. A baseline is a decision
  // somebody made, not an artefact of one execution.
  //
  // Stored as PNG whatever the run screenshot format is — a JPEG baseline would
  // make every comparison fight its own compression artefacts.
  function baselineDir(testId) {
    const id = String(testId);
    if (!SAFE_SEGMENT.test(id)) throw new Error('unsafe test id');
    return path.join(root, 'baselines', id);
  }

  async function saveBaseline(testId, buffer, { stepIndex = 0, environmentId = null } = {}) {
    if (!buffer || !buffer.length) return null;
    const dir = baselineDir(testId);
    await fsImpl.mkdir(dir, { recursive: true });
    const env = environmentId === null || environmentId === undefined ? 'any' : String(environmentId);
    if (!SAFE_SEGMENT.test(env)) throw new Error('unsafe environment id');
    const name = `step-${Number(stepIndex) || 0}-env-${env}.png`;
    const full = path.join(dir, name);
    await fsImpl.writeFile(full, buffer);
    return path.relative(root, full);
  }

  async function removeBaselines(testId) {
    try {
      await fsImpl.rm(baselineDir(testId), { recursive: true, force: true });
      return true;
    } catch (err) {
      if (logger && logger.warn) logger.warn(`service-tests: could not remove baselines for test ${testId} (${err.message})`);
      return false;
    }
  }

  async function removeRun(runId) {
    try {
      await fsImpl.rm(runDir(runId), { recursive: true, force: true });
      return true;
    } catch (err) {
      if (logger && logger.warn) logger.warn(`service-tests: could not remove artefacts for run ${runId} (${err.message})`);
      return false;
    }
  }

  return { saveScreenshot, readScreenshot, saveBaseline, removeBaselines, baselineDir, removeRun, runDir, root };
}

// The retention job: deletes screenshots older than the configured window and
// clears the column that referenced them. Files first, then the rows — a stale
// row pointing at a deleted file renders as "no screenshot", while a deleted row
// pointing at a live file leaks disk forever.
function createArtifactRetention({ runsRepo, store, settings, logger = null }) {
  async function run() {
    let days = 30;
    try {
      const artifacts = await settings.get('artifacts');
      if (artifacts && artifacts.retentionDays) days = artifacts.retentionDays;
    } catch { /* fall back to the default rather than skipping the sweep */ }

    let rows;
    try { rows = await runsRepo.screenshotsOlderThan(days); } catch (err) {
      if (logger && logger.warn) logger.warn(`service-tests retention: could not list artefacts (${err.message})`);
      return { removed: 0, cleared: 0 };
    }
    if (!rows.length) return { removed: 0, cleared: 0 };

    let removed = 0;
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      if (await store.removeRun(row.id)) removed += 1;
    }
    const cleared = await runsRepo.clearScreenshots(rows.map((r) => r.id));
    if (logger && logger.info) logger.info(`service-tests retention: removed ${removed} run artefact directories older than ${days}d`);
    return { removed, cleared };
  }

  let timer = null;
  return {
    run,
    start() {
      if (timer) return;
      run().catch(() => {});
      timer = setInterval(() => { run().catch(() => {}); }, 6 * 60 * 60 * 1000);
      if (timer.unref) timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}

module.exports = { createArtifactStore, createArtifactRetention, effectiveType, EXT };
