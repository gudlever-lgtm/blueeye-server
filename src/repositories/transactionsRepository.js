'use strict';

// Data-access for the transaction-test domain (migration 046):
//   transaction_tests · transaction_test_agents (join) · transaction_results.
// Plain objects in/out; `config`/`thresholds`/`detail` are JSON columns parsed
// to objects here so callers never touch raw JSON.

function parseJson(v, fallback = null) {
  if (v == null) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
}

function parseTest(row, agentIds = []) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    config: parseJson(row.config, {}),
    thresholds: parseJson(row.thresholds, null),
    interval_ms: row.interval_ms,
    enabled: !!row.enabled,
    agent_ids: agentIds,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    test_id: row.test_id,
    agent_id: row.agent_id,
    ran_at: row.ran_at instanceof Date ? row.ran_at.toISOString() : row.ran_at,
    status: row.status,
    latency_ms: row.latency_ms,
    detail: parseJson(row.detail, null),
  };
}

function createTransactionsRepository(db) {
  const { pool } = db;

  // Agent-id list for a set of test ids → { testId: [agentId, ...] }.
  async function agentIdMap(testIds) {
    if (!testIds.length) return {};
    const [rows] = await pool.query(
      'SELECT test_id, agent_id FROM transaction_test_agents WHERE test_id IN (?) ORDER BY agent_id',
      [testIds]
    );
    const map = {};
    for (const r of rows) (map[r.test_id] = map[r.test_id] || []).push(r.agent_id);
    return map;
  }

  async function list() {
    const [rows] = await pool.query(
      'SELECT id,name,type,config,thresholds,interval_ms,enabled,created_at,updated_at FROM transaction_tests ORDER BY name'
    );
    const map = await agentIdMap(rows.map((r) => r.id));
    return rows.map((r) => parseTest(r, map[r.id] || []));
  }

  async function findById(id) {
    const [rows] = await pool.query(
      'SELECT id,name,type,config,thresholds,interval_ms,enabled,created_at,updated_at FROM transaction_tests WHERE id=?',
      [id]
    );
    if (!rows[0]) return null;
    const map = await agentIdMap([id]);
    return parseTest(rows[0], map[id] || []);
  }

  async function create({ name, type, config, thresholds = null, interval_ms = 60000, enabled = true }) {
    const [res] = await pool.query(
      'INSERT INTO transaction_tests (name,type,config,thresholds,interval_ms,enabled) VALUES (?,?,?,?,?,?)',
      [name, type, JSON.stringify(config || {}), thresholds ? JSON.stringify(thresholds) : null, interval_ms, enabled ? 1 : 0]
    );
    return findById(res.insertId);
  }

  async function update(id, { name, type, config, thresholds, interval_ms, enabled }) {
    const existing = await findById(id);
    if (!existing) return null;
    await pool.query(
      'UPDATE transaction_tests SET name=?,type=?,config=?,thresholds=?,interval_ms=?,enabled=?,updated_at=NOW() WHERE id=?',
      [
        name ?? existing.name,
        type ?? existing.type,
        JSON.stringify(config ?? existing.config),
        thresholds !== undefined ? (thresholds ? JSON.stringify(thresholds) : null) : (existing.thresholds ? JSON.stringify(existing.thresholds) : null),
        interval_ms ?? existing.interval_ms,
        (enabled !== undefined ? enabled : existing.enabled) ? 1 : 0,
        id,
      ]
    );
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM transaction_tests WHERE id=?', [id]);
    return res.affectedRows > 0;
  }

  async function agentsFor(testId) {
    const [rows] = await pool.query('SELECT agent_id FROM transaction_test_agents WHERE test_id=? ORDER BY agent_id', [testId]);
    return rows.map((r) => r.agent_id);
  }

  // Replace a test's agent assignments atomically. Returns the new id list.
  async function setAgents(testId, agentIds) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM transaction_test_agents WHERE test_id=?', [testId]);
      if (agentIds.length) {
        const values = agentIds.map((aid) => [testId, aid]);
        await conn.query('INSERT INTO transaction_test_agents (test_id, agent_id) VALUES ?', [values]);
      }
      await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw err;
    } finally {
      conn.release();
    }
    return agentIds.slice();
  }

  // Enabled tests assigned to one agent — pushed to the agent as its config.
  async function testsForAgent(agentId) {
    const [rows] = await pool.query(
      `SELECT t.id,t.name,t.type,t.config,t.thresholds,t.interval_ms,t.enabled,t.created_at,t.updated_at
         FROM transaction_tests t
         JOIN transaction_test_agents ta ON ta.test_id = t.id
        WHERE ta.agent_id = ? AND t.enabled = 1
        ORDER BY t.id`,
      [agentId]
    );
    return rows.map((r) => parseTest(r, [agentId]));
  }

  // The set of test ids an agent is assigned to (result-ingest authorisation).
  async function assignedTestIds(agentId) {
    const [rows] = await pool.query('SELECT test_id FROM transaction_test_agents WHERE agent_id=?', [agentId]);
    return new Set(rows.map((r) => r.test_id));
  }

  // Batch-insert results. rows: [{ test_id, agent_id, ran_at, status, latency_ms, detail }].
  async function insertResults(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const values = rows.map((r) => [
      r.test_id,
      r.agent_id,
      r.ran_at instanceof Date ? r.ran_at : (r.ran_at ? new Date(r.ran_at) : new Date()),
      String(r.status),
      r.latency_ms ?? null,
      r.detail != null ? JSON.stringify(r.detail) : null,
    ]);
    const [res] = await pool.query(
      'INSERT INTO transaction_results (test_id,agent_id,ran_at,status,latency_ms,detail) VALUES ?',
      [values]
    );
    return res.affectedRows;
  }

  // Results for a test, optionally filtered by [from,to] and one agent.
  async function results({ testId, from = null, to = null, agentId = null, limit = 500 }) {
    const where = ['test_id = ?'];
    const params = [testId];
    if (from) { where.push('ran_at >= ?'); params.push(from); }
    if (to) { where.push('ran_at <= ?'); params.push(to); }
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT id,test_id,agent_id,ran_at,status,latency_ms,detail FROM transaction_results
        WHERE ${where.join(' AND ')} ORDER BY ran_at DESC LIMIT ?`,
      params
    );
    return rows.map(parseResult);
  }

  // Time-bucketed aggregation for the heatmap: avg_latency, fail_count and
  // sample_count per bucket per agent, over [from,to]. bucket ∈ 5m|15m|1h.
  async function heatmap({ testId, from = null, to = null, bucket = '5m' }) {
    const bucketSeconds = bucket === '1h' ? 3600 : (bucket === '15m' ? 900 : 300);
    const where = ['test_id = ?'];
    const params = [bucketSeconds, testId];
    if (from) { where.push('ran_at >= ?'); params.push(from); }
    if (to) { where.push('ran_at <= ?'); params.push(to); }
    const [rows] = await pool.query(
      `SELECT agent_id,
              FLOOR(UNIX_TIMESTAMP(ran_at) / ?) AS bucket,
              AVG(latency_ms) AS avg_latency,
              SUM(status <> 'ok') AS fail_count,
              COUNT(*) AS sample_count
         FROM transaction_results
        WHERE ${where.join(' AND ')}
        GROUP BY agent_id, bucket
        ORDER BY bucket, agent_id`,
      params
    );
    return rows.map((r) => ({
      agent_id: r.agent_id,
      bucket: Number(r.bucket),
      avg_latency: r.avg_latency == null ? null : Math.round(Number(r.avg_latency)),
      fail_count: Number(r.fail_count),
      sample_count: Number(r.sample_count),
    }));
  }

  // The most recent N statuses for (test, agent), newest-first — feeds the
  // consecutive-fails alert evaluation.
  async function recentStatuses(testId, agentId, limit = 10) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 10;
    const [rows] = await pool.query(
      'SELECT status FROM transaction_results WHERE test_id=? AND agent_id=? ORDER BY ran_at DESC, id DESC LIMIT ?',
      [testId, agentId, lim]
    );
    return rows.map((r) => r.status);
  }

  return {
    list,
    findById,
    create,
    update,
    remove,
    agentsFor,
    setAgents,
    testsForAgent,
    assignedTestIds,
    insertResults,
    results,
    heatmap,
    recentStatuses,
  };
}

module.exports = { createTransactionsRepository, parseTest, parseResult };
