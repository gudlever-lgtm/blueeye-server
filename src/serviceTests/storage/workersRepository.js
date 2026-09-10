'use strict';

// Data-access for `service_test_workers` (migration 079) — the worker heartbeat.
//
// The queue used to infer liveness from the newest claim, which cannot tell a
// worker that is idle from a worker that was never installed. This table answers
// the question directly: a worker writes a row on every poll tick, so it is
// visible before it has ever had work to do.
function createWorkersRepository({ db, now = () => new Date() }) {
  const { pool } = db;
  const COLS = 'worker_id,hostname,version,started_at,last_seen_at';

  function shape(row) {
    if (!row) return null;
    return {
      worker_id: row.worker_id,
      hostname: row.hostname,
      version: row.version,
      started_at: row.started_at,
      last_seen_at: row.last_seen_at,
    };
  }

  // Upsert. started_at is left alone on an update so the UI can show uptime;
  // only a genuinely new worker id starts the clock again.
  async function heartbeat({ workerId, hostname = null, version = null } = {}) {
    const id = String(workerId || '').slice(0, 190);
    if (!id) throw new Error('workersRepository: workerId is required');
    const at = now();
    await pool.query(
      `INSERT INTO service_test_workers (worker_id, hostname, version, started_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE hostname = VALUES(hostname), version = VALUES(version), last_seen_at = VALUES(last_seen_at)`,
      [id, hostname ? String(hostname).slice(0, 255) : null, version ? String(version).slice(0, 64) : null, at, at]
    );
    return id;
  }

  // Workers seen within the window. Ordered newest-seen first so the UI can name
  // one without sorting.
  async function listAlive(withinMs) {
    const cutoff = new Date(now().getTime() - Math.max(1000, Number(withinMs) || 60000));
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_workers WHERE last_seen_at >= ? ORDER BY last_seen_at DESC`,
      [cutoff]
    );
    return rows.map(shape);
  }

  async function list() {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_workers ORDER BY last_seen_at DESC`);
    return rows.map(shape);
  }

  // Drops rows for workers that have been gone a long time — a container that is
  // recreated gets a new id (hostname-pid), so without this the table grows by
  // one row per restart forever.
  async function prune(olderThanMs) {
    const cutoff = new Date(now().getTime() - Math.max(60000, Number(olderThanMs) || 604800000));
    const [res] = await pool.query('DELETE FROM service_test_workers WHERE last_seen_at < ?', [cutoff]);
    return res.affectedRows || 0;
  }

  return { heartbeat, listAlive, list, prune };
}

module.exports = { createWorkersRepository };
