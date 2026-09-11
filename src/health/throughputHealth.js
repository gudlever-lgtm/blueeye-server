'use strict';

// Turns an agent's latest active speed-test into a health signal, folded into the
// fleet/agent verdict like the interface signal. A measurement below the
// configured Mbps floors — or one that failed outright — flags the agent.
//
// Thresholds are opt-in (disabled by default): "too slow" depends on the link,
// so nothing is flagged until an admin sets a floor (Settings → Analysis).
// Pure + dependency-free for direct unit testing.

const { numOrNull } = require('../lib/num');

const round1 = (n) => (numOrNull(n) === null ? null : Math.round(numOrNull(n) * 10) / 10);
// Thresholds are the OPPOSITE case and 0 is correct here: an unset floor means
// "do not flag on this", and every use below is guarded by `> 0`.
const numOr0 = (v) => { const n = numOrNull(v); return n === null ? 0 : n; };

// `latest` is a speedtest_results row ({ ts, ok, down_mbps, up_mbps }) or null.
// `thr` is { enabled, downWarnMbps, downBadMbps, upWarnMbps, upBadMbps }.
// Returns { status:'ok'|'warn'|'bad', downMbps, upMbps, ts, ok, reason } or null
// when disabled or there is no measurement.
function throughputHealthSummary(latest, thr = {}) {
  if (!thr || !thr.enabled || !latest) return null;
  // A MISSING reading must stay null. `Number(null)` is 0, and 0 Mbps is below
  // every floor an admin can set — so a speed-test row with no figure used to
  // flag the agent BAD for "Download 0 Mbps", an outage invented out of absence.
  const down = numOrNull(latest.down_mbps);
  const up = numOrNull(latest.up_mbps);
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
