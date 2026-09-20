'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateSnmpProfile, AUTH_PROTOS, PRIV_PROTOS } = require('../validation/snmpProfileValidation');

// SNMP credential profiles (migration 112).
//
// ADMIN FOR EVERYTHING, including the read. This is the one place in the SNMP
// feature where even a listing is admin-only: the device inventory is
// infrastructure a viewer may look at, but a list of credential profiles tells
// an attacker which sites share a secret and which use v3, which is the map of
// where to attack first.
//
// NO SECRET IS EVER RETURNED. The repository's SAFE columns omit every
// encrypted value; the list says WHETHER a secret is set, never what it is.
// The one read that decrypts is named so nobody calls it from a route.
//
// Every change is audited. A credential changing is exactly what the
// hash-chained audit log exists for, and `redactBody` already keeps the secret
// out of the audit body.
function createSnmpProfilesRouter({ snmpProfilesRepo, locationsRepo = null, auditLogger = null, logger = null }) {
  const router = express.Router();
  const admin = [requireAuth, requireRole(ROLES.ADMIN)];

  // Same call shape as the device routes beside this one. Best-effort: an
  // audit that fails must not undo a change that already happened, and the
  // failure is logged rather than swallowed.
  async function audit(req, action, profile, label) {
    if (!auditLogger || typeof auditLogger.record !== 'function') return;
    try {
      await auditLogger.record(req, {
        action,
        targetType: 'snmp_profile',
        targetId: String(profile),
        targetLabel: label,
      });
    } catch (err) {
      if (logger) logger.warn(`snmp-profiles: audit failed (${err.message})`);
    }
  }

  // The protocols this build can actually use, so the UI offers exactly those
  // and not a list that has drifted from the validator.
  router.get('/meta', ...admin, asyncHandler(async (req, res) => {
    res.json({ authProtocols: AUTH_PROTOS, privProtocols: PRIV_PROTOS, versions: ['1', '2c', '3'] });
  }));

  router.get('/', ...admin, asyncHandler(async (req, res) => {
    const profiles = await snmpProfilesRepo.list();
    // How many devices each profile is named by. An admin about to delete one
    // should see how many switches stop being polled.
    const withCounts = [];
    for (const p of profiles) {
      let devices = 0;
      try { devices = await snmpProfilesRepo.deviceCount(p.id); } catch { devices = 0; }
      withCounts.push({ ...p, devices });
    }
    res.json({ profiles: withCounts });
  }));

  router.get('/:id', ...admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const profile = await snmpProfilesRepo.findById(id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json({ profile, devices: await snmpProfilesRepo.deviceCount(id) });
  }));

  router.post('/', ...admin, asyncHandler(async (req, res) => {
    const { value, errors } = validateSnmpProfile(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    if (value.locationId != null && locationsRepo) {
      const location = await locationsRepo.findById(value.locationId);
      if (!location) return res.status(404).json({ error: 'Location not found' });
    }
    const existing = await snmpProfilesRepo.findByName(value.name);
    if (existing) {
      return res.status(409).json({ error: 'A profile with that name already exists', profileId: existing.id });
    }

    const profile = await snmpProfilesRepo.create(value);
    await audit(req, 'snmp_profile.create', profile.id, `${profile.name} (v${profile.version})`);
    res.status(201).json({ profile });
  }));

  router.patch('/:id', ...admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const current = await snmpProfilesRepo.findById(id);
    if (!current) return res.status(404).json({ error: 'Profile not found' });

    // The cross-field rules run on the MERGED shape, so a patch that removes
    // an auth key from an authPriv profile is caught here rather than when a
    // switch stops answering.
    const { value, errors } = validateSnmpProfile(req.body, { partial: true, existing: current });
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    if (value.locationId != null && locationsRepo) {
      const location = await locationsRepo.findById(value.locationId);
      if (!location) return res.status(404).json({ error: 'Location not found' });
    }
    if (value.name && value.name !== current.name) {
      const clash = await snmpProfilesRepo.findByName(value.name);
      if (clash && clash.id !== id) {
        return res.status(409).json({ error: 'A profile with that name already exists', profileId: clash.id });
      }
    }

    const profile = await snmpProfilesRepo.update(id, value);
    // The KEYS that changed, never their values. `redactBody` keeps secrets out
    // of the audit body, and naming the fields is what makes the trail useful.
    await audit(req, 'snmp_profile.update', id, `${current.name} — changed: ${Object.keys(value).join(', ')}`);
    res.json({ profile });
  }));

  router.delete('/:id', ...admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const profile = await snmpProfilesRepo.findById(id);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    // Devices naming this profile fall back to the resolution chain — their
    // site's profile, then the global default. The count is reported so the
    // answer is visible rather than discovered.
    const devices = await snmpProfilesRepo.deviceCount(id);
    await snmpProfilesRepo.remove(id);
    await audit(req, 'snmp_profile.delete', id, `${profile.name}, ${devices} device(s) fall back`);
    res.json({ ok: true, devicesAffected: devices });
  }));

  return router;
}

module.exports = { createSnmpProfilesRouter };
