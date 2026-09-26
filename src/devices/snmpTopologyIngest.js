'use strict';

const { disambiguateIfNames } = require('./ifNames');

// Stores one SNMP topology cycle: the forwarding tables, LLDP and CDP
// neighbours, VLAN names, router ARP tables and ENTITY-MIB inventory an agent
// read from the switches assigned to it.
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
  // Loop detection runs HERE, after the forwarding table has just been
  // re-read, because that is the moment the MAC move counters have moved. On a
  // timer it would either check a table nothing has touched or miss the window
  // where a loop is visible at all.
  l2LoopService = null,
  // Switch-port link history (./switchPortStateService.js): the ports whose
  // status this poll changed, recorded instead of overwritten.
  switchPortStateService = null,
  // The link-MTU mismatch rule (./linkMtuService.js). Runs here for the same
  // reason loop detection does — both halves of its evidence have just been
  // re-read — but throttles itself, because a mismatch is a configuration and
  // is no truer a minute after the poll that found it.
  linkMtuService = null,
  // Switch-seen LLDP changes into topology_changes
  // (topologyChangeService.processDeviceSnapshot).
  topologyChangeService = null,
  // The ARP table of a router or L3 switch (IP-MIB, migration 125). Its own
  // table, not arp_entries: that one keys on an agent. Wired through the
  // new-device detector in server.js, so a MAC the router sees for the first
  // time at a site is raised like one an agent sees.
  deviceArpRepo = null,
  logger = null,
  now = () => new Date(),
}) {
  // deviceId -> device, refreshed per batch. A batch is at most 200 devices
  // and arrives every few minutes, so one read per batch is the right cost —
  // and reading it fresh each time is what makes a re-assignment take effect
  // on the next cycle rather than after a restart. The row itself (not just
  // the id) because the port history and the neighbour diff name the switch.
  async function ownedBy(agentId) {
    const rows = await snmpDevicesRepo.list({ agentId });
    return new Map(rows.map((d) => [d.id, d]));
  }

  // The neighbours this switch reported on its PREVIOUS poll that carried any.
  // snmp_neighbors is upserted, never replaced, so the stored rows are every
  // neighbour seen inside retention; the ones from the last snapshot are those
  // sharing its (newest) last_seen. Anything older is a neighbour that had
  // already gone, and must not be "removed" a second time.
  //
  // PER PROTOCOL (migration 124). LLDP and CDP are walked separately, and one
  // can fail while the other answers; the poll that lost its CDP walk still
  // moved the LLDP rows' last_seen. A single "newest" across both would then
  // drop every CDP row out of the previous snapshot, and the next poll that
  // reads CDP again would announce each of them as newly added.
  function lastSnapshot(stored) {
    const ms = (v) => (v == null ? NaN : new Date(v).getTime());
    const newest = new Map();
    for (const n of stored) {
      const t = ms(n.lastSeen);
      const p = (n && n.protocol) || 'lldp';
      if (Number.isFinite(t) && t > (newest.get(p) ?? -Infinity)) newest.set(p, t);
    }
    if (!newest.size) return [];
    // One second of slack: last_seen is a DATETIME, and a sweep's rows share
    // one `at` that MySQL may have rounded.
    return stored.filter((n) => {
      const top = newest.get((n && n.protocol) || 'lldp');
      return top != null && top - ms(n.lastSeen) <= 1000;
    });
  }

  function asEdge(n) {
    return {
      localPort: n.localIfName || (n.localPort != null ? String(n.localPort) : null),
      remoteChassisId: n.remoteChassisId,
      remotePort: n.remotePortId ?? '',
      remoteName: n.remoteSysName || null,
    };
  }

  const protocolOf = (n) => (n && n.protocol) || 'lldp';

  // The previous snapshot as the diff should see it: only the protocols THIS
  // poll reported. The diff already treats an empty current table as "the walk
  // failed", not "every neighbour left"; the same holds per protocol — a
  // switch whose CDP walk timed out while LLDP answered has not lost its CDP
  // neighbours, and they must not be announced as removed.
  function comparable(previous, current) {
    const reported = new Set(current.map(protocolOf));
    return previous.filter((n) => reported.has(protocolOf(n)));
  }

  // The first chassis the device reported — what the device list shows as its
  // model and serial. Null when the device reported no inventory at all, which
  // keeps whatever is stored (COALESCE in recordPoll).
  function primaryHardware(inventory) {
    const list = Array.isArray(inventory) ? inventory : [];
    const e = list.find((x) => x.class === 'chassis') || null;
    if (!e) return null;
    return {
      vendor: e.vendor, model: e.model, serial: e.serial,
      hardwareRev: e.hardwareRev, firmwareRev: e.firmwareRev, softwareRev: e.softwareRev,
    };
  }

  // Stores one cycle. Returns counts the route reports verbatim.
  async function ingest(agentId, { devices = [], failures = [] } = {}) {
    const owned = await ownedBy(agentId);
    const at = now();

    let stored = 0;
    let fdbRows = 0;
    let neighbourRows = 0;
    let interfaceRows = 0;
    let vlanRows = 0;
    let portTransitions = 0;
    let neighbourChanges = 0;
    let arpRows = 0;
    let inventoryRows = 0;
    let refused = 0;
    const deviceErrors = [];
    // Ports whose ifIndex moved since the last poll. Reported back to the
    // caller because a counter delta that spans a renumbering is two different
    // ports subtracted from each other — see migration 108.
    const renumbered = [];
    // Devices whose forwarding table this cycle actually wrote. Only those are
    // worth a loop check — a device that failed or was refused has no new
    // evidence either way.
    const storedDeviceIds = [];

    for (const d of devices) {
      const device = owned.get(d.deviceId);
      if (!device) {
        refused += 1;
        if (logger) {
          logger.warn(`snmp-topology: agent ${agentId} submitted device ${d.deviceId} it does not poll`);
        }
        continue;
      }
      try {
        // The neighbours as they stood BEFORE this poll. Read once and used
        // twice: the port history asks "was this an uplink" (a link that just
        // went down has usually taken its LLDP neighbour with it, so the answer
        // is in the previous table), and the neighbour diff needs the previous
        // snapshot to compare against.
        let storedNeighbours = null;
        if (snmpNeighborsRepo && (switchPortStateService || topologyChangeService)) {
          try {
            storedNeighbours = await snmpNeighborsRepo.listForDevice(d.deviceId, { limit: 1024 });
          } catch (err) {
            if (logger) logger.warn(`snmp-topology: previous neighbours unavailable for device ${d.deviceId} (${err.message})`);
          }
        }
        const previousSnapshot = Array.isArray(storedNeighbours) ? lastSnapshot(storedNeighbours) : null;

        // Interfaces FIRST: the forwarding table and the neighbours both name
        // ports, and a port that does not exist in the inventory yet cannot be
        // joined to. Best-effort like the neighbours — an inventory failure
        // must not cost the forwarding table somebody is waiting for.
        if (deviceInterfacesRepo && d.interfaces && d.interfaces.length) {
          try {
            const out = await deviceInterfacesRepo.upsertMany(d.deviceId, disambiguateIfNames(d.interfaces), { at });
            interfaceRows += out.upserted;
            for (const r of out.renumbered) renumbered.push({ deviceId: d.deviceId, ...r });
            // Ports whose link state this poll changed. Recorded as history
            // rather than silently overwritten — best-effort, after the write.
            if (switchPortStateService && Array.isArray(out.statusChanges) && out.statusChanges.length) {
              try {
                const ports = await switchPortStateService.recordPollChanges({
                  agentId, device, changes: out.statusChanges, neighbours: previousSnapshot, at,
                });
                portTransitions += ports.transitions + ports.flapped;
              } catch (err) {
                if (logger) logger.warn(`snmp-topology: port history failed for device ${d.deviceId} (${err.message})`);
              }
            }
          } catch (err) {
            if (logger) logger.warn(`snmp-topology: interface ingest failed for device ${d.deviceId} (${err.message})`);
          }
        }
        if (d.fdb.length) {
          fdbRows += await fdbEntriesRepo.upsertMany(d.deviceId, d.fdb, { at });
        }
        // VLAN names (migration 117). Best-effort: a name is a label, and a
        // label failing to store must not cost the table it labels.
        if (d.vlans && d.vlans.length && typeof fdbEntriesRepo.upsertVlans === 'function') {
          try {
            vlanRows += await fdbEntriesRepo.upsertVlans(d.deviceId, d.vlans, { at });
          } catch (err) {
            if (logger) logger.warn(`snmp-topology: vlan names failed for device ${d.deviceId} (${err.message})`);
          }
        }
        // The switch's own LLDP table against its previous snapshot, BEFORE
        // the upsert moves last_seen. First snapshot = baseline, no rows.
        if (topologyChangeService && previousSnapshot && d.neighbours.length
          && typeof topologyChangeService.processDeviceSnapshot === 'function') {
          try {
            const diff = await topologyChangeService.processDeviceSnapshot({
              agentId,
              deviceId: d.deviceId,
              deviceName: device.displayName || device.host,
              prev: comparable(previousSnapshot, d.neighbours).map(asEdge),
              next: d.neighbours.map(asEdge),
            });
            neighbourChanges += diff.changes.length;
          } catch (err) {
            if (logger) logger.warn(`snmp-topology: neighbour diff failed for device ${d.deviceId} (${err.message})`);
          }
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
        // The router's ARP table. Best-effort like the neighbours: an identity
        // source failing to store must not cost the forwarding table. The
        // device and the polling agent travel with it so the new-device
        // detector wrapping this repository can scope "never seen" to the
        // device's site and name who observed it.
        if (deviceArpRepo && Array.isArray(d.arp) && d.arp.length) {
          try {
            arpRows += await deviceArpRepo.upsertMany(d.deviceId, d.arp, { at, device, agentId });
          } catch (err) {
            if (logger) logger.warn(`snmp-topology: ARP ingest failed for device ${d.deviceId} (${err.message})`);
          }
        }
        // The ENTITY-MIB inventory, replaced — it is the box as it is now. An
        // empty report replaces nothing: a walk that timed out has not
        // unplugged a line card.
        if (Array.isArray(d.inventory) && d.inventory.length
          && typeof snmpDevicesRepo.replaceInventory === 'function') {
          try {
            inventoryRows += await snmpDevicesRepo.replaceInventory(d.deviceId, d.inventory, { at });
          } catch (err) {
            if (logger) logger.warn(`snmp-topology: inventory ingest failed for device ${d.deviceId} (${err.message})`);
          }
        }
        await snmpDevicesRepo.recordPoll(d.deviceId, {
          ok: true,
          supported: d.supported,
          sysDescr: d.sysDescr ?? null,
          sysName: d.sysName ?? null,
          sysLocation: d.sysLocation ?? null,
          sysContact: d.sysContact ?? null,
          sysObjectId: d.sysObjectId ?? null,
          hardware: primaryHardware(d.inventory),
          at,
        });
        stored += 1;
        if (d.fdb.length) storedDeviceIds.push(d.deviceId);
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

    // Loop detection over the devices whose forwarding tables just changed.
    // Best-effort and last: a detector that throws must never cost the sweep
    // that was going to feed it.
    let loops = 0;
    if (l2LoopService && storedDeviceIds.length) {
      try {
        const found = await l2LoopService.checkDevices(storedDeviceIds, { agentId });
        loops = found.length;
      } catch (err) {
        if (logger) logger.warn(`snmp-topology: loop detection failed (${err.message})`);
      }
    }

    // The link-MTU mismatch rule. Best-effort and last, like the loop check
    // above: a rule that throws must never cost the cycle that fed it. It runs
    // only when a port inventory was actually stored — without one the MTUs are
    // the same rows it looked at last time.
    let linkMtuFindings = 0;
    if (linkMtuService && interfaceRows > 0) {
      try {
        linkMtuFindings = await linkMtuService.check({ agentId });
      } catch (err) {
        if (logger) logger.warn(`snmp-topology: link MTU check failed (${err.message})`);
      }
    }

    return {
      stored, fdbRows, neighbourRows, interfaceRows, vlanRows, renumbered, loops, linkMtuFindings,
      portTransitions, neighbourChanges, arpRows, inventoryRows,
      refused, failuresRecorded, deviceErrors,
    };
  }

  return { ingest };
}

module.exports = { createSnmpTopologyIngest };
