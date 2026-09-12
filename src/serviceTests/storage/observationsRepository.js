'use strict';

const { parseJson, numOrNull, intOrNull } = require('./shape');

// Data-access for `service_observations` (migration 089).
//
// An observation is one typed fact a run produced. `observe/observations.js`
// derives them; this stores and reads them back, and nothing else in this file
// has an opinion about what they mean.
//
// Two decisions worth knowing about:
//
//   * Writes are batched into ONE statement. A journey with forty API calls
//     produces sixty-odd observations, and sixty round trips per run would make
//     the worker slower than the browser it is driving.
//   * `unknown` is stored, not filtered out. It is the reason the correlation
//     engine can say "the network was fine" and mean it — dropping the facts
//     nobody looked at would make an incomplete picture indistinguishable from
//     a complete one.
function createObservationsRepository({ db, now = () => new Date() }) {
  const { pool } = db;
  const COLS = `id,run_id,test_id,journey_id,application_id,environment_id,layer,kind,subject,
    outcome,value,unit,summary,detail,observed_at,created_at`;

  // The column is ENUM — an unknown layer would be silently coerced to '' by a
  // non-strict server, or rejected by a strict one mid-batch. Neither is worth
  // risking for a typo, so anything unrecognised lands in `application`, which
  // is what the pure module defaults to as well.
  const LAYERS = ['browser', 'page', 'api', 'application', 'server', 'network', 'infrastructure', 'assurance'];
  const OUTCOMES = ['ok', 'bad', 'unknown'];

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      run_id: row.run_id,
      test_id: row.test_id,
      journey_id: row.journey_id,
      application_id: row.application_id,
      environment_id: row.environment_id,
      layer: row.layer,
      kind: row.kind,
      subject: row.subject,
      outcome: row.outcome,
      // numOrNull, not Number(): a measurement nobody took must never read back
      // as a measurement of zero.
      value: numOrNull(row.value),
      unit: row.unit,
      summary: row.summary,
      detail: parseJson(row.detail, null),
      observed_at: row.observed_at,
      created_at: row.created_at,
    };
  }

  // Everything one run observed, written in a single statement.
  //
  // Returns the number written. A run whose observations fail to store still
  // has its real result — the caller is expected to treat that as a warning,
  // not as a failed run.
  async function recordMany(context, observations) {
    const ctx = (context && typeof context === 'object') ? context : {};
    const list = (Array.isArray(observations) ? observations : []).filter((o) => o && typeof o === 'object');
    if (!list.length) return 0;

    const at = now();
    const values = [];
    const rows = [];
    for (const o of list) {
      rows.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      values.push(
        intOrNull(ctx.run_id), intOrNull(ctx.test_id), intOrNull(ctx.journey_id),
        intOrNull(ctx.application_id), intOrNull(ctx.environment_id),
        LAYERS.includes(o.layer) ? o.layer : 'application',
        String(o.kind || 'unknown').slice(0, 64),
        o.subject === null || o.subject === undefined ? null : String(o.subject).slice(0, 512),
        OUTCOMES.includes(o.outcome) ? o.outcome : 'unknown',
        numOrNull(o.value),
        o.unit === null || o.unit === undefined ? null : String(o.unit).slice(0, 32),
        o.summary === null || o.summary === undefined ? null : String(o.summary).slice(0, 512),
        o.detail ? JSON.stringify(o.detail) : null,
        // The observation's own time when it has one. A run that took four
        // minutes produced facts across four minutes, and stamping them all
        // with the write time would make the timeline a record of the database.
        o.observed_at instanceof Date ? o.observed_at : at,
      );
    }

    const [res] = await pool.query(
      `INSERT INTO service_observations
         (run_id, test_id, journey_id, application_id, environment_id, layer, kind, subject,
          outcome, value, unit, summary, detail, observed_at)
       VALUES ${rows.join(', ')}`,
      values
    );
    return res.affectedRows;
  }

  async function forRun(runId) {
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_observations WHERE run_id = ? ORDER BY observed_at, id`,
      [intOrNull(runId)]
    );
    return rows.map(shape);
  }

  // Observations across an application in a window — what the health and
  // dependency screens read. Capped hard: this table is the highest-volume one
  // in the module, and an unbounded read of it is a page that never loads.
  async function list({ applicationId = null, testId = null, layer = null, outcome = null,
    since = null, limit = 500 } = {}) {
    const capped = Math.min(2000, Math.max(1, Number(limit) || 500));
    const where = [];
    const params = [];
    if (applicationId !== null) { where.push('application_id = ?'); params.push(intOrNull(applicationId)); }
    if (testId !== null) { where.push('test_id = ?'); params.push(intOrNull(testId)); }
    if (layer !== null) { where.push('layer = ?'); params.push(layer); }
    if (outcome !== null) { where.push('outcome = ?'); params.push(outcome); }
    if (since !== null) { where.push('observed_at >= ?'); params.push(since); }
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_observations
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY observed_at DESC, id DESC LIMIT ${capped}`,
      params
    );
    return rows.map(shape);
  }

  // Retention. Observations are the module's growth risk: one row per API call
  // per run, forever, is a table that outgrows everything else in the database.
  async function purgeOlderThan(days) {
    // A missing or nonsensical window falls back to the shipped default rather
    // than to zero — getting this wrong deletes the evidence the moment it is
    // written.
    const window = Number(days) > 0 ? Number(days) : 30;
    const cutoff = new Date(now().getTime() - window * 86400000);
    const [res] = await pool.query('DELETE FROM service_observations WHERE observed_at < ?', [cutoff]);
    return res.affectedRows;
  }

  return { recordMany, forRun, list, purgeOlderThan, shape };
}

module.exports = { createObservationsRepository };
