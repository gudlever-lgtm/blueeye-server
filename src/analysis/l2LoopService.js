'use strict';

const crypto = require('crypto');
const { detectLoop } = require('./l2Loop');
const { median } = require('./baselines');
const { numOrNull } = require('../lib/num');

// Runs the loop detector over what the server already stores, and turns a
// verdict into a finding.
//
// WHERE THE THREE FACTS COME FROM. All of them are already being collected;
// none of this polls anything:
//
//   MAC flapping      fdb_entries.move_count / last_move_at (migration 111)
//   broadcast surge   device_counter_samples.in_bcast_pps (migration 109)
//   STP churn         device_events where event_type = 'stp.topology_change'
//                     (migration 103, stage 01/03)
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

// How far back the window reaches. Long enough for several topology sweeps to
// have happened, short enough that a loop that ended twenty minutes ago is not
// still being reported.
const WINDOW_MINUTES = 10;

// Broadcast baseline: the median of the port's recent history, which is the
// same robust measure the rest of the analysis uses. A mean would be dragged
// up by the surge it is supposed to be measuring against.
const BASELINE_SAMPLES = 30;

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
  windowMinutes = WINDOW_MINUTES,
  logger = null,
  now = () => new Date(),
}) {
  // deviceId -> ms epoch of the last finding raised. In memory on purpose: a
  // restart re-raising one loop finding is the correct failure mode, where
  // persisting it would mean a schema for a debounce.
  const lastRaised = new Map();

  // The broadcast picture for one device: each port's current rate against its
  // own recent median.
  async function broadcastFor(deviceId, since) {
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
      .filter((s) => s && s.inBcastPps != null)
      .sort((a, b) => Number(b.inBcastPps) - Number(a.inBcastPps))
      .slice(0, MAX_BASELINE_PORTS);

    const out = [];
    for (const sample of candidates) {
      let history = [];
      try {
        const series = await counterSamplesRepo.series(sample.interfaceId, {
          from: since, to: now(), maxPoints: BASELINE_SAMPLES,
        });
        // numOrNull, not Number(): a sample with no broadcast reading must not
        // become a 0 in the baseline, because a baseline pulled down by absent
        // readings makes an ordinary rate look like a surge.
        history = (series.samples || [])
          .map((s) => numOrNull(s.inBcastPps))
          .filter((v) => v !== null);
      } catch { history = []; }
      out.push({
        interfaceId: sample.interfaceId,
        ifName: sample.ifName || null,
        inBcastPps: Number(sample.inBcastPps),
        // NULL, not 0, when there is no history: an absent baseline must never
        // become the strongest possible evidence of a surge.
        baselineBcastPps: history.length >= 3 ? median(history) : null,
      });
    }
    return out;
  }

  // Spanning-tree reconvergences this device reported in the window. Best
  // effort: a device that sends no syslog has not said the tree is stable, so
  // its absence is not evidence either way — which is why it only ever ADDS to
  // the score.
  async function topoChangesFor(deviceId, since) {
    if (!deviceEventsRepo || typeof deviceEventsRepo.list !== 'function') return 0;
    try {
      // `list` takes a WINDOW IN MINUTES, not a from/to pair — the device log's
      // own shape. Rounded up so a partial minute never narrows the window.
      const minutes = Math.max(1, Math.ceil((now().getTime() - since.getTime()) / 60000));
      const out = await deviceEventsRepo.list({
        deviceId, minutes, eventType: 'stp.topology_change', limit: 100,
      });
      // The repository answers { events, ... } on the read the device log uses
      // and a bare array on some fakes; both are accepted rather than the
      // service knowing which store it got.
      const events = Array.isArray(out) ? out : (out && out.events) || [];
      return events.length;
    } catch (err) {
      if (logger) logger.warn(`l2loop: device events unavailable for ${deviceId} (${err.message})`);
      return 0;
    }
  }

  // Checks one device. Returns the finding it raised, or null.
  async function checkDevice(deviceId, { agentId = null, deviceName = null } = {}) {
    const at = now();
    const since = new Date(at.getTime() - windowMinutes * 60 * 1000);

    let moving = [];
    try {
      moving = await fdbEntriesRepo.movingMacs(deviceId, { since, limit: 500 });
    } catch (err) {
      if (logger) logger.warn(`l2loop: forwarding table unavailable for ${deviceId} (${err.message})`);
      return null;
    }
    if (!moving.length) return null;

    // `move_count` is monotonic, so the window's moves are what it gained since
    // the window opened. Without a previous reading the best available answer
    // is the count itself, which over-reports only for a device whose history
    // starts inside the window.
    const inWindow = moving.map((m) => ({ ...m, movesInWindow: m.moveCount }));

    const [broadcast, topoChanges] = await Promise.all([
      broadcastFor(deviceId, since),
      topoChangesFor(deviceId, since),
    ]);

    const verdict = detectLoop({
      moving: inWindow, broadcast, topoChanges, windowMinutes, deviceId, deviceName,
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
          pairs: verdict.pairs,
          macs: verdict.evidence.macs,
          broadcast: verdict.evidence.broadcast,
          topoChanges: verdict.topoChanges,
          score: verdict.score,
        },
      }],
      correlatedWith: [],
      createdAt: at,
      acked: false,
    };

    if (findingStore) {
      try {
        await findingStore.save(finding);
      } catch (err) {
        if (logger) logger.error(`l2loop: could not save finding for device ${deviceId} (${err.message})`);
        return null;
      }
    }
    // Grouped like any other finding — a loop belongs in the same event as the
    // link flaps and the timeouts it is causing.
    if (eventCaseService) {
      try { await eventCaseService.assignFinding(finding); } catch { /* best effort */ }
    }
    try { publishFinding(finding.hostId, { type: 'finding', payload: finding }); } catch { /* best effort */ }
    return finding;
  }

  // Checks every device an agent just polled. Called from the topology ingest,
  // which is the moment the move counters have moved.
  async function checkDevices(deviceIds, { agentId = null } = {}) {
    const ids = [...new Set((Array.isArray(deviceIds) ? deviceIds : []).map(Number))].filter(Boolean);
    const out = [];
    for (const deviceId of ids) {
      let deviceName = null;
      if (snmpDevicesRepo) {
        try {
          const d = await snmpDevicesRepo.findById(deviceId);
          deviceName = d ? (d.displayName || d.host) : null;
        } catch { deviceName = null; }
      }
      try {
        const finding = await checkDevice(deviceId, { agentId, deviceName });
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
  createL2LoopService, WINDOW_MINUTES, REFRACTORY_MINUTES, MAX_BASELINE_PORTS,
};
