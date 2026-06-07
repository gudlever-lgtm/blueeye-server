'use strict';

// Data-access for the single-row `agent_release_key`. The private key is stored as
// an opaque secret-box token (private_pem_encrypted); the safe status read omits it,
// and only getWithSecret() returns it — for the release signer, which decrypts it in
// memory to sign. The key is write-once (create() refuses when one exists) and
// deletable (remove()).
const SAFE_COLUMNS = 'id, public_pem, fingerprint, created_by, created_at';

function createAgentReleaseKeyRepository(db) {
  const { pool } = db;

  // Safe status view (NO private key), or null when none is stored.
  async function get() {
    const [rows] = await pool.query(`SELECT ${SAFE_COLUMNS} FROM agent_release_key ORDER BY id LIMIT 1`);
    return rows[0] ?? null;
  }

  // Includes the encrypted private key — internal use only (the release signer).
  async function getWithSecret() {
    const [rows] = await pool.query(`SELECT ${SAFE_COLUMNS}, private_pem_encrypted FROM agent_release_key ORDER BY id LIMIT 1`);
    return rows[0] ?? null;
  }

  // Insert the single key row. Throws (code 'EXISTS') when one already exists — the
  // key is write-once. The UNIQUE singleton column is the backstop against a race.
  async function create({ publicPem, privatePemEncrypted, fingerprint, createdBy = null }) {
    if (await get()) { const e = new Error('A release signing key already exists'); e.code = 'EXISTS'; throw e; }
    try {
      await pool.query(
        `INSERT INTO agent_release_key (singleton, public_pem, private_pem_encrypted, fingerprint, created_by)
         VALUES (1, ?, ?, ?, ?)`,
        [publicPem, privatePemEncrypted, fingerprint, createdBy]
      );
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') { const e = new Error('A release signing key already exists'); e.code = 'EXISTS'; throw e; }
      throw err;
    }
    return get();
  }

  // Delete the key (all rows). Returns how many were removed.
  async function remove() {
    const [res] = await pool.query('DELETE FROM agent_release_key');
    return res && typeof res.affectedRows === 'number' ? res.affectedRows : 0;
  }

  return { get, getWithSecret, create, remove };
}

module.exports = { createAgentReleaseKeyRepository };
