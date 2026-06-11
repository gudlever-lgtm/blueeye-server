'use strict';

// Data-access for `ha_nodes` — the cluster registry used by high-availability
// deployments. Each running replica upserts a heartbeat row (who/where/which
// version + whether it currently holds the leader lock). The status/admin API
// reads it to show the live cluster topology, and a node clears its leader flag
// when it stops. Holds no secrets — operational metadata only.
function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    is_leader: !!row.is_leader,
  };
}

function createHaNodesRepository(db) {
  const { pool } = db;

  // Insert-or-update this node's heartbeat. started_at is preserved across
  // heartbeats (only set on first insert); last_seen_at is bumped every time.
  async function heartbeat({ nodeId, hostname = null, pid = null, version = null, isLeader = false }) {
    const id = String(nodeId).slice(0, 191);
    await pool.query(
      `INSERT INTO ha_nodes (node_id, hostname, pid, version, is_leader, started_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         hostname = VALUES(hostname),
         pid = VALUES(pid),
         version = VALUES(version),
         is_leader = VALUES(is_leader),
         last_seen_at = NOW()`,
      [id, hostname, pid, version, isLeader ? 1 : 0]
    );
    // Exactly one node holds the advisory lock, so exactly one row should show
    // is_leader=1. A crashed ex-leader's row keeps its stale flag until it ages
    // out of the active window; clear it on promotion so GET /api/ha/nodes never
    // shows two leaders during failover. Self was just written as leader above,
    // so there's no window with zero leaders.
    if (isLeader) {
      await pool.query(
        'UPDATE ha_nodes SET is_leader = 0 WHERE node_id <> ? AND is_leader = 1',
        [id]
      );
    }
  }

  // Nodes seen within `withinSeconds`, leader first then most-recently-seen. The
  // `active` flag is computed so callers can show stale rows distinctly if they
  // widen the window.
  async function listActive(withinSeconds = 60) {
    const [rows] = await pool.query(
      `SELECT node_id, hostname, pid, version, is_leader, started_at, last_seen_at,
              (last_seen_at >= (NOW() - INTERVAL ? SECOND)) AS active
         FROM ha_nodes
        WHERE last_seen_at >= (NOW() - INTERVAL ? SECOND)
        ORDER BY is_leader DESC, last_seen_at DESC`,
      [withinSeconds, withinSeconds]
    );
    return rows.map((r) => ({ ...mapRow(r), active: !!r.active }));
  }

  // Clear the leader flag on clean shutdown so the cluster view doesn't show a
  // gone node as leader until its heartbeat ages out.
  async function markStopped(nodeId) {
    await pool.query('UPDATE ha_nodes SET is_leader = 0 WHERE node_id = ?', [nodeId]);
  }

  // Housekeeping: drop rows for nodes that have been gone a long time.
  async function prune(olderThanSeconds = 86400) {
    const [res] = await pool.query(
      'DELETE FROM ha_nodes WHERE last_seen_at < (NOW() - INTERVAL ? SECOND)',
      [olderThanSeconds]
    );
    return res.affectedRows || 0;
  }

  return { heartbeat, listActive, markStopped, prune };
}

module.exports = { createHaNodesRepository };
