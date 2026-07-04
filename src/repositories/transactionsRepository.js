'use strict';

const { median, mad } = require('../analysis/baselines');

// Data-access for the transaction-test domain (migration 046):
//   transaction_tests · transaction_test_agents · transaction_results ·
//   transaction_baselines.
//
// Secrets live AES-256-GCM-encrypted in transaction_tests.config_secrets and are
// NEVER returned by the read methods — callers get `secret_names` only. Only
// testsForAgent()/findByIdWithSecrets() decrypt (for the WS push), keyed by the
// injected secretBox.
function createTransactionsRepository({ db, secretBox = null }) {
  const { pool } = db;

  function parseJson(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
    return v;
  }

  // Secret NAMES from an encrypted blob (never the values). Defensive: a decrypt
  // failure (e.g. key rotation) yields no names rather than throwing on a read.
  function secretNamesOf(blob) {
    if (!blob || !secretBox) return [];
    try { return Object.keys(secretBox.decryptJson(blob) || {}); } catch { return []; }
  }
  function secretsOf(blob) {
    if (!blob || !secretBox) return {};
    try { return secretBox.decryptJson(blob) || {}; } catch { return {}; }
  }

  function shape(row, agentIds = [], withSecrets = false) {
    if (!row) return null;
    const base = {
      id: row.id,
      name: row.name,
      type: row.type,
      target: row.target,
      config: parseJson(row.config, {}),
      secret_names: secretNamesOf(row.config_secrets),
      interval_sec: row.interval_sec,
      enabled: !!row.enabled,
      agent_ids: agentIds,
      created_by: row.created_by,
      created_at: row.created_at,
    };
    if (withSecrets) base.secrets = secretsOf(row.config_secrets);
    return base;
  }

  async function agentIdMap(testIds) {
    if (!testIds.length) return {};
    const [rows] = await pool.query('SELECT test_id, agent_id FROM transaction_test_agents WHERE test_id IN (?) ORDER BY agent_id', [testIds]);
    const map = {};
    for (const r of rows) (map[r.test_id] = map[r.test_id] || []).push(r.agent_id);
    return map;
  }

  const TEST_COLS = 'id,name,type,target,config,config_secrets,interval_sec,enabled,created_by,created_at';

  async function list() {
    const [rows] = await pool.query(`SELECT ${TEST_COLS} FROM transaction_tests ORDER BY name`);
    const map = await agentIdMap(rows.map((r) => r.id));
    return rows.map((r) => shape(r, map[r.id] || []));
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${TEST_COLS} FROM transaction_tests WHERE id=?`, [id]);
    if (!rows[0]) return null;
    const map = await agentIdMap([id]);
    return shape(rows[0], map[id] || []);
  }

  // For the WS push only: includes decrypted `secrets`.
  async function findByIdWithSecrets(id) {
    const [rows] = await pool.query(`SELECT ${TEST_COLS} FROM transaction_tests WHERE id=?`, [id]);
    if (!rows[0]) return null;
    const map = await agentIdMap([id]);
    return shape(rows[0], map[id] || [], true);
  }

  function encryptSecrets(secrets) {
    if (secrets === undefined) return undefined; // keep existing
    if (!secrets || Object.keys(secrets).length === 0) return null; // clear
    if (!secretBox) return null;
    return secretBox.encryptJson(secrets);
  }

  async function create({ name, type, target = null, config, secrets, interval_sec = 60, enabled = true, created_by = null }) {
    const blob = encryptSecrets(secrets);
    const [res] = await pool.query(
      'INSERT INTO transaction_tests (name,type,target,config,config_secrets,interval_sec,enabled,created_by) VALUES (?,?,?,?,?,?,?,?)',
      [name, type, target, JSON.stringify(config || {}), blob ?? null, interval_sec, enabled ? 1 : 0, created_by]
    );
    return findById(res.insertId);
  }

  async function update(id, { name, type, target, config, secrets, interval_sec, enabled }) {
    const [rows] = await pool.query('SELECT config_secrets FROM transaction_tests WHERE id=?', [id]);
    if (!rows[0]) return null;
    const blob = encryptSecrets(secrets); // undefined = keep
    const existingBlob = rows[0].config_secrets;
    await pool.query(
      'UPDATE transaction_tests SET name=?,type=?,target=?,config=?,config_secrets=?,interval_sec=?,enabled=? WHERE id=?',
      [name, type, target, JSON.stringify(config || {}), blob === undefined ? existingBlob : blob, interval_sec, enabled ? 1 : 0, id]
    );
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM transaction_tests WHERE id=?', [id]);
    if (res.affectedRows === 0) return false;
    // No FKs — clean up the satellite rows explicitly.
    await pool.query('DELETE FROM transaction_test_agents WHERE test_id=?', [id]);
    await pool.query('DELETE FROM transaction_baselines WHERE test_id=?', [id]);
    await pool.query('DELETE FROM transaction_results WHERE test_id=?', [id]);
    return true;
  }

  async function agentsFor(testId) {
    const [rows] = await pool.query('SELECT agent_id FROM transaction_test_agents WHERE test_id=? ORDER BY agent_id', [testId]);
    return rows.map((r) => r.agent_id);
  }

  async function setAgents(testId, agentIds) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM transaction_test_agents WHERE test_id=?', [testId]);
      if (agentIds.length) await conn.query('INSERT INTO transaction_test_agents (test_id, agent_id) VALUES ?', [agentIds.map((a) => [testId, a])]);
      await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw err;
    } finally {
      conn.release();
    }
    return agentIds.slice();
  }

  // Enabled tests assigned to an agent, WITH decrypted secrets — for the WS push.
  async function testsForAgent(agentId) {
    const [rows] = await pool.query(
      `SELECT t.id,t.name,t.type,t.target,t.config,t.config_secrets,t.interval_sec,t.enabled,t.created_by,t.created_at
         FROM transaction_tests t JOIN transaction_test_agents ta ON ta.test_id=t.id
        WHERE ta.agent_id=? AND t.enabled=1 ORDER BY t.id`,
      [agentId]
    );
    return rows.map((r) => shape(r, [agentId], true));
  }

  async function assignedTestIds(agentId) {
    const [rows] = await pool.query('SELECT test_id FROM transaction_test_agents WHERE agent_id=?', [agentId]);
    return new Set(rows.map((r) => r.test_id));
  }

  // Batch-insert results. rows: [{ test_id, agent_id, time, status, latency_ms,
  // step_timings, step_failed, deviation, detail }].
  async function insertResults(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const values = rows.map((r) => [
      r.time instanceof Date ? r.time : (r.time ? new Date(r.time) : new Date()),
      r.test_id, r.agent_id, String(r.status),
      r.latency_ms ?? null,
      r.step_timings != null ? JSON.stringify(r.step_timings) : null,
      r.step_failed ?? null,
      r.deviation ?? null,
      r.detail != null ? (typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)).slice(0, 255) : null,
    ]);
    const [res] = await pool.query(
      'INSERT INTO transaction_results (time,test_id,agent_id,status,latency_ms,step_timings,step_failed,deviation,detail) VALUES ?',
      [values]
    );
    return res.affectedRows;
  }

  function parseResult(row) {
    return {
      time: row.time instanceof Date ? row.time.toISOString() : row.time,
      test_id: row.test_id, agent_id: row.agent_id, status: row.status,
      latency_ms: row.latency_ms, step_timings: parseJson(row.step_timings, null),
      step_failed: row.step_failed, deviation: row.deviation,
      detail: parseJson(row.detail, row.detail),
    };
  }

  async function results({ testId, from = null, to = null, agentId = null, limit = 500 }) {
    const where = ['test_id = ?'];
    const params = [testId];
    if (from) { where.push('time >= ?'); params.push(from); }
    if (to) { where.push('time <= ?'); params.push(to); }
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
    params.push(lim);
    const [rows] = await pool.query(
      `SELECT time,test_id,agent_id,status,latency_ms,step_timings,step_failed,deviation,detail
         FROM transaction_results WHERE ${where.join(' AND ')} ORDER BY time DESC LIMIT ?`,
      params
    );
    return rows.map(parseResult);
  }

  async function heatmap({ testId, from = null, to = null, bucket = '5m' }) {
    const bucketSeconds = bucket === '1h' ? 3600 : (bucket === '15m' ? 900 : 300);
    const where = ['test_id = ?'];
    const params = [bucketSeconds, testId];
    if (from) { where.push('time >= ?'); params.push(from); }
    if (to) { where.push('time <= ?'); params.push(to); }
    const [rows] = await pool.query(
      `SELECT agent_id,
              FLOOR(UNIX_TIMESTAMP(time) / ?) AS bucket,
              AVG(latency_ms) AS avg_latency,
              SUM(status <> 'ok') AS fail_count,
              COUNT(*) AS sample_count
         FROM transaction_results WHERE ${where.join(' AND ')}
        GROUP BY agent_id, bucket ORDER BY bucket, agent_id`,
      params
    );
    return rows.map((r) => ({
      agent_id: r.agent_id, bucket: Number(r.bucket),
      avg_latency: r.avg_latency == null ? null : Math.round(Number(r.avg_latency)),
      fail_count: Number(r.fail_count), sample_count: Number(r.sample_count),
    }));
  }

  // Median per day per step for one (test, agent) over `days`. Medians computed in
  // JS (reusing the analysis median) since MySQL has no native median. step 0 =
  // whole-test latency; steps 1..N = step_timings[n-1].
  async function trend({ testId, agentId, days = 7 }) {
    const since = new Date(Date.now() - days * 86400000);
    const [rows] = await pool.query(
      `SELECT time, latency_ms, step_timings FROM transaction_results
        WHERE test_id=? AND agent_id=? AND status='ok' AND time >= ? ORDER BY time`,
      [testId, agentId, since]
    );
    // day -> step -> [values]
    const byDay = new Map();
    for (const row of rows) {
      const day = (row.time instanceof Date ? row.time.toISOString() : String(row.time)).slice(0, 10);
      let steps = byDay.get(day);
      if (!steps) { steps = new Map(); byDay.set(day, steps); }
      if (row.latency_ms != null) (steps.get(0) || steps.set(0, []).get(0)).push(row.latency_ms);
      const st = parseJson(row.step_timings, null);
      if (Array.isArray(st)) st.forEach((v, i) => { if (v != null) (steps.get(i + 1) || steps.set(i + 1, []).get(i + 1)).push(v); });
    }
    const out = [];
    for (const [day, steps] of byDay) {
      for (const [step, vals] of steps) {
        out.push({ day, step, median_ms: Math.round(median(vals)), sample_count: vals.length });
      }
    }
    out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.step - b.step));
    return out;
  }

  // Most recent N statuses for (test, agent), newest-first — consecutive-fails.
  async function recentStatuses(testId, agentId, limit = 10) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 10;
    const [rows] = await pool.query('SELECT status FROM transaction_results WHERE test_id=? AND agent_id=? ORDER BY time DESC LIMIT ?', [testId, agentId, lim]);
    return rows.map((r) => r.status);
  }

  // The latest status per OTHER agent for a test since `sinceTime` — cross-check.
  async function latestStatusPerAgent(testId, sinceTime) {
    const [rows] = await pool.query(
      `SELECT r.agent_id, r.status, r.time FROM transaction_results r
        JOIN (SELECT agent_id, MAX(time) AS mt FROM transaction_results WHERE test_id=? AND time >= ? GROUP BY agent_id) last
          ON r.agent_id=last.agent_id AND r.time=last.mt AND r.test_id=?`,
      [testId, sinceTime, testId]
    );
    return rows.map((r) => ({ agent_id: r.agent_id, status: r.status, time: r.time instanceof Date ? r.time.toISOString() : r.time }));
  }

  // --- Baselines (MAD) ---

  async function getBaseline(testId, agentId, step) {
    const [rows] = await pool.query('SELECT median_ms, mad_ms, sample_count FROM transaction_baselines WHERE test_id=? AND agent_id=? AND step=?', [testId, agentId, step]);
    return rows[0] ? { median_ms: rows[0].median_ms, mad_ms: rows[0].mad_ms, sample_count: rows[0].sample_count } : null;
  }

  async function upsertBaseline({ test_id, agent_id, step, median_ms, mad_ms, sample_count }) {
    await pool.query(
      `INSERT INTO transaction_baselines (test_id,agent_id,step,median_ms,mad_ms,sample_count)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE median_ms=VALUES(median_ms), mad_ms=VALUES(mad_ms), sample_count=VALUES(sample_count)`,
      [test_id, agent_id, step, median_ms, mad_ms, sample_count]
    );
  }

  // All (test, agent) pairs that have assignments — the baseline job iterates these.
  async function assignedPairs() {
    const [rows] = await pool.query('SELECT test_id, agent_id FROM transaction_test_agents');
    return rows.map((r) => ({ test_id: r.test_id, agent_id: r.agent_id }));
  }

  // ok results (latency + per-step timings) for one pair over a window — feeds the
  // baseline recompute. Reuses median()/mad() from the analysis module.
  async function okResultsSince({ testId, agentId, since, limit = 5000 }) {
    const lim = Number.isInteger(limit) && limit > 0 && limit <= 20000 ? limit : 5000;
    const [rows] = await pool.query(
      'SELECT latency_ms, step_timings FROM transaction_results WHERE test_id=? AND agent_id=? AND status=? AND time >= ? ORDER BY time DESC LIMIT ?',
      [testId, agentId, 'ok', since, lim]
    );
    return rows.map((r) => ({ latency_ms: r.latency_ms, step_timings: parseJson(r.step_timings, null) }));
  }

  return {
    list, findById, findByIdWithSecrets, create, update, remove,
    agentsFor, setAgents, testsForAgent, assignedTestIds,
    insertResults, results, heatmap, trend, recentStatuses, latestStatusPerAgent,
    getBaseline, upsertBaseline, assignedPairs, okResultsSince,
    // exposed for the baseline job (no duplication of stats)
    _median: median, _mad: mad,
  };
}

module.exports = { createTransactionsRepository };
