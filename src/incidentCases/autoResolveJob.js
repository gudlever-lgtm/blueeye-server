'use strict';

// Leader-only background job (point 4): resolves incidents stuck in
// `investigating` once no new anomaly has linked to them within the inactivity
// window ("investigating → resolved automatically when no new anomalies link
// within X minutes"). Exposes { runOnce, start, stop } so it slots into the HA
// coordinator's jobs array exactly like the retention / transaction-baseline
// jobs. Best-effort: a failure on one incident never stops the rest, and the
// whole run swallows repo errors so it can never crash the scheduler.

const silentLogger = { info() {}, warn() {}, error() {} };

function createIncidentAutoResolveJob({
  incidentCasesRepo,
  // Optional: record the automatic transition in the hash-chained audit_log,
  // same as manual transitions (actor = system).
  auditLogRepo = null,
  inactivityMs = 15 * 60 * 1000, // "X minutter" of no new anomalies → auto-resolve
  intervalMs = 60 * 1000, // how often to sweep for stale incidents
  now = () => Date.now(),
  logger = silentLogger,
} = {}) {
  let timer = null;

  async function runOnce() {
    const olderThan = new Date(now() - inactivityMs);
    let stale;
    try {
      stale = await incidentCasesRepo.listStaleInvestigating(olderThan);
    } catch (err) {
      logger.warn(`incident-auto-resolve: could not list stale incidents (${err.message})`);
      return 0;
    }
    let resolved = 0;
    for (const inc of stale) {
      try {
        const ok = await incidentCasesRepo.updateStatus(inc.id, {
          from: 'investigating', to: 'resolved', at: new Date(now()),
        });
        if (!ok) continue; // lost a race (already transitioned) — skip
        resolved += 1;
        if (auditLogRepo && typeof auditLogRepo.record === 'function') {
          try {
            await auditLogRepo.record({
              category: 'incident',
              action: 'incident_auto_resolve',
              actorRole: 'system',
              target: String(inc.id),
              detail: `investigating→resolved (no new anomalies for ${Math.round(inactivityMs / 60000)}m)`,
            });
          } catch { /* audit is best-effort */ }
        }
      } catch (err) {
        logger.warn(`incident-auto-resolve: failed to resolve incident ${inc.id} (${err.message})`);
      }
    }
    if (resolved) logger.info(`incident-auto-resolve: auto-resolved ${resolved} incident(s).`);
    return resolved;
  }

  function start() {
    if (timer) return;
    runOnce().catch((err) => logger.error(`incident-auto-resolve: initial run failed: ${err.message}`));
    timer = setInterval(() => {
      runOnce().catch((err) => logger.error(`incident-auto-resolve: run failed: ${err.message}`));
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { runOnce, start, stop };
}

module.exports = { createIncidentAutoResolveJob };
