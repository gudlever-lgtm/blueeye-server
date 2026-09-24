'use strict';

// Reads a transaction result's PHASE breakdown and says whether the time went
// on the network or on the application.
//
// That is the question, every time. "The system is slow" arrives as a ticket,
// somebody looks at a graph of one number per step, and the argument that
// follows — networks team versus application team — is unwinnable from that
// number, because a 4200 ms step looks identical whether the name server, the
// path, the handshake, the server or the download was responsible.
//
// The phases make it answerable, and the arithmetic is worth stating plainly:
//
//   dns       name resolution.
//   tcp       the TCP handshake, which is EXACTLY ONE round trip. This is the
//             network RTT, measured without a capture and without a ping.
//   tls       the TLS handshake — roughly two more round trips plus the crypto,
//             so a tls phase far above 2×tcp is the server's CPU, not the path.
//   ttfb      request sent → first response byte. It contains one round trip of
//             travel; the REST is the server thinking. So:
//                 think ≈ ttfb − tcp
//             which is the single most useful derived number here, and the one
//             that ends the argument.
//   transfer  first byte → last byte: response size over achieved throughput.
//
// Pure. No I/O, no model, no thresholds that live anywhere but here.

// A phase has to be worth this share of the step before it is named as the
// cause. Below it, nothing dominates and the honest answer is "mixed".
const DOMINANT_SHARE = 0.5;
// The network share is lower because a round trip is never most of a slow step
// — if a third of a slow request is spent on the handshake, the path is the
// story even though the server still took the rest.
const NETWORK_SHARE = 0.3;
// Steps faster than this are not worth attributing. Attributing 4 ms is noise
// wearing a verdict's clothes.
const MIN_INTERESTING_MS = 50;

function num(v) { return Number.isFinite(v) ? v : null; }
function ms(v) { const n = num(v); return n == null ? 0 : n; }

// The phase records on a result, as an array (possibly empty).
function phasesOf(result) {
  return result && Array.isArray(result.step_phases) ? result.step_phases : [];
}

// Which step to explain: the one that FAILED if any did, else the slowest.
// A failed step is always the interesting one even when a different step was
// slower — the slow step is a symptom, the failed step is the event.
function focusStep(result) {
  const phases = phasesOf(result);
  if (!phases.length) return null;
  const failed = Number.isInteger(result.step_failed) ? result.step_failed : null;
  if (failed != null && phases[failed]) return { index: failed, phases: phases[failed], failed: true };

  let best = null;
  for (let i = 0; i < phases.length; i += 1) {
    const p = phases[i];
    if (!p || typeof p !== 'object') continue;
    const total = ms(p.dns) + ms(p.tcp) + ms(p.tls) + ms(p.ttfb) + ms(p.transfer);
    if (!best || total > best.total) best = { index: i, phases: p, total, failed: false };
  }
  return best;
}

// Splits one phase record into the three numbers a person actually wants.
// `think` is the server's own time with the round trip taken back out; it is
// null when there is no handshake measurement to subtract, because guessing the
// RTT would make the most load-bearing number here the least trustworthy.
function split(p) {
  const tcp = num(p.tcp);
  const ttfb = num(p.ttfb);
  return {
    resolution: num(p.dns),
    network: tcp,
    handshake: num(p.tls),
    think: tcp != null && ttfb != null ? Math.max(0, Math.round(ttfb - tcp)) : null,
    ttfb,
    transfer: num(p.transfer),
    total: ms(p.dns) + ms(p.tcp) + ms(p.tls) + ms(p.ttfb) + ms(p.transfer),
    reused: p.reused === true,
    address: typeof p.address === 'string' ? p.address : null,
  };
}

