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
    // Raw device-config snapshots. Guarded so a repo/config without this
    // dimension (older wiring / tests) simply skips it.
    let configSnapshots = 0;
    if (config.configSnapshotRetentionDays && typeof repo.purgeConfigSnapshotsBefore === 'function') {
      const configCut = new Date(t - config.configSnapshotRetentionDays * DAY_MS);
      configSnapshots = await repo.purgeConfigSnapshotsBefore(configCut);
    }
    // ARP/neighbour entries. Guarded like the config snapshots above so older
    // wiring (or a test repo without the dimension) simply skips it.
    let arpEntries = 0;
    if (config.arpRetentionDays && typeof repo.purgeArpEntriesBefore === 'function') {
      const arpCut = new Date(t - config.arpRetentionDays * DAY_MS);
      arpEntries = await repo.purgeArpEntriesBefore(arpCut);
    }
    // Interface state transitions (history) and the snapshot rows of interfaces
    // that stopped being reported. Guarded like the dimensions above.
    let interfaceTransitions = 0;
    let interfaceStates = 0;
    if (config.interfaceTransitionRetentionDays && typeof repo.purgeInterfaceTransitionsBefore === 'function') {
      const cut = new Date(t - config.interfaceTransitionRetentionDays * DAY_MS);
      interfaceTransitions = await repo.purgeInterfaceTransitionsBefore(cut);
      if (typeof repo.purgeInterfaceStatesBefore === 'function') {
        interfaceStates = await repo.purgeInterfaceStatesBefore(cut);
      }
    }
    return { flowRollups, metricRollups, findings, configSnapshots, arpEntries, interfaceTransitions, interfaceStates };
  }

  return { purgeExpired };
}

module.exports = { createPurge };
