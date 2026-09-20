'use strict';

// Retention configuration, read from the same env mechanism as the rest of the
// server. DB hygiene is a safe default, so retention is ON unless disabled.
function toInt(v, d) { const n = Number.parseInt(v, 10); return Number.isNaN(n) ? d : n; }

function loadRetentionConfig(env = process.env) {
  return {
    enabled: env.RETENTION_ENABLED !== 'false',
    rawRetentionDays: toInt(env.RETENTION_RAW_DAYS, 7), // raw/full-resolution kept this long
    rollupRetentionDays: toInt(env.RETENTION_ROLLUP_DAYS, 90), // aggregated kept this long
    findingRetentionDays: toInt(env.RETENTION_FINDING_DAYS, 365), // findings kept longest
    configSnapshotRetentionDays: toInt(env.RETENTION_CONFIG_SNAPSHOT_DAYS, 180), // raw device-config snapshots
    // ARP/neighbour entries. Short by design: a neighbour table is a snapshot of
    // a segment, and a stale answer to "where is this MAC" is worse than none.
    arpRetentionDays: toInt(env.RETENTION_ARP_DAYS, 30),
    // Interface state transitions. Long enough to cover an investigation that
    // spans several shifts, which is the whole point of recording them.
    interfaceTransitionRetentionDays: toInt(env.RETENTION_INTERFACE_TRANSITION_DAYS, 90),
    // Device events (syslog, and SNMP traps from stage 03). Long enough to
    // explain an outage somebody is still writing the report for; short enough
    // that a chatty fleet does not turn the device log into the largest thing
    // on the disk. Matches the TimescaleDB retention policy in
    // server/db/timescale/001_init.sql, so the two stores expire together.
    deviceEventRetentionDays: toInt(env.RETENTION_DEVICE_EVENT_DAYS, 30),
    // Forwarding-table entries. SHORT, like the ARP window and for the same
    // reason: a forwarding entry ages out of the SWITCH in minutes, so a
    // three-week-old "this MAC is on Gi0/14" is worse than no answer. Long
    // enough that a device switched off over a holiday is still findable.
    fdbRetentionDays: toInt(env.RETENTION_FDB_DAYS, 30),
    // Burst runs. LONGER than the telemetry around them, and deliberately so:
    // a burst is a measurement somebody chose to take while standing in front
    // of a fault, and its verdict gets quoted in a report weeks later. There
    // are a handful of rows a week, not a stream, so keeping them is cheap.
    burstRunRetentionDays: toInt(env.RETENTION_BURST_DAYS, 90),
    rollupIntervalMinutes: toInt(env.RETENTION_ROLLUP_INTERVAL_MINUTES, 60), // bucket granularity
    intervalHours: toInt(env.RETENTION_JOB_INTERVAL_HOURS, 24), // how often the job runs
    batchSize: toInt(env.RETENTION_BATCH_SIZE, 5000), // rows fetched per rollup page
  };
}

module.exports = { loadRetentionConfig };
