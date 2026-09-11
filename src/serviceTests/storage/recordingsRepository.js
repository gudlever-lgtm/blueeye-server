'use strict';

const crypto = require('crypto');

// Data-access for `service_test_recordings` (migration 082).
//
// A recording is scaffolding between "start recording" and "save as a test". The
// capture token is never stored — only its SHA-256 — so a leak of this table
// yields a hash of a credential that has already expired. Same reasoning as a
// password column, for the same reason.
function createRecordingsRepository({ db, now = () => new Date() }) {
  const { pool } = db;
  const COLS = `id, application_id, name, status, events, event_count, base_url,
    created_test_id, created_by, expires_at, last_event_at, created_at, updated_at`;
  const R_COLS = COLS.split(',').map((c) => `r.${c.trim()}`).join(', ');
  // A recording's name is only unique within its application, like a test's, so
  // every read that feeds a list carries the application name — joined, not
  // looked up per row. LEFT, so a recording outlives a deleted application row
  // in the response rather than vanishing from it.
  const WITH_APP = `SELECT ${R_COLS}, a.name AS application_name
    FROM service_test_recordings r
    LEFT JOIN service_test_applications a ON a.id = r.application_id`;

  const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

  function parseJson(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      application_id: row.application_id,
      application_name: row.application_name ?? null,
      name: row.name,
      status: row.status,
      events: parseJson(row.events, []),
      event_count: row.event_count,
      base_url: row.base_url,
      created_test_id: row.created_test_id,
      created_by: row.created_by,
      expires_at: row.expires_at,
      last_event_at: row.last_event_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      // The token is NEVER read back. It is shown once, at creation, and after
      // that only its hash exists — there is nothing here to return.
    };
  }

  async function findById(id) {
    const [rows] = await pool.query(`${WITH_APP} WHERE r.id = ? LIMIT 1`, [id]);
    return shape(rows[0]);
  }

  // Starts a recording and returns { recording, token }. The token is the only
  // time it exists in plaintext anywhere.
  async function start({ applicationId, name, baseUrl = null, createdBy = null, ttlMs = 3600000 }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now().getTime() + Math.max(60000, Number(ttlMs) || 3600000));
    const [res] = await pool.query(
      `INSERT INTO service_test_recordings
         (application_id, name, status, token_hash, events, event_count, base_url, created_by, expires_at)
       VALUES (?, ?, 'recording', ?, ?, 0, ?, ?, ?)`,
      [applicationId, String(name || 'Recorded test').slice(0, 255), hashToken(token),
        JSON.stringify([]), baseUrl ? String(baseUrl).slice(0, 1024) : null, createdBy, expiresAt]
    );
    return { recording: await findById(res.insertId), token };
  }

  // Resolves a recording from its capture token — the ingest path's whole
  // authentication. Compared as HASHES, and only a recording that is still
  // `recording` and not expired can be found: an abandoned session is not a
  // capture endpoint left open on the internet.
  async function findByToken(token) {
    if (!token) return null;
    const [rows] = await pool.query(
      `${WITH_APP} WHERE r.token_hash = ? AND r.status = 'recording' AND r.expires_at > ? LIMIT 1`,
      [hashToken(token), now()]
    );
    return shape(rows[0]);
  }

  // Appends observations. Bounded in the SQL layer as well as above it: a
  // recorder that goes wrong must not be able to grow one JSON column without
  // limit.
  //
  // Read-then-write, not atomic. That is adequate and not a bug waiting to
  // happen, because the only writer is one recorder in one browser tab, which
  // holds a flush in flight before starting the next. Two recorders sharing a
  // token cannot exist — the token names exactly one session.
  async function appendEvents(id, events, { maxEvents = 2000 } = {}) {
    const current = await findById(id);
    if (!current) return null;
    const merged = [...current.events, ...(Array.isArray(events) ? events : [])].slice(-maxEvents);
    await pool.query(
      `UPDATE service_test_recordings SET events = ?, event_count = ?, last_event_at = ?
       WHERE id = ? AND status = 'recording'`,
      [JSON.stringify(merged), merged.length, now(), id]
    );
    return findById(id);
  }

  async function stop(id) {
    await pool.query("UPDATE service_test_recordings SET status = 'stopped' WHERE id = ? AND status = 'recording'", [id]);
    return findById(id);
  }

  // Accepting one is terminal, and it clears the events: the test is the
  // artefact now, and keeping the raw capture would keep a copy of everything
  // the operator typed long after it stopped being useful.
  async function accept(id, testId) {
    await pool.query(
      "UPDATE service_test_recordings SET status = 'accepted', created_test_id = ?, events = ? WHERE id = ?",
      [testId, JSON.stringify([]), id]
    );
    return findById(id);
  }

  async function list({ applicationId = null, status = null, limit = 50 } = {}) {
    const where = [];
    const params = [];
    if (applicationId) { where.push('r.application_id = ?'); params.push(applicationId); }
    if (status) { where.push('r.status = ?'); params.push(status); }
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const [rows] = await pool.query(
      `${WITH_APP}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.created_at DESC LIMIT ${n}`,
      params
    );
    return rows.map(shape);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM service_test_recordings WHERE id = ?', [id]);
    return (res.affectedRows || 0) > 0;
  }

  // Expired sessions carry whatever the operator typed before they wandered off.
  // They are swept rather than kept: nobody is coming back for them.
  async function purgeExpired() {
    const [res] = await pool.query(
      "DELETE FROM service_test_recordings WHERE status = 'recording' AND expires_at < ?",
      [now()]
    );
    return res.affectedRows || 0;
  }

  return { findById, findByToken, start, appendEvents, stop, accept, list, remove, purgeExpired, hashToken };
}

module.exports = { createRecordingsRepository };
