'use strict';

// Per-interface health derived from a traffic payload (proc or snmp). Pure +
// shared by the /api/interfaces route and the fleet-health rollup. status:
// down | bad (errors / >=90% util) | warn (drops / >=75% util) | ok.
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
].join('|') + ')$', 'i');

// Is this interface a virtual/software port (container/VM/VPN/loopback)?
function isVirtual(name) {
  return typeof name === 'string' && VIRTUAL_IFACE_RE.test(name);
}

function computeInterfaceHealth(traffic) {
  const ifaces = traffic && Array.isArray(traffic.interfaces) ? traffic.interfaces : [];
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
    const errPerSec = round2((rxErrors + txErrors) / elapsed);
    const dropPerSec = round2((rxDrop + txDrop) / elapsed);
    const operStatus = i.operStatus || null;
    const virtual = isVirtual(i.iface);
    const linkDown = !!operStatus && !['up', 'unknown', 'dormant'].includes(operStatus);
    let status = 'ok';
    // A down virtual/idle interface (docker0, veth…, tun…) is expected, not a
    // fault — don't escalate it. A real link down still reads 'down'.
    if (linkDown && !virtual) status = 'down';
    else if (errPerSec > 0 || (utilPct != null && utilPct >= 90)) status = 'bad';
    else if (dropPerSec > 0 || (utilPct != null && utilPct >= 75)) status = 'warn';
    return {
      iface: i.iface, operStatus, speedMbps, virtual, linkDown,
      rxBytesPerSec, txBytesPerSec, utilPct,
      errPerSec, dropPerSec, rxErrors, txErrors, rxDrop, txDrop, status,
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

module.exports = { computeInterfaceHealth, interfaceHealthSummary, IFACE_RANK, isVirtual };
