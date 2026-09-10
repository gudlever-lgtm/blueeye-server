'use strict';

const { intOrNull } = require('./shape');

// Data-access for `service_test_credentials` (migration 078).
//
// The password is AES-256-GCM encrypted at rest via the injected secretBox and
// is NEVER returned by list()/findById(). Only findByIdWithSecret() decrypts,
// and only the worker calls it, at execution time. That asymmetry is the whole
// point of the file: there is no code path where an API response, a log line or
// a screenshot can pick up a plaintext password by accident
// (docs/service-tests.md §6).
function createCredentialsRepository({ db, secretBox = null }) {
  const { pool } = db;
  const COLS = 'id,tenant_id,application_id,label,username,secret_encrypted,created_by,created_at,updated_at';

  // The safe shape: reports WHETHER a secret is stored, never what it is.
  function shape(row) {
    if (!row) return null;
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      application_id: row.application_id,
      label: row.label,
      username: row.username,
      has_secret: !!row.secret_encrypted,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  const encrypt = (plaintext) => {
    if (plaintext === null || plaintext === undefined || plaintext === '') return null;
    return secretBox ? secretBox.encrypt(plaintext) : String(plaintext);
  };

  async function list({ applicationId = null } = {}) {
    if (applicationId === null) {
      const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_credentials ORDER BY application_id, label`);
      return rows.map(shape);
    }
    const [rows] = await pool.query(
      `SELECT ${COLS} FROM service_test_credentials WHERE application_id = ? ORDER BY label`,
      [applicationId]
    );
    return rows.map(shape);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_credentials WHERE id = ?`, [id]);
    return shape(rows[0]);
  }

  // The ONLY path that returns plaintext. Worker-only. A decrypt failure (a
  // rotated key, a tampered row) yields null rather than a wrong value — the run
  // then fails with "credential unavailable", which is the honest outcome.
  async function findByIdWithSecret(id) {
    const [rows] = await pool.query(`SELECT ${COLS} FROM service_test_credentials WHERE id = ?`, [id]);
    const row = rows[0];
    if (!row) return null;
    let secret = null;
    if (row.secret_encrypted) {
      if (!secretBox) secret = row.secret_encrypted;
      else { try { secret = secretBox.decrypt(row.secret_encrypted); } catch { secret = null; } }
    }
    return { ...shape(row), username: row.username, secret };
  }

  async function create(input) {
    const [res] = await pool.query(
      `INSERT INTO service_test_credentials (application_id, label, username, secret_encrypted, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [input.application_id, input.label, input.username ?? null, encrypt(input.secret), intOrNull(input.created_by)]
    );
    return findById(res.insertId);
  }

  // `secret` omitted leaves the stored one untouched; `secret: ''` clears it.
  // That distinction is what lets an operator rename a credential without
  // retyping the password.
  async function update(id, input) {
    const sets = [];
    const params = [];
    for (const field of ['label', 'username']) {
      if (input[field] !== undefined) { sets.push(`${field} = ?`); params.push(input[field]); }
    }
    if (input.secret !== undefined) { sets.push('secret_encrypted = ?'); params.push(encrypt(input.secret)); }
    if (!sets.length) return findById(id);
    params.push(id);
    await pool.query(`UPDATE service_test_credentials SET ${sets.join(', ')} WHERE id = ?`, params);
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM service_test_credentials WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  return { list, findById, findByIdWithSecret, create, update, remove };
}

module.exports = { createCredentialsRepository };
