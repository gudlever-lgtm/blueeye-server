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
  collect, interval_sec, counter_interval_sec, enabled, last_polled_at, last_ok_at,
  last_error, last_uptime_ticks, last_uptime_at, supported, created_at, updated_at`;

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

function createSnmpDevicesRepository(db, { secretBox = null } = {}) {
  const { pool } = db;

  async function list({ agentId = null, enabled = null } = {}) {
    const where = [];
    const params = [];
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    if (enabled != null) { where.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    const [rows] = await pool.query(
      `SELECT ${SAFE_COLUMNS} FROM snmp_devices
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
    return rows.map((row) => {
      const device = mapRow(row);
      let community = null;
      if (row.community_encrypted && secretBox) {
        try { community = secretBox.decrypt(row.community_encrypted); } catch { community = null; }
      }
      return { ...device, community };
    });
  }

  async function create({
    agentId = null, host, port = 161, version = '2c', community = null,
    displayName = null, locationId = null, collect = null, intervalSec = 300,
    counterIntervalSec = null, enabled = true,
  }) {
    const encrypted = community && secretBox ? secretBox.encrypt(community) : null;
    const [res] = await pool.query(
      `INSERT INTO snmp_devices
         (agent_id, host, port, version, community_encrypted, display_name,
          location_id, collect, interval_sec, counter_interval_sec, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId, host, port, version, encrypted, displayName, locationId,
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
