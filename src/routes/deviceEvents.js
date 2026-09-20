'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { validateDeviceEventQuery } = require('../validation/deviceEventValidation');
const { SEVERITY_NAMES, EVENT_TYPE_GROUPS, describeEventType } = require('../devices/deviceEventCatalog');

// The device log: what the network equipment itself said, newest first.
//
// viewer+, deliberately. This is the same data class as the Flows explorer and
// the probe results a viewer already reads — device operational messages, no
// payload, credentials masked on the agent before they ever left the host. A
// technician who can see that a link went down should not need operator rights
// to read the line where the switch says so.
//
// The route OWNS NO ANALYSIS. It reads `device_events` and attaches the two
// things the row cannot carry itself: the human name of the device it resolved
// to, and the catalogue entry that explains what the event_type means.
function createDeviceEventsRouter({ deviceEventsRepo, agentsRepo, logger = null }) {
  const router = express.Router();
  const viewer = [requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN)];

  // Resolves device/agent ids to display names in ONE query for the whole page,
  // rather than a lookup per row. A device log page is 100 rows from maybe 6
  // devices; 100 queries for 6 answers is the kind of thing that only shows up
  // in production.
  async function nameMap(rows) {
    const ids = new Set();
    for (const r of rows) {
      if (r.deviceId != null) ids.add(r.deviceId);
      if (r.agentId != null) ids.add(r.agentId);
    }
    const names = new Map();
    if (!ids.size) return names;
    try {
      const agents = await agentsRepo.findAll();
      for (const a of agents) {
        if (ids.has(Number(a.id))) names.set(Number(a.id), a.display_name || a.hostname);
      }
    } catch (err) {
      if (logger) logger.warn(`device-events: could not resolve display names (${err.message})`);
    }
    return names;
  }

  // GET /api/device-events — the log itself.
  router.get('/', ...viewer, asyncHandler(async (req, res) => {
    const errors = {};
    const filter = validateDeviceEventQuery(req.query, errors);
    if (!filter) return res.status(400).json({ error: 'Validation failed', details: errors });

    // A device filter that names a device nobody has is a 404, not an empty
    // list: "no events" and "no such device" are different answers, and only
    // one of them means stop looking.
    if (filter.deviceId != null) {
      const device = await agentsRepo.findById(filter.deviceId);
      if (!device) return res.status(404).json({ error: 'Device not found' });
    }
    if (filter.agentId != null) {
      const agent = await agentsRepo.findById(filter.agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
    }

    const rows = await deviceEventsRepo.list(filter);
    const names = await nameMap(rows);

    const events = rows.map((r) => ({
      ...r,
      deviceName: r.deviceId != null ? (names.get(r.deviceId) || null) : null,
      agentName: names.get(r.agentId) || null,
      severityName: SEVERITY_NAMES[r.severity] || String(r.severity),
      // What this event_type MEANS, in the operator's language. Null for a type
      // this server's catalogue does not know — which happens by design when a
      // newer agent classifies something this one has not heard of, and is
      // shown as the raw type rather than hidden.
      typeLabel: describeEventType(r.eventType),
    }));

    // Counts for the severity chips. Computed over the same window WITHOUT the
    // severity filter, because a chip is only useful while it counts the rows
    // it is currently hiding.
    let counts = [];
    try {
      counts = await deviceEventsRepo.severityCounts({
        minutes: filter.minutes,
        deviceId: filter.deviceId ?? null,
        agentId: filter.agentId ?? null,
      });
    } catch (err) {
      if (logger) logger.warn(`device-events: severity counts failed (${err.message})`);
    }

    res.json({
      window: { minutes: filter.minutes },
      filter,
      counts,
      events,
      // A full page means there is probably more; the UI uses this to decide
      // whether to offer "load more" rather than guessing from the count.
      hasMore: rows.length === filter.limit,
    });
  }));

  // GET /api/device-events/catalog — what the filters can offer.
  //
  // Served rather than hardcoded in the dashboard so the two never drift: the
  // severity names and the event-type groups have exactly one definition.
  router.get('/catalog', ...viewer, asyncHandler(async (req, res) => {
    res.json({
      severities: SEVERITY_NAMES.map((name, value) => ({ value, name })),
      groups: EVENT_TYPE_GROUPS,
    });
  }));

  return router;
}

module.exports = { createDeviceEventsRouter };
