'use strict';

// Per-interface health derived from a traffic payload (proc or snmp). Pure +
// shared by the /api/interfaces route and the fleet-health rollup. status:
// down | bad (errors / >=90% util / duplex mismatch / CRC / carrier) |
// warn (drops / >=75% util / half duplex / NIC fifo overrun) | ok.
// `reasons` names WHICH fault it is (see reasonsOf).
//
// Virtual/software interfaces (Docker/K8s/VM/VPN/loopback) are routinely "down"
// simply because they are idle — e.g. the docker0 bridge has no carrier until a
// container attaches. That is NOT a link fault, so a *down* virtual interface is
// reported as `ok` (with `virtual:true`, `linkDown:true`) and never escalates an
// agent to CRITICAL. A real NIC (eth*/en*/wl*/bond*, VLAN sub-ifs, appliance
// bridges like br-lan/br0) matches no pattern and keeps the strict link-down
// behaviour. Errors / discards / utilisation on a virtual interface that IS up
// are still flagged normally.

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// Well-known Linux virtual/software interface names. Deliberately specific (each
// alternative is anchored + shape-checked) so a physical NIC or a meaningful
// appliance bridge (br-lan, br0) is never silently ignored.
const VIRTUAL_IFACE_RE = new RegExp('^(' + [
  'lo\\d*',                          // loopback
  'docker\\d+',                      // Docker default bridge (docker0)
  'br-[0-9a-f]{12}',                 // Docker user-defined bridges (br-<netid>)
  'veth[0-9a-z]+',                   // veth pairs (containers)
  'virbr\\d+(-nic)?', 'vnet\\d+',    // libvirt/KVM bridges + guest taps
  'tap\\d+', 'tun\\d+',              // tun/tap (OpenVPN, …)
  'wg\\d+', 'tailscale\\d*', 'nordlynx\\d*', 'zt[0-9a-z]{6,}', // WireGuard / VPN / ZeroTier overlays
  'vmnet\\d+', 'vboxnet\\d+',        // VMware / VirtualBox host-only nets
  'ifb\\d+', 'dummy\\d+',            // intermediate-functional-block / dummy
  '(gre|gretap|sit|ip6tnl|ip6gre|erspan)\\d*', // tunnels
  'macvtap\\d+',                     // macvtap
  'cni\\d+', 'cali[0-9a-f]+', 'flannel\\.?\\d*', 'cilium_\\w+', // common K8s CNIs
  'vEthernet \\(.+\\)',             // Windows Hyper-V virtual switch ports
  'utun\\d+', 'awdl\\d+', 'llw\\d+',  // macOS VPN tunnels, AirDrop / low-latency WLAN
  'anpi\\d+', 'ap\\d+', 'gif\\d+', 'stf\\d+', // macOS internal, hotspot, 6in4 tunnels
  'bridge\\d+',                     // macOS Thunderbolt Bridge / Internet Sharing
].join('|') + ')$', 'i');

// Link state to the lowercase operstate vocabulary. Windows agents before
// 0.37.3 send Get-NetAdapter's Status raw ("Up", "Disconnected", "Disabled",
// "Not Present"); compared case-sensitively, every Windows link read DOWN.
const WIN_OPER_STATUS = { disconnected: 'down', disabled: 'down' };
function normalizeOperStatus(status) {
  if (typeof status !== 'string') return null;
  const key = status.replace(/[\s_-]/g, '').toLowerCase();
  if (!key) return null;
  return WIN_OPER_STATUS[key] || key;
}

// Is this interface a virtual/software port (container/VM/VPN/loopback)?
function isVirtual(name) {
  return typeof name === 'string' && VIRTUAL_IFACE_RE.test(name);
}

// A counter that may legitimately be ABSENT (a source that cannot read it) and
// whose absence must never be read as zero — zero is the answer that rules a
// fault out. Same strictness as `lateCollisions` below: a finite non-negative
// number, or null.
function optCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}
const perSec = (n, elapsed) => (n === null ? null : round2(n / elapsed));

// The negotiated duplex, from the agent's /sys/class/net/<if>/duplex (proc
// source, agent 0.40+). Anything but the kernel's three words is null.
function duplexOf(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'full' || s === 'half' || s === 'unknown' ? s : null;
}

// WHY an interface is unhealthy, as codes the dashboard translates
// (iface.reason.* in public/i18n.js) and the diagnose rules read as facts.
// Each one is a different fix, which is the point of naming them apart:
//
//   duplex_mismatch — half duplex AND collisions / frame errors / late
//                     collisions moving. A switched port has no business
//                     colliding; the partner is almost certainly at full. The
//                     fix is the port configuration, not the cable.
//   half_duplex     — half duplex with nothing moving yet. Worth knowing on a
//                     switched network: it becomes the fault above the moment
//                     both ends transmit at once.
//   crc_errors      — frame (CRC/alignment) errors on a link that is NOT half
//                     duplex: the cable, the patch lead, the SFP, the port —
//                     or the full-duplex end of a mismatch.
//   carrier_errors  — the transmitter lost carrier: a flapping link or bad
//                     cabling.
//   fifo_overrun    — the NIC's own ring overran: the HOST is too slow to
//                     drain it (CPU, interrupt moderation, driver), not the wire.
function reasonsOf({ duplex, collPerSec, frameErrPerSec, carrierErrPerSec, fifoErrPerSec, lateCollPerSec }) {
  const reasons = [];
  const moving = (v) => v !== null && v > 0;
  if (duplex === 'half') {
    reasons.push(moving(collPerSec) || moving(frameErrPerSec) || moving(lateCollPerSec) ? 'duplex_mismatch' : 'half_duplex');
  } else if (moving(frameErrPerSec)) {
    reasons.push('crc_errors');
  }
  if (moving(carrierErrPerSec)) reasons.push('carrier_errors');
  if (moving(fifoErrPerSec)) reasons.push('fifo_overrun');
  return reasons;
}

