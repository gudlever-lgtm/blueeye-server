'use strict';

// Reads a transaction capture — the packet headers of the traffic one test run
// generated — and says what went wrong on the wire.
//
// WHAT THIS ADDS OVER THE PHASE TIMINGS. The phases (analysis/transactionPhases.js)
// say a handshake took 900 ms. They cannot say whether the SYN was sent four
// times because the first three were dropped, or whether it arrived first time
// and the server was slow to accept. Same number, same graph, different fault,
// different owner. Five things are only visible here:
//
//   retransmissions   the same segment sent again = the first one was lost
//   duplicate ACKs    the receiver asking again for a gap = out-of-order delivery
//   resets            a refusal, which a connect timeout looks exactly like
//   zero windows      the RECEIVER out of buffer — an application fault that
//                     presents as a slow network
//   MSS               what each end offered: an MTU or tunnel mismatch, found
//                     before it becomes an unexplainable stall on big responses
//
// Deterministic and local, like every other verdict in this product: robust
// counting, no model, and an explanation that travels with the measurement so
// the row reads the same in six weeks as it did on the screen.

const TCP = 6;

// A SYN answered slower than this is worth naming on its own: it is a round
// trip, and a round trip inside one site does not take a quarter of a second.
const SLOW_HANDSHAKE_MS = 250;
// Below the Ethernet default of 1460 means something in the path is shrinking
// the segment — a tunnel, a PPPoE link, a VPN.
const STANDARD_MSS = 1460;

function isFlag(rec, letter) { return typeof rec.flags === 'string' && rec.flags.includes(letter); }
function num(v) { return Number.isFinite(v) ? v : null; }

// Which side is the agent? The first SYN it sent names it. Falls back to the
// first packet's source, which is the same answer whenever a capture starts
// where it should — at the beginning of the conversation.
function localSideOf(packets) {
  const syn = packets.find((p) => p.proto === TCP && isFlag(p, 'S') && !isFlag(p, 'A'));
  const first = syn || packets[0];
  return first ? { ip: first.src, port: first.sport } : null;
}

function isOutbound(rec, local) {
  if (!local) return null;
  return rec.src === local.ip;
}

// Counts the wire-level faults. Pure arithmetic over the records — every number
// here is a count of packets matching a stated condition, so a disagreement
// about a verdict can always be settled by looking at the same packets.
function measure(packets) {
  const list = Array.isArray(packets) ? packets.filter((p) => p && typeof p === 'object') : [];
  const local = localSideOf(list);

  const seen = new Map();        // direction|seq|len → times sent
  const ackRuns = new Map();     // direction|ack → consecutive bare ACKs
  let retransmits = 0;
  let dupAcks = 0;
  let resets = 0;
  let resetOnSyn = 0;
  let zeroWindows = 0;
  let syns = 0;
  let synAcks = 0;
  let handshakeRttMs = null;
  let mss = null;
  let firstSynAt = null;
  let bytesOut = 0;
  let bytesIn = 0;

  for (const rec of list) {
    if (rec.proto !== TCP) continue;
    const out = isOutbound(rec, local);
    const dir = out === null ? '?' : (out ? 'o' : 'i');
    const payload = Number.isFinite(rec.payload) ? rec.payload : 0;

    if (Number.isFinite(rec.mss)) mss = mss == null ? rec.mss : Math.min(mss, rec.mss);
    if (out) bytesOut += Number.isFinite(rec.len) ? rec.len : 0;
    else bytesIn += Number.isFinite(rec.len) ? rec.len : 0;

    if (isFlag(rec, 'S') && !isFlag(rec, 'A')) {
      syns += 1;
      if (firstSynAt == null) firstSynAt = num(rec.t);
    }
    if (isFlag(rec, 'S') && isFlag(rec, 'A')) {
      synAcks += 1;
      if (handshakeRttMs == null && firstSynAt != null && num(rec.t) != null) {
        handshakeRttMs = Math.round((rec.t - firstSynAt) * 1000) / 1000;
      }
    }
    if (isFlag(rec, 'R')) {
      resets += 1;
      // A reset answering a SYN is a REFUSAL — the port is closed or a firewall
      // is rejecting rather than dropping. A reset later in the conversation is
      // something else entirely, so they are counted apart.
      if (synAcks === 0) resetOnSyn += 1;
    }
    // A zero window on a RST is meaningless (the connection is gone), so it is
    // not counted as the receiver being out of buffer.
    if (rec.win === 0 && !isFlag(rec, 'R')) zeroWindows += 1;

    // A segment carrying data (or a SYN) seen twice with the same sequence
    // number is a retransmission: the sender did not get its acknowledgement.
    if (payload > 0 || isFlag(rec, 'S')) {
      const key = `${dir}|${rec.seq}|${payload}`;
      const times = (seen.get(key) || 0) + 1;
      seen.set(key, times);
      if (times > 1) retransmits += 1;
    }

    // A bare ACK repeating an acknowledgement number is the receiver saying "I
    // am still missing the same thing" — the classic out-of-order signature.
    if (payload === 0 && isFlag(rec, 'A') && !isFlag(rec, 'S') && !isFlag(rec, 'F') && !isFlag(rec, 'R')) {
      const key = `${dir}|${rec.ack}`;
      const times = (ackRuns.get(key) || 0) + 1;
      ackRuns.set(key, times);
      if (times > 1) dupAcks += 1;
    }
  }

  const dataPackets = list.filter((p) => p.proto === TCP && Number.isFinite(p.payload) && p.payload > 0).length;
  return {
    packets: list.length,
    retransmits,
    retransmitPct: dataPackets + syns > 0 ? Math.round((retransmits / (dataPackets + syns)) * 1000) / 10 : 0,
    dupAcks,
    resets,
    resetOnSyn,
    zeroWindows,
    syns,
    synAcks,
    synUnanswered: Math.max(0, syns - synAcks),
    handshakeRttMs,
    mss,
    bytesOut,
    bytesIn,
    local,
  };
}

