'use strict';

const crypto = require('crypto');
const { DEFAULT_FLAP_WINDOW_SECONDS } = require('../health/interfaceStateService');
const { isReversal } = require('../health/interfaceStateDiff');

// Link-state HISTORY for the ports on a polled switch, and the findings a port
// going down or flapping deserves.
//
// WHAT WAS MISSING. `device_interfaces.oper_status` is overwritten by every
// topology poll, and a trap or syslog line saying "Gi1/0/24 went down" only
// ever reached the Device Log. So a switch port could go down, come back, go
// down again all afternoon, and the product had no record that it had changed
// at all — and nothing on the path to an alert, an event case or the changes
// feed.
//
// TWO WAYS A CHANGE IS LEARNED, ONE HISTORY.
//
//   poll   two consecutive topology polls disagree about a port. Reported by
//          the interface upsert (deviceInterfacesRepository.statusChanges).
//   trap / syslog
//          the switch says so as it happens (link.down / link.up /
//          link.admin_down), tied to a polled device by its address and to a
//          port by its name. The port row is updated too, which is what stops
//          the next poll announcing the same change a second time.
//
// Both go into `interface_state_transitions` (migration 118), with the flap
// collapse the agent path already uses (interfaceStateService): a transition
// that reverses the port's previous one inside the window folds onto that row
// as "flapping N×" instead of adding another. The window is the agent path's
// DEFAULT_FLAP_WINDOW_SECONDS — but never shorter than two topology polls,
// because a poll every five minutes cannot see a reversal inside five minutes
// at all, and a flap detector that can never fire is not one.
//
// WHICH CHANGES ARE FINDINGS. Not every one. An access port goes down every
// evening when somebody switches their PC off, and a finding for each of those
// would train everybody to ignore the lot. So:
//
//   * a port FLAPPING (FLAP_FINDING_TRANSITIONS changes inside the window) is
//     always a finding — a link that keeps bouncing is a fault whatever is on
//     the other end;
//   * a port going DOWN is a finding when it is an UPLINK, meaning the switch's
//     own LLDP table has a neighbour on it: another switch, a router, an access
//     point — something with more than one person behind it;
//   * everything else is a row in the changes feed and nothing more.
//
// An administratively disabled port is never a fault. Somebody turned it off.
//
// Best-effort throughout, like every other bookkeeping step on an ingest path.

// How many state changes inside the window make a port "flapping" enough for a
// finding: down, up, down. One bounce is somebody reseating a cable.
const FLAP_FINDING_TRANSITIONS = 3;

// A flap window never wider than this, whatever the poll interval. A device
// polled hourly cannot tell a flap from two unrelated changes, and pretending
// otherwise would call a port that went down at 09:00 and up at 10:30 flapping.
const MAX_FLAP_WINDOW_SECONDS = 30 * 60;

// One finding per port per metric per this long. A port that flaps all
// afternoon is one fault.
const REFRACTORY_MINUTES = 30;

// A port's link state, in the transition vocabulary. NULL means the status says
// nothing about the link (dormant, testing, notPresent, unknown) — and a change
// to or from "nothing" is not a change.
function portState({ adminStatus = null, operStatus = null } = {}) {
  if (adminStatus === 'down') return 'disabled';
  if (operStatus === 'up') return 'ok';
  if (operStatus === 'down' || operStatus === 'lowerLayerDown') return 'down';
  return null;
}

// The new status a device event implies for a port.
function statusFromEvent(eventType, current = {}) {
  if (eventType === 'link.down') return { adminStatus: current.adminStatus === 'down' ? 'down' : 'up', operStatus: 'down' };
  if (eventType === 'link.up') return { adminStatus: 'up', operStatus: 'up' };
  if (eventType === 'link.admin_down') return { adminStatus: 'down', operStatus: 'down' };
  return null;
}

const LINK_EVENTS = ['link.down', 'link.up', 'link.admin_down'];

function severityFor(from, to, uplink) {
  if (to === 'down') return uplink ? 'CRIT' : 'INFO';
  return 'INFO';
}

function summaryFor(deviceName, ifName, from, to, uplinkTo) {
  const where = `${deviceName} ${ifName}`;
  const tail = uplinkTo ? ` (uplink to ${uplinkTo})` : '';
  if (to === 'down') return from === 'disabled' ? `${where} enabled, no link yet${tail}` : `${where} link went down${tail}`;
  if (to === 'disabled') return `${where} administratively shut down${tail}`;
  if (from === 'disabled') return `${where} enabled and link up${tail}`;
  return `${where} link came back up${tail}`;
}

const SOURCE_TEXT = {
  poll: 'seen by the SNMP topology poll',
  trap: 'reported by an SNMP trap from the switch',
  syslog: "reported in the switch's own syslog",
};

