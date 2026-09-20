'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../auth/middleware');
const { ROLES } = require('../auth/roles');
const { parseId } = require('../validation/locationValidation');
const { validateSnmpDevice } = require('../validation/snmpDeviceValidation');
const { denyReason, explainReason } = require('../serviceTests/security/hostPolicy');

// The SNMP device inventory: which switches the server polls, and through which
// agent.
//
// RBAC. Reading is viewer+ (the device list is inventory, the same class as the
// agent list). WRITING IS ADMIN: adding a device points the server's polling at
// an address and stores a credential, which is an admin's decision, not an
// operator's. The one operator+ action is "poll now", which changes no
// configuration — it only asks an agent to do sooner what it would do anyway.
//
// THE HOST CHECK RUNS TWICE. Once here on write, and again in the agent-config
// read before a device is handed to an agent to poll. This is the same
// two-check rule the Service Assurance SSRF allowlist follows, and for the same
// reason: a row written before the deny-list changed must not keep reaching a
// target the policy now refuses.
//
// What is refused is deliberately narrow — loopback, link-local (including
// cloud metadata) and broadcast. RFC1918 is NOT refused, because a switch at
// 10.14.0.11 is the entire point of this feature.
function createSnmpDevicesRouter({
  snmpDevicesRepo,
  fdbEntriesRepo = null,
  snmpNeighborsRepo = null,
  agentsRepo,
  agentCommander = null,
  auditLogger = null,
  logger = null,
}) {
  const router = express.Router();
  const viewer = [requireAuth, requireRole(ROLES.VIEWER, ROLES.OPERATOR, ROLES.ADMIN)];
  const operator = [requireAuth, requireRole(ROLES.OPERATOR, ROLES.ADMIN)];
  const admin = [requireAuth, requireRole(ROLES.ADMIN)];

  // Refuses an address the server must never be pointed at. Returns an error
  // string, or null when the host is acceptable.
  function hostRefusal(host) {
    const reason = denyReason(host);
    if (!reason) return null;
    return explainReason
      ? explainReason(reason, host)
      : 'that address can never be polled';
  }

  router.get('/', ...viewer, asyncHandler(async (req, res) => {
    const devices = await snmpDevicesRepo.list({});
    // Attach the polling agent's name in one read rather than per row.
    let names = new Map();
    try {
      const agents = await agentsRepo.findAll();
      names = new Map(agents.map((a) => [Number(a.id), a.display_name || a.hostname]));
    } catch (err) {
      if (logger) logger.warn(`snmp-devices: could not resolve agent names (${err.message})`);
    }
    res.json({
      devices: devices.map((d) => ({
        ...d,
        agentName: d.agentId == null ? null : (names.get(d.agentId) || null),
      })),
    });
  }));

  router.get('/:id', ...viewer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const device = await snmpDevicesRepo.findById(id);
    if (!device) return res.status(404).json({ error: 'Device not found' });

    // The forwarding table and the neighbours this device reported. Both are
    // best-effort: a device page that cannot show its port table is still worth
    // opening for the poll state and the error.
    let fdb = [];
    let neighbours = [];
    let fdbTotal = 0;
    try {
      if (fdbEntriesRepo) {
        fdb = await fdbEntriesRepo.listForDevice(id, { limit: 500 });
        fdbTotal = await fdbEntriesRepo.countForDevice(id);
      }
    } catch (err) {
      if (logger) logger.warn(`snmp-devices: forwarding table unavailable for ${id} (${err.message})`);
    }
    try {
      if (snmpNeighborsRepo) neighbours = await snmpNeighborsRepo.listForDevice(id, { limit: 200 });
    } catch (err) {
      if (logger) logger.warn(`snmp-devices: neighbours unavailable for ${id} (${err.message})`);
    }
    res.json({ device, fdb, fdbTotal, neighbours });
  }));

  router.post('/', ...admin, asyncHandler(async (req, res) => {
    const { value, errors } = validateSnmpDevice(req.body);
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    const refusal = hostRefusal(value.host);
    if (refusal) return res.status(400).json({ error: 'Validation failed', details: { host: refusal } });

    if (value.agentId != null) {
      const agent = await agentsRepo.findById(value.agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
    }

    // One row per address per port: two admins adding the same switch would
    // otherwise double every poll and split its history.
    const existing = await snmpDevicesRepo.findByHost(value.host, value.port ?? 161);
    if (existing) {
      return res.status(409).json({ error: 'A device with that address and port already exists', deviceId: existing.id });
    }

    const device = await snmpDevicesRepo.create(value);
    if (auditLogger) {
      await auditLogger.record(req, {
        action: 'snmp_device.create',
        targetType: 'snmp_device',
        targetId: String(device.id),
        targetLabel: device.host,
      });
    }
    res.status(201).json({ device });
  }));

  router.patch('/:id', ...admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const existing = await snmpDevicesRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Device not found' });

    const { value, errors } = validateSnmpDevice(req.body, { partial: true });
    if (errors) return res.status(400).json({ error: 'Validation failed', details: errors });

    if (value.host !== undefined) {
      const refusal = hostRefusal(value.host);
      if (refusal) return res.status(400).json({ error: 'Validation failed', details: { host: refusal } });
    }
    if (value.agentId != null) {
      const agent = await agentsRepo.findById(value.agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
    }

    const device = await snmpDevicesRepo.update(id, value);
    if (auditLogger) {
      await auditLogger.record(req, {
        action: 'snmp_device.update',
        targetType: 'snmp_device',
        targetId: String(id),
        targetLabel: device.host,
      });
    }
    res.json({ device });
  }));

  router.delete('/:id', ...admin, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const existing = await snmpDevicesRepo.findById(id);
    if (!existing) return res.status(404).json({ error: 'Device not found' });

    await snmpDevicesRepo.remove(id);
    if (auditLogger) {
      await auditLogger.record(req, {
        action: 'snmp_device.delete',
        targetType: 'snmp_device',
        targetId: String(id),
        targetLabel: existing.host,
      });
    }
    res.status(204).end();
  }));

  // Asks the polling agent to run a cycle now. operator+, because it changes no
  // configuration — it only brings forward work the agent would do anyway.
  //
  // 202: the agent does the polling, so the result arrives on its own ingest
  // path a moment later. Answering 200 would claim the table had been refreshed
  // by the time this returned, which it has not.
  router.post('/:id/poll', ...operator, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const device = await snmpDevicesRepo.findById(id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (device.agentId == null) {
      return res.status(409).json({ error: 'This device has no polling agent assigned' });
    }
    if (!agentCommander || typeof agentCommander.sendCommand !== 'function') {
      return res.status(503).json({ error: 'No agent channel is configured' });
    }
    const sent = agentCommander.sendCommand(device.agentId, { name: 'poll-snmp', deviceId: id });
    if (!sent) {
      return res.status(409).json({ error: 'The polling agent is not connected' });
    }
    res.status(202).json({ ok: true, deviceId: id, agentId: device.agentId });
  }));

  return router;
}

module.exports = { createSnmpDevicesRouter };
