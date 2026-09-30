'use strict';

const { numOrNull } = require('../lib/num');

// Data-access for `known_peers` (migration 142) — which external networks a
// site has EVER talked to.
//
// flow_records answers "who did we talk to in the last week" and is purged
// after RETENTION_RAW_DAYS; this answers "have we ever talked to them", and
// forgets after 400 days (retention on last_seen). The new-peer detector
// consults it before calling an ASN or a country new, and touches it after
// every hour it scores — see src/analysis/newPeerDetector.js.
//
// `scope` is where "known" applies: 'site:<id>' or, for an agent without a
// site, 'agent:<id>' — the same string known_devices uses, built by the same
// scopeKey so a site means the same thing in both memories.

const { scopeKey } = require('./knownDevicesRepository');

// Peer kinds this table stores. A fourth caller passing something else is a
// bug, and silently writing it would put a row nothing ever reads again.
const PEER_KINDS = Object.freeze(['asn', 'country']);

// The most peers one call handles. An hour of flow records across a fleet
// yields low thousands of distinct (kind, key) pairs even on a busy site —
// there are ~75 000 routed ASNs in total and a site reaches a few hundred of
// them — so this is a ceiling against a runaway caller, not a working limit.
const MAX_PEERS = 20000;
// Peers per statement: keeps each IN () list and each multi-row INSERT (eight
// placeholders per row) well inside max_allowed_packet and the 65 535
// placeholder ceiling.
const CHUNK = 500;

function chunks(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// The key half of a peer, normalised. An ASN is a decimal string (so 15169 and
// '15169' are one row), a country is upper-case alpha-2. Anything else is
// null, and a null peer is never written or looked up — a guessed key would
// make a network look known that never was.
function peerKey(kind, value) {
  if (kind === 'asn') {
    const n = numOrNull(value);
    return n != null && n > 0 ? String(Math.trunc(n)) : null;
  }
  if (kind === 'country') {
    const c = String(value == null ? '' : value).trim().toUpperCase();
    return /^[A-Z]{2}$/.test(c) ? c : null;
  }
  return null;
}

function createKnownPeersRepository(db) {
  const { pool } = db;

  // Which of `peers` this scope has ever reached (inside the retention
  // window). `peers` is [{ kind, key }]; the answer is a Set of 'kind|key'
  // strings, which is what the detector tests membership against.
  //
  // Bounded (MAX_PEERS), one read per kind per CHUNK, each served by the
  // primary key.
  async function knownPeers({ scope, peers } = {}) {
    const known = new Set();
    if (!scope) return known;
    const byKind = new Map();
    for (const p of Array.isArray(peers) ? peers : []) {
      if (!p) continue;
      const key = peerKey(p.kind, p.key);
      if (key == null) continue;
      if (!byKind.has(p.kind)) byKind.set(p.kind, new Set());
      byKind.get(p.kind).add(key);
    }
    let budget = MAX_PEERS;
    for (const [kind, keys] of byKind) {
      const list = [...keys].slice(0, Math.max(0, budget));
      budget -= list.length;
      if (!list.length) continue;
      for (const part of chunks(list)) {
        // eslint-disable-next-line no-await-in-loop
        const [rows] = await pool.query(
          'SELECT peer_key FROM known_peers WHERE scope = ? AND peer_kind = ? AND peer_key IN (?)',
          [scope, kind, part],
        );
        for (const r of rows) known.add(`${kind}|${r.peer_key}`);
      }
    }
    return known;
  }

  // Records an hour's sightings: a new peer gets first_seen = last_seen = at;
  // a known one keeps its first_seen and moves last_seen (never backwards — a
  // late or replayed hour must not age a peer) along with the evidence
  // addresses and the AS name. Returns rows affected.
  async function touchMany(scope, peers, at = new Date()) {
    const seen = new Map();
    for (const p of Array.isArray(peers) ? peers : []) {
      if (!p || !PEER_KINDS.includes(p.kind)) continue;
      const key = peerKey(p.kind, p.key);
      if (key == null) continue;
      seen.set(`${p.kind}|${key}`, {
        kind: p.kind,
        key,
        name: p.name == null ? null : String(p.name).slice(0, 255),
        srcIp: p.srcIp == null ? null : String(p.srcIp).slice(0, 45),
        extIp: p.extIp == null ? null : String(p.extIp).slice(0, 45),
      });
    }
    if (!scope || !seen.size) return 0;
    let affected = 0;
    for (const part of chunks([...seen.values()].slice(0, MAX_PEERS))) {
      const values = [];
      const params = [];
      for (const p of part) {
        values.push('(?, ?, ?, ?, ?, ?, ?, ?)');
        params.push(scope, p.kind, p.key, p.name, at, at, p.srcIp, p.extIp);
      }
      // eslint-disable-next-line no-await-in-loop
      const [res] = await pool.query(
        `INSERT INTO known_peers (scope, peer_kind, peer_key, peer_name, first_seen, last_seen, last_src_ip, last_ext_ip)
         VALUES ${values.join(', ')}
         ON DUPLICATE KEY UPDATE
           peer_name   = IF(VALUES(last_seen) >= last_seen, COALESCE(VALUES(peer_name), peer_name), peer_name),
           last_src_ip = IF(VALUES(last_seen) >= last_seen, COALESCE(VALUES(last_src_ip), last_src_ip), last_src_ip),
           last_ext_ip = IF(VALUES(last_seen) >= last_seen, COALESCE(VALUES(last_ext_ip), last_ext_ip), last_ext_ip),
           last_seen   = GREATEST(last_seen, VALUES(last_seen))`,
        params,
      );
      affected += (res && res.affectedRows) || 0;
    }
    return affected;
  }

  // The oldest first_seen in a scope — the detector's flood guard reads it to
  // ask whether this scope has a memory worth comparing against yet. NULL when
  // the scope has never been written.
  async function oldestFirstSeen(scope) {
    if (!scope) return null;
    const [rows] = await pool.query('SELECT MIN(first_seen) AS oldest FROM known_peers WHERE scope = ?', [scope]);
    const v = rows && rows[0] ? rows[0].oldest : null;
    return v ? new Date(v) : null;
  }

  return { knownPeers, touchMany, oldestFirstSeen };
}

module.exports = { createKnownPeersRepository, scopeKey, peerKey, PEER_KINDS, MAX_PEERS };
