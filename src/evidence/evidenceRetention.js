'use strict';

// Evidence retention (Fase 6). Ages out old evidence snapshots — EXCEPT snapshots
// attached to a cluster that still has an unacknowledged CRIT finding (the
// existing never-delete rule). Default window 90 days, configurable.
//
// Pure-ish: it reads the candidate cluster ids from the evidence repo, asks the
// finding store which of them still hold an unacknowledged CRIT member (the
// protected set), then deletes the rest older than the cutoff. Never throws.

const DAY_MS = 24 * 60 * 60 * 1000;
const silentLogger = { info() {}, warn() {} };

function createEvidenceRetention({
  evidenceRepo,
  clustersRepo,
  findingStore = null,
  retentionDays = 90,
  now = () => new Date(),
  logger = silentLogger,
} = {}) {
  // True if the cluster still has an unacknowledged CRIT member finding.
  async function hasUnackedCrit(clusterId) {
    if (!clustersRepo || !findingStore || typeof findingStore.get !== 'function') return false;
    let cluster = null;
    try { cluster = await clustersRepo.findById(clusterId); } catch { cluster = null; }
    if (!cluster) return false;
    for (const fid of cluster.memberFindingIds || []) {
      let f = null;
      try { f = await findingStore.get(fid); } catch { f = null; } // eslint-disable-line no-await-in-loop
      if (f && f.severity === 'CRIT' && !f.acked) return true;
    }
    return false;
  }

  // Deletes expired snapshots, preserving those on unacknowledged-CRIT clusters.
  // Returns { deleted, protectedClusters }. Never throws.
  async function run() {
    const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 90;
    const cutoff = new Date(now().getTime() - days * DAY_MS);
    try {
      const candidates = typeof evidenceRepo.clusterIdsWithSnapshotsOlderThan === 'function'
        ? await evidenceRepo.clusterIdsWithSnapshotsOlderThan(cutoff) : [];
      const protectedClusterIds = [];
      for (const cid of candidates) {
        if (await hasUnackedCrit(cid)) protectedClusterIds.push(cid); // eslint-disable-line no-await-in-loop
      }
      const deleted = await evidenceRepo.ageOut(cutoff, { protectedClusterIds });
      if (deleted) logger.info(`evidence-retention: deleted ${deleted} snapshot(s); protected ${protectedClusterIds.length} CRIT cluster(s).`);
      return { deleted, protectedClusters: protectedClusterIds };
    } catch (err) {
      logger.warn(`evidence-retention: run failed (${err.message})`);
      return { deleted: 0, protectedClusters: [] };
    }
  }

  return { run, hasUnackedCrit };
}

module.exports = { createEvidenceRetention };
