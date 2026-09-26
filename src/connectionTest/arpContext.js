'use strict';

// What the server already knows about the destination's ARP, and — the part
// that decides whether the answer means anything — whether ARP is on the path
// to it at all.
//
// ARP only resolves addresses on the sender's own segment. For anything routed,
// the packet goes to the default gateway and the destination's MAC is never
// asked for, so "no ARP entry for the destination" is not a finding: it is the
// correct state of a working network. A ladder rung that reported it as a
// failure would mark every internet destination broken at layer 2.
//
// So the question is asked in two halves:
//
//   1. Is this address on a segment this agent is on? Answered from the agent's
//      OWN neighbour table: an address it has ARPed is by definition on one of
//      its segments, so the /24 (or /64) of every entry it reported is a
//      segment it sits on. Evidence the server already has, from agents that
//      already report it — no new agent code, and nothing inferred from a
//      configuration file that may not match the wire.
//
//   2. If so, has anything ever answered for it? `arp_entries` again, this time
//      by address.
//
// When the agent has never reported a neighbour table, both halves are
// unanswerable and the rung says so. "We do not know" is a sentence; a green
// tick would not be.

const { subnetKey } = require('../diagnose/addr');

// How much of a neighbour table to read. A segment shows up in the first
// handful of entries; this is a ceiling on one screen's worth of work, not a
// sample of the network.
const SEGMENT_SCAN_LIMIT = 500;

// Look up the ARP context for one destination address.
//
//   arpRepo   arpEntriesRepository (or null — then nothing is known)
//   agentId   the agent the ladder is being walked from
//   ip        the destination, as an address (a name has no ARP answer)
//
// Returns { onLocalSegment, mac, source, lastSeen, interface } where
// onLocalSegment is true / false / null, and null means the question could not
// be asked rather than that the answer was no.
async function arpContext({ arpRepo, agentId, ip }) {
  if (!arpRepo || !ip) return null;
  const key = subnetKey(ip);
  if (!key) return null;

  const own = await arpRepo.listForAgent({ agentId, limit: SEGMENT_SCAN_LIMIT }).catch(() => []);
  // No neighbour table from this agent: it may well be on the segment and
  // simply never have reported. Unanswerable, and said as such.
  const segments = new Set((own || []).map((e) => subnetKey(e.ip)).filter(Boolean));
  const onLocalSegment = segments.size === 0 ? null : segments.has(key);
  if (onLocalSegment !== true) return { onLocalSegment, mac: null, source: null, lastSeen: null, interface: null };

  const hits = await arpRepo.findByIp({ ip, limit: 25 }).catch(() => []);
  // The same RFC1918 address legitimately exists at more than one site, so the
  // entry THIS agent reported is the only one that answers "what is at that
  // address, from here".
  const mine = (hits || []).find((e) => Number(e.agentId) === Number(agentId)) || null;
  if (!mine) return { onLocalSegment: true, mac: null, source: null, lastSeen: null, interface: null };
  return {
    onLocalSegment: true,
    mac: mine.mac,
    source: mine.source,
    lastSeen: mine.lastSeen,
    interface: mine.interface,
  };
}

module.exports = { arpContext, SEGMENT_SCAN_LIMIT };
