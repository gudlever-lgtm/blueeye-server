'use strict';

const { computeSample, detectReboot } = require('./counterDelta');
const {
  detectDuplexMismatch, buildDuplexFinding, REFRACTORY_MINUTES: DUPLEX_REFRACTORY_MINUTES,
} = require('./duplexMismatch');

// Stores one SNMP counter cycle: a snapshot of every interface counter on each
// switch the submitting agent polls, turned into rates against the previous
// snapshot.
//
// THE OWNERSHIP CHECK IS THE SAME ONE the topology ingest makes, for the same
// reason: an agent may only write the devices the server assigned to IT.
//
// WHAT IS NEW HERE is that this ingest has to look BACKWARDS. A counter is
// meaningless alone — the rate is the difference against the last reading — so
// every cycle reads the previous sample per port before it writes. One indexed
// query per device, not one per port.
//
// AND IT HAS TO KNOW WHEN NOT TO SUBTRACT. Three cases, all of which produce a
// plausible-looking number if nobody checks:
//
//   * The device rebooted (sysUpTime, checked against the elapsed real time).
//   * The port's ifIndex moved (reported by the interface upsert, mig. 108).
//   * The gap between readings is too long or too short to mean anything.
//
// The arithmetic and those decisions live in counterDelta.js, which is pure and
// tested on its own. This file is the plumbing: who owns what, what was the
// previous reading, and which rows to write.
function createSnmpCounterIngest({
  snmpDevicesRepo,
  deviceInterfacesRepo,
  counterSamplesRepo,
  // The analysis pipeline. Optional: without it the samples are stored and
  // nothing evaluates them, which is exactly the state per-interface counters
  // were in before this — collected, shown, never analysed.
  analysisPipeline = null,
  // Where a rule-based switch finding goes (./findingSink.js). Optional: without
  // it the duplex indicator is simply not raised, and the samples are stored as
  // before.
  findingSink = null,
  logger = null,
  now = () => new Date(),
}) {
  // interfaceId -> ms of the last duplex finding. In memory, like every other
  // refractory period on this path.
  const duplexRaised = new Map();

  // Raises the duplex-mismatch indicator for the rows that show it. Best-effort
  // and after the write, like the detector: the measurement is the record.
  async function checkDuplex(agentId, device, rows, nameById, at) {
    if (!findingSink) return 0;
    let raised = 0;
    for (const r of rows) {
      const verdict = detectDuplexMismatch(r);
      if (!verdict) continue;
      const last = duplexRaised.get(r.interfaceId);
      if (last && at.getTime() - last < DUPLEX_REFRACTORY_MINUTES * 60 * 1000) continue;
      const finding = buildDuplexFinding(r, verdict, {
        hostId: agentId,
        deviceName: device.displayName || device.host,
        ifName: nameById.get(r.interfaceId) || null,
      });
      try {
        if (await findingSink.emit(finding)) {
          duplexRaised.set(r.interfaceId, at.getTime());
          raised += 1;
        }
      } catch (err) {
        if (logger) logger.warn(`snmp-counters: duplex finding failed for device ${device.id} (${err.message})`);
      }
    }
    return raised;
  }

  async function ownedBy(agentId) {
    const rows = await snmpDevicesRepo.list({ agentId });
    return new Map(rows.map((d) => [d.id, d]));
  }

  // Stores one cycle. Returns counts the route reports verbatim.
  async function ingest(agentId, { devices = [], failures = [] } = {}) {
    const owned = await ownedBy(agentId);
    const at = now();

    let stored = 0;
    let samples = 0;
    let findings = 0;
    let refused = 0;
    let unresolved = 0;
    const discontinuities = {};
    const deviceErrors = [];

    for (const d of devices) {
      const device = owned.get(d.deviceId);
      if (!device) {
        refused += 1;
        if (logger) logger.warn(`snmp-counters: agent ${agentId} submitted device ${d.deviceId} it does not poll`);
        continue;
      }

      try {
        // The port inventory, by NAME first and ifIndex second. The name is the
        // identity (migration 108); the index is the fallback for a device
        // whose ifName column the agent could not read.
        const { byName, byIndex } = await deviceInterfacesRepo.idMapForDevice(d.deviceId);
        const previous = await counterSamplesRepo.latestForDevice(d.deviceId);
        const ports = await deviceInterfacesRepo.listForDevice(d.deviceId, { limit: 4096 });
        const speedById = new Map(ports.map((p) => [p.id, p.speedMbps]));
        const nameById = new Map(ports.map((p) => [p.id, p.ifName]));
        // Ports whose ifIndex moved on THIS cycle's topology poll. The
        // interface ingest reported them; a rate across that boundary is two
        // different ports subtracted from each other.
        const renumberedNames = new Set(Array.isArray(d.renumbered) ? d.renumbered : []);

        // Did the device restart since the last counter poll? Read from the
        // device row rather than recomputed from the samples, because the
        // check has to happen before the new rows are written.
        const readAt = d.readAt ? new Date(d.readAt) : at;
        const prevUptimeAt = device.lastUptimeAt ? new Date(device.lastUptimeAt) : null;
        const elapsedDeviceSec = prevUptimeAt ? (readAt.getTime() - prevUptimeAt.getTime()) / 1000 : null;
        const rebooted = detectReboot({
          prevTicks: device.lastUptimeTicks == null ? null : Number(device.lastUptimeTicks),
          nextTicks: d.sysUpTimeTicks == null ? null : Number(d.sysUpTimeTicks),
          elapsedSec: elapsedDeviceSec,
        });

        const rows = [];
        for (const iface of d.interfaces || []) {
          const interfaceId = (iface.ifName && byName.get(iface.ifName))
            || (iface.ifIndex != null && byIndex.get(Number(iface.ifIndex)))
            || null;
          if (!interfaceId) {
            // A counter for a port the inventory has never seen. Dropped, not
            // guessed at: the sample would have nothing to be a measurement OF,
            // and the next topology poll will create the row.
            unresolved += 1;
            continue;
          }

          const prev = previous.get(interfaceId) || null;
          const elapsedSec = prev && prev.ts
            ? (readAt.getTime() - new Date(prev.ts).getTime()) / 1000
            : null;

          const sample = computeSample({
            current: iface,
            previous: prev,
            elapsedSec,
            speedMbps: speedById.get(interfaceId) ?? null,
            rebooted,
            renumbered: renumberedNames.has(iface.ifName),
            hc: d.hc !== false,
          });
          if (sample.discontinuity) {
            discontinuities[sample.discontinuity] = (discontinuities[sample.discontinuity] || 0) + 1;
          }
          rows.push({ ts: readAt, deviceId: d.deviceId, interfaceId, ...sample });
        }

        if (rows.length) {
          samples += await counterSamplesRepo.insertMany(rows);
          // Run the detector over the rates. Best-effort and AFTER the write,
          // like the agent path: the measurement is the record, and an analysis
          // failure must never cost it.
          if (analysisPipeline && typeof analysisPipeline.processDeviceSamples === 'function') {
            try {
              // Decorated with the port name so an explanation reads as a place
              // rather than as an id.
              const named = rows.map((r) => ({ ...r, ifName: nameById.get(r.interfaceId) || null }));
              const found = await analysisPipeline.processDeviceSamples(String(agentId), named);
              findings += found.length;
            } catch (err) {
              if (logger) logger.warn(`snmp-counters: analysis failed for device ${d.deviceId} (${err.message})`);
            }
          }
          findings += await checkDuplex(agentId, device, rows, nameById, at);
        }

        // The device clock, for the NEXT cycle's reboot check. Written after
        // the samples so a failed insert does not move the reference forward.
        await snmpDevicesRepo.recordCounterPoll(d.deviceId, {
          uptimeTicks: d.sysUpTimeTicks ?? null,
          at: readAt,
        });
        stored += 1;
      } catch (err) {
        deviceErrors.push({ deviceId: d.deviceId, error: String(err.message).slice(0, 255) });
        if (logger) logger.warn(`snmp-counters: could not store device ${d.deviceId} (${err.message})`);
      }
    }

    // The agent's own per-device failures. Recorded on the device like the
    // topology path's, so "last answered 41 minutes ago" stays readable.
    let failuresRecorded = 0;
    for (const f of failures) {
      if (!owned.has(f.deviceId)) { refused += 1; continue; }
      try {
        await snmpDevicesRepo.recordPoll(f.deviceId, { ok: false, error: f.error, at });
        failuresRecorded += 1;
      } catch (err) {
        if (logger) logger.warn(`snmp-counters: could not record failure for device ${f.deviceId} (${err.message})`);
      }
    }

    return { stored, samples, findings, unresolved, refused, failuresRecorded, discontinuities, deviceErrors };
  }

  return { ingest };
}

module.exports = { createSnmpCounterIngest };
