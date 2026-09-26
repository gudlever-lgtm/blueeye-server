'use strict';

const {
  linksWithBothMtus, detectLinkMtuMismatch, buildLinkMtuFinding, REFRACTORY_MINUTES,
} = require('./linkMtuMismatch');

// Runs the link-MTU mismatch rule over what the topology poll already stores,
// and turns a verdict into a finding.
//
// WHERE THE FACTS COME FROM. Nothing here polls anything:
//
//   who is cabled to whom   snmp_neighbors (migration 106) — LLDP and CDP as
//                           the switches themselves report it, resolved to
//                           device pairs by src/topology/l2Path.js's
//                           buildSwitchGraph, which is the same resolution the
//                           topology map and the L2 path already draw. A looser
//                           one would name the wrong cable.
//   what each port carries  device_interfaces.mtu (migration 139), read from
//                           IF-MIB ifMtu on every topology poll.
//
// WHEN IT RUNS. After a topology cycle, because that is when both halves have
// just been re-read — but NOT after every one. Unlike a loop, a mismatch is a
// configuration: it lasts until somebody changes a setting, and it is no truer
// a minute after the poll that found it. So the check is throttled to
// `minIntervalMs`, and the finding itself is refracted per link on top of that,
// because a fault that cannot change on its own must not be raised sixty times
// a day.
//
// THE READS ARE FLEET-WIDE, which is why the throttle matters. A link has two
// ends and they belong to two different switches, which may well be polled by
// two different agents — so the question cannot be answered from one device's
// rows. Twenty switches of forty-eight ports is a few thousand small rows; at
// the default interval that is a handful of reads an hour.

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// How often the fleet-wide check may run at all, however many topology cycles
// land in between.
const DEFAULT_MIN_INTERVAL_MS = 15 * 60 * 1000;

// Bounds on the reads. Both are the repositories' own defaults' order of
// magnitude; they are stated here so one enormous estate degrades into a
// partial check rather than an unbounded query.
const NEIGHBOUR_LIMIT = 20000;
const INTERFACE_LIMIT = 50000;

function createLinkMtuService({
  snmpDevicesRepo = null,
  snmpNeighborsRepo = null,
  deviceInterfacesRepo = null,
  // Where a rule-based switch finding goes (./findingSink.js). Without it the
  // check is simply not run: there is nowhere for the answer to go.
  findingSink = null,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  logger = silentLogger,
  now = () => new Date(),
} = {}) {
  const log = logger || silentLogger;
  // linkId -> ms of the last finding. In memory, like every other refractory
  // period on this path: a restart re-raising a standing mismatch once is the
  // correct behaviour, not a bug.
  const raised = new Map();
  let lastRunMs = 0;

  function ready() {
    return Boolean(findingSink && snmpDevicesRepo && snmpNeighborsRepo && deviceInterfacesRepo
      && typeof snmpNeighborsRepo.listAll === 'function'
      && typeof deviceInterfacesRepo.listAll === 'function');
  }

  // Runs the check. Returns the number of findings raised — 0 when it was
  // throttled, unwired, or found nothing.
  //
  // `force` skips the interval throttle (not the per-link refractory): for the
  // caller that has a reason to ask now.
  async function check({ agentId = null, force = false } = {}) {
    if (!ready()) return 0;
    const at = now();
    const ms = at.getTime();
    if (!force && lastRunMs && ms - lastRunMs < minIntervalMs) return 0;
    lastRunMs = ms;

    let devices;
    let neighbours;
    let interfaces;
    let deviceMacs;
    try {
      [devices, neighbours, interfaces, deviceMacs] = await Promise.all([
        snmpDevicesRepo.list({}),
        snmpNeighborsRepo.listAll({ limit: NEIGHBOUR_LIMIT }),
        deviceInterfacesRepo.listAll({ limit: INTERFACE_LIMIT }),
        typeof deviceInterfacesRepo.listMacs === 'function'
          ? deviceInterfacesRepo.listMacs({})
          : Promise.resolve([]),
      ]);
    } catch (err) {
      log.warn(`link-mtu: could not read the topology (${err.message})`);
      return 0;
    }

    const links = linksWithBothMtus({ devices, neighbours, deviceMacs, interfaces });
    // interfaceId for the smaller end, so the finding hangs off the port a
    // technician will open. Absent is fine — the finding names the port either
    // way; the id is what lets the UI link straight to it.
    const idByPort = new Map();
    for (const i of interfaces || []) {
      if (i && i.id != null && i.deviceId != null && i.ifName) {
        idByPort.set(`${Number(i.deviceId)}|${String(i.ifName).trim().toLowerCase()}`, Number(i.id));
      }
    }

    let count = 0;
    for (const link of links) {
      const verdict = detectLinkMtuMismatch(link);
      if (!verdict) continue;
      const last = raised.get(link.id);
      if (last && ms - last < REFRACTORY_MINUTES * 60 * 1000) continue;
      const finding = buildLinkMtuFinding(link, verdict, {
        // The agent that submitted the cycle, like every other switch finding.
        // Null only when nothing asked on an agent's behalf, and then the
        // polling agent of the smaller end's device is the honest answer.
        hostId: agentId ?? deviceAgent(devices, link.low.deviceId) ?? 'server',
        interfaceId: idByPort.get(`${link.low.deviceId}|${String(link.low.ifName).trim().toLowerCase()}`) ?? null,
        at,
      });
      try {
        if (await findingSink.emit(finding)) {
          raised.set(link.id, ms);
          count += 1;
        }
      } catch (err) {
        log.warn(`link-mtu: finding failed for link ${link.id} (${err.message})`);
      }
    }
    return count;
  }

  function deviceAgent(devices, deviceId) {
    const d = (devices || []).find((x) => x && Number(x.id) === Number(deviceId));
    return d && d.agentId != null ? String(d.agentId) : null;
  }

  return { check };
}

module.exports = { createLinkMtuService, DEFAULT_MIN_INTERVAL_MS };
