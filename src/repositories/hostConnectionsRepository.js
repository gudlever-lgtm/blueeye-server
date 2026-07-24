'use strict';

// Data-access for `host_connections` (migration 070) — agent-reported
// connection-table edges, a second SOURCE for the service dependency graph.
// The reporting agent owns its rows (replaced wholesale each report). Rows are
// surfaced to the service-dependency job as flow-shaped rows (bytes/packets = 0,
// conn_count = the observed count) so the SAME aggregator + host resolution
// applies. Pure data-access; orientation happened on the agent.

const MAX_EDGES = 1000; // cap per agent report — bounds the table + the report

function sanitize(edges) {
  const out = [];
  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e) continue;
    const srcIp = typeof e.srcIp === 'string' ? e.srcIp.trim() : '';
    const dstIp = typeof e.dstIp === 'string' ? e.dstIp.trim() : '';
    const dstPort = Number(e.dstPort);
    const connCount = Number(e.connCount);
    if (!srcIp || !dstIp || srcIp === dstIp) continue;
    if (srcIp.length > 64 || dstIp.length > 64) continue;
    if (!Number.isInteger(dstPort) || dstPort <= 0 || dstPort > 65535) continue;
    out.push({ srcIp, dstIp, dstPort, connCount: Number.isInteger(connCount) && connCount > 0 ? connCount : 1 });
    if (out.length >= MAX_EDGES) break;
  }
  return out;
}

function createHostConnectionsRepository(db) {
  const { pool } = db;

  // Replace an agent's reported edge set (it always sends its full current view).
  // Delete-then-insert keeps stale edges from that agent from lingering.
  async function replaceForAgent(agentId, edges, { now = new Date() } = {}) {
    const clean = sanitize(edges);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM host_connections WHERE agent_id = ?', [agentId]);
      if (clean.length) {
        const values = clean.map((e) => [agentId, e.srcIp, e.dstIp, e.dstPort, e.connCount, now]);
        await conn.query(
          'INSERT INTO host_connections (agent_id, src_ip, dst_ip, dst_port, conn_count, last_seen) VALUES ?',
          [values],
        );
      }
      await conn.commit();
      return clean.length;
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw err;
    } finally {
      conn.release();
    }
  }

  // The recent edges as flow-shaped rows for the service-dependency aggregator.
  // Rolling window by last_seen; no byte volume (bytes/packets = 0).
  async function listAsFlowRows({ from, to = new Date() }) {
    const [rows] = await pool.query(
      `SELECT src_ip, dst_ip, dst_port, conn_count, last_seen
         FROM host_connections
        WHERE last_seen >= ? AND last_seen <= ?`,
      [from, to],
    );
    return rows.map((r) => ({
      srcIp: r.src_ip,
      dstIp: r.dst_ip,
      dstPort: Number(r.dst_port),
      bytes: 0,
      packets: 0,
      connCount: Number(r.conn_count) || 0,
      firstSeen: r.last_seen,
      lastSeen: r.last_seen,
    }));
  }

  async function purgeOlderThan(cutoff) {
    const [res] = await pool.query('DELETE FROM host_connections WHERE last_seen < ?', [cutoff]);
    return res.affectedRows || 0;
  }

  return { replaceForAgent, listAsFlowRows, purgeOlderThan };
}

module.exports = { createHostConnectionsRepository, sanitize };
