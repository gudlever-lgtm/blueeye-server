'use strict';

// Data-access for `snmp_credential_profiles` — the NAMED SNMP communities
// (migration 112) and the two things they are assigned to (migration 113).
//
// A community is assigned to SITES and to AGENTS, and the two answer different
// questions:
//
//   * a site says WHICH communities are valid on that network. It may have
//     several, in its own order of preference.
//   * an agent says which of them THIS HOST is allowed to speak. That is the
//     access rule, and it is a grant: an agent walks only with a community
//     assigned to it.
//
// THE RESOLUTION CHAIN IS THE POINT OF THIS FILE, and it runs on the SERVER:
//
//   1. the device's OWN credential  (snmp_devices.community_encrypted)
//   2. the community the device names (snmp_devices.credential_profile_id)
//   3. the communities of the device's SITE, in the site's order
//   4. the global default community  (is_global_default)
//   5. nothing — and the device says so rather than quietly polling 'public'
//
// Steps 2-4 are all filtered by the polling agent's grants, and the FIRST
// usable one is what the agent receives. Several communities per site is not
// several attempts per device: the agent still gets exactly ONE credential and
// never learns that others exist. Trying them in order at the agent is
// credential spraying — technically identical to an attack, harmful against v3
// (failed authPriv attempts are security events, and some platforms lock the
// account) and useless against v2c (a wrong community usually just times out,
// so three communities x 30 s per device per cycle collapses the polling before
// it finds anything). More communities assigned makes that worse, not better.
//
// NOTHING SECRET IS EVER RETURNED by the ordinary reads. `SAFE_COLUMNS` omits
// every encrypted column and the v3 user; the one read that decrypts is named
// so nobody reaches for it absent-mindedly, the same rule
// `snmpDevicesRepository.listForAgentWithSecret` already follows.