// Turns the counts into a verdict and the sentence a technician reads.
// `truncated` says the capture hit its ceiling, which changes what the numbers
// can be claimed to mean.
function classify(m, { truncated = false } = {}) {
  if (!m.packets) {
    return { pattern: 'empty', explanation: 'The capture matched no packets at all. Either nothing was sent, or it left by an interface this capture was not watching.' };
  }
  if (m.syns > 0 && m.synAcks === 0) {
    if (m.resetOnSyn > 0) {
      return { pattern: 'refused', explanation: `The connection was refused: ${m.syns} SYN${m.syns > 1 ? 's' : ''} sent, answered with a reset. The host is up and reachable — the port is closed, or a firewall is rejecting rather than dropping.` };
    }
    return { pattern: 'blackhole', explanation: `${m.syns} SYN${m.syns > 1 ? 's were' : ' was'} sent and nothing came back at all. Not a refusal — a refusal returns a reset. Something on the path is dropping silently: a firewall, an ACL, or a host that is not there.` };
  }
  if (m.resetOnSyn === 0 && m.resets > 0) {
    return { pattern: 'reset', explanation: `The connection was established and then reset after ${m.packets} packets. The far end dropped it mid-conversation — an application restart, an idle timeout, or a stateful device that lost the flow.` };
  }
  if (m.zeroWindows > 0) {
    return { pattern: 'window_limited', explanation: `The receiver advertised a zero window ${m.zeroWindows} time${m.zeroWindows > 1 ? 's' : ''}: it ran out of buffer and told the sender to stop. That is the application not reading fast enough, not the network being slow — the packets arrived, nobody collected them.` };
  }
  if (m.retransmits > 0) {
    const rtt = m.handshakeRttMs != null ? ` The handshake itself took ${m.handshakeRttMs} ms.` : '';
    return { pattern: 'loss', explanation: `${m.retransmits} segment${m.retransmits > 1 ? 's were' : ' was'} retransmitted (${m.retransmitPct}% of what was sent)${m.dupAcks ? ` and ${m.dupAcks} duplicate ACK${m.dupAcks > 1 ? 's' : ''} came back` : ''}. Packets are being lost on this path — congestion, a duplex mismatch, or a bad cable.${rtt}` };
  }
  if (m.dupAcks > 0) {
    return { pattern: 'reordering', explanation: `${m.dupAcks} duplicate ACK${m.dupAcks > 1 ? 's' : ''} with nothing retransmitted: segments are arriving out of order rather than being lost. Usually a path that splits across links (ECMP, a bonded pair).` };
  }
  if (m.handshakeRttMs != null && m.handshakeRttMs >= SLOW_HANDSHAKE_MS) {
    return { pattern: 'slow_path', explanation: `The handshake took ${m.handshakeRttMs} ms with no loss and no retransmissions. That is simply the round-trip time of this path — distance or a saturated link, not a fault to fix on the host.` };
  }
  if (m.mss != null && m.mss < STANDARD_MSS) {
    return { pattern: 'reduced_mss', explanation: `Clean exchange, but the largest segment agreed was ${m.mss} bytes rather than ${STANDARD_MSS}. Something in the path is shrinking it — a tunnel or a VPN. Worth knowing before a large response stalls for no visible reason.` };
  }
  const head = truncated ? 'As far as the capture goes (it hit its packet ceiling), nothing' : 'Nothing';
  return { pattern: 'clean', explanation: `${head} is wrong on the wire: no retransmissions, no duplicate ACKs, no resets, no zero windows${m.handshakeRttMs != null ? `, and a ${m.handshakeRttMs} ms handshake` : ''}. Whatever went wrong on this run did not go wrong in the network.` };
}

// The whole analysis for one capture. Returns the counts AND the verdict, both
// of which are stored — the counts so a later reader can disagree with the
// sentence, the sentence so nobody has to re-derive it from data that has aged.
function analyseCapture({ packets, truncated = false } = {}) {
  const m = measure(packets);
  const { pattern, explanation } = classify(m, { truncated });
  return {
    pattern,
    explanation,
    packet_count: m.packets,
    retransmits: m.retransmits,
    retransmit_pct: m.retransmitPct,
    dup_acks: m.dupAcks,
    resets: m.resets,
    zero_windows: m.zeroWindows,
    syn_unanswered: m.synUnanswered,
    handshake_rtt_ms: m.handshakeRttMs,
    mss: m.mss,
    bytes_out: m.bytesOut,
    bytes_in: m.bytesIn,
  };
}

module.exports = { analyseCapture, measure, classify, SLOW_HANDSHAKE_MS, STANDARD_MSS };
