'use strict';

// Data-access for `snmp_devices` (migration 104) — the switches an agent polls
// on the server's behalf.
//
// THE COMMUNITY STRING NEVER LEAVES THIS FILE IN CLEAR TEXT, except on the one
// path that has to carry it: the config handed to the agent that does the
// polling. `SAFE_COLUMNS` omits `community_encrypted` entirely, so an API read
// cannot return it even by accident — the same shape `cmdbConfigRepository`
// uses, and for the same reason. `listForAgentWithSecret` is the single
// exception and is named so nobody reaches for it absent-mindedly.

const SAFE_COLUMNS = `id, agent_id, host, port, version, display_name, location_id,
  credential_profile_id, collect, interval_sec, counter_interval_sec, enabled,
  last_polled_at, last_ok_at, last_error, last_uptime_ticks, last_uptime_at,
  supported, created_at, updated_at`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    agentId: row.agent_id == null ? null : Number(row.agent_id),
    host: row.host,
    port: Number(row.port),
    version: String(row.version),
    displayName: row.display_name ?? null,
    locationId: row.location_id == null ? null : Number(row.location_id),
    // NULL means "resolve it" — by site, then globally (migration 112). A
    // device with its own community still wins over both, so every row that
    // existed before profiles keeps working with nothing to migrate.
    credentialProfileId: row.credential_profile_id == null ? null : Number(row.credential_profile_id),
    // WHETHER this device carries its own community, never what it is. The
    // difference between "no credential configured" and "a credential you
    // cannot see" is the whole of what a reader needs, and a caller asking
    // "is this switch going to be polled" had no way to tell them apart —
    // `SAFE_COLUMNS` omits the encrypted column entirely, as it must.
    // `undefined` on the shapes that do not select it, so absent is never
    // read as false.
    hasCommunity: row.has_community === undefined ? undefined : !!Number(row.has_community),
    collect: parseJson(row.collect, ['if', 'fdb', 'lldp', 'vlan']),
    intervalSec: Number(row.interval_sec),
    // NULL means this device is not polled for counters. The volume is opt-in
    // per device, and `collect` saying 'ifcounters' is the other half of it.
    counterIntervalSec: row.counter_interval_sec == null ? null : Number(row.counter_interval_sec),
    enabled: !!row.enabled,
    lastPolledAt: toIso(row.last_polled_at),
    lastOkAt: toIso(row.last_ok_at),
    lastError: row.last_error ?? null,
    // What the DEVICE's own clock said at the last counter poll, and when that
    // was. Kept here rather than recomputed from the samples because the reboot
    // check has to run before the new rows are written, and scanning the time
    // series for it would be a read per device per cycle.
    lastUptimeTicks: row.last_uptime_ticks == null ? null : Number(row.last_uptime_ticks),
    lastUptimeAt: toIso(row.last_uptime_at),
    // NULL, not []. A device that has never been polled has not told us what it
    // supports, and an empty array would read as "supports nothing" — the same
    // absent-is-not-zero rule the agent applies to a missing SNMP counter.
    supported: row.supported == null ? null : parseJson(row.supported, null),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function createSnmpDevicesRepository(db, { secretBox = null, credentialProfilesRepo = null } = {}) {
  const { pool } = db;

  // The boolean, computed in SQL so the encrypted value never leaves the
  // database on this path.
  const HAS_COMMUNITY = "community_encrypted IS NOT NULL AND community_encrypted <> '' AS has_community";

  async function list({ agentId = null, enabled = null } = {}) {
    const where = [];
    const params = [];
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    if (enabled != null) { where.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    const [rows] = await pool.query(
      `SELECT ${SAFE_COLUMNS}, ${HAS_COMMUNITY} FROM snmp_devices
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY host ASC, port ASC`,
      params,
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(`SELECT ${SAFE_COLUMNS} FROM snmp_devices WHERE id = ? LIMIT 1`, [id]);
    return mapRow(rows[0]);
  }

  async function findByHost(host, port = 161) {
    const [rows] = await pool.query(
      `SELECT ${SAFE_COLUMNS} FROM snmp_devices WHERE host = ? AND port = ? LIMIT 1`, [host, port],
    );
    return mapRow(rows[0]);
  }

  // The ONE read that returns the credential, and only for the agent that polls
  // the device. Decrypted here so the caller never handles a secretBox token;
  // a device whose stored token cannot be decrypted (a rotated key) yields a
  // null community rather than throwing — the agent then fails that one poll
  // and the dashboard shows the reason, instead of the whole config read dying.
  async function listForAgentWithSecret(agentId) {
    const [rows] = await pool.query(
      `SELECT ${SAFE_COLUMNS}, community_encrypted FROM snmp_devices
        WHERE agent_id = ? AND enabled = 1 ORDER BY id ASC`,
      [agentId],
    );
    // THE RESOLUTION CHAIN (migrations 112 and 113), run HERE on the server:
    //
    //   1. the device's own credential
    //   2. the named community the device names
    //   3. the communities of the device's site, in the site's order
    //   4. the global default community
    //   5. nothing — reported as such, never as a quiet fallback to 'public'
    //
    // Steps 2-4 are filtered by what THIS AGENT is granted (migration 113): an
    // agent walks only with a community assigned to it, and one that is not
    // assigned is skipped as though it were not configured. A site's several
    // communities are an ORDER OF PREFERENCE, not a list to try — the agent
    // still receives ONE credential per device and never learns the others
    // exist. Trying them in order at the agent is credential spraying: it locks
    // v3 accounts and, on v2c, times out once per community per device per
    // cycle against a 60-second interval floor.
    //
    // A device's OWN community is not a named community and is not filtered:
    // it belongs to that one switch, it is shared with nothing, and there is
    // nothing for an admin to assign. Which is also why it still wins — a
    // credential set on the device itself is the most specific statement there
    // is about how to reach it.
    const out = [];
    for (const row of rows) {
      const device = mapRow(row);
      let credential = null;

      if (row.community_encrypted && secretBox) {
        try {
          const community = secretBox.decrypt(row.community_encrypted);
          if (community) {
            credential = { version: device.version, community, source: 'device' };
          }
        } catch { credential = null; }
      }

      // Why there is no credential, when there is none. "This site has no
      // community" and "this agent may not use the one it has" send an admin to
      // two different screens, so the device reports which.
      let blockedProfileId = null;

      if (!credential && credentialProfilesRepo) {
        try {
          // `resolveForAgent` is the agent-aware chain; `resolveProfileIdFor`
          // is kept for callers that only want the id.
          const chain = typeof credentialProfilesRepo.resolveForAgent === 'function'
            ? await credentialProfilesRepo.resolveForAgent({
              profileId: device.credentialProfileId,
              locationId: device.locationId,
              agentId,
            })
            : {
              profileId: await credentialProfilesRepo.resolveProfileIdFor({
                profileId: device.credentialProfileId,
                locationId: device.locationId,
              }),
              blocked: null,
            };
          const { profileId } = chain;
          blockedProfileId = chain.blocked ?? null;
          const resolved = profileId ? await credentialProfilesRepo.resolveWithSecret(profileId) : null;
          if (resolved) {
            credential = {
              // The version that RUNS is the credential's, not the device row's:
              // a v3 profile against a device row still saying 2c would
              // otherwise authenticate with a community that does not exist.
              version: resolved.version,
              community: resolved.community,
              v3User: resolved.v3User,
              v3AuthProto: resolved.v3AuthProto,
              v3AuthKey: resolved.v3AuthKey,
              v3PrivProto: resolved.v3PrivProto,
              v3PrivKey: resolved.v3PrivKey,
              v3Context: resolved.v3Context,
              securityLevel: resolved.securityLevel,
              source: 'profile',
              profileId: resolved.profileId,
              profileName: resolved.profileName,
            };
          }
        } catch { credential = null; }
      }

      out.push({
        ...device,
        // Kept for the agents and tests that read `community` directly.
        community: credential ? (credential.community ?? null) : null,
        credential,
        // Set only when a community WOULD have answered and this agent is not
        // granted it. An agent handed a target with no credential refuses to
        // poll it and says so, rather than falling back to 'public'.
        credentialBlockedByGrant: !credential && blockedProfileId != null,
      });
    }
    return out;
  }

  async function create({
    agentId = null, host, port = 161, version = '2c', community = null,
    displayName = null, locationId = null, collect = null, intervalSec = 300,
    counterIntervalSec = null, credentialProfileId = null, enabled = true,
  }) {
    const encrypted = community && secretBox ? secretBox.encrypt(community) : null;
    const [res] = await pool.query(
      `INSERT INTO snmp_devices
         (agent_id, host, port, version, community_encrypted, credential_profile_id,
          display_name, location_id, collect, interval_sec, counter_interval_sec, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId, host, port, version, encrypted, credentialProfileId,
        displayName, locationId,
        collect == null ? null : JSON.stringify(collect), intervalSec,
        counterIntervalSec, enabled ? 1 : 0,
      ],
    );
    return findById(res.insertId);
  }

  // Patch semantics: only the keys present are written. `community` is the one
  // field that cannot be READ back, so an omitted community leaves the stored
  // one alone and an explicit null clears it — otherwise every edit of a
  // display name would silently wipe the credential.
  async function update(id, patch = {}) {
    const fields = [];
    const params = [];
    const set = (col, val) => { fields.push(`${col} = ?`); params.push(val); };

    if (patch.agentId !== undefined) set('agent_id', patch.agentId);
    if (patch.host !== undefined) set('host', patch.host);
    if (patch.port !== undefined) set('port', patch.port);
    if (patch.version !== undefined) set('version', patch.version);
    if (patch.displayName !== undefined) set('display_name', patch.displayName);
    if (patch.locationId !== undefined) set('location_id', patch.locationId);
    if (patch.collect !== undefined) set('collect', patch.collect == null ? null : JSON.stringify(patch.collect));
    if (patch.intervalSec !== undefined) set('interval_sec', patch.intervalSec);
    if (patch.counterIntervalSec !== undefined) set('counter_interval_sec', patch.counterIntervalSec);
    if (patch.credentialProfileId !== undefined) set('credential_profile_id', patch.credentialProfileId);
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
    if (patch.community !== undefined) {
      set('community_encrypted', patch.community && secretBox ? secretBox.encrypt(patch.community) : null);
    }
    if (!fields.length) return findById(id);

    params.push(id);
    await pool.query(`UPDATE snmp_devices SET ${fields.join(', ')} WHERE id = ?`, params);
    return findById(id);
  }

  async function remove(id) {
    const [res] = await pool.query('DELETE FROM snmp_devices WHERE id = ?', [id]);
    return res.affectedRows > 0;
  }

  // Records the outcome of one poll. A success clears `last_error` and stamps
  // `last_ok_at`; a failure keeps the LAST GOOD time so the UI can say "last
  // answered 41 minutes ago" rather than just "failing", which is the
  // difference between a switch that just blipped and one that is gone.
  async function recordPoll(id, { ok, error = null, supported = null, at = new Date() } = {}) {
    if (ok) {
      await pool.query(
        `UPDATE snmp_devices
            SET last_polled_at = ?, last_ok_at = ?, last_error = NULL,
                supported = COALESCE(?, supported)
          WHERE id = ?`,
        [at, at, supported == null ? null : JSON.stringify(supported), id],
      );
      return;
    }
    await pool.query(
      'UPDATE snmp_devices SET last_polled_at = ?, last_error = ? WHERE id = ?',
      [at, error == null ? null : String(error).slice(0, 255), id],
    );
  }

  // Remembers the device clock a counter cycle read, for the NEXT cycle's
  // reboot check. Separate from recordPoll because the two cycles are separate:
  // a topology poll that failed must not move the counter reference forward,
  // and a counter poll that succeeded must not clear a topology error.
  async function recordCounterPoll(id, { uptimeTicks = null, at = new Date() } = {}) {
    await pool.query(
      'UPDATE snmp_devices SET last_uptime_ticks = ?, last_uptime_at = ? WHERE id = ?',
      [uptimeTicks == null ? null : Number(uptimeTicks), at, id],
    );
  }

  return {
    list,
    findById,
    findByHost,
    listForAgentWithSecret,
    create,
    update,
    remove,
    recordPoll,
    recordCounterPoll,
  };
}

module.exports = { createSnmpDevicesRepository, mapRow, SAFE_COLUMNS };