function createSwitchPortStateService({
  interfaceStatesRepo,
  deviceInterfacesRepo = null,
  snmpNeighborsRepo = null,
  findingSink = null,
  flapWindowSeconds = DEFAULT_FLAP_WINDOW_SECONDS,
  now = () => new Date(),
  logger = null,
} = {}) {
  // `${interfaceId}|${metric}` -> ms of the last finding. In memory on purpose,
  // like the loop detector's: a restart re-raising one finding is the right
  // failure mode, where persisting a debounce would be a schema for nothing.
  const lastRaised = new Map();

  function deviceLabel(device) {
    return (device && (device.displayName || device.host)) || `device ${device && device.id}`;
  }

  function windowFor(device) {
    const poll = Number(device && device.intervalSec) > 0 ? Number(device.intervalSec) * 2 : 0;
    return Math.min(Math.max(flapWindowSeconds, poll), Math.max(flapWindowSeconds, MAX_FLAP_WINDOW_SECONDS));
  }

  // ifName -> the neighbour on it, from the switch's own LLDP table. The
  // STORED table, not this poll's: a link that just went down has usually
  // taken its LLDP neighbour with it, and "was this an uplink" is a question
  // about before.
  async function uplinksFor(device, neighbours) {
    let list = neighbours;
    if (!Array.isArray(list)) {
      list = [];
      if (snmpNeighborsRepo && typeof snmpNeighborsRepo.listForDevice === 'function') {
        try { list = await snmpNeighborsRepo.listForDevice(device.id, { limit: 512 }); } catch { list = []; }
      }
    }
    const out = new Map();
    for (const n of list || []) {
      const port = n && (n.localIfName || (n.localPort != null ? String(n.localPort) : null));
      if (!port || out.has(port)) continue;
      out.set(port, n.remoteSysName || n.remoteChassisId || 'a neighbour');
    }
    return out;
  }

  function refractory(interfaceId, metric, at) {
    const key = `${interfaceId}|${metric}`;
    const last = lastRaised.get(key);
    if (last && at.getTime() - last < REFRACTORY_MINUTES * 60 * 1000) return true;
    lastRaised.set(key, at.getTime());
    return false;
  }

  function buildFinding({
    agentId, device, port, metric, severity, observed, explanation, labels, at, windowSec,
  }) {
    const hostId = String(agentId);
    return {
      id: crypto.randomUUID(),
      // The observing agent, so every per-agent read finds it, with the switch
      // and the port beside it (migration 110) — the same shape the counter
      // findings have.
      hostId,
      deviceId: Number(device.id),
      interfaceId: Number(port.id),
      metric,
      severity,
      kind: 'THRESHOLD',
      observed,
      baseline: null,
      deviation: null,
      window: [new Date(at.getTime() - windowSec * 1000), at],
      explanation,
      evidence: [{
        hostId,
        deviceId: Number(device.id),
        interfaceId: Number(port.id),
        metric,
        value: observed,
        ts: at,
        labels,
      }],
      correlatedWith: [],
      createdAt: at,
      acked: false,
    };
  }

  async function raise(finding) {
    if (!findingSink) return null;
    try { return await findingSink.emit(finding); } catch (err) {
      if (logger) logger.warn(`switch-port: could not raise ${finding.metric} (${err.message})`);
      return null;
    }
  }

  // Records one port's change. The shared tail of both paths.
  async function recordTransition({
    agentId, device, port, from, to, operStatus, source, uplinkTo, at,
  }) {
    const out = { transition: null, flapped: false, findings: [] };
    const name = deviceLabel(device);
    const windowSec = windowFor(device);
    const since = new Date(at.getTime() - windowSec * 1000);

    let previous = null;
    try {
      previous = await interfaceStatesRepo.latestForDeviceIface({ deviceId: device.id, iface: port.ifName, since });
    } catch (err) {
      if (logger) logger.warn(`switch-port: flap lookup failed for device ${device.id} (${err.message})`);
    }
    const asRow = previous
      ? { iface: previous.iface, from_status: previous.fromStatus, to_status: previous.toStatus }
      : null;
    const candidate = { iface: port.ifName, from_status: from, to_status: to };

    let flapCount = 0;
    if (asRow && (isReversal(asRow, candidate) || previous.flapping)) {
      // Same collapse as the agent path: once a port is known to be bouncing
      // inside the window, every further change belongs to that one row.
      await interfaceStatesRepo.markFlapping(previous.id, { at });
      out.flapped = true;
      flapCount = Number(previous.flapCount || 1) + 1;
    } else {
      const t = {
        iface: port.ifName,
        deviceId: Number(device.id),
        interfaceId: Number(port.id),
        fromStatus: from,
        toStatus: to,
        operStatus: operStatus || null,
        source,
        severity: severityFor(from, to, Boolean(uplinkTo)),
        summary: summaryFor(name, port.ifName, from, to, uplinkTo),
        detectedAt: at,
      };
      t.id = await interfaceStatesRepo.insertTransition(agentId, t);
      out.transition = t;
    }

    const labels = {
      iface: port.ifName, device: name, source, from, to, uplinkTo: uplinkTo || null,
    };

    // A port that keeps bouncing is a fault whatever is behind it.
    if (flapCount >= FLAP_FINDING_TRANSITIONS) {
      const metric = `if.${port.id}.link.flapping`;
      if (!refractory(port.id, metric, at)) {
        const behind = uplinkTo
          ? ` It is the uplink to ${uplinkTo}, so everything reached through it loses its path each time.`
          : '';
        const finding = await raise(buildFinding({
          agentId, device, port, metric,
          severity: uplinkTo ? 'CRIT' : 'WARN',
          observed: flapCount,
          windowSec,
          at,
          labels: { ...labels, flapCount },
          explanation:
            `Port ${port.ifName} on ${name} has changed link state ${flapCount} times within `
            + `${Math.round(windowSec / 60)} minutes (latest ${SOURCE_TEXT[source] || source}).${behind} `
            + 'A link that keeps bouncing is usually a failing cable, optic or connector, or a speed/duplex '
            + 'negotiation fault on one end, and every bounce drops the traffic on it for a moment.',
        }));
        if (finding) out.findings.push(finding);
      }
      return out;
    }

    // An uplink going down cuts off whatever is behind it.
    if (!out.flapped && to === 'down' && from === 'ok' && uplinkTo) {
      const metric = `if.${port.id}.link.down`;
      if (!refractory(port.id, metric, at)) {
        const finding = await raise(buildFinding({
          agentId, device, port, metric,
          severity: 'CRIT',
          observed: 0,
          windowSec,
          at,
          labels,
          explanation:
            `Port ${port.ifName} on ${name} went down (${SOURCE_TEXT[source] || source}). It is the link to `
            + `${uplinkTo}, known from the switch's own LLDP table, so whatever is reached through ${uplinkTo} `
            + 'is cut off from this switch unless another path exists. The port is administratively up, so '
            + 'this is a fault — the cable, an optic or the far end — not somebody shutting it down.',
        }));
        if (finding) out.findings.push(finding);
      }
    }
    return out;
  }

  // The POLL path: a topology cycle for one device, and the ports whose status
  // differs from what the previous poll stored.
  async function recordPollChanges({ agentId, device, changes = [], neighbours = null, at = now() } = {}) {
    const result = { transitions: 0, flapped: 0, findings: [] };
    if (!interfaceStatesRepo || !device || !Array.isArray(changes) || !changes.length) return result;
    const uplinks = await uplinksFor(device, neighbours);
    for (const c of changes) {
      const from = portState(c.from);
      const to = portState(c.to);
      // A change to or from a status that says nothing about the link, or a
      // port whose previous state we never knew, is not a transition.
      if (from == null || to == null || from === to) continue;
      try {
        const out = await recordTransition({
          agentId, device, port: { id: c.interfaceId, ifName: c.ifName },
          from, to, operStatus: c.to.operStatus, source: 'poll',
          uplinkTo: uplinks.get(c.ifName) || null, at,
        });
        if (out.transition) result.transitions += 1;
        if (out.flapped) result.flapped += 1;
        result.findings.push(...out.findings);
      } catch (err) {
        if (logger) logger.warn(`switch-port: could not record ${c.ifName} on device ${device.id} (${err.message})`);
      }
    }
    return result;
  }

  // The EVENT path: one link.* event from a trap or syslog, already tied to a
  // polled device and one of its ports. `port` is the device_interfaces row.
  async function recordEvent({ agentId, device, port, eventType, source = 'syslog', at = now() } = {}) {
    const result = { transition: false, flapped: false, findings: [] };
    if (!interfaceStatesRepo || !device || !port || !LINK_EVENTS.includes(eventType)) return result;
    const next = statusFromEvent(eventType, port);
    const from = portState(port);
    const to = portState(next);
    // The same state the port is already in: the trap and the syslog line for
    // one event, or an event the last poll already recorded.
    if (to == null || from === to) return result;

    // The port row is the latest known state. Updating it is what stops the
    // next poll reporting this change again as its own.
    if (deviceInterfacesRepo && typeof deviceInterfacesRepo.setStatus === 'function') {
      try { await deviceInterfacesRepo.setStatus(port.id, next); } catch (err) {
        if (logger) logger.warn(`switch-port: could not update port ${port.id} (${err.message})`);
      }
    }
    // A port we had no usable state for before is now known; that first known
    // state is not a change.
    if (from == null) return result;

    const uplinks = await uplinksFor(device, null);
    const out = await recordTransition({
      agentId, device, port, from, to, operStatus: next.operStatus, source,
      uplinkTo: uplinks.get(port.ifName) || null, at,
    });
    result.transition = Boolean(out.transition);
    result.flapped = out.flapped;
    result.findings = out.findings;
    return result;
  }

  return { recordPollChanges, recordEvent };
}

module.exports = {
  createSwitchPortStateService,
  portState,
  statusFromEvent,
  LINK_EVENTS,
  FLAP_FINDING_TRANSITIONS,
  MAX_FLAP_WINDOW_SECONDS,
  REFRACTORY_MINUTES,
};
