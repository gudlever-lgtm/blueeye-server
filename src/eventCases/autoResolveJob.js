'use strict';

// Leader-only background job (point 4): resolves events stuck in
// `investigating` once no new anomaly has linked to them within the inactivity
// window ("investigating → resolved automatically when no new anomalies link
// within X minutes"). Exposes { runOnce, start, stop } so it slots into the HA
// coordinator's jobs array exactly like the retention / transaction-baseline
// jobs. Best-effort: a failure on one event never stops the rest, and the
// whole run swallows repo errors so it can never crash the scheduler.

const { EVENT_ACTIVITY_WINDOW_MS } = require('./activityWindow');

const silentLogger = { info() {}, warn() {}, error() {} };

function createEventAutoResolveJob({
  eventCasesRepo,
  // Optional: record the automatic transition in the hash-chained audit_log,
  // same as manual transitions (actor = system).
  auditLogRepo = null,
  // Optional (migration 129): the situation store. A case that is part of a
  // situation (cross-agent cluster) which is still ACTIVE is NOT resolved on
  // its own quiet: "no new anomaly on THIS device" is not "the condition is
  // over" while the same fault is still firing on the other agents of its
  // situation.
  //
  // ACTIVE, not merely open: the situation is open/acknowledged AND its last
  // activity (detected_at, advanced by every member that joins) is inside the
  // same inactivity window. Holding on status alone held cases forever — a
  // situation with an unacknowledged CRIT member never auto-resolves
  // (crossAgentClusterService), so its cases never did either, and they
  // clogged the oldest-first batch below for every case behind them. Once the
  // situation itself has gone quiet for the window, its cases resolve on their
  // own quiet like any other; the situation stays for the operator.
  clustersRepo = null,
  // Same window eventCaseService groups within, so an event is never resolved
  // while a new anomaly would still have joined it (./activityWindow.js).
  inactivityMs = EVENT_ACTIVITY_WINDOW_MS,
  intervalMs = 60 * 1000, // how often to sweep for stale events
  now = () => Date.now(),
  logger = silentLogger,
} = {}) {
  let timer = null;

  // True when the case's situation is still active (see clustersRepo above).
  // Per sweep, each situation is read once. A failed read is "not known
  // active": the case resolves as it did before situations were linked, rather
  // than being held open by an outage of the lookup.
  async function situationLive(clusterId, cache, activeSince) {
    if (clusterId == null || !clustersRepo || typeof clustersRepo.findById !== 'function') return false;
    if (!cache.has(clusterId)) {
      let live = false;
      try {
        const c = await clustersRepo.findById(clusterId);
        const lastActivity = c && c.detectedAt ? new Date(c.detectedAt).getTime() : NaN;
        live = Boolean(c && (c.status === 'open' || c.status === 'acknowledged')
          && Number.isFinite(lastActivity) && lastActivity >= activeSince.getTime());
      } catch (err) {
        logger.warn(`event-auto-resolve: could not read situation ${clusterId} (${err.message})`);
      }
      cache.set(clusterId, live);
    }
    return cache.get(clusterId);
  }

  async function runOnce() {
    const olderThan = new Date(now() - inactivityMs);
    let stale;
    try {
      // With situations wired, the query itself leaves out the cases an active
      // situation holds, so a large held set cannot fill the (oldest-first,
      // limited) batch and starve the cases behind it. The per-case check
      // below stays for a repository that does not honour the option.
      stale = clustersRepo
        ? await eventCasesRepo.listStaleInvestigating(olderThan, undefined, { holdClustersActiveSince: olderThan })
        : await eventCasesRepo.listStaleInvestigating(olderThan);
    } catch (err) {
      logger.warn(`event-auto-resolve: could not list stale events (${err.message})`);
      return 0;
    }
    let resolved = 0;
    const situations = new Map();
    for (const inc of stale) {
      try {
        if (await situationLive(inc.clusterId, situations, olderThan)) continue; // its situation is still going
        const ok = await eventCasesRepo.updateStatus(inc.id, {
          from: 'investigating', to: 'resolved', at: new Date(now()),
        });
        if (!ok) continue; // lost a race (already transitioned) — skip
        resolved += 1;
        if (auditLogRepo && typeof auditLogRepo.record === 'function') {
          try {
            await auditLogRepo.record({
              category: 'event',
              action: 'event_auto_resolve',
              actorRole: 'system',
              target: String(inc.id),
              detail: `investigating→resolved (no new anomalies for ${Math.round(inactivityMs / 60000)}m)`,
            });
          } catch { /* audit is best-effort */ }
        }
      } catch (err) {
        logger.warn(`event-auto-resolve: failed to resolve event ${inc.id} (${err.message})`);
      }
    }
    if (resolved) logger.info(`event-auto-resolve: auto-resolved ${resolved} event(s).`);
    return resolved;
  }

  function start() {
    if (timer) return;
    runOnce().catch((err) => logger.error(`event-auto-resolve: initial run failed: ${err.message}`));
    timer = setInterval(() => {
      runOnce().catch((err) => logger.error(`event-auto-resolve: run failed: ${err.message}`));
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { runOnce, start, stop };
}

module.exports = { createEventAutoResolveJob };
