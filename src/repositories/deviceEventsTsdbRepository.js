'use strict';

// TSDB variant of the device-events repository (docs/storage-split-audit.md).
// Writes land in the TimescaleDB `device_events` hypertable, keyed on `ts`
// (the MySQL `received_at`).
//
// The read shape is IDENTICAL to deviceEventsRepository.js — same camelCase
// object, same ordering, same filters — so the router, the timeline merge and
// the changes feed never learn which store answered.
//
// ONE REAL DIFFERENCE, and it is in the writes. MySQL folds repeats with
// `ON DUPLICATE KEY UPDATE` against a UNIQUE dedup_key. A hypertable cannot
// carry a UNIQUE index that excludes the partitioning column, so folding here
// is an explicit UPDATE-then-INSERT against the dedup_key WITHIN the current
// window, which is what the bucketed key already bounds. The outcome an API
// caller sees — `{ inserted, folded }` — is the same either way.

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function mapRow(row) {
  if (!row) return null;
  return {
    // A hypertable has no surrogate key. The device log addresses a row by its
    // (ts, dedup_key) pair instead, and `id` stays null rather than carrying a
    // number that would not survive a re-read.
    id: row.id == null ? null : Number(row.id),
    agentId: Number(row.agent_id),
    deviceId: row.device_id == null ? null : Number(row.device_id),
    sourceIp: row.source_ip,
    receivedAt: toIso(row.ts),
    deviceTime: toIso(row.device_time),
    clockSkewMs: row.clock_skew_ms == null ? null : Number(row.clock_skew_ms),
    transport: row.transport,
    facility: row.facility == null ? null : Number(row.facility),
    severity: Number(row.severity),
    eventType: row.event_type,
    deviceHostname: row.device_hostname ?? null,
    tag: row.tag ?? null,
    ifname: row.ifname ?? null,
    summary: row.summary,
    raw: row.raw ?? null,
    detail: row.detail ?? null, // pg parses JSONB already
    occurrences: Number(row.occurrences),
  };
}

const SELECT_COLUMNS = `NULL::bigint AS id, agent_id, device_id, source_ip, ts,
  device_time, clock_skew_ms, transport, facility, severity, event_type,
  device_hostname, tag, ifname, summary, raw, detail, occurrences`;

