'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateSnmpProfile, AUTH_PROTOS, PRIV_PROTOS } = require('../validation/snmpProfileValidation');

// NAMED SNMP COMMUNITIES (migrations 112 and 113) — what Settings calls
// "SNMP communities": a credential with a name, assigned to the SITES it is
// valid at and to the AGENTS allowed to walk with it.
//
// ADMIN FOR EVERYTHING, including the read. This is the one place in the SNMP
// feature where even a listing is admin-only: the device inventory is
// infrastructure a viewer may look at, but a list of communities tells an
// attacker which sites share a secret and which use v3 — and now also which
// agent to take over to get the most of them. That is the map of where to
// attack first.
//
// NO SECRET IS EVER RETURNED. The repository's SAFE columns omit every
// encrypted value; the list says WHETHER a secret is set, never what it is.
// The one read that decrypts is named so nobody calls it from a route.
//
// Every change is audited. A credential changing is exactly what the
// hash-chained audit log exists for, and `redactBody` already keeps the secret
// out of the audit body.
function createSnmpProfilesRouter({
  snmpProfilesRepo, locationsRepo = null, agentsRepo = null,
  auditLogger = null, logger = null,
}) {
  const router = express.Router();
  const admin = [requireAuth, requireRole(ROLES.ADMIN)];

  // An assignment naming a site or an agent that does not exist is a typo, and
  // it is refused rather than stored: a grant to agent 41 when 41 was deleted
  // last month reads, forever after, as a grant that is in force.
  //
  // Returns an error message, or null. Best-effort by design — a repository
  // that is not wired (the licence-only builds do not wire agents) checks what
  // it can and the foreign keys catch the rest.
  async function unknownAssignment(value) {
    if (Array.isArray(value.locationIds) && locationsRepo) {
      for (const id of value.locationIds) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await locationsRepo.findById(id))) return `Location ${id} not found`;
      }
    }
    if (Array.isArray(value.agentIds) && agentsRepo) {
      for (const id of value.agentIds) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await agentsRepo.findById(id))) return `Agent ${id} not found`;
      }
    }
    return null;
  }

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

  // The list, optionally narrowed to one site or one agent — "which communities
  // are valid here" and "which may this agent walk with" are the two questions
  // the assignment model exists to answer, and both are a filter on this list
  // rather than a screen of their own.
  router.get('/', ...admin, asyncHandler(async (req, res) => {
    const locationId = req.query.locationId === undefined ? null : parseId(req.query.locationId);
    const agentId = req.query.agentId === undefined ? null : parseId(req.query.agentId);
    if (req.query.locationId !== undefined && locationId === null) {
      return res.status(400).json({ error: 'locationId must be a positive integer' });
    }
    if (req.query.agentId !== undefined && agentId === null) {
      return res.status(400).json({ error: 'agentId must be a positive integer' });
    }

    let profiles;
    if (locationId !== null && typeof snmpProfilesRepo.listForLocation === 'function') {
      profiles = await snmpProfilesRepo.listForLocation(locationId);
    } else if (agentId !== null && typeof snmpProfilesRepo.listForAgent === 'function') {
      profiles = await snmpProfilesRepo.listForAgent(agentId);
    } else {
      profiles = await snmpProfilesRepo.list();
    }
    // How many devices each profile is named by. An admin about to delete one
    // should see how many switches stop being polled.
    const withCounts = [];
    for (const p of profiles) {
      let devices = 0;
      try { devices = await snmpProfilesRepo.deviceCount(p.id); } catch { devices = 0; }
      withCounts.push({ ...p, devices });
    }
    return res.json({ profiles: withCounts });
  }));

  // The SITE's order of preference across the communities assigned to it.
  //
  // A PUT on the site rather than a field on the community: the order is a fact
  // about the site ("at Aarhus, the core community before the access one"), and
  // writing it from one community's side could only say where that one sits.
  //
  // Mounted before `/:id` so `order` is never read as an id.
  router.put('/order/:locationId', ...admin, asyncHandler(async (req, res) => {
    const locationId = parseId(req.params.locationId);
    if (locationId === null) return res.status(400).json({ error: 'locationId must be a positive integer' });
    if (typeof snmpProfilesRepo.setLocationOrder !== 'function') {
      return res.status(404).json({ error: 'Ordering is not available in this build' });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const ids = Array.isArray(body.profileIds) ? body.profileIds : null;
    if (!ids || ids.some((n) => !Number.isInteger(Number(n)) || Number(n) < 1)) {
      return res.status(400).json({ error: 'Validation failed', details: { profileIds: 'profileIds must be an array of positive integers' } });
    }
    if (locationsRepo && !(await locationsRepo.findById(locationId))) {
      return res.status(404).json({ error: 'Location not found' });
    }
    try {
      const order = await snmpProfilesRepo.setLocationOrder(locationId, ids.map(Number));
      await audit(req, 'snmp_profile.order', locationId, `site ${locationId}: ${order.join(' > ')}`);
      return res.json({ ok: true, profileIds: order });
    } catch (err) {
      // A partial order leaves the rest somewhere nobody chose, and "somewhere
      // nobody chose" is what decides which credential a switch is polled with.
      if (err && err.code === 'SNMP_ORDER_MISMATCH') {
        return res.status(400).json({ error: 'Validation failed', details: { profileIds: err.message } });
      }
      throw err;
    }
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

    const unknown = await unknownAssignment(value);
    if (unknown) return res.status(404).json({ error: unknown });

    const existing = await snmpProfilesRepo.findByName(value.name);
    if (existing) {
      return res.status(409).json({ error: 'A profile with that name already exists', profileId: existing.id });
    }

    const profile = await snmpProfilesRepo.create(value);
    await audit(req, 'snmp_profile.create', profile.id,
      `${profile.name} (v${profile.version}), ${(value.locationIds || []).length} site(s), `
      + `${(value.agentIds || []).length} agent(s)`);
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

    const unknown = await unknownAssignment(value);
    if (unknown) return res.status(404).json({ error: unknown });

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
    // The assignments go with it (ON DELETE CASCADE) — so the agents that were
    // granted it lose that grant, which is the other half of what stops being
    // polled and is worth saying in the trail.
    await audit(req, 'snmp_profile.delete', id,
      `${profile.name}, ${devices} device(s) fall back, `
      + `${(profile.locationIds || []).length} site assignment(s) removed`);
    res.json({ ok: true, devicesAffected: devices });
  }));

  return router;
}

module.exports = { createSnmpProfilesRouter };
