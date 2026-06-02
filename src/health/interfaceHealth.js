'use strict';

// Per-interface health derived from a traffic payload (proc or snmp). Pure +
// shared by the /api/interfaces route and the fleet-health rollup. status:
// down | bad (errors / >=90% util) | warn (drops / >=75% util) | ok.

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

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
    const down = !!operStatus && !['up', 'unknown', 'dormant'].includes(operStatus);
    let status = 'ok';
    if (down) status = 'down';
    else if (errPerSec > 0 || (utilPct != null && utilPct >= 90)) status = 'bad';
    else if (dropPerSec > 0 || (utilPct != null && utilPct >= 75)) status = 'warn';
    return {
      iface: i.iface, operStatus, speedMbps,
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

module.exports = { computeInterfaceHealth, interfaceHealthSummary, IFACE_RANK };