const SAFE_COLUMNS = `id, name, is_global_default, version, v3_auth_proto, v3_priv_proto,
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

// GROUP_CONCAT comes back as '3,7,7' or NULL. Ordered, de-duplicated and
// numeric, because the site order IS the resolution order and a caller that
// renders it must see the same sequence the resolver walks.
function idList(v) {
  if (v == null || v === '') return [];
  const out = [];
  for (const part of String(v).split(',')) {
    const n = Number(part);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    // "The fallback for every site" is its own column rather than the absence
    // of a site (migration 113). Assigned to no site and default for every site
    // are opposite intentions, and encoding them as the same NULL made one of
    // them unsayable.
    isGlobalDefault: !!row.is_global_default,
    // Filled in by the reads that join them; undefined elsewhere rather than
    // [], so "this shape does not carry assignments" cannot be misread as
    // "assigned to nothing".
    locationIds: row.location_ids === undefined ? undefined : idList(row.location_ids),
    agentIds: row.agent_ids === undefined ? undefined : idList(row.agent_ids),
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

  // The assignments, joined in rather than fetched per row. A GROUP_CONCAT over
  // two small link tables is one query for the whole list; a read per profile is
  // a page that gets slower with every community an admin adds.
  //
  // The site ids come back IN THE SITE'S OWN ORDER (priority, then id), which is
  // the order the resolver walks — so what the UI lists and what a device
  // resolves to cannot disagree.
  const ASSIGNMENT_JOIN = `
    LEFT JOIN (
      SELECT profile_id, GROUP_CONCAT(location_id ORDER BY priority ASC, profile_id ASC) AS location_ids
        FROM snmp_profile_locations GROUP BY profile_id
    ) pl ON pl.profile_id = p.id
    LEFT JOIN (
      SELECT profile_id, GROUP_CONCAT(agent_id ORDER BY agent_id ASC) AS agent_ids
        FROM snmp_profile_agents GROUP BY profile_id
    ) pa ON pa.profile_id = p.id`;

  const SAFE_SELECT = `SELECT ${SAFE_COLUMNS.split(',').map((c) => `p.${c.trim()}`).join(', ')},
           p.community_encrypted IS NOT NULL AND p.community_encrypted <> '' AS community_encrypted,
           p.v3_user, pl.location_ids, pa.agent_ids
      FROM snmp_credential_profiles p ${ASSIGNMENT_JOIN}`;

  // The safe listing. `hasCommunity` and the v3 protocols are included because
  // a profile that looks empty and is not is worse than no profile at all.
  async function list() {
    const [rows] = await pool.query(
      `${SAFE_SELECT} ORDER BY p.is_global_default DESC, p.name ASC`,
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(`${SAFE_SELECT} WHERE p.id = ? LIMIT 1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  // Every community valid at a site, in the site's own order. The Locations
  // screen reads this to answer "what can be polled here", which is a question
  // about the site rather than about any one community.
  async function listForLocation(locationId) {
    const [rows] = await pool.query(
      `${SAFE_SELECT}
         JOIN snmp_profile_locations l ON l.profile_id = p.id AND l.location_id = ?
        ORDER BY l.priority ASC, p.id ASC`,
      [locationId],
    );
    return rows.map(mapRow);
  }

  // Every community THIS AGENT may walk with. An empty array means the agent
  // polls nothing that needs a named credential — which is the default for a
  // newly enrolled agent, and deliberately so.
  async function listForAgent(agentId) {
    const [rows] = await pool.query(
      `${SAFE_SELECT}
         JOIN snmp_profile_agents g ON g.profile_id = p.id AND g.agent_id = ?
        ORDER BY p.is_global_default DESC, p.name ASC`,
      [agentId],
    );
    return rows.map(mapRow);
  }

  async function findByName(name) {
    const [rows] = await pool.query(
      'SELECT id, name FROM snmp_credential_profiles WHERE name = ? LIMIT 1', [name],
    );
    return rows[0] ? { id: Number(rows[0].id), name: rows[0].name } : null;
  }

  // At most one global default. Enforced here rather than by a unique index:
  // a partial index is not something MySQL has, and the rule is "the lowest id
  // wins" rather than "the write fails", so a second one is harmless.
  async function findGlobalDefault() {
    const [rows] = await pool.query(
      `${SAFE_SELECT} WHERE p.is_global_default = 1 ORDER BY p.id ASC LIMIT 1`,
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
         (name, is_global_default, version, community_encrypted, v3_user, v3_auth_proto,
          v3_auth_key_encrypted, v3_priv_proto, v3_priv_key_encrypted, v3_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        v.name, v.isGlobalDefault ? 1 : 0, v.version || '2c',
        encryptOrNull(v.community),
        v.v3User ?? null, v.v3AuthProto ?? null, encryptOrNull(v.v3AuthKey),
        v.v3PrivProto ?? null, encryptOrNull(v.v3PrivKey), v.v3Context ?? null,
      ],
    );
    const id = res.insertId;
    // The assignments are part of creating a community, not a second step: a
    // community that exists and is assigned to nothing polls nothing, and
    // leaving that state behind because the second call failed is worse than
    // not having created it.
    if (v.locationIds !== undefined) await setLocations(id, v.locationIds);
    if (v.agentIds !== undefined) await setAgents(id, v.agentIds);
    return findById(id);
  }

  // Replaces a community's SITE list, in the order given — the array's order IS
  // the site's order of preference, so moving a community up the list changes
  // which one a device at that site resolves to.
  //
  // Delete-then-insert rather than a diff: the list is a handful of rows, and a
  // diff would have to get the reordering right as well as the membership.
  async function setLocations(id, locationIds = []) {
    const ids = [...new Set((Array.isArray(locationIds) ? locationIds : [])
      .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
    await pool.query('DELETE FROM snmp_profile_locations WHERE profile_id = ?', [id]);
    if (!ids.length) return [];
    await pool.query(
      'INSERT INTO snmp_profile_locations (profile_id, location_id, priority) VALUES ?',
      [ids.map((locationId, i) => [id, locationId, i])],
    );
    return ids;
  }

  // Sets a SITE's order of preference across the communities assigned to it.
  //
  // The order lives on the link row rather than on either side, because it is a
  // fact about the site: "at Aarhus, try the core community before the access
  // one". Writing it from the community's side could only ever say where that
  // one community sits, which is half a sentence.
  //
  // `profileIds` must name exactly the communities currently assigned to the
  // site — no more, no fewer. A partial order is one where the rest end up
  // somewhere nobody chose, and "somewhere nobody chose" is what decides which
  // credential a switch is polled with.
  async function setLocationOrder(locationId, profileIds = []) {
    const [rows] = await pool.query(
      'SELECT profile_id FROM snmp_profile_locations WHERE location_id = ?', [locationId],
    );
    const current = rows.map((r) => Number(r.profile_id)).sort((a, b) => a - b);
    const wanted = [...new Set((profileIds || []).map(Number))];
    const check = [...wanted].sort((a, b) => a - b);
    if (check.length !== current.length || check.some((id, i) => id !== current[i])) {
      const err = new Error('the order must name exactly the communities assigned to this site');
      err.code = 'SNMP_ORDER_MISMATCH';
      throw err;
    }
    for (let i = 0; i < wanted.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        'UPDATE snmp_profile_locations SET priority = ? WHERE location_id = ? AND profile_id = ?',
        [i, locationId, wanted[i]],
      );
    }
    return wanted;
  }

  // Replaces a community's AGENT grants. Unordered — an agent either may use it
  // or may not, and there is no preference to express.
  async function setAgents(id, agentIds = []) {
    const ids = [...new Set((Array.isArray(agentIds) ? agentIds : [])
      .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
    await pool.query('DELETE FROM snmp_profile_agents WHERE profile_id = ?', [id]);
    if (!ids.length) return [];
    await pool.query(
      'INSERT INTO snmp_profile_agents (profile_id, agent_id) VALUES ?',
      [ids.map((agentId) => [id, agentId])],
    );
    return ids;
  }

  // Patch semantics, and the same rule the device row follows: a secret that is
  // OMITTED is left alone, an explicit null clears it. Otherwise renaming a
  // profile would silently wipe its credentials.
  async function update(id, patch = {}) {
    const fields = [];
    const params = [];
    const set = (col, val) => { fields.push(`${col} = ?`); params.push(val); };

    if (patch.name !== undefined) set('name', patch.name);
    if (patch.isGlobalDefault !== undefined) set('is_global_default', patch.isGlobalDefault ? 1 : 0);
    if (patch.version !== undefined) set('version', patch.version);
    if (patch.v3User !== undefined) set('v3_user', patch.v3User);
    if (patch.v3AuthProto !== undefined) set('v3_auth_proto', patch.v3AuthProto);
    if (patch.v3PrivProto !== undefined) set('v3_priv_proto', patch.v3PrivProto);
    if (patch.v3Context !== undefined) set('v3_context', patch.v3Context);
    if (patch.community !== undefined) set('community_encrypted', encryptOrNull(patch.community));
    if (patch.v3AuthKey !== undefined) set('v3_auth_key_encrypted', encryptOrNull(patch.v3AuthKey));
    if (patch.v3PrivKey !== undefined) set('v3_priv_key_encrypted', encryptOrNull(patch.v3PrivKey));
    // An OMITTED assignment list leaves the assignments alone, the same rule
    // the secrets follow — otherwise renaming a community would unassign it
    // from every site and agent that uses it.
    if (patch.locationIds !== undefined) await setLocations(id, patch.locationIds);
    if (patch.agentIds !== undefined) await setAgents(id, patch.agentIds);
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
  //
  // It counts the devices that NAME it. Devices that reach it through their
  // site are not counted here, because they fall back to the rest of the site's
  // list — which is the whole reason a site may have more than one.
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

  // THE CHAIN, for one device, as the polling AGENT sees it. Returns
  //
  //   { profileId, source, blocked }
  //
  // where `source` is which step answered and `blocked` names a community that
  // WOULD have answered but is not granted to this agent. The difference
  // matters: "this site has no community" sends an admin to the Locations
  // screen, "this agent may not use the one it has" sends them to the grant,
  // and a device that reports neither reports nothing useful at all.
  //
  // Every step is filtered by the agent's grants, and the FIRST one that
  // survives the filter wins. Only that one is ever sent — the list is an
  // order of preference, not a list of things to try on the wire.
  async function resolveForAgent({ profileId = null, locationId = null, agentId = null } = {}) {
    // No agent means no grant to check against: the device is unassigned and
    // nothing polls it. Answering with a credential here would hand one out on
    // a path that has no agent to hand it to.
    if (!agentId) return { profileId: null, source: null, blocked: null };

    const granted = async (id) => {
      const [rows] = await pool.query(
        'SELECT 1 FROM snmp_profile_agents WHERE profile_id = ? AND agent_id = ? LIMIT 1',
        [id, agentId],
      );
      return rows.length > 0;
    };

    if (profileId) {
      // A device that NAMES a community and whose agent may not use it does not
      // fall through to the site's list. The naming was deliberate and a quiet
      // substitution would poll the switch with a credential nobody chose.
      return (await granted(profileId))
        ? { profileId: Number(profileId), source: 'device', blocked: null }
        : { profileId: null, source: null, blocked: Number(profileId) };
    }

    if (locationId) {
      const [rows] = await pool.query(
        `SELECT l.profile_id AS id,
                EXISTS (SELECT 1 FROM snmp_profile_agents g
                         WHERE g.profile_id = l.profile_id AND g.agent_id = ?) AS granted
           FROM snmp_profile_locations l
          WHERE l.location_id = ?
          ORDER BY l.priority ASC, l.profile_id ASC`,
        [agentId, locationId],
      );
      const usable = rows.find((r) => Number(r.granted) === 1);
      if (usable) return { profileId: Number(usable.id), source: 'site', blocked: null };
      if (rows.length) {
        return { profileId: null, source: null, blocked: Number(rows[0].id) };
      }
    }

    const [rows] = await pool.query(
      `SELECT p.id,
              EXISTS (SELECT 1 FROM snmp_profile_agents g
                       WHERE g.profile_id = p.id AND g.agent_id = ?) AS granted
         FROM snmp_credential_profiles p
        WHERE p.is_global_default = 1 ORDER BY p.id ASC LIMIT 1`,
      [agentId],
    );
    if (!rows[0]) return { profileId: null, source: null, blocked: null };
    return Number(rows[0].granted) === 1
      ? { profileId: Number(rows[0].id), source: 'global', blocked: null }
      : { profileId: null, source: null, blocked: Number(rows[0].id) };
  }

  // The id alone, for callers that only need to know which credential to
  // decrypt. `resolveForAgent` is the one that can say WHY there is none.
  async function resolveProfileIdFor(opts = {}) {
    const { profileId } = await resolveForAgent(opts);
    return profileId;
  }

  return {
    list,
    listForLocation,
    listForAgent,
    findById,
    findByName,
    findGlobalDefault,
    create,
    update,
    setLocations,
    setLocationOrder,
    setAgents,
    remove,
    deviceCount,
    resolveWithSecret,
    resolveProfileIdFor,
    resolveForAgent,
  };
}

module.exports = {
  createSnmpCredentialProfilesRepository,
  mapRow,
  securityLevel,
  SAFE_COLUMNS,
};
