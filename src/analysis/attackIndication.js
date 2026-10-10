'use strict';

// WHICH FINDINGS MEAN "SOMETHING IS ATTACKING THIS NETWORK" — the one list, so
// four detectors, the changes feed, the event guide and the red bar at the top
// of the dashboard cannot disagree about it.
//
// It existed implicitly in three places before this: a regex in
// src/changes/indications.js, another in src/eventCases/guide.js, and the
// metric strings inside each detector. Three copies of a list is three answers
// to "is this an attack indication", and the one that matters — the bar that
// interrupts an operator's day — has to be the same answer as the sentence in
// the feed.
//
// MEMBERSHIP IS ABOUT THE QUESTION, NOT THE SEVERITY. A metric is here when the
// thing it measures is something an attacker does: enumerating the network,
// calling home on a schedule, guessing a password, answering DHCP when it
// should not, reaching a network this site has never reached. Whether any
// particular finding is worth interrupting somebody for is a SEVERITY question,
// decided per finding (and re-decidable through severity rules) — see
// BANNER_SEVERITIES below.
//
// `device.new` is deliberately NOT here. An unknown device appearing is
// inventory drift far more often than it is an intruder, it fires on every new
// laptop, and a red bar that is on every morning is a red bar nobody reads.

// Exact metric names.
const ATTACK_METRICS = Object.freeze([
  // A source sweeping ports or hosts (src/analysis/scanDetector.js).
  'net.scan',
  // Regular outbound contact on a machine's schedule (src/analysis/beaconDetector.js).
  'net.beacon',
  // One host reaching many internal peers on a file-share or remote-execution
  // port (src/analysis/scanDetector.js). The shape ransomware spreads in.
  'net.lateral',
  // A network this site has never reached (src/analysis/newPeerDetector.js).
  'peer.new_asn',
  'peer.new_country',
  // A second DHCP server answering (src/analysis/probeFindings.js). Older than
  // the rest and never framed this way; it is the same question.
  'probe.dhcp.rogue',
]);

// Prefixes, so a rule an operator adds for an event type this server's
// catalogue has not heard of (SECURITY_EVENT_RULES accepts one — the agent's
// classifier ships ahead of the server's table) is covered the day it fires,
// without a code change here.
const ATTACK_METRIC_PREFIXES = Object.freeze(['security.']);

const EXACT = new Set(ATTACK_METRICS);

function isAttackMetric(metric) {
  const m = String(metric == null ? '' : metric).trim().toLowerCase();
  if (!m) return false;
  if (EXACT.has(m)) return true;
  return ATTACK_METRIC_PREFIXES.some((p) => m.startsWith(p));
}

// What the red bar reacts to. INFO is excluded on purpose: `peer.new_asn` is
// INFO by default precisely because a new content-delivery network is not an
// incident, and an operator who disagrees raises it — in Settings, or with a
// severity rule — at which point the bar starts reacting to it. The bar
// follows the STORED severity, which is the one severity rules produced, so
// "downgrade this to INFO" is also how you take something off the bar.
const BANNER_SEVERITIES = Object.freeze(['WARN', 'CRIT']);

// How far back the bar looks. A day: long enough that a scan at 03:00 is still
// on screen when somebody arrives, short enough that last week's acknowledged
// noise is not.
const BANNER_WINDOW_HOURS = 24;

// RED MEANS "WE ARE REASONABLY SURE", AND ONE WARN IS NOT SURE.
//
// A single net.scan says one source touched a lot of ports. The detector's own
// sentence then admits that a vulnerability scanner, an asset inventory or a
// backup agent walking the LAN looks exactly the same — and a red line that
// says "attack" over a sentence that says "this is probably your backup agent"
// teaches an operator to stop reading the line.
//
// So a WARN reaches the bar only when something ELSE on the attack list agrees
// about it: another attack-indication finding, raised by a DIFFERENT detector,
// open, inside the same window, in the same event case (the server's own
// correlation — src/eventCases/). A scan plus a first-ever ASN from the same
// host is a story; a scan on its own is a candidate, and candidates belong in
// the Changes feed and on Analysis, where they already are.
//
// A DIFFERENT metric, because two net.scan findings in one case is one detector
// saying the same thing twice, which is repetition, not corroboration.
//
// CRIT is exempt: the critical thresholds exist precisely to name the cases
// nobody needs a second opinion on, and waiting for corroboration there would
// hold the bar back on the one night it matters.
const CORROBORATION_EXEMPT_SEVERITIES = Object.freeze(['CRIT']);

// What the bar shows of a finding's explanation: whole sentences, never a
// sentence cut mid-word. The strip is two lines, the full text lives on the
// finding and on the event page the bar links to, and "…add it to" with the
// rest missing is worse than one complete sentence.
const BAR_SUMMARY_MAX = 240;

function summarize(text, max = BAR_SUMMARY_MAX) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length <= max) return s;
  // Whole sentences while they fit. A sentence ends at . ! or ? followed by a
  // space and a capital or a digit — "10.0.0.5" and "v1.2" do not end one.
  const sentences = s.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  let out = '';
  for (const part of sentences) {
    const next = out ? `${out} ${part}` : part;
    if (next.length > max) break;
    out = next;
  }
  if (out) return out;
  // The first sentence alone is longer than the cap: cut on a word boundary and
  // SAY that it was cut.
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

module.exports = {
  ATTACK_METRICS,
  ATTACK_METRIC_PREFIXES,
  BANNER_SEVERITIES,
  BANNER_WINDOW_HOURS,
  CORROBORATION_EXEMPT_SEVERITIES,
  BAR_SUMMARY_MAX,
  isAttackMetric,
  summarize,
};
