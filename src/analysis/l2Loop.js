'use strict';

// Layer-2 forwarding loop detection.
//
// WHAT WAS HERE BEFORE. Nothing. `src/diagnose/playbooks/l2_loop.json` is a
// symptom playbook — it describes the fault in two languages and lists tests a
// technician can run. There has never been a detector. The audit's finding was
// that the premise "L2 loop detection already uses BRIDGE-MIB" did not hold:
// the server contains no OIDs at all.
//
// WHY A LOOP IS WORTH ITS OWN DETECTOR rather than a z-score on a counter.
// A loop is not an outlier in one metric. It is a PATTERN across three
// independent facts, each of which is unremarkable on its own:
//
//   1. A MAC address appearing on two different ports of one switch, over and
//      over, within seconds. Frames from one host arrive by two paths, so the
//      switch relearns the address on whichever port delivered last. This is
//      the signature — Cisco's own %SW_MATM-4-MACFLAP_NOTIF says exactly this
//      — and nothing else produces it at this rate.
//   2. Broadcast arrival rate rising together on MANY ports. A broadcast in a
//      loop circulates forever and multiplies at every switch, so the rise is
//      simultaneous across the broadcast domain rather than on one link.
//   3. Spanning-tree topology changes. STP reconverging repeatedly is either
//      the cause (it has not converged) or the symptom (it keeps trying).
//
// One of these alone is ordinary: a MAC moves when somebody unplugs a laptop
// and plugs it in elsewhere; broadcast rises when a backup starts; STP changes
// when a port comes up. TOGETHER they are a loop, and the scoring below is
// built so that the first fact carries the case and the other two corroborate.
//
// Pure: facts in, a verdict out. No database, no clock, no I/O.

// How many times one MAC must move within the window before it counts as
// flapping. Two is a laptop being moved; a loop produces dozens.
const MIN_MOVES_PER_MAC = 4;

// How many distinct MACs must be flapping. One flapping MAC is a duplicated
// address or a badly behaved NIC — a real fault, but a different one. A loop
// moves everything that talks through it.
const MIN_FLAPPING_MACS = 3;

// Ports carrying a broadcast surge before it reads as a domain-wide event
// rather than one chatty link.
const MIN_SURGING_PORTS = 3;

// How many times a port's broadcast rate must exceed its own baseline to count
// as surging. Deliberately a RATIO against the port's own history, not an
// absolute: an access port doing 5 broadcasts a second is odd, an uplink doing
// 5 is idle.
const BROADCAST_SURGE_RATIO = 8;

// Severity thresholds on the score below.
const CRIT_SCORE = 5;
const WARN_SCORE = 3;

// THE ONE CASE BROADCAST CARRIES ON ITS OWN. A loop entirely BEHIND one port —
// an unmanaged desk switch with two of its ports patched together is the
// everyday version — never makes a MAC flap on the managed switch: every frame
// from down there arrives on the same port, over and over. What the managed
// switch does see is a broadcast storm pouring in on that one port and never
// stopping. So a port whose broadcast rate is both far above its own baseline
// AND above this absolute floor, for at least BROADCAST_SUSTAINED_SAMPLES
// consecutive counter samples, is raised as a SUSPECTED loop behind that port —
// at WARN, never CRIT, and saying why it is less certain than a MAC flap.
//
// The floor is what keeps a quiet port that went from 0.5 to 5 broadcasts a
// second (a ratio of ten) from reading as a storm; a desk switch in a loop
// produces thousands.
const BROADCAST_STORM_MIN_PPS = 200;
// A single sample above the line is a burst — an ARP sweep, a backup starting.
// Consecutive samples are a storm that is not stopping.
const BROADCAST_SUSTAINED_SAMPLES = 2;

