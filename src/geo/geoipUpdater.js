'use strict';

const { buildFromSources, buildCityFromSource, dbipUrls, monthCandidates, DEFAULT_DBIP_BASE } = require('./geoipBuild');

// Fetches the latest EU-sourced DB-IP Lite release, builds the provider CSV into a
// server-managed path (the /data volume by default — so it works in Docker with no
// host mount), and live-reloads the geo provider via the settings service. Drives
// the Settings → Map "Update now" button and the optional monthly auto-refresh.
//
// Network egress is admin-initiated (or opt-in monthly); air-gapped installs simply
// never trigger it and keep using a file/script-built CSV. `build`/`now` are
// injectable for tests so no real download or clock is needed.
function createGeoipUpdater({
  settingsService,
  config = {},
  logger = console,
  build = buildFromSources,
  buildCity = buildCityFromSource,
  httpGet,
  now = () => new Date(),
  checkIntervalMs = 24 * 60 * 60 * 1000,
} = {}) {
  const geoCfg = config.geo || {};
  const buildPath = geoCfg.buildPath || '/data/geoip.csv';
  const cityBuildPath = geoCfg.cityBuildPath || '/data/geoip-city.csv';
  const baseUrl = geoCfg.sourceUrl || DEFAULT_DBIP_BASE;

  const idle = { state: 'idle', startedAt: null, finishedAt: null, ranges: 0, month: null, error: null, cityRanges: 0, cityError: null };
  let job = { ...idle };
  let timer = null;

  function status() {
    return { ...job, buildPath, cityBuildPath, running: job.state === 'running' };
  }

  // Whether to build the city table too: the caller's say, else the admin's
  // Settings → Map toggle (on unless turned off).
  async function wantCity(includeCity) {
    if (includeCity !== undefined) return includeCity !== false;
    try {
      const g = settingsService && settingsService.getGeoip ? await settingsService.getGeoip() : null;
      return !(g && g.city && g.city.include === false);
    } catch { return true; }
  }

  // Build from the newest published month, falling back to the previous one when
  // this month's file isn't out yet (a 404 fails fast, before any download).
  //
  // The city table is built from the SAME month, after the country table. It
  // is the largest file by far and only a fallback for the traceroute map, so
  // a failure there is reported (`cityError`) but never fails the update.
  async function runUpdate({ includeAsn = true, includeCity } = {}) {
    if (job.state === 'running') return status();
    job = { ...idle, state: 'running', startedAt: new Date().toISOString() };
    try {
      let built = null;
      let lastErr = null;
      for (const month of monthCandidates(now())) {
        const urls = dbipUrls(baseUrl, month);
        try {
          const r = await build({
            country: { url: urls.country },
            asn: includeAsn ? { url: urls.asn } : null,
            out: buildPath,
            httpGet,
            source: `DB-IP Lite ${month}`,
          });
          built = { month, rows: r.rows };
          break;
        } catch (e) {
          lastErr = e;
          logger.warn(`geoip: build for ${month} failed (${e.message})`);
        }
      }
      if (!built) throw lastErr || new Error('no DB-IP Lite release found');
      let city = null;
      let cityError = null;
      if (await wantCity(includeCity)) {
        try {
          const r = await buildCity({
            city: { url: dbipUrls(baseUrl, built.month).city },
            out: cityBuildPath,
            httpGet,
            source: `DB-IP City Lite ${built.month}`,
          });
          city = { dbPath: cityBuildPath, ranges: r.rows };
        } catch (e) {
          cityError = e.message;
          logger.warn(`geoip: city table for ${built.month} failed (${e.message}) — hops fall back to country level`);
        }
      }
      // Persist the path + build metadata and live-reload the provider.
      if (settingsService && settingsService.recordGeoipBuild) {
        await settingsService.recordGeoipBuild({ dbPath: buildPath, month: built.month, ranges: built.rows, city });
      }
      job = {
        ...idle, state: 'ok', startedAt: job.startedAt, finishedAt: new Date().toISOString(),
        ranges: built.rows, month: built.month, cityRanges: city ? city.ranges : 0, cityError,
      };
      logger.info(`geoip: updated to ${built.month} — ${built.rows} ranges at ${buildPath}${city ? `, ${city.ranges} city ranges at ${cityBuildPath}` : ''}`);
    } catch (e) {
      job = { ...idle, state: 'error', startedAt: job.startedAt, finishedAt: new Date().toISOString(), error: e.message };
      logger.warn(`geoip: update failed (${e.message})`);
    }
    return status();
  }

  // Fire-and-forget entry point for the HTTP handler: starts a run unless one is
  // already in flight, and returns the (running) status immediately.
  function trigger(opts) {
    if (job.state !== 'running') runUpdate(opts).catch(() => {});
    return status();
  }

  // Daily check: when auto-update is on and the data is missing or from an older
  // month, refresh. Best-effort — failures are logged, never thrown.
  async function maybeAutoUpdate() {
    try {
      const g = settingsService && settingsService.getGeoip ? await settingsService.getGeoip() : null;
      if (!g || !g.autoUpdate) return false;
      const curMonth = monthCandidates(now())[0];
      const lastMonth = g.lastBuild && g.lastBuild.month;
      if (g.configured && lastMonth === curMonth) return false; // already current
      logger.info('geoip: auto-update due → refreshing');
      await runUpdate({ includeAsn: true }); // city follows the Settings toggle
      return true;
    } catch (e) {
      logger.warn(`geoip: auto-update check failed (${e.message})`);
      return false;
    }
  }

  function startSchedule() {
    if (timer) return;
    timer = setInterval(() => { maybeAutoUpdate(); }, checkIntervalMs);
    if (timer.unref) timer.unref();
    // Deferred first check so boot isn't blocked, and a fresh install with
    // auto-update on gets a database without waiting a day.
    const first = setTimeout(() => maybeAutoUpdate(), 60 * 1000);
    if (first.unref) first.unref();
  }
  function stopSchedule() { if (timer) { clearInterval(timer); timer = null; } }

  return { runUpdate, trigger, status, maybeAutoUpdate, startSchedule, stopSchedule };
}

module.exports = { createGeoipUpdater };
