'use strict';

// Dispatch-time suppression gate (Fase 5). Clustering is a ~60s sweep that runs
// AFTER findings are ingested + individually alerted, so most member alerts are
// the accepted RACE case (already sent, noted in the next cluster update). This
// gate handles the other half: once a medium/high cluster is OPEN, further
// findings on its affected hosts have their INDIVIDUAL alert (+ ITSM emit)
// suppressed at dispatch, to be rolled into the cluster.
//
// It leaves NO finding-level alert-log row for a suppressed finding, so when the
// sweep later folds that finding into the cluster it records it as
// "alert_suppressed" (vs "alert_race" for one that did alert). One audit trail,
// no double counting.
//
// TTL-cached (open clusters are few); a sync check for the hot path.

const LIVE = new Set(['open', 'acknowledged']);
const NOTIFY_CONFIDENCE = new Set(['medium', 'high']); // low clusters keep per-finding alerts
const DEFAULT_TTL_MS = 30 * 1000;

function createClusterAlertGate({
  clustersRepo,
  findingStore = null,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  logger = { warn() {} },
} = {}) {
  let hostToCluster = new Map(); // hostId -> clusterId (medium/high open clusters)
  let lastLoaded = 0;
  let loading = null;

  // Rebuilds the affected-host → cluster map from the open medium/high clusters.
  // hostIds are derived from member findings (findingStore), matching how the
  // correlator keys them.
  async function refresh() {
    if (!clustersRepo || typeof clustersRepo.listOpen !== 'function') return;
    const map = new Map();
    try {
      const open = await clustersRepo.listOpen();
      for (const c of Array.isArray(open) ? open : []) {
        if (!NOTIFY_CONFIDENCE.has(c.confidence)) continue;
        for (const fid of c.memberFindingIds || []) {
          let host = null;
          if (findingStore && typeof findingStore.get === 'function') {
            try { const f = await findingStore.get(fid); host = f && f.hostId; } catch { host = null; } // eslint-disable-line no-await-in-loop
          }
          if (host != null) map.set(String(host), c.id);
        }
      }
      hostToCluster = map;
      lastLoaded = now();
    } catch (err) {
      logger.warn(`cluster-gate: refresh failed (${err.message})`);
    }
  }

  async function ensureFresh() {
    if (lastLoaded !== 0 && now() - lastLoaded < ttlMs) return;
    if (!loading) loading = refresh().finally(() => { loading = null; });
    await loading;
  }

  // Sync: the cluster id whose open incident already covers this finding's host,
  // or null. Callers suppress the finding's individual alert + ITSM emit when set.
  function suppressedCluster(finding) {
    if (!finding || finding.hostId == null) return null;
    return hostToCluster.get(String(finding.hostId)) ?? null;
  }

  return { refresh, ensureFresh, suppressedCluster, get size() { return hostToCluster.size; } };
}

module.exports = { createClusterAlertGate };
