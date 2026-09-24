'use strict';

const net = require('net');
const { computeSample, detectReboot, MIN_DELTA_SEC } = require('./counterDelta');
const {
  detectDuplexMismatch, buildDuplexFinding, REFRACTORY_MINUTES: DUPLEX_REFRACTORY_MINUTES,
} = require('./duplexMismatch');

// Stores the interface counters an sFlow exporter pushes, as device counter
// samples — the SAME rows, the same rates, the same discontinuity rules and
// the same analysis an SNMP counter poll produces (./snmpCounterIngest.js).
//
// WHY. An sFlow switch sends its own generic interface counters and Ethernet
// error counters (FCS, alignment, late collisions, carrier sense) every polling
// interval, without anyone asking. The agent used to count those samples and
// throw them away, so a switch that exports sFlow but is not polled over SNMP
// — no community, a vendor that locks SNMP down, a site that never set it up —
// had flows and no per-port error, discard or duplex analysis at all.
//
// WHERE IT COMES FROM. The agent's sFlow snapshot carries `sflowCounters` (see
// blueeye-agent PROTOCOL.md): one entry per (exporter address, ifIndex), with
// the counters as two arrays in sFlow's own record order. Optional: an older
// agent sends no such key and nothing here runs.
//
// WHICH DEVICE. The exporter's address is matched against snmp_devices.host,
// as an IP literal (IPv6 compared in its compressed form). A device registered
// by HOSTNAME does not match — the ingest does not resolve names on the report
// path — and shows up as an unregistered exporter in the coverage report,
// whose suggestion is to register the address.
//
// WHICH ONE WINS. A device that is ALSO polled for SNMP counters (an assigned
// agent, `ifcounters` in collect, a counter interval) is left to the SNMP
// poll: two sources writing one series interleave their readings and every
// rate is computed across two clocks. The exporter is still recorded as
// registered.
//
// A PORT THE INVENTORY DOES NOT HAVE. An sFlow-only switch has no SNMP
// topology poll to create its device_interfaces rows, so skipping unknown
// ports (what the SNMP path does — the next topology poll creates them) would
// store nothing, ever. Instead a minimal row is created, named `ifIndex N` with
// name_source 'ifIndex' — the value migration 108 already has for exactly
// this: a port known only by its index. The name is honest about what we know.
// Once an SNMP topology poll inventories the port under its real name, the
// real row wins the ifIndex lookup, and the topology upsert retires the minimal
// one — its if_index cleared, the row and its history kept
// (deviceInterfacesRepository.upsertMany). A
// renumbered ifIndex cannot be detected on a minimal row — nothing but the
// index identifies it — which is the price of having it at all, and bounded:
// at most MAX_MINIMAL_PER_DEVICE such rows per device.

// EXPORTERS HEARD ONLY IN FLOW SAMPLES. A switch can be set up to send flow
// samples and no counter samples; it then never appears in `sflowCounters`,
// and so would never be recorded in sflow_exporters and never show up as an
// unregistered exporter in the coverage report. A newer agent also sends
// `traffic.sflowExporters` — the exporter addresses heard this interval, from
// flow OR counter samples, at most 256. Those not already counted above are
// recorded with `interfaces: null` ("heard, no counters counted"), which the
// repository stores without touching a count a counter sample recorded.

// sFlow v5 record order (the agent's IF_COUNTER_FIELDS / ETHERNET_FIELDS).
const IF_FIELDS = [
  'ifInOctets', 'ifInUcastPkts', 'ifInMulticastPkts', 'ifInBroadcastPkts', 'ifInDiscards',
  'ifInErrors', 'ifInUnknownProtos', 'ifOutOctets', 'ifOutUcastPkts', 'ifOutMulticastPkts',
  'ifOutBroadcastPkts', 'ifOutDiscards', 'ifOutErrors',
];
const ETH_FIELDS = [
  'dot3StatsAlignmentErrors', 'dot3StatsFCSErrors', 'dot3StatsSingleCollisionFrames',
  'dot3StatsMultipleCollisionFrames', 'dot3StatsSQETestErrors', 'dot3StatsDeferredTransmissions',
  'dot3StatsLateCollisions', 'dot3StatsExcessiveCollisions', 'dot3StatsInternalMacTransmitErrors',
  'dot3StatsCarrierSenseErrors', 'dot3StatsFrameTooLongs', 'dot3StatsInternalMacReceiveErrors',
  'dot3StatsSymbolErrors',
];

