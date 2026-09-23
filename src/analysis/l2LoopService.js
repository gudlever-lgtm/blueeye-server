'use strict';

const crypto = require('crypto');
const {
  detectLoop, MIN_MOVES_PER_MAC, BROADCAST_STORM_MIN_PPS, BROADCAST_SUSTAINED_SAMPLES, BROADCAST_SURGE_RATIO,
} = require('./l2Loop');
const { median } = require('./baselines');
const { numOrNull } = require('../lib/num');
const { createDeviceFindingSink } = require('../devices/findingSink');

// Runs the loop detector over what the server already stores, and turns a
// verdict into a finding.
//
// WHERE THE THREE FACTS COME FROM. All of them are already being collected;
// none of this polls anything:
//
//   MAC flapping      fdb_mac_moves — each observed move, counted inside the
//                     window (migration 117; move_count is all-time)
//   broadcast surge   device_counter_samples.in_bcast_pps (migration 109)
//   STP churn         device_events where event_type = 'stp.topology_change'
//                     (migration 103, stage 01/03), matched to THIS switch by
//                     the address it sent from — see topoChangesFor
//
// WHEN IT RUNS. After a topology cycle, which is when the forwarding table has
// just been re-read and the move counters have just moved. Running it on a
// timer instead would mean either checking a table nothing has touched, or
// missing the window where a loop is visible.
//
// THE FINDING IS A THRESHOLD, NOT AN ANOMALY. There is no baseline to deviate
// from: the rule is "this many MACs flapping this fast IS a loop", stated in
// code and explained in the finding. `kind` is THRESHOLD because that is what
// the enum calls a rule with a fixed trigger, and a loop is exactly that.

// How far back the window reaches, at least. Long enough for several topology
// sweeps to have happened, short enough that a loop that ended twenty minutes
// ago is not still being reported.
const WINDOW_MINUTES = 10;

// ...and never fewer sweeps than this. A sweep sees at most ONE move per MAC
// (the port it is on now against the port it was on last time), so a window of
// ten minutes over a switch polled every five holds two sweeps, and a MAC can
// never reach MIN_MOVES_PER_MAC inside it. Counting moves correctly (migration
// 117) made that visible: the old all-time count had been hiding it. The
// window stretches to cover this many sweeps of the device's own interval —
// twice the move minimum, because a MAC flapping between two ports is on a
// different one at only about half of the sweeps that look at it.
const MIN_SWEEPS_PER_WINDOW = MIN_MOVES_PER_MAC * 2;

// Broadcast baseline: the median of the port's history over this lookback,
// the same robust measure the rest of the analysis uses. A mean would be
// dragged up by the surge it is supposed to be measuring against, and a
// lookback of an hour keeps a storm that started minutes ago from BECOMING the
// median it is compared with.
const BASELINE_SAMPLES = 120;
const BASELINE_LOOKBACK_MINUTES = 60;

// One finding per device per this long. A loop that lasts an hour is one fault,
// not sixty; without this the detector would raise a finding on every topology
// cycle for as long as somebody took to find the cable.
const REFRACTORY_MINUTES = 30;

// How many ports get a baseline read. Each one is its own query, and a 48-port
// switch asking 48 times is fine — a chassis with 500 ports asking 500 times,
// per cycle, is not. The ports are taken in order of their CURRENT broadcast
// rate, so the ones a surge could possibly be on are the ones that get looked
// at, and the cap sits far above the three surging ports the detector needs.
const MAX_BASELINE_PORTS = 64;

