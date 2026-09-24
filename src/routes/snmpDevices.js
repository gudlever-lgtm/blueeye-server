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
const POLL_REPLY_TIMEOUT_MS = 20000;

// The agent's poll-snmp command-result (agent 0.39+, PROTOCOL.md), field by
// field: it is input from an agent and goes straight to a browser, so only
// bounded counts, booleans and one short sentence pass. The per-device `snmp`
// and `counters` breakdowns stay out — they can be long, and the table the
// poll refreshes already shows them.
function pollResultOf(reply) {
  const count = (v) => (Number.isInteger(v) && v >= 0 && v <= 100000 ? v : null);
  const bool = (v) => (typeof v === 'boolean' ? v : null);
  return {
    devices: count(reply.devices),
    polled: count(reply.polled),
    failed: count(reply.failed),
    configRefreshed: bool(reply.configRefreshed),
    deviceAssigned: bool(reply.deviceAssigned),
    detail: typeof reply.detail === 'string' && reply.detail.trim() ? reply.detail.trim().slice(0, 200) : null,
    error: reply.ok === false && typeof reply.error === 'string' ? reply.error.slice(0, 200) : null,
  };
}

function createSnmpDevicesRouter({
  snmpDevicesRepo,
  fdbEntriesRepo = null,
  snmpNeighborsRepo = null,
  deviceInterfacesRepo = null,
  counterSamplesRepo = null,
  // A polled router's ARP table (migration 125) and the site names, for the
  // device page. Both optional: without them the page simply has less on it.
  deviceArpRepo = null,
  locationsRepo = null,
  agentsRepo,
  agentCommander = null,
  auditLogger = null,
  logger = null,
  // How long "Poll now" waits for the agent's command-result before answering
  // 202 (still polling). The agent re-reads its config (<= 5 s) and then walks
  // every assigned switch, so this is well above one device's cycle.
  pollTimeoutMs = POLL_REPLY_TIMEOUT_MS,
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
    // The ports themselves. Best-effort like the two above, and for the same
    // reason: the poll state is worth opening the page for on its own.
    let interfaces = [];
    try {
      if (deviceInterfacesRepo) interfaces = await deviceInterfacesRepo.listForDevice(id, { limit: 1000 });
    } catch (err) {
      if (logger) logger.warn(`snmp-devices: interfaces unavailable for ${id} (${err.message})`);
    }
    // VLAN names the switch reported (migration 117). Best-effort like the
    // rest: a page without its VLAN labels is still worth opening.
    let vlans = [];
    try {
      if (fdbEntriesRepo && typeof fdbEntriesRepo.listVlans === 'function') vlans = await fdbEntriesRepo.listVlans(id);
    } catch (err) {
      if (logger) logger.warn(`snmp-devices: vlan names unavailable for ${id} (${err.message})`);
    }
    // The router's ARP table (IP-MIB, collect 'arp') — newest first and
    // bounded, with the true size beside it. Best-effort like the rest.
    let arp = [];
    let arpTotal = 0;
    try {
      if (deviceArpRepo && typeof deviceArpRepo.listForDevice === 'function') {
        arp = await deviceArpRepo.listForDevice(id, { limit: 500 });
        arpTotal = typeof deviceArpRepo.countForDevice === 'function'
          ? await deviceArpRepo.countForDevice(id) : arp.length;
      }
    } catch (err) {
      if (logger) logger.warn(`snmp-devices: ARP table unavailable for ${id} (${err.message})`);
    }
    // Every chassis and module the device reported (ENTITY-MIB).
    let inventory = [];
    try {
      if (typeof snmpDevicesRepo.listInventory === 'function') inventory = await snmpDevicesRepo.listInventory(id);
    } catch (err) {
      if (logger) logger.warn(`snmp-devices: inventory unavailable for ${id} (${err.message})`);
    }
    // The site's NAME, so the page can say "Aarhus · rack B" without a second
    // request. Null when the device has no site or the name cannot be read.
    let siteName = null;
    try {
      if (device.locationId != null && locationsRepo && typeof locationsRepo.findById === 'function') {
        const loc = await locationsRepo.findById(device.locationId);
        siteName = loc ? loc.name : null;
      }
    } catch (err) {
      if (logger) logger.warn(`snmp-devices: site name unavailable for ${id} (${err.message})`);
    }
    res.json({
      device, siteName, fdb, fdbTotal, neighbours, interfaces, vlans, arp, arpTotal, inventory,
    });
  }));

  // The port table on its own, for a screen that wants it without the
  // forwarding table beside it. 404 for an unknown device rather than an empty
  // list: "this switch has no ports" and "there is no such switch" are
  // different answers.
  router.get('/:id/interfaces', ...viewer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const device = await snmpDevicesRepo.findById(id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!deviceInterfacesRepo) return res.status(503).json({ error: 'Interface inventory is not configured' });
    const interfaces = await deviceInterfacesRepo.listForDevice(id, { limit: 1000 });
    res.json({ deviceId: id, interfaces });
  }));

  // The newest counter sample for every port on a device — the per-switch port
  // table with its rates on it. 404 for an unknown device; 503 when counters
  // are not configured at all, which is a different answer from "no data".
  router.get('/:id/counters', ...viewer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const device = await snmpDevicesRepo.findById(id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!counterSamplesRepo) return res.status(503).json({ error: 'Counter collection is not configured' });

    const samples = await counterSamplesRepo.latestWithNames(id);
    // The TSDB variant cannot join the port name (it lives in MySQL), so the
    // decoration happens here for both — one read either way.
    let names = new Map();
    if (deviceInterfacesRepo) {
      try {
        const ports = await deviceInterfacesRepo.listForDevice(id, { limit: 4096 });
        names = new Map(ports.map((p) => [p.id, p]));
      } catch (err) {
        if (logger) logger.warn(`snmp-devices: port names unavailable for ${id} (${err.message})`);
      }
    }
    res.json({
      deviceId: id,
      counters: samples.map((sample) => {
        const port = names.get(sample.interfaceId);
        return {
          ...sample,
          ifName: sample.ifName ?? (port ? port.ifName : null),
          ifAlias: port ? port.ifAlias : null,
          speedMbps: port ? port.speedMbps : null,
          operStatus: port ? port.operStatus : null,
          adminStatus: port ? port.adminStatus : null,
        };
      }),
    });
  }));

  // One port's series over a window. The chart.
  router.get('/:id/interfaces/:interfaceId/series', ...viewer, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const interfaceId = parseId(req.params.interfaceId);
    if (id === null || interfaceId === null) {
      return res.status(400).json({ error: 'id and interfaceId must be positive integers' });
    }
    const device = await snmpDevicesRepo.findById(id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!counterSamplesRepo) return res.status(503).json({ error: 'Counter collection is not configured' });

    // The port must belong to THIS device. Without the check, an interface id
    // from another switch would return its series under this device's page.
    if (deviceInterfacesRepo) {
      const port = await deviceInterfacesRepo.findById(interfaceId);
      if (!port || Number(port.deviceId) !== id) {
        return res.status(404).json({ error: 'Interface not found on that device' });
      }
    }

    const minutes = Number(req.query.minutes);
    const window = Number.isInteger(minutes) && minutes >= 5 && minutes <= 20160 ? minutes : 240;
    const to = new Date();
    const from = new Date(to.getTime() - window * 60 * 1000);
    const out = await counterSamplesRepo.series(interfaceId, { from, to, maxPoints: 500 });
    res.json({ deviceId: id, interfaceId, minutes: window, ...out });
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
        category: 'snmp',
        action: 'snmp_device.create',
        target: String(device.id),
        detail: `${device.host}${device.displayName ? ` (${device.displayName})` : ''}`,
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
        category: 'snmp',
        action: 'snmp_device.update',
        target: String(id),
        // WHICH fields changed, never their values: the community is one of
        // them, and naming the fields is what makes the trail useful.
        detail: `${device.host} — changed: ${Object.keys(value).join(', ')}`,
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
        category: 'snmp',
        action: 'snmp_device.delete',
        target: String(id),
        detail: existing.host,
      });
    }
    res.status(204).end();
  }));

  // Asks the polling agent to run a cycle now. operator+, because it changes no
  // configuration — it only brings forward work the agent would do anyway.
  //
  // The command goes out CORRELATED (sendCommandAndWait, the path ping and
  // diagnose use) and the agent's command-result — how many devices it holds,
  // how many answered, whether THIS device is one of them — comes back in the
  // response. Sent uncorrelated, as it was, the socket had no id to match the
  // reply to and dropped it, so "Poll now" could never say "this device is not
  // assigned to that agent" or "0 of 2 answered".
  //
  // 200 with `result` when the agent answered within the bound. 202 when it
  // did not: the cycle is still running (a slow switch, a config re-read of up
  // to 5 s), or the agent predates the reply — its data still arrives on the
  // ingest path, and 202 says exactly that rather than claiming a refresh.
  router.post('/:id/poll', ...operator, asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const device = await snmpDevicesRepo.findById(id);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (device.agentId == null) {
      return res.status(409).json({ error: 'This device has no polling agent assigned' });
    }
    if (!agentCommander || typeof agentCommander.sendCommandAndWait !== 'function') {
      return res.status(503).json({ error: 'No agent channel is configured' });
    }
    const out = await agentCommander.sendCommandAndWait(device.agentId, { name: 'poll-snmp', deviceId: id }, { timeoutMs: pollTimeoutMs });
    if (!out || !out.delivered) {
      return res.status(409).json({ error: 'The polling agent is not connected' });
    }
    if (out.timedOut || !out.reply) {
      return res.status(202).json({ ok: true, pending: true, deviceId: id, agentId: device.agentId });
    }
    res.json({ ok: out.reply.ok !== false, pending: false, deviceId: id, agentId: device.agentId, result: pollResultOf(out.reply) });
  }));

  return router;
}

module.exports = { createSnmpDevicesRouter, POLL_REPLY_TIMEOUT_MS };
