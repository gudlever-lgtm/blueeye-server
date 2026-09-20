'use strict';

// Stores one SNMP topology cycle: the forwarding tables, LLDP neighbours and
// VLAN names an agent read from the switches assigned to it.
//
// THE OWNERSHIP CHECK IS THE POINT OF THIS FILE. An agent submits results for
// device ids, and it must only be able to write the devices the server assigned
// to IT. Without that, any agent token could rewrite the forwarding table of
// any switch in the fleet — which is both a data-integrity problem and a way to
// make a technician walk to the wrong building. Every submitted deviceId is
// checked against `snmp_devices.agent_id` before a single row is written, and a
// mismatch is counted and dropped rather than failing the batch: an agent whose
// assignment changed mid-cycle is a normal race, not an attack.
//
// PER-DEVICE ISOLATION, ALL THE WAY DOWN. One device's rows failing to store
// must not lose the others. Each device is written in its own try, and the
// response says how many were stored, how many were refused and why.

function createSnmpTopologyIngest({
  snmpDevicesRepo,
  fdbEntriesRepo,
  // Switch-seen LLDP goes to its OWN table, not `lldp_neighbors` (063): that
  // one keys on an `agents` id and these rows belong to an `snmp_devices` id.
  // Reusing it would attribute a switch's neighbours to whichever agent shared
  // the number, which does not throw — it just draws the wrong network.
  snmpNeighborsRepo = null,
  // The ports themselves. The agent has been sending this list since stage 02
  // and the validator has been accepting it; until now nothing stored it, so
  // the ifIndex->ifName table crossed the wire on every poll and was thrown
  // away. It is the join every per-port measurement needs.
  deviceInterfacesRepo = null,
  logger = null,
  now = () => new Date(),
}) {
  // deviceId -> agentId, refreshed per batch. A batch is at most 200 devices
  // and arrives every few minutes, so one read per batch is the right cost —
  // and reading it fresh each time is what makes a re-assignment take effect
  // on the next cycle rather than after a restart.
  async function ownedBy(agentId) {
    const rows = await snmpDevicesRepo.list({ agentId });
    return new Set(rows.map((d) => d.id));
  }

  // Stores one cycle. Returns counts the route reports verbatim.
  async function ingest(agentId, { devices = [], failures = [] } = {}) {
    const owned = await ownedBy(agentId);
    const at = now();

    let stored = 0;
    let fdbRows = 0;
    let neighbourRows = 0;
    let interfaceRows = 0;
    let refused = 0;
    const deviceErrors = [];
    // Ports whose ifIndex moved since the last poll. Reported back to the
    // caller because a counter delta that spans a renumbering is two different
    // ports subtracted from each other — see migration 108.
    const renumbered = [];

    for (const d of devices) {
      if (!owned.has(d.deviceId)) {
        refused += 1;
        if (logger) {
          logger.warn(`snmp-topology: agent ${agentId} submitted device ${d.deviceId} it does not poll`);
        }
        continue;
      }
      try {
        // Interfaces FIRST: the forwarding table and the neighbours both name
        // ports, and a port that does not exist in the inventory yet cannot be
        // joined to. Best-effort like the neighbours — an inventory failure
        // must not cost the forwarding table somebody is waiting for.
        if (deviceInterfacesRepo && d.interfaces && d.interfaces.length) {
          try {
            const out = await deviceInterfacesRepo.upsertMany(d.deviceId, d.interfaces, { at });
            interfaceRows += out.upserted;
            for (const r of out.renumbered) renumbered.push({ deviceId: d.deviceId, ...r });
          } catch (err) {
            if (logger) logger.warn(`snmp-topology: interface ingest failed for device ${d.deviceId} (${err.message})`);
          }
        }
        if (d.fdb.length) {
          fdbRows += await fdbEntriesRepo.upsertMany(d.deviceId, d.fdb, { at });
        }
        // LLDP neighbours seen BY THE SWITCH, stored per device. They are NOT
        // merged into the topology graph here: a switch sees far more
        // neighbours than an agent host does — every access point and phone —
        // and folding the two sources together changes what the graph MEANS.
        // That deserves its own change. Best-effort either way: a neighbour
        // failure must not cost the forwarding table, which is the part
        // somebody is actually waiting for.
        if (snmpNeighborsRepo && d.neighbours.length) {
          try {
            neighbourRows += await snmpNeighborsRepo.upsertMany(d.deviceId, d.neighbours, { at });
          } catch (err) {
            if (logger) logger.warn(`snmp-topology: neighbour ingest failed for device ${d.deviceId} (${err.message})`);
          }
        }
        await snmpDevicesRepo.recordPoll(d.deviceId, { ok: true, supported: d.supported, at });
        stored += 1;
      } catch (err) {
        deviceErrors.push({ deviceId: d.deviceId, error: String(err.message).slice(0, 255) });
        if (logger) logger.warn(`snmp-topology: could not store device ${d.deviceId} (${err.message})`);
        // Record the failure on the device too, so the dashboard shows a reason
        // rather than a device that silently stopped updating.
        try {
          await snmpDevicesRepo.recordPoll(d.deviceId, { ok: false, error: err.message, at });
        } catch { /* the row is already the problem; do not compound it */ }
      }
    }

    // The agent's own per-device failures: a switch that timed out, refused the
    // community or answered garbage. Recorded against the device so "last
    // answered 41 minutes ago" is readable, which is the difference between a
    // switch that blipped and one that is gone.
    let failuresRecorded = 0;
    for (const f of failures) {
      if (!owned.has(f.deviceId)) { refused += 1; continue; }
      try {
        await snmpDevicesRepo.recordPoll(f.deviceId, { ok: false, error: f.error, at });
        failuresRecorded += 1;
      } catch (err) {
        if (logger) logger.warn(`snmp-topology: could not record failure for device ${f.deviceId} (${err.message})`);
      }
    }

    return { stored, fdbRows, neighbourRows, interfaceRows, renumbered, refused, failuresRecorded, deviceErrors };
  }

  return { ingest };
}

module.exports = { createSnmpTopologyIngest };
