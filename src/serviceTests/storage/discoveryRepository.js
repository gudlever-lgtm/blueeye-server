'use strict';

const { parseJson, bool, intOrNull } = require('./shape');

// Data-access for `service_test_discoveries` + `_discovery_pages` +
// `_discovery_elements` (migration 078).
//
// A discovery is queued the same way a run is, and claimed with the same
// conditional UPDATE, so the browser work happens on the worker rather than in
// an Express request. Results are stored, never overwritten: re-running discovery
// creates a NEW row, so previous findings and the tests derived from them stay
// intact (spec §37).
function createDiscoveryRepository({ db, now = () => new Date() }) {
  const { pool } = db;
  const COLS = `id,tenant_id,application_id,environment_id,status,scope_url,budgets,page_count,form_count,
    element_count,request_count,login_count,detected_login,login_test_id,credential_id,authenticated,
    authenticated_page_count,session_lost_at_page,auth_note,error_message,started_at,ended_at,claimed_by,claimed_at,
    requested_by,created_at,updated_at`;

  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      application_id: row.application_id,
      environment_id: row.environment_id,
      status: row.status,
      scope_url: row.scope_url,
      budgets: parseJson(row.budgets, {}),
      page_count: row.page_count,
      form_count: row.form_count,
      element_count: row.element_count,
      request_count: row.request_count,
      login_count: row.login_count,
      // Field descriptions only — never a value and never a credential.
      detected_login: parseJson(row.detected_login, null),
      login_test_id: row.login_test_id ?? null,
      credential_id: row.credential_id ?? null,
      // Whether it got IN, not whether it was asked to. A discovery that
      // requested a sign-in and could not must never read as a private-site map.
      authenticated: row.authenticated === 1 || row.authenticated === true,
      authenticated_page_count: row.authenticated_page_count ?? 0,
      session_lost_at_page: row.session_lost_at_page ?? null,
      auth_note: row.auth_note ?? null,
      error_message: row.error_message,
      started_at: row.started_at,
      ended_at: row.ended_at,
      claimed_by: row.claimed_by,
      claimed_at: row.claimed_at,
      requested_by: row.requested_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_discoveries WHERE id = ?`, [id]);
    return shape(rows[0]);
  }

  async function list({ applicationId = null, limit = 20 } = {}) {
    const capped = Math.min(200, Math.max(1, Number(limit) || 20));
    const [rows] = applicationId === null
      ? await pool.query(`SELECT ${COLS} FROM service_test_discoveries ORDER BY created_at DESC, id DESC LIMIT ?`, [capped])
      : await pool.query(
        `SELECT ${COLS} FROM service_test_discoveries WHERE application_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        [applicationId, capped]
      );
    return rows.map(shape);
  }

  // The most recent completed discovery for an application — what the
  // "Last discovery: … / Pages: … / Forms: …" panel reads.
  async function latestForApplication(applicationId) {
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_discoveries
       WHERE application_id = ? AND status = 'complete' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [applicationId]
    );
    return shape(rows[0]);
  }

  async function enqueue(input) {
    const [res] = await pool.query(
      `INSERT INTO service_test_discoveries
         (application_id, environment_id, scope_url, budgets, status, login_test_id, credential_id, requested_by)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      [input.application_id, intOrNull(input.environment_id), input.scope_url,
        JSON.stringify(input.budgets || {}),
        intOrNull(input.login_test_id), intOrNull(input.credential_id),
        intOrNull(input.requested_by)]
    );
    return findById(res.insertId);
  }

  // Same atomic-claim contract as runsRepository.claimNext().
  async function claimNext(workerId) {
    const [candidates] = await pool.query(
      "SELECT id FROM service_test_discoveries WHERE status = 'queued' ORDER BY created_at, id LIMIT 1"
    );
    if (!candidates[0]) return null;
    const id = candidates[0].id;
    const at = now();
    const [res] = await pool.query(
      `UPDATE service_test_discoveries SET status = 'running', claimed_by = ?, claimed_at = ?, started_at = ?
       WHERE id = ? AND status = 'queued'`,
      [String(workerId).slice(0, 120), at, at, id]
    );
    if (!res.affectedRows) return null;
    return findById(id);
  }

  async function addPage(discoveryId, page) {
    const [res] = await pool.query(
      `INSERT INTO service_test_discovery_pages
        (discovery_id, url, title, http_status, redirected_to, depth, load_ms, console_errors, failed_requests)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [discoveryId, page.url, page.title ?? null, intOrNull(page.http_status), page.redirected_to ?? null,
        intOrNull(page.depth) ?? 0, intOrNull(page.load_ms),
        JSON.stringify(page.console_errors || []), JSON.stringify(page.failed_requests || [])]
    );
    return res.insertId;
  }

  async function addElements(discoveryId, elements) {
    for (const e of elements || []) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO service_test_discovery_elements
          (discovery_id, page_id, kind, label, attributes, possible_login, potentially_destructive)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [discoveryId, intOrNull(e.page_id), e.kind, e.label ?? null, JSON.stringify(e.attributes || {}),
          e.possible_login ? 1 : 0, e.potentially_destructive ? 1 : 0]
      );
    }
    return (elements || []).length;
  }

  async function pages(discoveryId) {
    const [rows] = await pool.query(
      `SELECT id,discovery_id,url,title,http_status,redirected_to,depth,load_ms,console_errors,failed_requests
       FROM service_test_discovery_pages WHERE discovery_id = ? ORDER BY id`,
      [discoveryId]
    );
    return rows.map((r) => ({
      ...r,
      console_errors: parseJson(r.console_errors, []),
      failed_requests: parseJson(r.failed_requests, []),
    }));
  }

  async function elements(discoveryId, { kind = null } = {}) {
    const [rows] = kind === null
      ? await pool.query(
        `SELECT id,discovery_id,page_id,kind,label,attributes,possible_login,potentially_destructive
         FROM service_test_discovery_elements WHERE discovery_id = ? ORDER BY id`, [discoveryId]
      )
      : await pool.query(
        `SELECT id,discovery_id,page_id,kind,label,attributes,possible_login,potentially_destructive
         FROM service_test_discovery_elements WHERE discovery_id = ? AND kind = ? ORDER BY id`, [discoveryId, kind]
      );
    return rows.map((r) => ({
      ...r,
      attributes: parseJson(r.attributes, {}),
      possible_login: bool(r.possible_login),
      potentially_destructive: bool(r.potentially_destructive),
    }));
  }

  async function finish(id, summary) {
    await pool.query(
      `UPDATE service_test_discoveries
         SET status = ?, ended_at = ?, page_count = ?, form_count = ?, element_count = ?,
             request_count = ?, login_count = ?, detected_login = ?,
             login_test_id = ?, credential_id = ?, authenticated = ?,
             authenticated_page_count = ?, session_lost_at_page = ?, auth_note = ?,
             error_message = ?
       WHERE id = ?`,
      [summary.status || 'complete', summary.ended_at || now(), intOrNull(summary.page_count) ?? 0,
        intOrNull(summary.form_count) ?? 0, intOrNull(summary.element_count) ?? 0,
        intOrNull(summary.request_count) ?? 0, intOrNull(summary.login_count) ?? 0,
        summary.detected_login ? JSON.stringify(summary.detected_login) : null,
        intOrNull(summary.login_test_id), intOrNull(summary.credential_id),
        summary.authenticated ? 1 : 0,
        intOrNull(summary.authenticated_page_count) ?? 0,
        intOrNull(summary.session_lost_at_page),
        summary.auth_note ?? null,
        summary.error_message ?? null, id]
    );
    return findById(id);
  }

  // The login form the last COMPLETED discovery of this application found.
  //
  // This is what lets a rediscover sign in with nothing but a stored credential:
  // the anonymous pass found the door, and this is how the next one opens it.
  // The most recent wins — a site that moved its login has moved it, and the
  // older detection is wrong rather than merely older.
  async function lastDetectedLogin(applicationId) {
    const [rows] = await pool.query(
      `SELECT detected_login FROM service_test_discoveries
        WHERE application_id = ? AND status = 'complete' AND detected_login IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      [intOrNull(applicationId)]
    );
    return rows.length ? parseJson(rows[0].detected_login, null) : null;
  }

  async function reapStale(claimTimeoutMs) {
    const cutoff = new Date(now().getTime() - claimTimeoutMs);
    const [res] = await pool.query(
      `UPDATE service_test_discoveries
         SET status = 'failed', ended_at = ?, error_message = 'Discovery abandoned: the worker stopped responding'
       WHERE status = 'running' AND claimed_at IS NOT NULL AND claimed_at < ?`,
      [now(), cutoff]
    );
    return res.affectedRows;
  }

  return {
    findById, list, latestForApplication, enqueue, claimNext,
    addPage, addElements, pages, elements, finish, reapStale, lastDetectedLogin,
  };
}

module.exports = { createDiscoveryRepository };
