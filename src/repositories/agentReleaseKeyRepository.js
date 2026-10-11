'use strict';

// Data-access for `agent_release_key` — one row per signing PURPOSE.
//
// Two purposes (migration 148): `release` signs the agent releases a fleet
// installs, `command` signs the privileged commands it obeys. One key doing both
// means a compromise of it yields both, and the two want opposite handling — a
// release key is used on a build step a few times a month, a command key every
// time an operator presses Update.
//
// The private key is stored as an opaque secret-box token
// (private_pem_encrypted); the safe status read omits it, and only
// getWithSecret() returns it — for the signer, which decrypts it in memory. Each
// purpose is write-once (create() refuses when one exists for that purpose) and
// deletable.
//
// NULL purpose reads as `release`. The row that existed before migration 148 IS
// the release key, so NULL is the honest value for it rather than a backfill
// pretending it was always labelled.
const SAFE_COLUMNS = 'id, purpose, public_pem, fingerprint, created_by, created_at';

const PURPOSES = ['release', 'command'];

// The WHERE fragment for one purpose, plus its params. `release` also matches
// the unlabelled legacy row.
function purposeWhere(purpose) {
  const p = PURPOSES.includes(purpose) ? purpose : 'release';
  return p === 'release'
    ? { sql: "(purpose = 'release' OR purpose IS NULL)", params: [] }
    : { sql: 'purpose = ?', params: [p] };
}

function createAgentReleaseKeyRepository(db) {
  const { pool } = db;

  // Safe status view (NO private key) for one purpose, or null when none is
  // stored.
  async function get(purpose = 'release') {
    const w = purposeWhere(purpose);
    const [rows] = await pool.query(
      `SELECT ${SAFE_COLUMNS} FROM agent_release_key WHERE ${w.sql} ORDER BY id LIMIT 1`,
      w.params
    );
    return rows[0] ?? null;
  }

  // Includes the encrypted private key — internal use only (the signer).
  async function getWithSecret(purpose = 'release') {
    const w = purposeWhere(purpose);
    const [rows] = await pool.query(
      `SELECT ${SAFE_COLUMNS}, private_pem_encrypted FROM agent_release_key WHERE ${w.sql} ORDER BY id LIMIT 1`,
      w.params
    );
    return rows[0] ?? null;
  }

  // Insert the key row for one purpose. Throws (code 'EXISTS') when one already
  // exists — a key is write-once. The UNIQUE (singleton, purpose) index is the
  // backstop against a race.
  async function create({ publicPem, privatePemEncrypted, fingerprint, createdBy = null, purpose = 'release' }) {
    const p = PURPOSES.includes(purpose) ? purpose : 'release';
    if (await get(p)) { const e = new Error(`A ${p} signing key already exists`); e.code = 'EXISTS'; throw e; }
    try {
      // The purpose is written EXPLICITLY, never left to a default: MySQL treats
      // NULLs as distinct in a unique index, so an unlabelled row and an
      // explicit 'release' row would both be allowed and the write-once
      // guarantee would quietly stop holding.
      await pool.query(
        `INSERT INTO agent_release_key (singleton, purpose, public_pem, private_pem_encrypted, fingerprint, created_by)
         VALUES (1, ?, ?, ?, ?, ?)`,
        [p, publicPem, privatePemEncrypted, fingerprint, createdBy]
      );
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') { const e = new Error(`A ${p} signing key already exists`); e.code = 'EXISTS'; throw e; }
      throw err;
    }
    return get(p);
  }

  // Delete the key of one purpose. Returns how many rows were removed.
  async function remove(purpose = 'release') {
    const w = purposeWhere(purpose);
    const [res] = await pool.query(`DELETE FROM agent_release_key WHERE ${w.sql}`, w.params);
    return res && typeof res.affectedRows === 'number' ? res.affectedRows : 0;
  }

  return { get, getWithSecret, create, remove, PURPOSES };
}

module.exports = { createAgentReleaseKeyRepository, PURPOSES };
