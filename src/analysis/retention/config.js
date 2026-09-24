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
    // The recorded MAC MOVES (fdb_mac_moves, migration 117). Very short: they
    // answer "how often did this MAC move in the last few minutes" for the loop
    // detector and nothing else, and a loop writes one per flapping MAC per sweep.
    fdbMoveRetentionDays: toInt(env.RETENTION_FDB_MOVE_DAYS, 2),
    // Burst runs. LONGER than the telemetry around them, and deliberately so:
    // a burst is a measurement somebody chose to take while standing in front
    // of a fault, and its verdict gets quoted in a report weeks later. There
    // are a handful of rows a week, not a stream, so keeping them is cheap.
    burstRunRetentionDays: toInt(env.RETENTION_BURST_DAYS, 90),
    // The port inventory on a polled switch. LONGEST of the SNMP dimensions,
    // deliberately: counter samples reference an interface row, and purging the
    // row while its measurements are still stored would orphan them. It has to
    // outlive the longest retention of anything pointing at it, and a port that
    // stops being reported is a handful of bytes, not a stream.
    deviceInterfaceRetentionDays: toInt(env.RETENTION_DEVICE_INTERFACE_DAYS, 180),
    // Interface counter samples. The second-largest write stream in the
    // product after flow_records: ~1.4 million rows a day for twenty switches.
    // On a TSDB deployment this is a no-op (TimescaleDB expires and compresses
    // the chunks itself, 90 days); the number here is the MySQL fallback, kept
    // SHORTER because 180 bytes x 1.4 million a day is ~10 GB a month in
    // InnoDB with no compression to lean on.
    deviceCounterRetentionDays: toInt(env.RETENTION_DEVICE_COUNTER_DAYS, 14),
    // Internal (LAN/OT) flow rollup: how many (src, dst, proto, service) rows
    // one agent may keep per bucket before the rest folds into an overflow row.
    // Kept rows live as long as the other rollups (rollupRetentionDays).
    internalRollupTopN: toInt(env.RETENTION_INTERNAL_ROLLUP_TOP_N, 500),
    // Probe results (ping/DNS/HTTP/TLS/TCP/traceroute history). NOT short, on
    // purpose: the availability and outage reports accept a range of up to 366
    // days (src/validation/probeOutageValidation.js) and compute uptime from
    // these rows, so a shorter window would make a yearly SLA report quietly
    // describe only its last few weeks. 400 days covers the widest report the
    // product offers, plus "the same month last year".
    probeResultRetentionDays: toInt(env.RETENTION_PROBE_RESULT_DAYS, 400),
    // Probe outages — CLOSED ones only; an open outage is a current condition.
    // Same window as the probe results, for the same report.
    probeOutageRetentionDays: toInt(env.RETENTION_PROBE_OUTAGE_DAYS, 400),
    // Speed tests. A handful a day, and "is the line slower than last year" is
    // the question they answer, so a year.
    speedtestRetentionDays: toInt(env.RETENTION_SPEEDTEST_DAYS, 365),
    // Transaction-test results. The trend endpoint reads up to 90 days
    // (src/routes/transactions.js) and the baselines far less, so 90.
    transactionResultRetentionDays: toInt(env.RETENTION_TRANSACTION_RESULT_DAYS, 90),
    // LLDP topology changes. Same as the config snapshots: a change is quoted in
    // an investigation long after it happened.
    topologyChangeRetentionDays: toInt(env.RETENTION_TOPOLOGY_CHANGE_DAYS, 180),
    // Discovery candidates that were never promoted (status 'discovered' or
    // 'ignored') and that no sweep has seen for this long. A promoted row is
    // NEVER purged — it records an operator decision about a monitored host.
    discoveredDeviceRetentionDays: toInt(env.RETENTION_DISCOVERED_DEVICE_DAYS, 90),
    // The new-device detector's memory of every MAC a site has had
    // (known_devices, migration 131), aged on last_seen. LONG, and deliberately
    // unlike the ARP window: this answers "has this site EVER seen it", so a
    // device used once a quarter — or once a year — is not "new" every time it
    // comes back. 400 days, the same horizon as the probe history.
    knownDeviceRetentionDays: toInt(env.RETENTION_KNOWN_DEVICE_DAYS, 400),
    // Connection-table edges of agents that stopped reporting (a live agent
    // replaces its own rows on every report). Same as the ARP window.
    hostConnectionRetentionDays: toInt(env.RETENTION_HOST_CONNECTION_DAYS, 30),
    // audit_events (User Logs + agent lifecycle). Long, because it is the record
    // of who did what. The hash-chained audit_log is a different table and is
    // never purged by this job. 0 keeps audit_events forever.
    auditEventRetentionDays: toInt(env.RETENTION_AUDIT_EVENT_DAYS, 365),
    // First run after boot. Without it a server restarted more often than every
    // intervalHours (a deploy a day) never ran retention at all. Delayed so it
    // does not compete with the boot itself and with agents reconnecting.
    startupDelaySeconds: toInt(env.RETENTION_STARTUP_DELAY_SECONDS, 120),
    rollupIntervalMinutes: toInt(env.RETENTION_ROLLUP_INTERVAL_MINUTES, 60), // bucket granularity
    intervalHours: toInt(env.RETENTION_JOB_INTERVAL_HOURS, 24), // how often the job runs
    batchSize: toInt(env.RETENTION_BATCH_SIZE, 5000), // rows fetched per rollup page
  };
}

module.exports = { loadRetentionConfig };