function computeInterfaceHealth(traffic) {
  // Defensive: a result payload is only shallow-validated at ingest (object +
  // size), so `traffic.interfaces` may carry a null/non-object element from a
  // malformed or hostile agent. Drop those here rather than let a property read
  // throw — one bad element must never blank the whole /api/interfaces or
  // /fleet/health view (see routes/fleet.js per-agent guards).
  const ifaces = traffic && Array.isArray(traffic.interfaces)
    ? traffic.interfaces.filter((i) => i && typeof i === 'object')
    : [];
  const elapsed = Number(traffic && traffic.elapsedSec) > 0 ? Number(traffic.elapsedSec) : 1;
  return ifaces.map((i) => {
    const rxBytesPerSec = Number(i.rxBytesPerSec) || 0;
    const txBytesPerSec = Number(i.txBytesPerSec) || 0;
    const speedMbps = Number(i.speedMbps) > 0 ? Number(i.speedMbps) : null;
    const utilPct = speedMbps ? round1((Math.max(rxBytesPerSec, txBytesPerSec) * 8) / (speedMbps * 1e6) * 100) : null;
    const rxErrors = Number(i.rxErrors) || 0;
    const txErrors = Number(i.txErrors) || 0;
    const rxDrop = Number(i.rxDrop) || 0;
    const txDrop = Number(i.txDrop) || 0;
    // Late collisions (EtherLike-MIB, SNMP only). NULL when the source cannot
    // report them — a /proc sample never can, and plenty of switches omit the
    // MIB — and that is deliberately NOT folded into 0: zero late collisions is
    // what rules a duplex mismatch out, so a device that cannot answer must not
    // be read as answering "none".
    // Strict on purpose, where the other counters above coerce: `Number([])` is
    // 0, and 0 is precisely the value that RULES THIS FAULT OUT. A counter whose
    // absence is meaningful cannot be read through a coercion that turns junk
    // into the most consequential answer available. A number, or nothing.
    const lateCollisions = typeof i.lateCollisions === 'number' && Number.isFinite(i.lateCollisions) && i.lateCollisions >= 0
      ? i.lateCollisions
      : null;
    const lateCollPerSec = lateCollisions === null ? null : round2(lateCollisions / elapsed);
    const errPerSec = round2((rxErrors + txErrors) / elapsed);
    const dropPerSec = round2((rxDrop + txDrop) / elapsed);
    // The error detail the proc source reads from /proc/net/dev (agent 0.40+):
    // per-interval deltas of rx frame, rx fifo, tx colls and tx carrier. Null —
    // not 0 — from every other source and every older agent.
    const duplex = duplexOf(i.duplex);
    const collPerSec = perSec(optCount(i.txCollisions), elapsed);
    const frameErrPerSec = perSec(optCount(i.rxFrameErrors), elapsed);
    const fifoErrPerSec = perSec(optCount(i.rxFifoErrors), elapsed);
    const carrierErrPerSec = perSec(optCount(i.txCarrierErrors), elapsed);
    const operStatus = normalizeOperStatus(i.operStatus);
    const virtual = isVirtual(i.iface);
    const linkDown = !!operStatus && !['up', 'unknown', 'dormant'].includes(operStatus);
    // A link that is down has no duplex worth judging (the kernel reports the
    // last negotiated value, or none), so reasons are only read on a live link.
    const reasons = linkDown ? [] : reasonsOf({ duplex, collPerSec, frameErrPerSec, carrierErrPerSec, fifoErrPerSec, lateCollPerSec });
    let status = 'ok';
    // A down virtual/idle interface (docker0, veth…, tun…) is expected, not a
    // fault — don't escalate it. A real link down still reads 'down'.
    if (linkDown && !virtual) status = 'down';
    else if (errPerSec > 0 || (utilPct != null && utilPct >= 90)
      || reasons.includes('duplex_mismatch') || reasons.includes('crc_errors') || reasons.includes('carrier_errors')) status = 'bad';
    else if (dropPerSec > 0 || (utilPct != null && utilPct >= 75)
      || reasons.includes('half_duplex') || reasons.includes('fifo_overrun')) status = 'warn';
    return {
      iface: i.iface, operStatus, speedMbps, virtual, linkDown,
      rxBytesPerSec, txBytesPerSec, utilPct,
      errPerSec, dropPerSec, rxErrors, txErrors, rxDrop, txDrop, lateCollPerSec,
      duplex, collPerSec, frameErrPerSec, fifoErrPerSec, carrierErrPerSec, reasons, status,
    };
  });
}

const IFACE_RANK = { down: 0, bad: 1, warn: 2, ok: 3 };

// Reduce an agent's interfaces to one signal: the worst interface + a count.
// null when there is no interface data at all.
function interfaceHealthSummary(traffic) {
  const ifs = computeInterfaceHealth(traffic);
  if (!ifs.length) return null;
  let worst = ifs[0];
  for (const i of ifs) if (IFACE_RANK[i.status] < IFACE_RANK[worst.status]) worst = i;
  const issues = ifs.filter((i) => i.status !== 'ok').length;
  return { status: worst.status, worst, count: ifs.length, issues };
}

module.exports = { computeInterfaceHealth, interfaceHealthSummary, IFACE_RANK, isVirtual, reasonsOf };
