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
    // The internal (LAN/OT) flow rollup shares the rollup window. Guarded like
    // the dimensions below.
    const internalFlowRollups = typeof repo.purgeInternalFlowRollupsBefore === 'function'
      ? await repo.purgeInternalFlowRollupsBefore(rollupCut) : 0;
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
    // A polled router's ARP table (migration 125) is the same identity source
    // seen from a device, so it ages on the SAME window (RETENTION_ARP_DAYS).
    let deviceArpEntries = 0;
    if (config.arpRetentionDays && typeof repo.purgeArpEntriesBefore === 'function') {
      const arpCut = new Date(t - config.arpRetentionDays * DAY_MS);
      arpEntries = await repo.purgeArpEntriesBefore(arpCut);
      if (typeof repo.purgeDeviceArpEntriesBefore === 'function') {
        deviceArpEntries = await repo.purgeDeviceArpEntriesBefore(arpCut);
      }
    }
    // Device events (syslog/traps). Guarded like the dimensions above. On a
    // TSDB deployment this is a no-op: the hypertable expires them with a
    // TimescaleDB retention policy instead, and the repository says so by
    // reporting nothing removed.
    let deviceEvents = 0;
    if (config.deviceEventRetentionDays && typeof repo.purgeDeviceEventsBefore === 'function') {
      const cut = new Date(t - config.deviceEventRetentionDays * DAY_MS);
      deviceEvents = await repo.purgeDeviceEventsBefore(cut);
    }
    // Forwarding-table entries + the switch-seen neighbours. Guarded like the
    // dimensions above.
    let fdbEntries = 0;
    let snmpNeighbors = 0;
    let deviceVlans = 0;
    if (config.fdbRetentionDays && typeof repo.purgeFdbEntriesBefore === 'function') {
      const cut = new Date(t - config.fdbRetentionDays * DAY_MS);
      fdbEntries = await repo.purgeFdbEntriesBefore(cut);
      if (typeof repo.purgeSnmpNeighborsBefore === 'function') {
        snmpNeighbors = await repo.purgeSnmpNeighborsBefore(cut);
      }
      // VLAN names label the forwarding table and age with it.
      if (typeof repo.purgeDeviceVlansBefore === 'function') {
        deviceVlans = await repo.purgeDeviceVlansBefore(cut);
      }
    }
    // Burst runs. A burst is a deliberate measurement rather than a stream, so
    // it is kept longer than the telemetry around it; guarded like the rest.
    let burstRuns = 0;
    if (config.burstRunRetentionDays && typeof repo.purgeBurstRunsBefore === 'function') {
      const cut = new Date(t - config.burstRunRetentionDays * DAY_MS);
      burstRuns = await repo.purgeBurstRunsBefore(cut);
    }
    // Interface counter samples, purged BEFORE the inventory they point at, so
    // a sample never outlives the port row that gives it meaning.
    let deviceCounters = 0;
    if (config.deviceCounterRetentionDays && typeof repo.purgeDeviceCountersBefore === 'function') {
      const cut = new Date(t - config.deviceCounterRetentionDays * DAY_MS);
      deviceCounters = await repo.purgeDeviceCountersBefore(cut);
    }
    // The port inventory on polled switches. Guarded like the rest, and the
    // longest window of the SNMP dimensions — see the note in config.js.
    let deviceInterfaces = 0;
    if (config.deviceInterfaceRetentionDays && typeof repo.purgeDeviceInterfacesBefore === 'function') {
      const cut = new Date(t - config.deviceInterfaceRetentionDays * DAY_MS);
      deviceInterfaces = await repo.purgeDeviceInterfacesBefore(cut);
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
    // Measurement history, change records and stale inventory that used to
    // grow forever. One table each, each on its own window (see config.js),
    // each guarded like the dimensions above; a window of 0 (or unset) keeps
    // that table as it is.
    const byAge = async (days, method) => {
      if (!days || typeof repo[method] !== 'function') return 0;
      return repo[method](new Date(t - days * DAY_MS));
    };
    // The MAC moves the loop detector counts (migration 117): their own short window.
    const fdbMoves = await byAge(config.fdbMoveRetentionDays, 'purgeFdbMovesBefore');
    const probeResults = await byAge(config.probeResultRetentionDays, 'purgeProbeResultsBefore');
    const probeOutages = await byAge(config.probeOutageRetentionDays, 'purgeResolvedProbeOutagesBefore');
    const speedtestResults = await byAge(config.speedtestRetentionDays, 'purgeSpeedtestResultsBefore');
    const transactionResults = await byAge(config.transactionResultRetentionDays, 'purgeTransactionResultsBefore');
    const topologyChanges = await byAge(config.topologyChangeRetentionDays, 'purgeTopologyChangesBefore');
    const discoveredDevices = await byAge(config.discoveredDeviceRetentionDays, 'purgeStaleDiscoveredDevicesBefore');
    const hostConnections = await byAge(config.hostConnectionRetentionDays, 'purgeHostConnectionsBefore');
    const knownDevices = await byAge(config.knownDeviceRetentionDays, 'purgeKnownDevicesBefore');
    const auditEvents = await byAge(config.auditEventRetentionDays, 'purgeAuditEventsBefore');
    return {
      flowRollups, metricRollups, internalFlowRollups, findings, configSnapshots, arpEntries, deviceArpEntries, deviceEvents,
      fdbEntries, snmpNeighbors, deviceVlans, fdbMoves, burstRuns, deviceCounters, deviceInterfaces, interfaceTransitions, interfaceStates,
      probeResults, probeOutages, speedtestResults, transactionResults, topologyChanges, discoveredDevices,
      hostConnections, knownDevices, auditEvents,
    };
  }

  return { purgeExpired };
}

module.exports = { createPurge };
