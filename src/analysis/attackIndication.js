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

module.exports = {
  ATTACK_METRICS,
  ATTACK_METRIC_PREFIXES,
  BANNER_SEVERITIES,
  BANNER_WINDOW_HOURS,
  isAttackMetric,
};
