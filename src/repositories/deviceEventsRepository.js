'use strict';

// Data-access for `device_events` (migration 103) — what the network equipment
// itself says, as received by an agent.
//
// MySQL implementation. The TSDB variant lives in
// deviceEventsTsdbRepository.js and answers the same calls with the same row
// shape, so callers never learn which store they are talking to — the dual
// pattern `results` / `resultsTsdbRepo` already uses (docs/storage-split-audit.md).

const BASE_COLUMNS = `id, agent_id, device_id, source_ip, received_at, device_time,
  clock_skew_ms, transport, facility, severity, event_type, device_hostname,
  tag, ifname, summary, raw, detail, dedup_key, occurrences`;

function toIso(v) {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    deviceId: row.device_id == null ? null : Number(row.device_id),
    sourceIp: row.source_ip,
    receivedAt: toIso(row.received_at),
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
    detail: parseJson(row.detail),
    occurrences: Number(row.occurrences),
  };
}

function createDeviceEventsRepository(db) {
  const { pool } = db;

  // Inserts a batch. Rows whose dedup_key collides with a stored one are FOLDED
  // rather than duplicated: occurrences accumulate and received_at moves to the
  // later sighting, so "this has now happened 40 times" is one row that stays
  // current instead of 40 rows that bury everything else.
  //
  // The ingest builds a dedup_key that includes a time bucket (see
  // src/devices/deviceEventIngest.js), which is what keeps the folding bounded:
  // a link flap today never merges into one from last week. A NULL dedup_key
  // opts a row out — MySQL permits many NULLs in a UNIQUE index — which is how
  // an event that must never be folded is stored.
  //
  // Returns { inserted, folded }: the caller reports both, because an operator
  // seeing "202 accepted" with nothing new on screen deserves to know the batch
  // was a repeat rather than assume the pipeline is broken.
  async function createMany(agentId, events) {
    const rows = Array.isArray(events) ? events : [];
    if (!rows.length) return { inserted: 0, folded: 0 };

    const placeholders = [];
    const params = [];
    for (const e of rows) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      params.push(
        agentId,
        e.deviceId ?? null,
        e.sourceIp,
        e.receivedAt,
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
    }

    const [res] = await pool.query(
      `INSERT INTO device_events
         (agent_id, device_id, source_ip, received_at, device_time, clock_skew_ms,
          transport, facility, severity, event_type, device_hostname, tag, ifname,
          summary, raw, detail, dedup_key, occurrences)
       VALUES ${placeholders.join(', ')}
       ON DUPLICATE KEY UPDATE
         occurrences   = occurrences + VALUES(occurrences),
         received_at   = GREATEST(received_at, VALUES(received_at)),
         device_time   = VALUES(device_time),
         clock_skew_ms = VALUES(clock_skew_ms)`,
      params,
    );
    // mysql2 reports affectedRows as 1 per insert and 2 per updated duplicate,
    // so the folded count is the excess over the batch size.
    const affected = Number(res.affectedRows || 0);
    const folded = Math.max(affected - rows.length, 0);
    return { inserted: rows.length - folded, folded };
  }

  // The device-log read. Newest first, filtered by whatever the technician
  // narrowed to. Every filter is optional and every one is parameterised.
  //
  // `maxSeverity` filters syslog-numerically — LOWER is worse — so 4 means
  // "warning and above". That inversion is the single most confusing thing
  // about syslog and it is named, not hidden, in the parameter.
  async function list({
    minutes = 120,
    limit = 100,
    offset = 0,
    maxSeverity = null,
    deviceId = null,
    agentId = null,
    transport = null,
    eventType = null,
    q = null,
  } = {}) {
    const where = ['received_at >= (NOW(3) - INTERVAL ? MINUTE)'];
    const params = [minutes];

    if (maxSeverity != null) { where.push('severity <= ?'); params.push(maxSeverity); }
    if (deviceId != null) { where.push('device_id = ?'); params.push(deviceId); }
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }
    if (transport) { where.push('transport = ?'); params.push(transport); }
    if (eventType) { where.push('event_type = ?'); params.push(eventType); }
    if (q) {
      // A free-text narrowing over the three fields a technician actually types
      // into: the message, the device's own name and the interface. LIKE with a
      // leading wildcard cannot use an index, which is why the time window is
      // NOT optional — it is what bounds the scan.
      where.push('(summary LIKE ? OR device_hostname LIKE ? OR ifname LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS}
         FROM device_events
        WHERE ${where.join(' AND ')}
        ORDER BY received_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return rows.map(mapRow);
  }

  // Counts per severity in the window, for the filter chips. Same WHERE as
  // list() minus the severity filter itself — a chip that says how many rows it
  // would reveal is only useful while it counts the rows it is hiding.
  async function severityCounts({ minutes = 120, deviceId = null, agentId = null } = {}) {
    const where = ['received_at >= (NOW(3) - INTERVAL ? MINUTE)'];
    const params = [minutes];
    if (deviceId != null) { where.push('device_id = ?'); params.push(deviceId); }
    if (agentId != null) { where.push('agent_id = ?'); params.push(agentId); }

    const [rows] = await pool.query(
      `SELECT severity, COUNT(*) AS n, SUM(occurrences) AS occurrences
         FROM device_events
        WHERE ${where.join(' AND ')}
        GROUP BY severity
        ORDER BY severity ASC`,
      params,
    );
    return rows.map((r) => ({
      severity: Number(r.severity),
      rows: Number(r.n),
      occurrences: Number(r.occurrences || 0),
    }));
  }

  // One device's events inside an explicit window — the call the target
  // timeline makes. Ascending or descending is the caller's choice because the
  // timeline merges newest-first while an export reads oldest-first.
  async function listForDevice(deviceId, { from, to, limit = 200, newestFirst = true } = {}) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS}
         FROM device_events
        WHERE device_id = ? AND received_at >= ? AND received_at <= ?
        ORDER BY received_at ${newestFirst ? 'DESC' : 'ASC'}, id ${newestFirst ? 'DESC' : 'ASC'}
        LIMIT ?`,
      [deviceId, from, to, limit],
    );
    return rows.map(mapRow);
  }

  // Everything in a window regardless of device — what the changes feed merges.
  async function listBetween({ from, to, limit = 200, maxSeverity = null } = {}) {
    const where = ['received_at >= ?', 'received_at <= ?'];
    const params = [from, to];
    if (maxSeverity != null) { where.push('severity <= ?'); params.push(maxSeverity); }
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS}
         FROM device_events
        WHERE ${where.join(' AND ')}
        ORDER BY received_at DESC, id DESC
        LIMIT ?`,
      [...params, limit],
    );
    return rows.map(mapRow);
  }

  async function findById(id) {
    const [rows] = await pool.query(
      `SELECT ${BASE_COLUMNS} FROM device_events WHERE id = ? LIMIT 1`, [id],
    );
    return mapRow(rows[0]);
  }

  // Retention. Deletes in bounded batches so a long-neglected table does not
  // lock the ingest path out for the length of one enormous DELETE.
  async function purgeBefore(cutoff, { batchSize = 5000 } = {}) {
    let removed = 0;
    for (;;) {
      const [res] = await pool.query(
        'DELETE FROM device_events WHERE received_at < ? LIMIT ?', [cutoff, batchSize],
      );
      const n = Number(res.affectedRows || 0);
      removed += n;
      if (n < batchSize) break;
    }
    return removed;
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

module.exports = { createDeviceEventsRepository, mapRow };