// counterDelta's field name -> [array, sFlow field].
const MAP = {
  inOctets: ['if', 'ifInOctets'],
  inUcastPkts: ['if', 'ifInUcastPkts'],
  inMcastPkts: ['if', 'ifInMulticastPkts'],
  inBcastPkts: ['if', 'ifInBroadcastPkts'],
  inDiscards: ['if', 'ifInDiscards'],
  inErrors: ['if', 'ifInErrors'],
  outOctets: ['if', 'ifOutOctets'],
  outUcastPkts: ['if', 'ifOutUcastPkts'],
  outMcastPkts: ['if', 'ifOutMulticastPkts'],
  outBcastPkts: ['if', 'ifOutBroadcastPkts'],
  outDiscards: ['if', 'ifOutDiscards'],
  outErrors: ['if', 'ifOutErrors'],
  fcsErrors: ['eth', 'dot3StatsFCSErrors'],
  alignmentErrors: ['eth', 'dot3StatsAlignmentErrors'],
  lateCollisions: ['eth', 'dot3StatsLateCollisions'],
  carrierSenseErrors: ['eth', 'dot3StatsCarrierSenseErrors'],
};

// sFlow ifDirection (RFC 2863 ifDirection as sFlow defines it).
const DUPLEX = { 0: 'unknown', 1: 'full', 2: 'half' };

// One report is bounded: the agent sends at most 1024; this is the backstop.
const MAX_ENTRIES = 2048;
// traffic.sflowExporters: the agent sends at most 256 addresses.
const MAX_EXPORTERS = 256;
const MAX_MINIMAL_PER_DEVICE = 1024;
// A reading's own timestamp is used when it is plausible, else "now". Further
// back than this and it is not a reading from this report's interval.
const MAX_AGE_MS = 15 * 60 * 1000;
const MAX_SKEW_MS = 60 * 1000;
// The device list is read once per this long, not once per report.
const DEVICE_CACHE_MS = 30 * 1000;

// Canonical text for an IP literal (compressed IPv6), or null for a name.
function canonicalIp(s) {
  const v = String(s || '').trim();
  if (net.isIPv4(v)) return v;
  if (net.isIPv6(v)) {
    try { return new URL(`http://[${v}]/`).hostname.slice(1, -1); } catch { return v.toLowerCase(); }
  }
  return null;
}

// traffic.sflowExporters, checked: IP literals only (canonical form), each
// once, at most MAX_EXPORTERS. Anything else in the list is dropped rather than
// failing the report — it is an optional hint, and the results report is the
// agent's lifeline.
function normaliseExporters(list) {
  const out = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    if (out.size >= MAX_EXPORTERS) break;
    if (typeof v !== 'string' || v.length > 45) continue;
    const ip = canonicalIp(v);
    if (ip) out.add(ip);
  }
  return [...out];
}

// The results payload as it is STORED (results.payload, and its TSDB mirror):
// the same objects without traffic.sflowCounters and traffic.sflowExporters.
// Those are up to ~24 KB of raw counters per report, already stored where they
// are read — device_counter_samples and sflow_exporters, by this ingest — so
// keeping them in every results row as well only multiplied the table. Nothing
// reads them back from results. Copies, never mutates: the ingest, analysis,
// interface-state and flow pipelines are handed the originals. A result without
// either key is returned as the very same object.
const SFLOW_DETAIL_KEYS = ['sflowCounters', 'sflowExporters'];
function hasSflowDetail(traffic) {
  return !!traffic && typeof traffic === 'object' && SFLOW_DETAIL_KEYS.some((k) => k in traffic);
}
function stripTraffic(traffic) {
  const out = { ...traffic };
  for (const k of SFLOW_DETAIL_KEYS) delete out[k];
  return out;
}
function withoutSflowDetail(results) {
  return (Array.isArray(results) ? results : []).map((r) => {
    if (!r || typeof r !== 'object') return r;
    let out = r;
    if (hasSflowDetail(r.traffic)) out = { ...out, traffic: stripTraffic(r.traffic) };
    if (r.payload && typeof r.payload === 'object' && hasSflowDetail(r.payload.traffic)) {
      out = { ...out, payload: { ...r.payload, traffic: stripTraffic(r.payload.traffic) } };
    }
    return out;
  });
}

