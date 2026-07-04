'use strict';

// Repository for transaction tests and their results.
// Secrets are stored in the `secrets` column but NEVER included in any
// returned object — callers receive `secret_names` (array of key names) only.
function createTransactionTestsRepo({ db }) {
  function parseRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : (row.steps || []),
      // secrets intentionally omitted
      secret_names: typeof row.secret_names === 'string' ? JSON.parse(row.secret_names) : (row.secret_names || []),
      agents: typeof row.agents === 'string' ? JSON.parse(row.agents) : (row.agents || ['all']),
      enabled: !!row.enabled,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function parseResultRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      test_id: row.test_id,
      agent_id: row.agent_id,
      ran_at: row.ran_at,
      status: row.status,
      duration_ms: row.duration_ms,
      steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : (row.steps || null),
      error_detail: typeof row.error_detail === 'string' ? JSON.parse(row.error_detail) : (row.error_detail || null),
    };
  }

  async function findAll() {
    const [rows] = await db.query(
      'SELECT id,name,type,steps,secret_names,agents,enabled,created_at,updated_at FROM transaction_tests ORDER BY name'
    );
    return rows.map(parseRow);
  }

  async function findById(id) {
    const [rows] = await db.query(
      'SELECT id,name,type,steps,secret_names,agents,enabled,created_at,updated_at FROM transaction_tests WHERE id=?',
      [id]
    );
    return parseRow(rows[0] || null);
  }

  // Used internally (by the agent result ingest path) to resolve steps+secrets.
  async function findByIdWithSecrets(id) {
    const [rows] = await db.query(
      'SELECT * FROM transaction_tests WHERE id=?',
      [id]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...parseRow(row),
      secrets: typeof row.secrets === 'string' ? JSON.parse(row.secrets) : (row.secrets || {}),
    };
  }

  async function create({ name, type = 'http', steps = [], secrets = {}, agents = ['all'], enabled = true }) {
    const secretNames = Object.keys(secrets);
    const [result] = await db.query(
      'INSERT INTO transaction_tests (name,type,steps,secrets,secret_names,agents,enabled) VALUES (?,?,?,?,?,?,?)',
      [name, type, JSON.stringify(steps), JSON.stringify(secrets), JSON.stringify(secretNames), JSON.stringify(agents), enabled ? 1 : 0]
    );
    return findById(result.insertId);
  }

  async function update(id, { name, type, steps, secrets, agents, enabled }) {
    const existing = await findById(id);
    if (!existing) return null;
    // Only replace secrets when caller explicitly provides a non-empty object.
    // An omitted / null secrets field means "keep what's stored".
    let secretsVal = null;
    let secretNamesVal = null;
    if (secrets && typeof secrets === 'object' && Object.keys(secrets).length > 0) {
      secretsVal = JSON.stringify(secrets);
      secretNamesVal = JSON.stringify(Object.keys(secrets));
    } else {
      // Re-read raw secrets to preserve them
      const [rows] = await db.query('SELECT secrets, secret_names FROM transaction_tests WHERE id=?', [id]);
      if (rows[0]) {
        secretsVal = typeof rows[0].secrets === 'string' ? rows[0].secrets : JSON.stringify(rows[0].secrets || {});
        secretNamesVal = typeof rows[0].secret_names === 'string' ? rows[0].secret_names : JSON.stringify(rows[0].secret_names || []);
      }
    }
    await db.query(
      'UPDATE transaction_tests SET name=?,type=?,steps=?,secrets=?,secret_names=?,agents=?,enabled=?,updated_at=NOW() WHERE id=?',
      [
        name ?? existing.name,
        type ?? existing.type,
        JSON.stringify(steps ?? existing.steps),
        secretsVal,
        secretNamesVal,
        JSON.stringify(agents ?? existing.agents),
        (enabled !== undefined ? enabled : existing.enabled) ? 1 : 0,
        id,
      ]
    );
    return findById(id);
  }

  async function remove(id) {
    const [result] = await db.query('DELETE FROM transaction_tests WHERE id=?', [id]);
    return result.affectedRows > 0;
  }

  async function saveResult({ test_id, agent_id, ran_at, status, duration_ms, steps, error_detail }) {
    const [result] = await db.query(
      'INSERT INTO transaction_test_results (test_id,agent_id,ran_at,status,duration_ms,steps,error_detail) VALUES (?,?,?,?,?,?,?)',
      [test_id, agent_id, ran_at || new Date(), status, duration_ms ?? null, steps ? JSON.stringify(steps) : null, error_detail ? JSON.stringify(error_detail) : null]
    );
    return result.insertId;
  }

  // Latest result per (test_id, agent_id) for the matrix view.
  async function latestPerTestAgent() {
    const [rows] = await db.query(`
      SELECT r.test_id, r.agent_id, r.ran_at, r.status, r.duration_ms, r.error_detail
      FROM transaction_test_results r
      INNER JOIN (
        SELECT test_id, agent_id, MAX(ran_at) AS max_ran
        FROM transaction_test_results
        GROUP BY test_id, agent_id
      ) latest ON r.test_id=latest.test_id AND r.agent_id=latest.agent_id AND r.ran_at=latest.max_ran
    `);
    return rows.map(parseResultRow);
  }

  // Median duration per (test_id, agent_id) over last 30 days for deviation calc.
  async function medianDurationsPerTestAgent() {
    const [rows] = await db.query(`
      SELECT test_id, agent_id,
        AVG(duration_ms) AS avg_ms,
        MIN(duration_ms) AS min_ms,
        MAX(duration_ms) AS max_ms,
        COUNT(*) AS sample_count
      FROM transaction_test_results
      WHERE ran_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        AND status = 'ok'
        AND duration_ms IS NOT NULL
      GROUP BY test_id, agent_id
    `);
    return rows;
  }

  // Heatmap: time-bucket × agent aggregates for one test.
  // bucket: '5m' | '15m' | '1h'
  async function heatmapBuckets({ test_id, bucket = '5m', hours = 24 }) {
    const bucketSeconds = bucket === '1h' ? 3600 : (bucket === '15m' ? 900 : 300);
    const [rows] = await db.query(`
      SELECT
        agent_id,
        FLOOR(UNIX_TIMESTAMP(ran_at) / ?) AS bucket,
        AVG(duration_ms) AS avg_latency,
        SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS fails,
        COUNT(*) AS samples
      FROM transaction_test_results
      WHERE test_id = ?
        AND ran_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      GROUP BY agent_id, bucket
      ORDER BY bucket
    `, [bucketSeconds, test_id, hours]);
    return rows;
  }

  // Trend: per-step, per-day average duration for a test.
  async function stepTrend({ test_id, days = 7 }) {
    const [rows] = await db.query(`
      SELECT
        DATE(ran_at) AS day,
        agent_id,
        steps
      FROM transaction_test_results
      WHERE test_id = ?
        AND ran_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        AND status = 'ok'
        AND steps IS NOT NULL
      ORDER BY ran_at
    `, [test_id, days]);
    return rows.map((r) => ({
      day: r.day,
      agent_id: r.agent_id,
      steps: typeof r.steps === 'string' ? JSON.parse(r.steps) : (r.steps || []),
    }));
  }

  // Recent results for a test (for the detail/diagnosis view).
  async function findResults({ test_id, limit = 50 }) {
    const [rows] = await db.query(
      'SELECT * FROM transaction_test_results WHERE test_id=? ORDER BY ran_at DESC LIMIT ?',
      [test_id, limit]
    );
    return rows.map(parseResultRow);
  }

  return {
    findAll,
    findById,
    findByIdWithSecrets,
    create,
    update,
    remove,
    saveResult,
    latestPerTestAgent,
    medianDurationsPerTestAgent,
    heatmapBuckets,
    stepTrend,
    findResults,
  };
}

module.exports = { createTransactionTestsRepo };
