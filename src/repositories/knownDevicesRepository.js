'use strict';

const { numOrNull } = require('../lib/num');

// Data-access for `known_devices` (migration 131) — the new-device detector's
// long memory of which MACs a site has ever had.
//
// arp_entries answers "where is this MAC NOW" and forgets after 30 days;
// this answers "has this site ever seen it" and forgets after 400 (retention
// on last_seen). The detector consults it before calling a MAC new, and
// touches it after every ARP report — see src/discovery/newDeviceDetector.js.
//
// `scope` is where "known" applies: 'site:<id>' or, for an agent without a
// site, 'agent:<id>' (scopeKey below builds it, so the two sides agree).

// Where a sighting counts as "known". A site when there is one — a device that
// moves between two agents' view on the same site is not new — else the agent.
function scopeKey({ siteId = null, agentId = null } = {}) {
  const site = numOrNull(siteId);
  if (site != null) return `site:${site}`;
  const agent = numOrNull(agentId);
  if (agent != null) return `agent:${agent}`;
  return null;
}

// The most MACs one call handles. The caller passes one report's worth, and
// the largest report either path accepts is a router's ARP table
// (snmpDeviceValidation.MAX_ARP_PER_DEVICE, 8192) or an agent's own ARP report
// (agentCapabilities' arp bound); this covers both together, with room, so a
// MAC is never silently left out of the memory — and then reported as new
// again — because it sat past an arbitrary cut in a big table.
const MAX_MACS = 16384;
// MACs per statement: keeps each IN () list and each multi-row INSERT (five
// placeholders per row) well inside max_allowed_packet and the 65 535
// placeholder ceiling.
const CHUNK = 1000;

function chunks(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function createKnownDevicesRepository(db) {
  const { pool } = db;

  // Which of `macs` this scope has ever seen (inside the retention window).
  // Bounded (MAX_MACS), one IN () read per CHUNK, each served by the primary
  // key.
  async function knownMacs({ scope, macs } = {}) {
    const list = [...new Set((Array.isArray(macs) ? macs : []).filter((m) => typeof m === 'string' && m))].slice(0, MAX_MACS);
    if (!scope || !list.length) return new Set();
    const known = new Set();
    for (const part of chunks(list)) {
      // eslint-disable-next-line no-await-in-loop
      const [rows] = await pool.query(
        'SELECT mac FROM known_devices WHERE scope = ? AND mac IN (?)',
        [scope, part],
      );
      for (const r of rows) known.add(r.mac);
    }
    return known;
  }

  // Records a report's sightings: a new MAC gets first_seen = last_seen = at;
  // a known one keeps its first_seen and moves last_seen (never backwards — a
  // late evidence snapshot must not age a device) and last_ip. Returns rows
  // affected.
  async function touchMany(scope, entries, at = new Date()) {
    const seen = new Map();
    for (const e of Array.isArray(entries) ? entries : []) {
      if (e && typeof e.mac === 'string' && e.mac) seen.set(e.mac, e.ip || null);
    }
    if (!scope || !seen.size) return 0;
    let affected = 0;
    for (const part of chunks([...seen].slice(0, MAX_MACS))) {
      const values = [];
      const params = [];
      for (const [mac, ip] of part) {
        values.push('(?, ?, ?, ?, ?)');
        params.push(scope, mac, at, at, ip);
      }
      // eslint-disable-next-line no-await-in-loop
      const [res] = await pool.query(
        `INSERT INTO known_devices (scope, mac, first_seen, last_seen, last_ip)
         VALUES ${values.join(', ')}
         ON DUPLICATE KEY UPDATE
           last_ip = IF(VALUES(last_seen) >= last_seen, COALESCE(VALUES(last_ip), last_ip), last_ip),
           last_seen = GREATEST(last_seen, VALUES(last_seen))`,
        params,
      );
      affected += (res && res.affectedRows) || 0;
    }
    return affected;
  }

  return { knownMacs, touchMany };
}

module.exports = { createKnownDevicesRepository, scopeKey, MAX_MACS };