function counterOf(arr, fields, name) {
  if (!Array.isArray(arr)) return null;
  const v = arr[fields.indexOf(name)];
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// One entry from the agent, checked. Returns null for anything unusable.
function normaliseEntry(e, nowMs) {
  if (!e || typeof e !== 'object') return null;
  const agent = canonicalIp(e.agent);
  const ifIndex = Number(e.ifIndex);
  if (!agent || !Number.isInteger(ifIndex) || ifIndex <= 0 || ifIndex > 0xffffffff) return null;
  const hasIf = Array.isArray(e.if);
  const hasEth = Array.isArray(e.eth);
  if (!hasIf && !hasEth) return null;
  const atRaw = typeof e.at === 'number' ? e.at : Date.parse(e.at);
  const at = Number.isFinite(atRaw) && atRaw <= nowMs + MAX_SKEW_MS && atRaw >= nowMs - MAX_AGE_MS
    ? Math.min(atRaw, nowMs) : nowMs;
  const current = {};
  for (const [field, [arr, name]] of Object.entries(MAP)) {
    current[field] = arr === 'if' ? counterOf(e.if, IF_FIELDS, name) : counterOf(e.eth, ETH_FIELDS, name);
  }
  const dir = Number(e.direction);
  current.duplex = hasIf && Object.prototype.hasOwnProperty.call(DUPLEX, dir) ? DUPLEX[dir] : null;
  const speed = Number(e.speed);
  const status = Number(e.status);
  const uptimeMs = Number(e.uptimeMs);
  return {
    agent,
    ifIndex,
    at,
    current,
    speedMbps: Number.isFinite(speed) && speed > 0 ? Math.round(speed / 1e6) : null,
    ifType: Number.isInteger(Number(e.ifType)) ? Number(e.ifType) : null,
    adminStatus: hasIf && Number.isInteger(status) ? ((status & 1) ? 'up' : 'down') : null,
    operStatus: hasIf && Number.isInteger(status) ? ((status & 2) ? 'up' : 'down') : null,
    uptimeMs: Number.isFinite(uptimeMs) && uptimeMs >= 0 ? uptimeMs : null,
  };
}

// Does an SNMP counter poll already own this device's series?
function snmpCountersPolled(d) {
  return d.agentId != null
    && Array.isArray(d.collect) && d.collect.includes('ifcounters')
    && d.counterIntervalSec != null;
}

function createSflowCounterIngest({
  snmpDevicesRepo,
  deviceInterfacesRepo,
  counterSamplesRepo,
  // Optional: where the exporters heard are recorded for the coverage report.
  sflowExportersRepo = null,
  analysisPipeline = null,
  findingSink = null,
  logger = null,
  now = () => new Date(),
}) {
  const duplexRaised = new Map(); // interfaceId -> ms of the last duplex finding
  let deviceCache = null; // { at, byAddress }

  async function devicesByAddress(nowMs) {
    if (deviceCache && nowMs - deviceCache.at < DEVICE_CACHE_MS) return deviceCache.byAddress;
    const rows = await snmpDevicesRepo.list({});
    const byAddress = new Map();
    for (const d of rows || []) {
      const ip = d && canonicalIp(d.host);
      // The first device per address wins; two rows for one switch (different
      // SNMP ports) are one exporter.
      if (ip && !byAddress.has(ip)) byAddress.set(ip, d);
    }
    deviceCache = { at: nowMs, byAddress };
    return byAddress;
  }

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
        if (logger) logger.warn(`sflow-counters: duplex finding failed for device ${device.id} (${err.message})`);
      }
    }
    return raised;
  }

  // ifIndex -> interface row id for one device, creating the minimal rows the
  // inventory lacks. A real (named) row always wins over a minimal one.
  async function resolveInterfaces(device, entries, at) {
    const ports = await deviceInterfacesRepo.listForDevice(device.id, { limit: 4096 });
    const byIndex = new Map();
    for (const p of ports) {
      if (p.ifIndex == null) continue;
      const cur = byIndex.get(p.ifIndex);
      if (!cur || (cur.nameSource === 'ifIndex' && p.nameSource !== 'ifIndex')) byIndex.set(p.ifIndex, p);
    }
    // Retired placeholders (if_index cleared) no longer hold an index and do
    // not count against the bound; retention removes them.
    const minimalCount = ports.filter((p) => p.nameSource === 'ifIndex' && p.ifIndex != null).length;
    const missing = [];
    for (const e of entries) {
      if (byIndex.has(e.ifIndex) || missing.some((m) => m.ifIndex === e.ifIndex)) continue;
      if (minimalCount + missing.length >= MAX_MINIMAL_PER_DEVICE) break;
      missing.push({
        ifName: `ifIndex ${e.ifIndex}`,
        nameSource: 'ifIndex',
        ifIndex: e.ifIndex,
        ifType: e.ifType,
        speedMbps: e.speedMbps,
        adminStatus: e.adminStatus,
        operStatus: e.operStatus,
      });
    }
    let created = 0;
    if (missing.length) {
      await deviceInterfacesRepo.upsertMany(device.id, missing, { at });
      const { byName } = await deviceInterfacesRepo.idMapForDevice(device.id);
      for (const m of missing) {
        const id = byName.get(m.ifName);
        if (id == null) continue;
        byIndex.set(m.ifIndex, { id, ifName: m.ifName, speedMbps: m.speedMbps, nameSource: 'ifIndex' });
        created += 1;
      }
    }
    return { byIndex, created };
  }

  // Stores one report's counter entries, and records every exporter heard
  // (`exporters`: traffic.sflowExporters, optional). Never throws for one bad
  // device.
  async function ingest(agentId, rawEntries, { exporters = [] } = {}) {
    const at = now();
    const nowMs = at.getTime();
    const list = Array.isArray(rawEntries) ? rawEntries.slice(0, MAX_ENTRIES) : [];
    const heard = normaliseExporters(exporters);
    const result = {
      devices: 0, samples: 0, findings: 0, interfacesCreated: 0,
      unregistered: 0, flowOnly: 0, skipped: {}, discontinuities: {}, invalid: 0, deviceErrors: [],
    };
    const skip = (reason, n = 1) => { result.skipped[reason] = (result.skipped[reason] || 0) + n; };
    if (!list.length && !heard.length) return result;

    // Latest reading per (exporter, ifIndex) across the report.
    const byExporter = new Map();
    for (const raw of list) {
      const e = normaliseEntry(raw, nowMs);
      if (!e) { result.invalid += 1; continue; }
      if (!byExporter.has(e.agent)) byExporter.set(e.agent, new Map());
      const m = byExporter.get(e.agent);
      const cur = m.get(e.ifIndex);
      if (!cur || e.at >= cur.at) m.set(e.ifIndex, e);
    }
    if (!byExporter.size && !heard.length) return result;

    let devices;
    try {
      devices = await devicesByAddress(nowMs);
    } catch (err) {
      if (logger) logger.warn(`sflow-counters: could not read the device list (${err.message})`);
      return result;
    }

    const seen = [];
    for (const [address, perIf] of byExporter) {
      const entries = [...perIf.values()];
      const device = devices.get(address) || null;
      seen.push({ agentId, address, deviceId: device ? device.id : null, interfaces: entries.length });
      if (!device) { result.unregistered += 1; continue; }
      if (device.enabled === false) { skip('disabled', entries.length); continue; }
      if (snmpCountersPolled(device)) { skip('snmpPolled', entries.length); continue; }

      try {
        const { byIndex, created } = await resolveInterfaces(device, entries, at);
        result.interfacesCreated += created;
        // Bounded by the injected clock (the repository's own default is the
        // wall clock): an hour back, against readings a minute apart.
        const previous = await counterSamplesRepo.latestForDevice(device.id, { since: new Date(nowMs - 3600 * 1000) });

        // Reboot check, from the exporter's own uptime (ms) at its newest
        // reading. sFlow's uptime is a 32-bit millisecond counter, so it wraps
        // every 49.7 days — that wrap reads as one reboot, one row of null
        // rates, which is the honest failure mode.
        const newest = entries.reduce((a, b) => (b.at > a.at ? b : a));
        const prevUptimeAt = device.lastUptimeAt ? new Date(device.lastUptimeAt).getTime() : null;
        const rebooted = detectReboot({
          prevTicks: device.lastUptimeTicks == null ? null : Number(device.lastUptimeTicks),
          nextTicks: newest.uptimeMs == null ? null : Math.floor(newest.uptimeMs / 10),
          elapsedSec: prevUptimeAt == null ? null : (newest.at - prevUptimeAt) / 1000,
        });

        const rows = [];
        const nameById = new Map();
        for (const e of entries) {
          const port = byIndex.get(e.ifIndex);
          if (!port) { skip('noInterface'); continue; }
          const prev = previous.get(port.id) || null;
          const prevMs = prev && prev.ts ? new Date(prev.ts).getTime() : null;
          // The same reading twice (an exporter sending to two collectors, a
          // resubmitted report) is not a second measurement.
          if (prevMs != null && e.at - prevMs < MIN_DELTA_SEC * 1000) { skip('duplicate'); continue; }
          const sample = computeSample({
            current: e.current,
            previous: prev,
            elapsedSec: prevMs == null ? null : (e.at - prevMs) / 1000,
            speedMbps: port.speedMbps ?? e.speedMbps,
            rebooted,
            renumbered: false,
            // sFlow's octet counters are 64-bit.
            hc: true,
          });
          if (sample.discontinuity) {
            result.discontinuities[sample.discontinuity] = (result.discontinuities[sample.discontinuity] || 0) + 1;
          }
          nameById.set(port.id, port.ifName || null);
          rows.push({ ts: new Date(e.at), deviceId: device.id, interfaceId: port.id, ...sample });
        }

        if (rows.length) {
          result.samples += await counterSamplesRepo.insertMany(rows);
          if (analysisPipeline && typeof analysisPipeline.processDeviceSamples === 'function') {
            try {
              const named = rows.map((r) => ({ ...r, ifName: nameById.get(r.interfaceId) || null }));
              const found = await analysisPipeline.processDeviceSamples(String(agentId), named);
              result.findings += found.length;
            } catch (err) {
              if (logger) logger.warn(`sflow-counters: analysis failed for device ${device.id} (${err.message})`);
            }
          }
          result.findings += await checkDuplex(agentId, device, rows, nameById, at);
        }
        if (newest.uptimeMs != null && typeof snmpDevicesRepo.recordCounterPoll === 'function') {
          await snmpDevicesRepo.recordCounterPoll(device.id, {
            uptimeTicks: Math.floor(newest.uptimeMs / 10),
            at: new Date(newest.at),
          });
        }
        result.devices += 1;
      } catch (err) {
        result.deviceErrors.push({ deviceId: device.id, error: String(err.message).slice(0, 255) });
        if (logger) logger.warn(`sflow-counters: could not store device ${device.id} (${err.message})`);
      }
    }

    // Heard, but with no counter samples in this report: recorded all the
    // same (matched to a device like any exporter), without a port count.
    for (const address of heard) {
      if (byExporter.has(address)) continue;
      const device = devices.get(address) || null;
      seen.push({ agentId, address, deviceId: device ? device.id : null, interfaces: null });
      result.flowOnly += 1;
    }

    if (sflowExportersRepo && typeof sflowExportersRepo.recordSeen === 'function' && seen.length) {
      try {
        await sflowExportersRepo.recordSeen(seen, { at });
      } catch (err) {
        if (logger) logger.warn(`sflow-counters: could not record exporters (${err.message})`);
      }
    }
    return result;
  }

  // The agent-results hook: every result whose traffic snapshot carries
  // `sflowCounters` and/or `sflowExporters`. Returns the merged summary, or
  // null when there were none.
  async function processResults(agentId, results) {
    const entries = [];
    const exporters = [];
    for (const r of Array.isArray(results) ? results : []) {
      const traffic = r && (r.traffic || (r.payload && r.payload.traffic));
      if (!traffic) continue;
      if (Array.isArray(traffic.sflowCounters) && entries.length < MAX_ENTRIES) {
        entries.push(...traffic.sflowCounters.slice(0, MAX_ENTRIES - entries.length));
      }
      if (Array.isArray(traffic.sflowExporters) && exporters.length < MAX_EXPORTERS) {
        exporters.push(...traffic.sflowExporters.slice(0, MAX_EXPORTERS - exporters.length));
      }
    }
    if (!entries.length && !exporters.length) return null;
    return ingest(agentId, entries, { exporters });
  }

  return { ingest, processResults };
}

module.exports = {
  createSflowCounterIngest,
  normaliseEntry,
  canonicalIp,
  IF_FIELDS,
  ETH_FIELDS,
  normaliseExporters,
  withoutSflowDetail,
  MAX_ENTRIES,
  MAX_EXPORTERS,
  MAX_MINIMAL_PER_DEVICE,
};
