'use strict';

// Data-access for `snmp_credential_profiles` (migration 112).
//
// THE RESOLUTION CHAIN IS THE POINT OF THIS FILE, and it runs on the SERVER:
//
//   1. the device's OWN credential  (snmp_devices.community_encrypted)
//   2. the profile the device names (snmp_devices.credential_profile_id)
//   3. the profile for the device's SITE (location_id)
//   4. the global default profile   (location_id IS NULL)
//   5. nothing — and the device says so rather than quietly polling 'public'
//
// The agent receives ONE credential per device and never learns that profiles
// exist. That is deliberate: the audit's proposal had the agent try profiles in
// order, which is credential spraying — technically identical to an attack,
// harmful against v3 (failed authPriv attempts are security events, and some
// platforms lock the account) and useless against v2c (a wrong community
// usually just times out, so three profiles x 30 s per device per cycle
// collapses the polling before it finds anything).
//
// NOTHING SECRET IS EVER RETURNED by the ordinary reads. `SAFE_COLUMNS` omits
// every encrypted column and the v3 user; the one read that decrypts is named
// so nobody reaches for it absent-mindedly, the same rule
// `snmpDevicesRepository.listForAgentWithSecret` already follows.

const SAFE_COLUMNS = `id, name, location_id, version, v3_auth_proto, v3_priv_proto,
  v3_context, created_at, updated_at`;

const SECRET_COLUMNS = `${SAFE_COLUMNS}, community_encrypted, v3_user,
  v3_auth_key_encrypted, v3_priv_key_encrypted`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// The security level a v3 credential actually has, derived from which keys are
