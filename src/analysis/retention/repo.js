'use strict';

const FLOW_ROLLUP_COLS = ['bucket', 'agent_id', 'direction', 'country', 'asn', 'asn_name', 'bytes', 'packets', 'flow_count', 'bytes_min', 'bytes_max', 'bytes_median'];
const METRIC_ROLLUP_COLS = ['bucket', 'agent_id', 'metric', 'samples', 'val_min', 'val_max', 'val_median'];

// Data-access for retention: reading raw rows in batches, writing rollups
// (idempotent via ON DUPLICATE KEY UPDATE), and purging expired data.
function createRetentionRepo(db) {
  const { pool } = db;

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
    const [res] = await pool.query('DELETE FROM flow_records WHERE ts < ?', [beforeTs]);
    return res.affectedRows;
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
    const [res] = await pool.query('DELETE FROM results WHERE created_at < ?', [beforeTs]);
    return res.affectedRows;
  }

  // ---- purge ---------------------------------------------------------------
  async function purgeFlowRollupsBefore(ts) {
    const [res] = await pool.query('DELETE FROM flow_rollup WHERE bucket < ?', [ts]);
    return res.affectedRows;
  }
  async function purgeMetricRollupsBefore(ts) {
    const [res] = await pool.query('DELETE FROM metric_rollup WHERE bucket < ?', [ts]);
    return res.affectedRows;
  }
  // Only ACKNOWLEDGED findings are ever deleted — unacknowledged findings
  // (including CRIT) are kept regardless of age.
  async function purgeAckedFindingsBefore(ts) {
    const [res] = await pool.query('DELETE FROM findings WHERE acked = 1 AND created_at < ?', [ts]);
    return res.affectedRows;
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
