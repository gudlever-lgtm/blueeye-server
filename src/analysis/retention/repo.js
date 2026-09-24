'use strict';

const FLOW_ROLLUP_COLS = ['bucket', 'agent_id', 'direction', 'country', 'asn', 'asn_name', 'bytes', 'packets', 'flow_count', 'bytes_min', 'bytes_max', 'bytes_median'];
const METRIC_ROLLUP_COLS = ['bucket', 'agent_id', 'metric', 'samples', 'val_min', 'val_max', 'val_median'];
// Internal (RFC1918<->RFC1918) conversations, per hour, per service (migration 119).
const INTERNAL_FLOW_ROLLUP_COLS = ['bucket', 'agent_id', 'src_ip', 'dst_ip', 'proto', 'service_port', 'bytes', 'packets', 'flow_count'];

// Data-access for retention: reading raw rows in batches, writing rollups
// (idempotent via ON DUPLICATE KEY UPDATE), and purging expired data.
// Rows deleted per statement when purging. Keeps each DELETE short so it never
// holds a long row-lock on tables that ingest is concurrently writing to, and
// bounds the InnoDB undo log / replication lag per statement.
const DELETE_BATCH = 10000;

function createRetentionRepo(db) {
  const { pool } = db;

  // Repeatedly runs a LIMIT-ed DELETE until fewer than a full batch remain.
  // `sql` must end in `LIMIT ?`; the batch size is appended to `params`.
  async function deleteInBatches(sql, params) {
    let total = 0;
    for (;;) {
      const [res] = await pool.query(sql, [...params, DELETE_BATCH]);
      total += res.affectedRows;
      if (res.affectedRows < DELETE_BATCH) break;
    }
    return total;
  }

  // ---- flows ---------------------------------------------------------------
  async function getRawExternalFlowsBatch(beforeTs, afterId, limit) {
    const [rows] = await pool.query(
      `SELECT id, agent_id, ts, direction, country, asn, asn_name, bytes, packets, flows
       FROM flow_records
       WHERE internal = 0 AND country IS NOT NULL AND ts < ? AND id > ?
       ORDER BY id ASC LIMIT ?`,
      [beforeTs, afterId, limit]
    );
    return rows;
  }

  async function insertFlowRollups(rows) {
    if (!rows.length) return 0;
    const [res] = await pool.query(
      `INSERT INTO flow_rollup (${FLOW_ROLLUP_COLS.join(', ')}) VALUES ?
       ON DUPLICATE KEY UPDATE
         bytes = bytes + VALUES(bytes),
         packets = packets + VALUES(packets),
         flow_count = flow_count + VALUES(flow_count),
         bytes_min = LEAST(bytes_min, VALUES(bytes_min)),
         bytes_max = GREATEST(bytes_max, VALUES(bytes_max)),
         bytes_median = VALUES(bytes_median),
         asn_name = VALUES(asn_name)`,
      [rows]
    );
    return res.affectedRows;
  }

  // Internal flows — the LAN/OT conversations the external rollup above never
  // sees (it keys on peer country/ASN, and RFC1918 is never geolocated). Both
  // ports are read so the rollup can decide which end is the service.
  async function getRawInternalFlowsBatch(beforeTs, afterId, limit) {
    const [rows] = await pool.query(
      `SELECT id, agent_id, ts, src_ip, dst_ip, proto, src_port, dst_port, bytes, packets, flows
       FROM flow_records
       WHERE internal = 1 AND ts < ? AND id > ?
       ORDER BY id ASC LIMIT ?`,
      [beforeTs, afterId, limit]
    );
    return rows;
  }

  async function insertInternalFlowRollups(rows) {
    if (!rows.length) return 0;
    const [res] = await pool.query(
      `INSERT INTO flow_internal_rollup (${INTERNAL_FLOW_ROLLUP_COLS.join(', ')}) VALUES ?
       ON DUPLICATE KEY UPDATE
         bytes = bytes + VALUES(bytes),
         packets = packets + VALUES(packets),
         flow_count = flow_count + VALUES(flow_count)`,
      [rows]
    );
    return res.affectedRows;
  }

  async function deleteRawFlowsBefore(beforeTs) {
    return deleteInBatches('DELETE FROM flow_records WHERE ts < ? ORDER BY ts LIMIT ?', [beforeTs]);
  }

  // ---- metrics (from result payloads) -------------------------------------
  async function getRawResultsBatch(beforeTs, afterId, limit) {
    const [rows] = await pool.query(
      `SELECT id, agent_id, payload, created_at FROM results
       WHERE created_at < ? AND id > ? ORDER BY id ASC LIMIT ?`,
      [beforeTs, afterId, limit]
    );
    return rows;
  }

  async function insertMetricRollups(rows) {
    if (!rows.length) return 0;
    const [res] = await pool.query(
      `INSERT INTO metric_rollup (${METRIC_ROLLUP_COLS.join(', ')}) VALUES ?
       ON DUPLICATE KEY UPDATE
         samples = samples + VALUES(samples),
         val_min = LEAST(val_min, VALUES(val_min)),
         val_max = GREATEST(val_max, VALUES(val_max)),
         val_median = VALUES(val_median)`,
      [rows]
    );
    return res.affectedRows;
  }

  async function deleteRawResultsBefore(beforeTs) {
    return deleteInBatches('DELETE FROM results WHERE created_at < ? ORDER BY created_at LIMIT ?', [beforeTs]);
  }

  // ---- purge ---------------------------------------------------------------
  async function purgeFlowRollupsBefore(ts) {
    return deleteInBatches('DELETE FROM flow_rollup WHERE bucket < ? ORDER BY bucket LIMIT ?', [ts]);
  }
  async function purgeMetricRollupsBefore(ts) {
    return deleteInBatches('DELETE FROM metric_rollup WHERE bucket < ? ORDER BY bucket LIMIT ?', [ts]);
  }
  async function purgeInternalFlowRollupsBefore(ts) {
    return deleteInBatches('DELETE FROM flow_internal_rollup WHERE bucket < ? ORDER BY bucket LIMIT ?', [ts]);
  }
  // Only ACKNOWLEDGED findings are ever deleted — unacknowledged findings
  // (including CRIT) are kept regardless of age.
  async function purgeAckedFindingsBefore(ts) {
    return deleteInBatches('DELETE FROM findings WHERE acked = 1 AND created_at < ? ORDER BY created_at LIMIT ?', [ts]);
  }
  // Raw device-config snapshots older than the cutoff. The event_cases FK is
  // ON DELETE SET NULL, so purging an old snapshot just clears any stale
  // config-change link — it never deletes an event.
  async function purgeConfigSnapshotsBefore(ts) {
    return deleteInBatches('DELETE FROM config_snapshots WHERE captured_at < ? ORDER BY captured_at LIMIT ?', [ts]);
  }

  // ARP/neighbour entries not re-observed within the window. Deleting one only
  // costs a search hit that was already stale; the binding is re-learned on the
  // next capabilities report or evidence capture.
  async function purgeArpEntriesBefore(ts) {
    return deleteInBatches('DELETE FROM arp_entries WHERE last_seen < ? ORDER BY last_seen LIMIT ?', [ts]);
  }

  // Device events. Deleted by age like everything else here; the row is a
  // record of a moment, never a current state, so nothing re-derives from it.
  async function purgeDeviceEventsBefore(ts) {
    return deleteInBatches('DELETE FROM device_events WHERE received_at < ? ORDER BY received_at LIMIT ?', [ts]);
  }

  // Forwarding-table entries and the switch-seen LLDP adjacencies beside them.
  // Both age on last_seen and are re-learned on the next sweep.
  async function purgeFdbEntriesBefore(ts) {
    return deleteInBatches('DELETE FROM fdb_entries WHERE last_seen < ? ORDER BY last_seen LIMIT ?', [ts]);
  }

  async function purgeSnmpNeighborsBefore(ts) {
    return deleteInBatches('DELETE FROM snmp_neighbors WHERE last_seen < ? ORDER BY last_seen LIMIT ?', [ts]);
  }

  // VLAN names per switch (migration 117) age with the forwarding table they
  // label; the moves the loop detector counts have their own, much shorter,
  // window (fdbMoveRetentionDays).
  async function purgeDeviceVlansBefore(ts) {
    return deleteInBatches('DELETE FROM device_vlans WHERE last_seen < ? ORDER BY last_seen LIMIT ?', [ts]);
  }
  async function purgeFdbMovesBefore(ts) {
    return deleteInBatches('DELETE FROM fdb_mac_moves WHERE moved_at < ? ORDER BY moved_at LIMIT ?', [ts]);
  }

  // Burst runs, samples and all — the samples are a JSON column on the row, so
  // deleting the run takes its series with it and there is no second table to
  // keep in step.
  async function purgeBurstRunsBefore(ts) {
    return deleteInBatches('DELETE FROM burst_runs WHERE started_at < ? ORDER BY started_at LIMIT ?', [ts]);
  }

  // Ports on a polled switch that stopped being reported. Kept longest of the
  // SNMP dimensions: a counter sample points at one of these rows, so removing
  // it early strands the measurements that reference it.
  async function purgeDeviceInterfacesBefore(ts) {
    return deleteInBatches('DELETE FROM device_interfaces WHERE last_seen < ? ORDER BY last_seen LIMIT ?', [ts]);
  }

  // Interface counter samples. A no-op on a TSDB deployment: the hypertable
  // expires its own chunks with a retention policy, and the repository reports
  // nothing removed rather than pretending it swept.
  async function purgeDeviceCountersBefore(ts) {
    return deleteInBatches('DELETE FROM device_counter_samples WHERE ts < ? ORDER BY ts LIMIT ?', [ts]);
  }

  // Interface state transitions + the current-state snapshot rows of interfaces
  // that stopped being reported entirely. The snapshot cutoff is deliberately
  // longer-lived logic than the history: dropping a state row we still have
  // transitions for would make the next sighting look like a brand-new interface.
  async function purgeInterfaceTransitionsBefore(ts) {
    return deleteInBatches('DELETE FROM interface_state_transitions WHERE detected_at < ? ORDER BY detected_at LIMIT ?', [ts]);
  }
  async function purgeInterfaceStatesBefore(ts) {
    return deleteInBatches('DELETE FROM interface_states WHERE last_seen < ? ORDER BY last_seen LIMIT ?', [ts]);
  }

  // ---- measurement history (migration 120 adds the missing ts indexes) ------
  // Each of these is a record of a moment, never a current state, so they age
  // out on their own timestamp like device events do.
  async function purgeProbeResultsBefore(ts) {
    return deleteInBatches('DELETE FROM probe_results WHERE ts < ? ORDER BY ts LIMIT ?', [ts]);
  }
  async function purgeSpeedtestResultsBefore(ts) {
    return deleteInBatches('DELETE FROM speedtest_results WHERE ts < ? ORDER BY ts LIMIT ?', [ts]);
  }
  async function purgeTransactionResultsBefore(ts) {
    return deleteInBatches('DELETE FROM transaction_results WHERE `time` < ? ORDER BY `time` LIMIT ?', [ts]);
  }
  // Packet captures age out far sooner than the results they belong to — see
  // the note on transactionCaptureRetentionDays in config.js.
  async function purgeTransactionCapturesBefore(ts) {
    return deleteInBatches('DELETE FROM transaction_captures WHERE `time` < ? ORDER BY `time` LIMIT ?', [ts]);
  }
  // Only CLOSED outages. An outage that is still open is a current condition —
  // the probe-outage service resolves it by finding that row, so deleting it
  // would make the next recovery look like it never went down.
  async function purgeResolvedProbeOutagesBefore(ts) {
    return deleteInBatches(
      'DELETE FROM probe_outages WHERE resolved_at IS NOT NULL AND resolved_at < ? ORDER BY resolved_at LIMIT ?',
      [ts],
    );
  }
  async function purgeTopologyChangesBefore(ts) {
    return deleteInBatches('DELETE FROM topology_changes WHERE detected_at < ? ORDER BY detected_at LIMIT ?', [ts]);
  }
  // Discovery candidates nobody acted on. NEVER a promoted row: that one is the
  // record of an operator decision and points at a monitored agent. An ignored
  // or still-'discovered' candidate that no sweep has re-observed for the window
  // is gone from the network; if it comes back, the next sweep re-adds it (and
  // the new-device detector will say so).
  async function purgeStaleDiscoveredDevicesBefore(ts) {
    return deleteInBatches(
      "DELETE FROM discovered_devices WHERE status IN ('discovered', 'ignored') AND last_seen < ? ORDER BY last_seen LIMIT ?",
      [ts],
    );
  }
  // Connection-table edges (the second source of the dependency graph). The
  // agent replaces its own rows on every report, so only an agent that stopped
  // reporting leaves rows behind — this is what finally clears them.
  async function purgeHostConnectionsBefore(ts) {
    return deleteInBatches('DELETE FROM host_connections WHERE last_seen < ? ORDER BY last_seen LIMIT ?', [ts]);
  }
  // audit_events is NOT the hash-chained trail (that is audit_log, which is
  // never purged here — deleting a link would break verifyChain()). It is still
  // the User Logs record, so the default window is long, and a row ages on
  // last_seen_at so a recurring activity that is still happening is kept.
  async function purgeAuditEventsBefore(ts) {
    return deleteInBatches('DELETE FROM audit_events WHERE last_seen_at < ? ORDER BY last_seen_at LIMIT ?', [ts]);
  }

  return {
    getRawExternalFlowsBatch,
    insertFlowRollups,
    getRawInternalFlowsBatch,
    insertInternalFlowRollups,
    purgeInternalFlowRollupsBefore,
    deleteRawFlowsBefore,
    getRawResultsBatch,
    insertMetricRollups,
    deleteRawResultsBefore,
    purgeFlowRollupsBefore,
    purgeMetricRollupsBefore,
    purgeAckedFindingsBefore,
    purgeConfigSnapshotsBefore,
    purgeArpEntriesBefore,
    purgeDeviceEventsBefore,
    purgeFdbEntriesBefore,
    purgeSnmpNeighborsBefore,
    purgeDeviceVlansBefore,
    purgeFdbMovesBefore,
    purgeBurstRunsBefore,
    purgeTransactionCapturesBefore,
    purgeDeviceInterfacesBefore,
    purgeDeviceCountersBefore,
    purgeInterfaceTransitionsBefore,
    purgeInterfaceStatesBefore,
    purgeProbeResultsBefore,
    purgeSpeedtestResultsBefore,
    purgeTransactionResultsBefore,
    purgeResolvedProbeOutagesBefore,
    purgeTopologyChangesBefore,
    purgeStaleDiscoveredDevicesBefore,
    purgeHostConnectionsBefore,
    purgeAuditEventsBefore,
  };
}

module.exports = { createRetentionRepo, FLOW_ROLLUP_COLS, METRIC_ROLLUP_COLS, INTERNAL_FLOW_ROLLUP_COLS };
