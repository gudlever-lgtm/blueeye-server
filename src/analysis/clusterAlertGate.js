'use strict';

// Dispatch-time suppression gate (Fase 5). Clustering is a ~60s sweep that runs
// AFTER findings are ingested + individually alerted, so most member alerts are
// the accepted RACE case (already sent, noted in the next cluster update). This
// gate handles the other half: once a medium/high cluster is OPEN, further
// findings about the same SUBJECT as one of its members (the same probe target,
// switch port, device, transaction test, or the same condition on the same
// agent — crossAgentCorrelator.subjectOf) have their INDIVIDUAL alert (+ ITSM
// emit) suppressed at dispatch, to be rolled into the cluster. Keyed by subject,
// not by host: clusters are subject-based, so an unrelated fault on a host that
// happens to be in a cluster still alerts on its own.
//
// It leaves NO finding-level alert-log row for a suppressed finding, so when the
// sweep later folds that finding into the cluster it records it as
// "alert_suppressed" (vs "alert_race" for one that did alert). One audit trail,
// no double counting.
//
// TTL-cached (open clusters are few); a sync check for the hot path.

const { subjectOf } = require('./crossAgentCorrelator');

const LIVE = new Set(['open', 'acknowledged']);
const NOTIFY_CONFIDENCE = new Set(['medium', 'high']); // low clusters keep per-finding alerts
const DEFAULT_TTL_MS = 30 * 1000;

function createClusterAlertGate({
  clustersRepo,
  findingStore = null,
  // Optional: agent → site, so a private target (10.0.0.1) seen by two agents at
  // the same site is one subject, as the correlator decides. Without it such a
  // target is scoped per agent — the gate then suppresses less, never more.
  agentsRepo = null,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  logger = { warn() {} },
} = {}) {
  let subjectToCluster = new Map(); // subject key -> clusterId (medium/high open clusters)
  let siteOf = () => null;
  let lastLoaded = 0;
  let loading = null;

  async function loadSites() {
    if (!agentsRepo || typeof agentsRepo.findAll !== 'function') return () => null;
    const map = new Map();
    try {
      for (const a of (await agentsRepo.findAll()) || []) {
        map.set(String(a.id), a.location_id != null ? String(a.location_id) : null);
      }
    } catch (err) {
      logger.warn(`cluster-gate: could not load agent sites (${err.message})`);
    }
    return (hostId) => (map.has(String(hostId)) ? map.get(String(hostId)) : null);
  }

  // Rebuilds the member-subject → cluster map from the open medium/high
  // clusters. Subjects are derived from the member findings (findingStore)
  // exactly as the correlator derives them.
  async function refresh() {
    if (!clustersRepo || typeof clustersRepo.listOpen !== 'function') return;
    const map = new Map();
    try {
      const sites = await loadSites();
      const open = await clustersRepo.listOpen();
      for (const c of Array.isArray(open) ? open : []) {
        if (!NOTIFY_CONFIDENCE.has(c.confidence)) continue;
        for (const fid of c.memberFindingIds || []) {
          let f = null;
          if (findingStore && typeof findingStore.get === 'function') {
            try { f = await findingStore.get(fid); } catch { f = null; } // eslint-disable-line no-await-in-loop
          }
          if (f && f.hostId != null) map.set(subjectOf(f, { siteOf: sites }).key, c.id);
        }
      }
      subjectToCluster = map;
      siteOf = sites;
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

  // Sync: the cluster id whose open event already covers this finding's
  // subject, or null. Callers suppress the finding's individual alert + ITSM
  // emit when set.
  function suppressedCluster(finding) {
    if (!finding || finding.hostId == null) return null;
    return subjectToCluster.get(subjectOf(finding, { siteOf }).key) ?? null;
  }

  return { refresh, ensureFresh, suppressedCluster, get size() { return subjectToCluster.size; } };
}

module.exports = { createClusterAlertGate };
