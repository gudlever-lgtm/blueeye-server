'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const {
  buildSetupChecklist, DEVICE_EVENT_WINDOW_DAYS,
} = require('../services/setupChecklist');

// GET /api/setup/checklist — what is not set up yet, and what stays empty
// because of it.
//
// ADMIN ONLY. The rows are a description of how this install is wired: which
// agents exist, whether any switch has a usable credential, whether the GeoIP
// database is loaded. That is a map of the monitoring for anyone who can read
// it, and it is only actionable by somebody who can change it.
//
// EVERY SOURCE IS BEST-EFFORT AND FAILS TO `null`, NOT TO ZERO. A repository
// that cannot be read makes its row UNKNOWN; reporting it as zero would put a
// task on the list that nobody needs to do, and a checklist with invented work
// on it is one people stop reading.
function createSetupRouter({
  agentsRepo = null, snmpDevicesRepo = null, snmpProfilesRepo = null,
  deviceEventsRepo = null, locationsRepo = null, settingsService = null,
  logger = null,
}) {
  const router = express.Router();
  const admin = [requireAuth, requireRole(ROLES.ADMIN)];

  const tryRead = async (what, fn, fallback, failed = null) => {
    try {
      return await fn();
    } catch (err) {
      if (logger) logger.warn(`setup checklist: ${what} unavailable (${err && err.message})`);
      if (failed) failed.push(what);
      return fallback;
    }
  };

  // How many enabled devices resolve a credential their polling agent may
  // actually use. Asked of the resolver rather than inferred from the columns:
  // "has a community", "its site has one" and "this agent is granted it" are
  // three separate conditions and only the resolver knows all three.
  async function countCredentialed(devices) {
    if (!snmpProfilesRepo || typeof snmpProfilesRepo.resolveForAgent !== 'function') return null;
    let n = 0;
    for (const d of devices) {
      // A device with its OWN community needs nothing resolved.
      if (d.hasCommunity || d.community) { n += 1; continue; }
      if (d.agentId == null) continue; // nothing polls it, so nothing to resolve
      // eslint-disable-next-line no-await-in-loop
      const chain = await snmpProfilesRepo.resolveForAgent({
        profileId: d.credentialProfileId, locationId: d.locationId, agentId: d.agentId,
      });
      if (chain && chain.profileId) n += 1;
    }
    return n;
  }

  router.get('/checklist', ...admin, asyncHandler(async (req, res) => {
    // The lists fall back to null — "could not be read" — never to [], which
    // would read as "there are none" and put invented work on the list.
    const agents = await tryRead('agents', () => (agentsRepo && agentsRepo.findAll ? agentsRepo.findAll() : []), null);
    const snmpDevices = await tryRead('snmp devices', () => (snmpDevicesRepo && snmpDevicesRepo.list ? snmpDevicesRepo.list({}) : []), null);
    const locations = await tryRead('locations', () => (locationsRepo && locationsRepo.findAll ? locationsRepo.findAll() : []), null);
    // The scalar facts are null both when their source is absent and when it
    // threw; this names the ones that threw, so only those hold `complete` back.
    const failed = [];

    const enabled = (Array.isArray(snmpDevices) ? snmpDevices : []).filter((d) => d && d.enabled !== false);
    const credentialed = enabled.length
      ? await tryRead('credentialed', () => countCredentialed(enabled), null, failed)
      : null;

    const deviceEvents = await tryRead('deviceEvents', async () => {
      if (!deviceEventsRepo || typeof deviceEventsRepo.severityCounts !== 'function') return null;
      const rows = await deviceEventsRepo.severityCounts({ minutes: DEVICE_EVENT_WINDOW_DAYS * 24 * 60 });
      return (Array.isArray(rows) ? rows : []).reduce((n, r) => n + (Number(r.rows) || 0), 0);
    }, null, failed);

    const geoipRanges = await tryRead('geoipRanges', async () => {
      if (!settingsService || typeof settingsService.getGeoip !== 'function') return null;
      const geo = await settingsService.getGeoip();
      return Number.isInteger(geo && geo.ranges) ? geo.ranges : null;
    }, null, failed);

    res.json({
      generatedAt: new Date().toISOString(),
      ...buildSetupChecklist({
        agents, snmpDevices, credentialed, deviceEvents, geoipRanges, locations, failed,
      }),
    });
  }));

  return router;
}

module.exports = { createSetupRouter };