function createDeviceEventsTsdbRepository(tsdb) {
  const { pool } = tsdb;

  async function createMany(agentId, events) {
    const rows = Array.isArray(events) ? events : [];
    if (!rows.length) return { inserted: 0, folded: 0 };

    let folded = 0;
    const fresh = [];

    // Fold first, against the keys that already exist in this window. Rows with
    // no dedup_key skip the lookup entirely and are always inserted.
    for (const e of rows) {
      if (!e.dedupKey) { fresh.push(e); continue; }
      const res = await pool.query(
        `UPDATE device_events
            SET occurrences   = occurrences + $1,
                ts            = GREATEST(ts, $2::timestamptz),
                device_time   = $3,
                clock_skew_ms = $4
          WHERE dedup_key = $5
            AND ts >= now() - INTERVAL '2 days'`,
        [
          e.occurrences ?? 1,
          e.receivedAt,
          e.deviceTime ?? null,
          e.clockSkewMs ?? null,
          e.dedupKey,
        ],
      );
      if (res.rowCount > 0) folded += 1;
      else fresh.push(e);
    }

    if (fresh.length) {
      const tuples = [];
      const params = [];
      fresh.forEach((e, i) => {
        const b = i * 18;
        tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15},$${b + 16},$${b + 17},$${b + 18})`);
        params.push(
          e.receivedAt,
          agentId,
          e.deviceId ?? null,
          e.sourceIp,
          e.deviceTime ?? null,
          e.clockSkewMs ?? null,
          e.transport || 'syslog',
          e.facility ?? null,
          e.severity,
          e.eventType,
          e.deviceHostname ?? null,
          e.tag ?? null,
          e.ifname ?? null,
          e.summary,
          e.raw ?? null,
          e.detail == null ? null : JSON.stringify(e.detail),
          e.dedupKey ?? null,
          e.occurrences ?? 1,
        );
      });
      await pool.query(
        `INSERT INTO device_events
           (ts, agent_id, device_id, source_ip, device_time, clock_skew_ms,
            transport, facility, severity, event_type, device_hostname, tag,
            ifname, summary, raw, detail, dedup_key, occurrences)
         VALUES ${tuples.join(', ')}`,
        params,
      );
    }

    return { inserted: fresh.length, folded };
  }

  // Builds the shared WHERE for the reads below. The time bound is never
  // optional: an unbounded scan of a hypertable is the one query shape the
  // storage split forbids (see the closing note in 001_init.sql).
  function buildFilter({ maxSeverity, deviceId, agentId, transport, eventType, q }, params) {
    const where = [];
    if (maxSeverity != null) { params.push(maxSeverity); where.push(`severity <= $${params.length}`); }
    if (deviceId != null) { params.push(deviceId); where.push(`device_id = $${params.length}`); }
    if (agentId != null) { params.push(agentId); where.push(`agent_id = $${params.length}`); }
    if (transport) { params.push(transport); where.push(`transport = $${params.length}`); }
    if (eventType) { params.push(eventType); where.push(`event_type = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      where.push(`(summary ILIKE $${i} OR device_hostname ILIKE $${i} OR ifname ILIKE $${i})`);
    }
    return where;
  }

  async function list({
    minutes = 120, limit = 100, offset = 0,
    maxSeverity = null, deviceId = null, agentId = null,
    transport = null, eventType = null, q = null,
  } = {}) {
    const params = [minutes];
    const where = ['ts >= now() - make_interval(mins => $1::int)'];
    where.push(...buildFilter({ maxSeverity, deviceId, agentId, transport, eventType, q }, params));
    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const res = await pool.query(
      `SELECT ${SELECT_COLUMNS}
         FROM device_events
        WHERE ${where.join(' AND ')}
        ORDER BY ts DESC
        LIMIT $${limitIdx} OFFSET $${params.length}`,
      params,
    );
    return res.rows.map(mapRow);
  }

  async function severityCounts({ minutes = 120, deviceId = null, agentId = null } = {}) {
    const params = [minutes];
    const where = ['ts >= now() - make_interval(mins => $1::int)'];
    where.push(...buildFilter({ deviceId, agentId }, params));
    const res = await pool.query(
      `SELECT severity, COUNT(*) AS n, SUM(occurrences) AS occurrences
         FROM device_events
        WHERE ${where.join(' AND ')}
        GROUP BY severity
        ORDER BY severity ASC`,
      params,
    );
    return res.rows.map((r) => ({
      severity: Number(r.severity),
      rows: Number(r.n),
      occurrences: Number(r.occurrences || 0),
    }));
  }

  async function listForDevice(deviceId, { from, to, limit = 200, newestFirst = true } = {}) {
    const res = await pool.query(
      `SELECT ${SELECT_COLUMNS}
         FROM device_events
        WHERE device_id = $1 AND ts >= $2 AND ts <= $3
        ORDER BY ts ${newestFirst ? 'DESC' : 'ASC'}
        LIMIT $4`,
      [deviceId, from, to, limit],
    );
    return res.rows.map(mapRow);
  }

  async function listBetween({ from, to, limit = 200, maxSeverity = null } = {}) {
    const params = [from, to];
    const where = ['ts >= $1', 'ts <= $2'];
    if (maxSeverity != null) { params.push(maxSeverity); where.push(`severity <= $${params.length}`); }
    params.push(limit);
    const res = await pool.query(
      `SELECT ${SELECT_COLUMNS}
         FROM device_events
        WHERE ${where.join(' AND ')}
        ORDER BY ts DESC
        LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(mapRow);
  }

  // Retention is a TimescaleDB policy (add_retention_policy in 001_init.sql),
  // not an application DELETE. Kept on the interface so the two repositories
  // are substitutable; calling it is a no-op that reports nothing removed.
  async function purgeBefore() {
    return 0;
  }

  // findById has no meaning without a surrogate key; kept for interface parity.
  async function findById() {
    return null;
  }

  return {
    createMany,
    list,
    severityCounts,
    listForDevice,
    listBetween,
    findById,
    purgeBefore,
  };
}

module.exports = { createDeviceEventsTsdbRepository };