// Explains one result. Returns { verdict, explanation, step, split } — or
// verdict 'unknown' with a reason when there is nothing to read, which is the
// honest answer for an agent too old to send phases at all.
//
// verdict ∈ dns | network | tls | application | transfer | mixed | unknown
function explainPhases(result) {
  const focus = focusStep(result);
  if (!focus || !focus.phases) {
    return { verdict: 'unknown', explanation: 'This run carries no phase breakdown (the agent predates it, or the test type cannot measure one).', step: null, split: null };
  }
  const s = split(focus.phases);
  const stepLabel = phasesOf(result).length > 1 ? `Step ${focus.index + 1}` : 'The run';

  // A failed step is explained by WHERE IT STOPPED, not by which phase was
  // largest — on a failure the largest phase is usually just the timeout.
  if (focus.failed) {
    if (s.network == null && s.resolution != null) {
      return { verdict: 'dns', explanation: `${stepLabel} failed during name resolution after ${s.resolution} ms. Nothing was sent: there was no address to send it to.`, step: focus.index, split: s };
    }
    if (s.network == null) {
      return { verdict: 'network', explanation: `${stepLabel} failed before the TCP handshake completed. Nothing reached the application — this is the path, a firewall, or a host that is down.`, step: focus.index, split: s };
    }
    if (s.handshake == null && s.ttfb == null) {
      // NOT 'network'. The handshake completed, so the path demonstrably
      // carried packets both ways — labelling this a network fault would
      // contradict the sentence beside it. There is also nothing here to pin on
      // the application: for a tcp test there is no application exchange to
      // observe at all. 'mixed' is the honest answer, and the sentence says
      // exactly how far it got.
      return { verdict: 'mixed', explanation: `${stepLabel} completed its TCP handshake in ${s.network} ms and then failed. The host is reachable and the port answers, so the path carried packets both ways; whatever failed happened after that.`, step: focus.index, split: s };
    }
    if (s.ttfb == null) {
      return { verdict: 'application', explanation: `${stepLabel} connected in ${s.network} ms${s.handshake != null ? ` and finished TLS in ${s.handshake} ms` : ''}, then never sent a first byte. The network delivered the request; the application did not answer it.`, step: focus.index, split: s };
    }
    return { verdict: 'application', explanation: `${stepLabel} reached the application (first byte after ${s.ttfb} ms) and failed there. This is not a connectivity fault.`, step: focus.index, split: s };
  }

  if (s.total < MIN_INTERESTING_MS) {
    return { verdict: 'mixed', explanation: `${stepLabel} took ${Math.round(s.total)} ms in total. Nothing in it is worth attributing.`, step: focus.index, split: s };
  }

  const share = (v) => (v == null ? 0 : v / s.total);

  if (share(s.resolution) >= DOMINANT_SHARE) {
    return { verdict: 'dns', explanation: `${stepLabel} spent ${s.resolution} ms of ${Math.round(s.total)} ms resolving the name. The connection itself was ${s.network != null ? `${s.network} ms` : 'not the problem'} — fix the resolver, not the path.`, step: focus.index, split: s };
  }
  if (s.think != null && share(s.think) >= DOMINANT_SHARE) {
    return { verdict: 'application', explanation: `${stepLabel} spent ${s.think} ms waiting for the server to start answering, against a network round-trip of ${s.network} ms. The path is fine; the application is slow.`, step: focus.index, split: s };
  }
  if (share(s.network) >= NETWORK_SHARE) {
    return { verdict: 'network', explanation: `${stepLabel} spent ${s.network} ms of ${Math.round(s.total)} ms on the TCP handshake alone. One round trip costing that much is the path, not the application.`, step: focus.index, split: s };
  }
  if (s.handshake != null && share(s.handshake) >= DOMINANT_SHARE) {
    const expected = s.network != null ? s.network * 2 : null;
    const cpu = expected != null && s.handshake > expected * 2;
    return {
      verdict: 'tls',
      explanation: cpu
        ? `${stepLabel} spent ${s.handshake} ms on the TLS handshake against a ${s.network} ms round trip. A handshake is about two round trips, so most of that is the server's own crypto, not the path.`
        : `${stepLabel} spent ${s.handshake} ms of ${Math.round(s.total)} ms on the TLS handshake.`,
      step: focus.index,
      split: s,
    };
  }
  if (share(s.transfer) >= DOMINANT_SHARE) {
    return { verdict: 'transfer', explanation: `${stepLabel} spent ${s.transfer} ms of ${Math.round(s.total)} ms receiving the body. That is size over throughput — a large response, a narrow link, or both.`, step: focus.index, split: s };
  }

  const parts = [];
  if (s.resolution) parts.push(`${s.resolution} ms dns`);
  if (s.network) parts.push(`${s.network} ms connect`);
  if (s.handshake) parts.push(`${s.handshake} ms tls`);
  if (s.think) parts.push(`${s.think} ms server`);
  if (s.transfer) parts.push(`${s.transfer} ms transfer`);
  return {
    verdict: 'mixed',
    explanation: `${stepLabel} took ${Math.round(s.total)} ms with no single phase dominating (${parts.join(', ')}). Nothing here points at one owner.`,
    step: focus.index,
    split: s,
  };
}

// Sums each phase across every step of a result — what a waterfall renders, and
// what a report totals. Null stays null: a test with no TLS anywhere must not
// show a 0 ms TLS bar, which reads as "instant" rather than "never happened".
function totalPhases(result) {
  const phases = phasesOf(result).filter((p) => p && typeof p === 'object');
  if (!phases.length) return null;
  const out = { dns: null, tcp: null, tls: null, ttfb: null, transfer: null };
  for (const p of phases) {
    for (const key of Object.keys(out)) {
      const v = num(p[key]);
      if (v == null) continue;
      out[key] = (out[key] || 0) + v;
    }
  }
  return out;
}

module.exports = { explainPhases, totalPhases, focusStep, DOMINANT_SHARE, NETWORK_SHARE, MIN_INTERESTING_MS };