function round(n, places = 1) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// Groups flapping MACs by the PAIR of ports they are bouncing between.
//
// This is the part that turns a detection into a work instruction. "Six MACs
// are flapping" tells somebody to go looking; "six MACs are flapping between
// Gi1/0/12 and Gi1/0/24" tells them which two cables to pull, and one of those
// two is the loop.
function pairsFromMoves(moving) {
  const pairs = new Map();
  for (const m of moving) {
    if (m.prevBridgePort == null || m.bridgePort == null) continue;
    const a = Math.min(Number(m.bridgePort), Number(m.prevBridgePort));
    const b = Math.max(Number(m.bridgePort), Number(m.prevBridgePort));
    const key = `${a}:${b}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        portA: a, portB: b, macs: 0, moves: 0,
        ifNameA: null, ifNameB: null, vlans: new Set(),
      });
    }
    const p = pairs.get(key);
    p.macs += 1;
    // The moves INSIDE the window, and nothing else. `moveCount` is the
    // all-time figure and reading it here is the bug migration 117 fixed.
    p.moves += Number(m.movesInWindow || 0);
    if (m.vlan != null) p.vlans.add(Number(m.vlan));
    // The names are per-port and the row only names the port it is on NOW.
    if (Number(m.bridgePort) === a) p.ifNameA = p.ifNameA || m.ifName;
    else p.ifNameB = p.ifNameB || m.ifName;
  }
  return [...pairs.values()]
    .map((p) => ({ ...p, vlans: [...p.vlans].sort((x, y) => x - y) }))
    .sort((a, b) => b.macs - a.macs || b.moves - a.moves);
}

// Builds the sentence. It says what was seen, what it means, and where to go —
// in that order, because a technician reading it at 02:00 needs the third part
// most and will not get there if the first two are a wall of numbers.
function explain({ flappingMacs, totalMoves, pairs, surgingPorts, topoChanges, deviceName }) {
  const where = deviceName ? ` on ${deviceName}` : '';
  const parts = [];

  parts.push(
    `${flappingMacs} MAC addresses moved between ports ${totalMoves} times${where} in the last few minutes.`,
  );

  const top = pairs[0];
  if (top) {
    const a = top.ifNameA || `bridge port ${top.portA}`;
    const b = top.ifNameB || `bridge port ${top.portB}`;
    parts.push(
      `${top.macs} of them are bouncing between ${a} and ${b}`
      + (top.vlans.length === 1 ? ` on VLAN ${top.vlans[0]}` : '')
      + '. One of those two links is almost certainly carrying the loop.',
    );
  }

  if (surgingPorts >= MIN_SURGING_PORTS) {
    parts.push(
      `Broadcast traffic is up sharply on ${surgingPorts} ports at once, which is what a broadcast circulating in a loop looks like from the inside.`,
    );
  }
  if (topoChanges) {
    parts.push(
      `Spanning tree has reconverged ${topoChanges} times in the same window — either it has not settled, or it keeps trying to break the loop and failing.`,
    );
  }

  parts.push(
    'A switch relearns a MAC on whichever port delivered the frame last, so an address on two ports at once means frames from one host are arriving by two paths.',
  );
  return parts.join(' ');
}

// The lower-confidence verdict: no MAC is flapping, but broadcast is pouring
// in on one or more ports and not stopping (see BROADCAST_STORM_MIN_PPS).
function explainStorm({ storming, topoChanges, deviceName }) {
  const where = deviceName ? ` on ${deviceName}` : '';
  const top = storming[0];
  const name = top.ifName || `interface ${top.interfaceId}`;
  const ratio = top.baselineBcastPps > 0 ? Math.round(Number(top.inBcastPps) / Number(top.baselineBcastPps)) : null;
  const parts = [
    `Broadcast traffic arriving on ${name}${where} has stayed at ${round(Number(top.inBcastPps))} frames/s`
    + (ratio ? ` — ${ratio}× its usual ${round(Number(top.baselineBcastPps), 2)}/s —` : '')
    + ' for several samples in a row, and no MAC addresses are moving between ports.',
  ];
  if (storming.length > 1) {
    parts.push(`${storming.length - 1} other port${storming.length > 2 ? 's show' : ' shows'} the same.`);
  }
  parts.push(
    `A storm that pours in on one port without MACs flapping is what a loop BEHIND that port looks like — `
    + `an unmanaged switch or a phone with two of its ports cabled together, downstream of ${name}: the circulating `
    + 'frames all arrive the same way, so this switch never sees an address on two ports.',
  );
  if (topoChanges) {
    parts.push(`Spanning tree also reconverged ${topoChanges} times in the window.`);
  }
  parts.push(
    'This is a suspicion, not a detection: a faulty NIC or a host flooding broadcasts produces the same '
    + `picture. Look at what is connected to ${name} first.`,
  );
  return parts.join(' ');
}

// Reads one device's window. Every input is something the server already
// stores; nothing here polls anything.
//
//   moving       — fdb_entries rows that moved in the window (migration 111),
//                  each with { mac, vlan, bridgePort, prevBridgePort,
//                  movesInWindow, ifName }
//   broadcast    — [{ interfaceId, ifName, inBcastPps, baselineBcastPps,
//                     sustained? }] — `sustained` true when the port's last
//                  BROADCAST_SUSTAINED_SAMPLES samples were all a surge
//   topoChanges  — count of stp.topology_change device_events in the window
//
// Returns null when there is no case to answer, or a verdict with a severity,
// an explanation and the evidence behind it.
function detectLoop({
  moving = [],
  broadcast = [],
  topoChanges = 0,
  windowMinutes = 5,
  deviceId = null,
  deviceName = null,
} = {}) {
  // FACT 1 — the MACs that are actually flapping, not merely moved once.
  const flapping = (Array.isArray(moving) ? moving : []).filter(
    (m) => Number(m.movesInWindow || 0) >= MIN_MOVES_PER_MAC,
  );
  const totalMoves = flapping.reduce((sum, m) => sum + Number(m.movesInWindow || 0), 0);

  // FACT 2 — ports whose broadcast rate is far above their OWN baseline.
  const surging = (Array.isArray(broadcast) ? broadcast : []).filter((b) => {
    // Explicit null checks BEFORE Number(), because Number(null) is 0 and that
    // one conversion turns "we have no baseline for this port" into "this port
    // has never seen a broadcast" — which is the strongest possible evidence
    // of a surge, invented out of missing data.
    if (b == null || b.inBcastPps == null || b.baselineBcastPps == null) return false;
    const now = Number(b.inBcastPps);
    const base = Number(b.baselineBcastPps);
    if (!Number.isFinite(now) || !Number.isFinite(base)) return false;
    // A port whose baseline is a MEASURED zero needs an absolute floor, or the
    // first broadcast it ever sees reads as an infinite surge.
    if (base <= 0) return now >= 50;
    return now / base >= BROADCAST_SURGE_RATIO;
  });

  // The primary fact has to be present. Broadcast and STP corroborate; neither
  // is a loop on its own, and calling one would mean every nightly backup and
  // every port coming up raises a critical.
  //
  // With ONE exception, and it is a weaker verdict: a storm that is sustained
  // and loud on a port, with no MAC flapping at all, is the signature of a loop
  // behind that port (see BROADCAST_STORM_MIN_PPS). Raised at WARN at most,
  // with the reason it is only a suspicion in the explanation.
  if (flapping.length < MIN_FLAPPING_MACS) {
    const storming = surging
      .filter((b) => b.sustained === true && Number(b.inBcastPps) >= BROADCAST_STORM_MIN_PPS)
      .sort((a, b) => Number(b.inBcastPps) - Number(a.inBcastPps));
    if (!storming.length) return null;
    // Scored on the same scale so the two verdicts compare, but capped below
    // CRIT: the corroboration a MAC flap gives is exactly what is missing.
    let score = 2;
    if (topoChanges >= 2) score += 1;
    return {
      deviceId,
      basis: 'broadcast',
      severity: 'WARN',
      score,
      windowMinutes,
      flappingMacs: flapping.length,
      totalMoves,
      surgingPorts: surging.length,
      topoChanges: Number(topoChanges) || 0,
      pairs: [],
      stormPorts: storming.slice(0, 5).map((b) => ({ interfaceId: b.interfaceId, ifName: b.ifName || null })),
      evidence: {
        macs: flapping.slice(0, 20).map((m) => ({
          mac: m.mac, vlan: m.vlan, from: m.prevBridgePort, to: m.bridgePort,
          ifName: m.ifName, moves: Number(m.movesInWindow || 0),
        })),
        broadcast: storming.slice(0, 10).map((b) => ({
          interfaceId: b.interfaceId, ifName: b.ifName,
          pps: round(Number(b.inBcastPps)), baselinePps: round(Number(b.baselineBcastPps), 2),
          sustained: true,
        })),
      },
      explanation: explainStorm({ storming, topoChanges: Number(topoChanges) || 0, deviceName }),
    };
  }

  const pairs = pairsFromMoves(flapping);

  // The score. Flapping MACs carry it; the other two facts add to it, which is
  // how a clear-cut loop reaches CRIT and an ambiguous one stops at WARN.
  let score = 0;
  if (flapping.length >= MIN_FLAPPING_MACS) score += 2;
  if (flapping.length >= MIN_FLAPPING_MACS * 3) score += 1;
  // A pair of ports carrying most of the flapping is the strongest single
  // signal there is: it names the two cables.
  if (pairs[0] && pairs[0].macs >= MIN_FLAPPING_MACS) score += 1;
  if (surging.length >= MIN_SURGING_PORTS) score += 2;
  if (topoChanges >= 2) score += 1;

  const severity = score >= CRIT_SCORE ? 'CRIT' : (score >= WARN_SCORE ? 'WARN' : 'INFO');

  return {
    deviceId,
    basis: 'mac_flap',
    severity,
    score,
    windowMinutes,
    flappingMacs: flapping.length,
    totalMoves,
    surgingPorts: surging.length,
    topoChanges: Number(topoChanges) || 0,
    // The two ports to go and look at, best first.
    pairs: pairs.slice(0, 5).map((p) => ({
      portA: p.portA, portB: p.portB, ifNameA: p.ifNameA, ifNameB: p.ifNameB,
      macs: p.macs, moves: p.moves, vlans: p.vlans,
    })),
    // Enough of the raw observations to check the verdict by hand, capped so a
    // storm does not put a thousand MACs in a JSON column.
    evidence: {
      macs: flapping.slice(0, 20).map((m) => ({
        mac: m.mac, vlan: m.vlan, from: m.prevBridgePort, to: m.bridgePort,
        ifName: m.ifName, moves: Number(m.movesInWindow || 0),
      })),
      broadcast: surging.slice(0, 10).map((b) => ({
        interfaceId: b.interfaceId, ifName: b.ifName,
        pps: round(Number(b.inBcastPps)), baselinePps: round(Number(b.baselineBcastPps), 2),
      })),
    },
    explanation: explain({
      flappingMacs: flapping.length,
      totalMoves,
      pairs,
      surgingPorts: surging.length,
      topoChanges: Number(topoChanges) || 0,
      deviceName,
    }),
  };
}

module.exports = {
  detectLoop,
  pairsFromMoves,
  MIN_MOVES_PER_MAC,
  MIN_FLAPPING_MACS,
  MIN_SURGING_PORTS,
  BROADCAST_SURGE_RATIO,
  CRIT_SCORE,
  WARN_SCORE,
  BROADCAST_STORM_MIN_PPS,
  BROADCAST_SUSTAINED_SAMPLES,
};
