'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

// Deletes expired aggregated data and old findings. Findings purging is
// deliberately conservative: ONLY acknowledged findings are removed —
// unacknowledged findings (including CRIT) are kept regardless of age.
function createPurge({ repo, config, now = () => new Date() }) {
  async function purgeExpired() {
    const t = now().getTime();
    const rollupCut = new Date(t - config.rollupRetentionDays * DAY_MS);
    const findingCut = new Date(t - config.findingRetentionDays * DAY_MS);
    const flowRollups = await repo.purgeFlowRollupsBefore(rollupCut);
    const metricRollups = await repo.purgeMetricRollupsBefore(rollupCut);
    const findings = await repo.purgeAckedFindingsBefore(findingCut);
    return { flowRollups, metricRollups, findings };
  }

  return { purgeExpired };
}

module.exports = { createPurge };
