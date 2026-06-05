'use strict';

// Turns an agent's latest active speed-test into a health signal, folded into the
// fleet/agent verdict like the interface signal. A measurement below the
// configured Mbps floors — or one that failed outright — flags the agent.
//
// Thresholds are opt-in (disabled by default): "too slow" depends on the link,
// so nothing is flagged until an admin sets a floor (Settings → Analysis).
// Pure + dependency-free for direct unit testing.

const round1 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 10) / 10);
const numOr0 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// `latest` is a speedtest_results row ({ ts, ok, down_mbps, up_mbps }) or null.
// `thr` is { enabled, downWarnMbps, downBadMbps, upWarnMbps, upBadMbps }.
// Returns { status:'ok'|'warn'|'bad', downMbps, upMbps, ts, ok, reason } or null
// when disabled or there is no measurement.
function throughputHealthSummary(latest, thr = {}) {
  if (!thr || !thr.enabled || !latest) return null;
  const down = Number.isFinite(Number(latest.down_mbps)) ? Number(latest.down_mbps) : null;
  const up = Number.isFinite(Number(latest.up_mbps)) ? Number(latest.up_mbps) : null;
  const ok = latest.ok === 1 || latest.ok === true;
  const ts = latest.ts || null;

  const dWarn = numOr0(thr.downWarnMbps);
  const dBad = numOr0(thr.downBadMbps);
  const uWarn = numOr0(thr.upWarnMbps);
  const uBad = numOr0(thr.upBadMbps);

  const cands = [];
  if (!ok) {
    cands.push({ status: 'bad', reason: 'Last speed test failed.' });
  } else {
    if (down != null) {
      if (dBad > 0 && down < dBad) cands.push({ status: 'bad', reason: `Download ${round1(down)} Mbps (below ${dBad}).` });
      else if (dWarn > 0 && down < dWarn) cands.push({ status: 'warn', reason: `Download ${round1(down)} Mbps (below ${dWarn}).` });
    }
    if (up != null) {
      if (uBad > 0 && up < uBad) cands.push({ status: 'bad', reason: `Upload ${round1(up)} Mbps (below ${uBad}).` });
      else if (uWarn > 0 && up < uWarn) cands.push({ status: 'warn', reason: `Upload ${round1(up)} Mbps (below ${uWarn}).` });
    }
  }

  const tier = { bad: 0, warn: 1, ok: 2 };
  cands.sort((a, b) => tier[a.status] - tier[b.status]);
  const top = cands[0] || { status: 'ok', reason: `Throughput OK (down ${round1(down)} / up ${round1(up)} Mbps).` };
  return { status: top.status, reason: top.reason, downMbps: round1(down), upMbps: round1(up), ts, ok };
}

module.exports = { throughputHealthSummary };
