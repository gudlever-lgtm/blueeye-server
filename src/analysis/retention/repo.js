'use strict';

const FLOW_ROLLUP_COLS = ['bucket', 'agent_id', 'direction', 'country', 'asn', 'asn_name', 'bytes', 'packets', 'flow_count', 'bytes_min', 'bytes_max', 'bytes_median'];
const METRIC_ROLLUP_COLS = ['bucket', 'agent_id', 'metric', 'samples', 'val_min', 'val_max', 'val_median'];

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
  // Only ACKNOWLEDGED findings are ever deleted — unacknowledged findings
  // (including CRIT) are kept regardless of age.
  async function purgeAckedFindingsBefore(ts) {
    return deleteInBatches('DELETE FROM findings WHERE acked = 1 AND created_at < ? ORDER BY created_at LIMIT ?', [ts]);
  }

  return {
    getRawExternalFlowsBatch,
    insertFlowRollups,
    deleteRawFlowsBefore,
    getRawResultsBatch,
    insertMetricRollups,
    deleteRawResultsBefore,
    purgeFlowRollupsBefore,
    purgeMetricRollupsBefore,
    purgeAckedFindingsBefore,
  };
}

module.exports = { createRetentionRepo, FLOW_ROLLUP_COLS, METRIC_ROLLUP_COLS };
