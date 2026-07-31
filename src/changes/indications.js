'use strict';

// "What does this actually indicate?" — the metric → condition-family mapping the
// changes feed uses to say what an event MEANS, not just that it fired.
//
// A feed of "probe.latency on core-sw" twenty times over answers "what fired".
// It does not answer the question the technician actually has, which is "what is
// this telling me". That answer is one short sentence per condition family, and
// it belongs here: local, deterministic, no provider call, no ML.
//
// Deliberately regex-on-family rather than an exhaustive metric table. Metrics
// are minted by whatever the agent reports, so an unknown metric MUST degrade to
// "no interpretation offered" (family `null`) instead of a confident wrong one.
// The family split mirrors metricStep() in src/eventCases/guide.js so the feed
// and the troubleshooting guide speak one vocabulary — if you add a family here,
// add the matching guide step there.
//
// This module returns a family KEY, never a sentence. The wording lives in the
// dashboard's translation catalogues (`changes.indicates.<family>` in
// public/i18n.js, en + da), because the sentence is UI text and this is not the
// UI. The server stays free of presentation strings.

// Ordered: the first pattern that matches wins, so the more specific families
// (certificate, routing, flatline) are tested before the broad ones (latency).
const FAMILIES = [
  // A dead metric — the agent stopped reporting a value that used to move.
  ['flatline', /flatline|stall|no_data|nodata/],
  // TLS/certificate validity, not a performance signal at all.
  ['certificate', /\bcert/],
  // BGP/AS-path movement — the path to the target changed under us.
  ['routing', /aspath|as_path|bgp|route/],
  // The clock itself is wrong, which invalidates every other timestamp.
  ['clock', /clock|ntp|drift|skew/],
  // Reachability: packets are not arriving.
  ['loss', /loss|packet|reach|unreach|drop|timeout/],
  // Round-trip time / jitter.
  ['latency', /lat|jitter|rtt|delay|await/],
  // L1/L2 health on a port.
  ['interface', /iface|interface|if\.err|error|discard|crc|duplex|link|flap/],
  // Volume against capacity.
  ['saturation', /through|bandwidth|\bbw\b|util|saturat|volume|traffic|throughput/],
  // Host resources on the monitored device.
  ['resources', /cpu|mem|load|\bio\b|disk|swap|fd\b/],
  // A synthetic transaction / application check.
  ['transaction', /transact|app\.|http|query|login|synthetic/],
  // The device or service restarted.
  ['availability', /uptime|reboot|restart|down|offline|unavail/],
  // A named connection/session count.
  ['connections', /connection|session|socket|conntrack/],
];

// The condition family a metric belongs to, or null when nothing matches.
// Case-insensitive; a null/blank metric is `null`, never a guess.
function metricFamily(metric) {
  const m = String(metric == null ? '' : metric).toLowerCase();
  if (!m) return null;
  for (const [family, pattern] of FAMILIES) {
    if (pattern.test(m)) return family;
  }
  return null;
}

// The families this module can return — exported so the i18n parity test can
// assert every one of them has a `changes.indicates.<family>` string in BOTH
// catalogues. A family with no wording would render as a bare key on the page.
const FAMILY_KEYS = Object.freeze(FAMILIES.map(([family]) => family));

module.exports = { metricFamily, FAMILY_KEYS };
