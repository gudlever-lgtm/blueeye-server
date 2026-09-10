'use strict';

// Data-access for `service_test_certificates` (migration 080) — the current TLS
// certificate on each registered address.
//
// One row per (application, host, port), upserted on every check: this table is
// STATE, not history. What an operator asks is "what is expiring?", and a row
// per poll would answer that only after a GROUP BY, while growing forever.
function createCertificatesRepository({ db, now = () => new Date() }) {
  const { pool } = db;
  const COLS = `id, application_id, environment_id, host, port, url, subject, issuer, serial_number,
    fingerprint, alt_names, valid_from, valid_to, days_remaining, status, error_message, checked_at`;

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      application_id: row.application_id,
      environment_id: row.environment_id,
      host: row.host,
      port: row.port,
      url: row.url,
      subject: row.subject,
      issuer: row.issuer,
      serial_number: row.serial_number,
      fingerprint: row.fingerprint,
      alt_names: row.alt_names ? String(row.alt_names).split(/,\s*/).map((s) => s.replace(/^DNS:/, '')) : [],
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      days_remaining: row.days_remaining,
      status: row.status,
      error_message: row.error_message,
      checked_at: row.checked_at,
    };
  }

  const cut = (v, max) => (v === null || v === undefined ? null : String(v).slice(0, max));

  // Writes the outcome of one check. Returns the shaped row so the caller can
  // hand it straight to the reactor without a second read.
  async function record(applicationId, result) {
    const at = result.checked_at || now();
    const params = [
      applicationId,
      result.environment_id || null,
      cut(result.host, 255),
      Number(result.port) || 443,
      cut(result.url, 1024),
      cut(result.subject, 512),
      cut(result.issuer, 512),
      cut(result.serial_number, 128),
      cut(result.fingerprint, 190),
      cut(result.alt_names, 2000),
      result.valid_from || null,
      result.valid_to || null,
      Number.isFinite(result.days_remaining) ? result.days_remaining : null,
      result.status || 'ok',
      cut(result.error_message, 1000),
      at,
    ];
    await pool.query(
      `INSERT INTO service_test_certificates
         (application_id, environment_id, host, port, url, subject, issuer, serial_number,
          fingerprint, alt_names, valid_from, valid_to, days_remaining, status, error_message, checked_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         environment_id = VALUES(environment_id), url = VALUES(url), subject = VALUES(subject),
         issuer = VALUES(issuer), serial_number = VALUES(serial_number), fingerprint = VALUES(fingerprint),
         alt_names = VALUES(alt_names), valid_from = VALUES(valid_from), valid_to = VALUES(valid_to),
         days_remaining = VALUES(days_remaining), status = VALUES(status),
         error_message = VALUES(error_message), checked_at = VALUES(checked_at)`,
      params
    );
    return findByTarget(applicationId, result.host, Number(result.port) || 443);
  }

  async function findByTarget(applicationId, host, port) {
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_certificates WHERE application_id = ? AND host = ? AND port = ? LIMIT 1`,
      [applicationId, String(host || ''), Number(port) || 443]
    );
    return shape(rows[0]);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_certificates WHERE id = ? LIMIT 1`, [id]);
    return shape(rows[0]);
  }

  // Soonest expiry first: the list is a to-do list, and the thing expiring on
  // Friday belongs at the top of it. Rows with no expiry (unreachable) sort last
  // rather than first, which is what a NULL would otherwise do in MySQL.
  async function list({ applicationId = null, status = null, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (applicationId) { where.push('application_id = ?'); params.push(applicationId); }
    if (status) { where.push('status = ?'); params.push(status); }
    const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_certificates
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY (valid_to IS NULL) ASC, valid_to ASC LIMIT ${n}`,
      params
    );
    return rows.map(shape);
  }

  // Targets that have not been checked within the interval — the poll's work
  // list. A row that has never been checked has a NULL checked_at and is always
  // due.
  async function dueForCheck(intervalMs) {
    const cutoff = new Date(now().getTime() - Math.max(60000, Number(intervalMs) || 3600000));
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_certificates WHERE checked_at IS NULL OR checked_at < ? ORDER BY checked_at IS NOT NULL, checked_at ASC`,
      [cutoff]
    );
    return rows.map(shape);
  }

  // Drops rows for addresses an application no longer has. Called after a sweep
  // with the targets it actually found, so an environment that was deleted (or
  // moved off https) stops appearing in the list.
  async function pruneMissing(applicationId, keptTargets = []) {
    if (!keptTargets.length) {
      const [res] = await pool.query('DELETE FROM service_test_certificates WHERE application_id = ?', [applicationId]);
      return res.affectedRows || 0;
    }
    const placeholders = keptTargets.map(() => '(host = ? AND port = ?)').join(' OR ');
    const params = [applicationId, ...keptTargets.flatMap((t) => [String(t.host), Number(t.port) || 443])];
    const [res] = await pool.query(
      `DELETE FROM service_test_certificates WHERE application_id = ? AND NOT (${placeholders})`,
      params
    );
    return res.affectedRows || 0;
  }

  return { record, findById, findByTarget, list, dueForCheck, pruneMissing };
}

module.exports = { createCertificatesRepository };