// set rather than stored. A stored level can disagree with the keys; a derived
// one cannot.
function securityLevel({ v3User, authKey, privKey }) {
  if (!v3User) return null;
  if (authKey && privKey) return 'authPriv';
  if (authKey) return 'authNoPriv';
  return 'noAuthNoPriv';
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    locationId: row.location_id == null ? null : Number(row.location_id),
    version: String(row.version),
    // Which protocols, but never the keys. An operator needs to see that a
    // profile is SHA/AES to know it is configured; they never need the secret
    // back, and a route that cannot return it cannot leak it.
    v3AuthProto: row.v3_auth_proto ?? null,
    v3PrivProto: row.v3_priv_proto ?? null,
    v3Context: row.v3_context ?? null,
    // Whether a secret is SET, without saying what it is. The difference
    // between "no community configured" and "a community you cannot see" is
    // the whole of what a UI needs.
    hasCommunity: row.community_encrypted !== undefined
      ? !!row.community_encrypted : undefined,
    v3User: row.v3_user !== undefined ? (row.v3_user ?? null) : undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function createSnmpCredentialProfilesRepository(db, { secretBox = null } = {}) {
  const { pool } = db;

  // The safe listing. `hasCommunity` and the v3 protocols are included because
  // a profile that looks empty and is not is worse than no profile at all.
  async function list() {
    const [rows] = await pool.query(
      `SELECT ${SAFE_COLUMNS},
              community_encrypted IS NOT NULL AND community_encrypted <> '' AS community_encrypted,
              v3_user
         FROM snmp_credential_profiles
        ORDER BY location_id IS NULL DESC, name ASC`,
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${SAFE_COLUMNS},
              community_encrypted IS NOT NULL AND community_encrypted <> '' AS community_encrypted,
              v3_user
         FROM snmp_credential_profiles WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async function findByName(name) {
    const [rows] = await pool.query(
      'SELECT id, name FROM snmp_credential_profiles WHERE name = ? LIMIT 1', [name],
    );
    return rows[0] ? { id: Number(rows[0].id), name: rows[0].name } : null;
  }

  // At most one global default. Enforced here rather than by a unique index,
  // because MySQL treats NULLs as distinct and would happily allow twenty.
  async function findGlobalDefault() {
    const [rows] = await pool.query(
      `SELECT ${SAFE_COLUMNS} FROM snmp_credential_profiles
        WHERE location_id IS NULL ORDER BY id ASC LIMIT 1`,
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  function encryptOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    if (!secretBox) return null;
    return secretBox.encrypt(value);
  }

  async function create(v = {}) {
    const [res] = await pool.query(
      `INSERT INTO snmp_credential_profiles
         (name, location_id, version, community_encrypted, v3_user, v3_auth_proto,
          v3_auth_key_encrypted, v3_priv_proto, v3_priv_key_encrypted, v3_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        v.name, v.locationId ?? null, v.version || '2c',
        encryptOrNull(v.community),
        v.v3User ?? null, v.v3AuthProto ?? null, encryptOrNull(v.v3AuthKey),
        v.v3PrivProto ?? null, encryptOrNull(v.v3PrivKey), v.v3Context ?? null,
      ],
    );
    return findById(res.insertId);
  }

  // Patch semantics, and the same rule the device row follows: a secret that is
  // OMITTED is left alone, an explicit null clears it. Otherwise renaming a
  // profile would silently wipe its credentials.
  async function update(id, patch = {}) {
    const fields = [];
    const params = [];
    const set = (col, val) => { fields.push(`${col} = ?`); params.push(val); };

    if (patch.name !== undefined) set('name', patch.name);
    if (patch.locationId !== undefined) set('location_id', patch.locationId);
    if (patch.version !== undefined) set('version', patch.version);
    if (patch.v3User !== undefined) set('v3_user', patch.v3User);
    if (patch.v3AuthProto !== undefined) set('v3_auth_proto', patch.v3AuthProto);
    if (patch.v3PrivProto !== undefined) set('v3_priv_proto', patch.v3PrivProto);
    if (patch.v3Context !== undefined) set('v3_context', patch.v3Context);
    if (patch.community !== undefined) set('community_encrypted', encryptOrNull(patch.community));
    if (patch.v3AuthKey !== undefined) set('v3_auth_key_encrypted', encryptOrNull(patch.v3AuthKey));
    if (patch.v3PrivKey !== undefined) set('v3_priv_key_encrypted', encryptOrNull(patch.v3PrivKey));
    if (!fields.length) return findById(id);

    params.push(id);
    await pool.query(`UPDATE snmp_credential_profiles SET ${fields.join(', ')} WHERE id = ?`, params);
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM snmp_credential_profiles WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  // How many devices would fall back if this profile went away. An operator
  // deleting a profile should know how many switches stop being polled.
  async function deviceCount(id) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM snmp_devices WHERE credential_profile_id = ?', [id],
    );
    return Number((rows[0] && rows[0].n) || 0);
  }

  // THE ONE READ THAT DECRYPTS. Returns the usable credential for a profile, or
  // null. Named so nobody calls it by accident from a route.
  async function resolveWithSecret(profileId) {
    if (!profileId) return null;
    const [rows] = await pool.query(
      `SELECT ${SECRET_COLUMNS} FROM snmp_credential_profiles WHERE id = ? LIMIT 1`, [profileId],
    );
    const row = rows[0];
    if (!row) return null;

    const dec = (v) => {
      if (!v || !secretBox) return null;
      try { return secretBox.decrypt(v); } catch { return null; }
    };
    const authKey = dec(row.v3_auth_key_encrypted);
    const privKey = dec(row.v3_priv_key_encrypted);
    return {
      profileId: Number(row.id),
      profileName: row.name,
      version: String(row.version),
      community: dec(row.community_encrypted),
      v3User: row.v3_user ?? null,
      v3AuthProto: row.v3_auth_proto ?? null,
      v3AuthKey: authKey,
      v3PrivProto: row.v3_priv_proto ?? null,
      v3PrivKey: privKey,
      v3Context: row.v3_context ?? null,
      securityLevel: securityLevel({ v3User: row.v3_user, authKey, privKey }),
    };
  }

  // The chain, for one device. Returns the profile id to use, or null.
  // Resolution is by ID only — the caller decrypts once it knows which.
  async function resolveProfileIdFor({ profileId = null, locationId = null } = {}) {
    if (profileId) return Number(profileId);
    if (locationId) {
      const [rows] = await pool.query(
        'SELECT id FROM snmp_credential_profiles WHERE location_id = ? ORDER BY id ASC LIMIT 1',
        [locationId],
      );
      if (rows[0]) return Number(rows[0].id);
    }
    const [rows] = await pool.query(
      'SELECT id FROM snmp_credential_profiles WHERE location_id IS NULL ORDER BY id ASC LIMIT 1',
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  return {
    list,
    findById,
    findByName,
    findGlobalDefault,
    create,
    update,
    remove,
    deviceCount,
    resolveWithSecret,
    resolveProfileIdFor,
  };
}

module.exports = {
  createSnmpCredentialProfilesRepository,
  mapRow,
  securityLevel,
  SAFE_COLUMNS,
};