function createL2LoopService({
  fdbEntriesRepo,
  counterSamplesRepo = null,
  deviceEventsRepo = null,
  deviceInterfacesRepo = null,
  snmpDevicesRepo = null,
  findingStore = null,
  eventCaseService = null,
  publishFinding = () => {},
  // Alerting (migration-free, but new): a loop finding used to be stored,
  // published and grouped and then never ALERTED, because nothing handed this
  // service a dispatcher. Either pass `findingSink` (the server does — the one
  // path every rule-based switch finding takes) or the parts to build one.
  dispatcher = null,
  alertingEnabled = false,
  findingSink = null,
  windowMinutes = WINDOW_MINUTES,
  logger = null,
  now = () => new Date(),
}) {
  // deviceId -> ms epoch of the last finding raised. In memory on purpose: a
  // restart re-raising one loop finding is the correct failure mode, where
  // persisting it would mean a schema for a debounce.
  const lastRaised = new Map();

  const sink = findingSink || createDeviceFindingSink({
    findingStore, eventCaseService, publishFinding, dispatcher, alertingEnabled, logger,
  });

  // The detection window for one device, in minutes: the configured floor, or
  // MIN_SWEEPS_PER_WINDOW of the device's own topology interval, whichever is
  // longer. See MIN_SWEEPS_PER_WINDOW for why the second one exists.
  function windowFor(intervalSec) {
    const sweeps = Number(intervalSec) > 0 ? (Number(intervalSec) * MIN_SWEEPS_PER_WINDOW) / 60 : 0;
    return Math.max(windowMinutes, Math.ceil(sweeps));
  }

  // The broadcast picture for one device: each port's current rate against its
  // own median over the lookback, and whether the surge has held for the last
  // BROADCAST_SUSTAINED_SAMPLES samples. `minPps` narrows the ports looked at
  // to those loud enough to matter — which is what makes it affordable to ask
  // on EVERY cycle, not only on the cycles where MACs are moving: on a quiet
  // network no port is above the floor and nothing past the first read runs.
  async function broadcastFor(deviceId, { minPps = null } = {}) {
    if (!counterSamplesRepo) return [];
    let latest = [];
    try {
      latest = await counterSamplesRepo.latestWithNames(deviceId);
    } catch (err) {
      if (logger) logger.warn(`l2loop: counters unavailable for device ${deviceId} (${err.message})`);
      return [];
    }

    // Busiest first, then capped. A loop shows up as the HIGHEST broadcast
    // rates on the switch, so sorting by the current reading keeps exactly the
    // ports the detector could find a surge on.
    const candidates = (Array.isArray(latest) ? latest : [])
      .filter((s) => s && s.inBcastPps != null && (minPps == null || Number(s.inBcastPps) >= minPps))
      .sort((a, b) => Number(b.inBcastPps) - Number(a.inBcastPps))
      .slice(0, MAX_BASELINE_PORTS);

    const to = now();
    const from = new Date(to.getTime() - BASELINE_LOOKBACK_MINUTES * 60 * 1000);
    const out = [];
    for (const sample of candidates) {
      let history = [];
      try {
        const series = await counterSamplesRepo.series(sample.interfaceId, {
          from, to, maxPoints: BASELINE_SAMPLES,
        });
        // numOrNull, not Number(): a sample with no broadcast reading must not
        // become a 0 in the baseline, because a baseline pulled down by absent
        // readings makes an ordinary rate look like a surge.
        history = (series.samples || [])
          .map((s) => numOrNull(s.inBcastPps))
          .filter((v) => v !== null);
      } catch { history = []; }
      // NULL, not 0, when there is no history: an absent baseline must never
      // become the strongest possible evidence of a surge.
      const baseline = history.length >= 3 ? median(history) : null;
      // Sustained: the newest N readings (oldest-first series, so the tail)
      // are all a surge against that baseline — a storm that is not stopping,
      // rather than one burst.
      const tail = history.slice(-BROADCAST_SUSTAINED_SAMPLES);
      const surge = (v) => (baseline == null ? false
        : (baseline > 0 ? v / baseline >= BROADCAST_SURGE_RATIO : v >= 50));
      const sustained = baseline != null && tail.length >= BROADCAST_SUSTAINED_SAMPLES && tail.every(surge);
      out.push({
        interfaceId: sample.interfaceId,
        ifName: sample.ifName || null,
        inBcastPps: Number(sample.inBcastPps),
        baselineBcastPps: baseline,
        sustained,
      });
    }
    return out;
  }

  // Spanning-tree reconvergences THIS SWITCH reported in the window. Best
  // effort: a device that sends no syslog has not said the tree is stable, so
  // its absence is not evidence either way — which is why it only ever ADDS to
  // the score.
  //
  // THE ID SPACE. `device_events.device_id` is NOT an snmp_devices id: the
  // device-event ingest resolves a sender through the agents' own addresses
  // (hostResolver), so that column holds an AGENT id. Asking it for this
  // switch's snmp_devices id matched some unrelated agent's events, or none —
  // which is why this corroboration was always zero in production. The switch
  // is found instead by what it actually sent from: its polled address, which
  // is exactly what the agent's trap receiver and syslog listener record as
  // the source (and what the trap receiver matches senders against).
  async function topoChangesFor(device, since) {
    if (!deviceEventsRepo || typeof deviceEventsRepo.list !== 'function') return 0;
    const sourceIp = device && typeof device.host === 'string' ? device.host.trim() : '';
    // A device configured by DNS name has no address to match an event to.
    // Unknown is not zero, and zero only ever ADDS nothing.
    if (!sourceIp || !/^[0-9a-fA-F.:]+$/.test(sourceIp)) return 0;
    try {
      // `list` takes a WINDOW IN MINUTES, not a from/to pair — the device log's
      // own shape. Rounded up so a partial minute never narrows the window.
      const minutes = Math.max(1, Math.ceil((now().getTime() - since.getTime()) / 60000));
      const out = await deviceEventsRepo.list({
        sourceIp, minutes, eventType: 'stp.topology_change', limit: 100,
      });
      // The repository answers { events, ... } on the read the device log uses
      // and a bare array on some fakes; both are accepted rather than the
      // service knowing which store it got.
      const events = Array.isArray(out) ? out : (out && out.events) || [];
      return events.length;
    } catch (err) {
      if (logger) logger.warn(`l2loop: device events unavailable for ${device && device.id} (${err.message})`);
      return 0;
    }
  }

  // Checks one device. Returns the finding it raised, or null.
  //
  // `device` is the snmp_devices row when the caller has it: its host is how
  // the switch's own STP events are found, and its interval sets the window.
  async function checkDevice(deviceId, {
    agentId = null, deviceName = null, device = null, intervalSec = null,
  } = {}) {
    const at = now();
    const minutes = windowFor(intervalSec ?? (device && device.intervalSec));
    const since = new Date(at.getTime() - minutes * 60 * 1000);

    let moving = [];
    try {
      moving = await fdbEntriesRepo.movingMacs(deviceId, { since, limit: 500 });
    } catch (err) {
      if (logger) logger.warn(`l2loop: forwarding table unavailable for ${deviceId} (${err.message})`);
      return null;
    }

    // The moves INSIDE the window, counted from the move history by the
    // repository. Never `moveCount`: that is all-time, and reading it as "in
    // the window" made a MAC re-docked forty times over a month look like one
    // flapping forty times in ten minutes.
    const inWindow = (Array.isArray(moving) ? moving : [])
      .map((m) => ({ ...m, movesInWindow: Number(m.movesInWindow) || 0 }));

    // With MACs moving, every port's broadcast picture corroborates. Without,
    // only a port loud enough to be a storm can make a case at all, so only
    // those are looked at — on a quiet network, none.
    const broadcast = await broadcastFor(deviceId, {
      minPps: inWindow.length ? null : BROADCAST_STORM_MIN_PPS,
    });
    if (!inWindow.length && !broadcast.some((b) => b.sustained)) return null;
    const topoChanges = await topoChangesFor(device, since);

    const verdict = detectLoop({
      moving: inWindow, broadcast, topoChanges, windowMinutes: minutes, deviceId, deviceName,
    });
    if (!verdict) return null;

    // One finding per device per refractory period. A loop that lasts an hour
    // is one fault, not sixty.
    const last = lastRaised.get(deviceId);
    if (last && at.getTime() - last < REFRACTORY_MINUTES * 60 * 1000) return null;
    lastRaised.set(deviceId, at.getTime());

    const finding = {
      id: crypto.randomUUID(),
      // The polling agent, so every per-agent read finds it, with the device
      // beside it (migration 110). A loop is a property of the SWITCH, not of
      // one port, so interfaceId stays null even though the verdict names two.
      hostId: String(agentId ?? deviceId),
      deviceId,
      interfaceId: null,
      metric: 'l2.loop',
      severity: verdict.severity,
      kind: 'THRESHOLD',
      observed: verdict.flappingMacs,
      baseline: null,
      deviation: null,
      window: [since, at],
      explanation: verdict.explanation,
      // The MetricSample shape the store expects, carrying the whole verdict so
      // the finding can be re-read and checked by hand.
      evidence: [{
        hostId: String(agentId ?? deviceId),
        deviceId,
        metric: 'l2.loop',
        value: verdict.flappingMacs,
        ts: at,
        labels: {
          // 'mac_flap' — the detection; 'broadcast' — a sustained storm on a
          // port with no MAC moving, the lower-confidence suspicion.
          basis: verdict.basis,
          pairs: verdict.pairs,
          stormPorts: verdict.stormPorts || [],
          macs: verdict.evidence.macs,
          broadcast: verdict.evidence.broadcast,
          topoChanges: verdict.topoChanges,
          score: verdict.score,
          windowMinutes: minutes,
        },
      }],
      correlatedWith: [],
      createdAt: at,
      acked: false,
    };

    // Stored, published, grouped into an event (a loop belongs in the same
    // event as the link flaps and timeouts it is causing) and ALERTED, through
    // the one path every rule-based switch finding takes. Not stored means not
    // raised: the refractory period is released so the next cycle can try.
    const raised = await sink.emit(finding);
    if (!raised) {
      lastRaised.delete(deviceId);
      return null;
    }
    return finding;
  }

  // Checks every device an agent just polled. Called from the topology ingest,
  // which is the moment the move counters have moved.
  async function checkDevices(deviceIds, { agentId = null } = {}) {
    const ids = [...new Set((Array.isArray(deviceIds) ? deviceIds : []).map(Number))].filter(Boolean);
    const out = [];
    for (const deviceId of ids) {
      let deviceName = null;
      let device = null;
      if (snmpDevicesRepo) {
        try {
          device = await snmpDevicesRepo.findById(deviceId);
          deviceName = device ? (device.displayName || device.host) : null;
        } catch { deviceName = null; device = null; }
      }
      try {
        const finding = await checkDevice(deviceId, { agentId, deviceName, device });
        if (finding) out.push(finding);
      } catch (err) {
        if (logger) logger.warn(`l2loop: check failed for device ${deviceId} (${err.message})`);
      }
    }
    return out;
  }

  return { checkDevice, checkDevices };
}

module.exports = {
  createL2LoopService,
  WINDOW_MINUTES,
  MIN_SWEEPS_PER_WINDOW,
  BASELINE_LOOKBACK_MINUTES,
  REFRACTORY_MINUTES,
  MAX_BASELINE_PORTS,
};
