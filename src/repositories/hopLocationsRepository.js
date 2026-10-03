'use strict';

// Data-access for `hop_locations` (migration 144) — the server's own location
// table for traceroute hops: what an operator corrected by hand, and what a
// RIPE NCC dump published for a block. It outranks every GeoIP source when a
// hop is placed (src/geo/hopLocation.js).
//
// The table is small by nature — one row per router or block somebody cared
// enough to correct, so tens to low thousands — and it is read on EVERY hop of
// EVERY path. So it is not queried per lookup: src/geo/hopCorrections.js holds
// it in memory and reloads after a write. The only read here is `all()`.

const MAX_ROWS = 50000;

function row(r) {
  return {
    ip: r.ip,
    prefixLen: Number(r.prefix_len),
    lat: Number(r.latitude),
    lng: Number(r.longitude),
    city: r.city == null ? null : r.city,
    country: r.country == null ? null : r.country,
    source: r.source,
    note: r.note == null ? null : r.note,
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdByName: r.created_by_name == null ? null : r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT = `SELECT h.ip, h.prefix_len, h.latitude, h.longitude, h.city, h.country,
                       h.source, h.note, h.created_by, COALESCE(u.name, u.email) AS created_by_name,
                       h.created_at, h.updated_at
                FROM hop_locations h
                LEFT JOIN users u ON u.id = h.created_by`;

function createHopLocationsRepository(db) {
  const { pool } = db;

  // Every correction, longest prefix first so the in-memory store can keep that
  // order without re-sorting (a /32 exception inside a corrected /24 wins).
  async function all({ limit = MAX_ROWS } = {}) {
    const n = Math.min(MAX_ROWS, Math.max(1, Number(limit) || MAX_ROWS));
    const [rows] = await pool.query(`${SELECT} ORDER BY h.prefix_len DESC, h.ip ASC LIMIT ?`, [n]);
    return rows.map(row);
  }

  async function find(ip, prefixLen = 32) {
    const [rows] = await pool.query(`${SELECT} WHERE h.ip = ? AND h.prefix_len = ?`, [ip, prefixLen]);
    return rows.length ? row(rows[0]) : null;
  }

  // Insert or update one correction. `source` defaults to 'manual' — the UI
  // never writes anything else, and an import passes 'ripe' explicitly.
  //
  // ON DUPLICATE KEY keeps created_by/created_at of the FIRST writer unless the
  // new write is a manual one: a RIPE import must never claim a person's
  // correction, and a person correcting a RIPE row takes it over.
  async function upsert({
    ip, prefixLen = 32, lat, lng, city = null, country = null,
    source = 'manual', note = null, createdBy = null,
  } = {}) {
    await pool.query(
      `INSERT INTO hop_locations (ip, prefix_len, latitude, longitude, city, country, source, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         latitude = VALUES(latitude), longitude = VALUES(longitude),
         city = VALUES(city), country = VALUES(country),
         source = VALUES(source), note = VALUES(note),
         created_by = IF(VALUES(source) = 'manual', VALUES(created_by), created_by)`,
      [ip, prefixLen, lat, lng, city, country, source, note, createdBy],
    );
    return find(ip, prefixLen);
  }

  // Bulk insert for an import (scripts/import-ripe-geoloc.js). INSERT IGNORE on
  // purpose: a published `geoloc:` never overwrites what a person wrote down.
  async function insertManyIgnore(rows = []) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.ip && Number.isFinite(r.lat) && Number.isFinite(r.lng));
    if (!list.length) return 0;
    let written = 0;
    for (let i = 0; i < list.length; i += 500) {
      const part = list.slice(i, i + 500);
      const values = part.map((r) => [
        r.ip, r.prefixLen == null ? 32 : r.prefixLen, r.lat, r.lng,
        r.city == null ? null : String(r.city).slice(0, 100),
        r.country == null ? null : String(r.country).slice(0, 2).toUpperCase(),
        r.source || 'ripe',
        r.note == null ? null : String(r.note).slice(0, 255),
        r.createdBy == null ? null : r.createdBy,
      ]);
      // eslint-disable-next-line no-await-in-loop
      const [res] = await pool.query(
        `INSERT IGNORE INTO hop_locations
           (ip, prefix_len, latitude, longitude, city, country, source, note, created_by)
         VALUES ?`,
        [values],
      );
      written += res && res.affectedRows ? res.affectedRows : 0;
    }
    return written;
  }

  async function remove(ip, prefixLen = 32) {
    const [res] = await pool.query('DELETE FROM hop_locations WHERE ip = ? AND prefix_len = ?', [ip, prefixLen]);
    return res && res.affectedRows ? res.affectedRows : 0;
  }

  return { all, find, upsert, insertManyIgnore, remove };
}

module.exports = { createHopLocationsRepository, MAX_ROWS };
