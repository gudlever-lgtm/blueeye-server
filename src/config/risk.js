'use strict';

// Rule-based (NOT AI) risk classification of a config diff — v1. Classifies each
// changed line into a category, then reports the highest risk seen plus the
// reasons. Deliberately simple + explainable, matching the house style (local,
// explainable, no ML).
//
//   high   — security / reachability-affecting: ACLs, routing, interfaces, NAT,
//            crypto/VPN, AAA. A change here can take a service down.
//   low    — cosmetic / descriptive: comments, descriptions, banners, SNMP
//            location/contact, logging text.
//   medium — anything else that changed.
//   none   — nothing changed.

const RISK_ORDER = { none: 0, low: 1, medium: 2, high: 3 };

// Ordered high-risk matchers (first match wins for the reason label).
const HIGH_PATTERNS = [
  { label: 'acl', re: /\b(access-list|access-group|ip access|acl|permit|deny)\b/i },
  { label: 'routing', re: /\b(ip route|router\s+(bgp|ospf|eigrp|rip|isis)|neighbor|network\s+\d|redistribute|route-map|prefix-list)\b/i },
  { label: 'interface', re: /\b(interface|shutdown|no shutdown|ip address|switchport|channel-group)\b/i },
  { label: 'vlan', re: /\b(vlan|trunk|spanning-tree)\b/i },
  { label: 'nat', re: /\b(ip nat|nat pool)\b/i },
  { label: 'crypto', re: /\b(crypto|ipsec|isakmp|tunnel|vpn)\b/i },
  { label: 'aaa', re: /\b(aaa|tacacs|radius|authentication|authorization)\b/i },
];

// Low-risk (cosmetic) matchers. A leading "!" is a config comment.
const LOW_PATTERNS = [
  { label: 'comment', re: /^\s*!/ },
  { label: 'description', re: /^\s*description\b/i },
  { label: 'banner', re: /\bbanner\b/i },
  { label: 'snmp-info', re: /\bsnmp-server\s+(location|contact)\b/i },
  { label: 'logging-text', re: /^\s*(remark|comment)\b/i },
];

// Classifies one changed line → { risk, reason }.
function classifyLine(text) {
  const s = typeof text === 'string' ? text : '';
  for (const p of HIGH_PATTERNS) if (p.re.test(s)) return { risk: 'high', reason: p.label };
  for (const p of LOW_PATTERNS) if (p.re.test(s)) return { risk: 'low', reason: p.label };
  return { risk: 'medium', reason: 'other' };
}

// Classifies a diff (the object from computeConfigDiff) → { risk, reasons } where
// `reasons` is the distinct set of matched category labels that drove the score,
// most-severe first.
function classifyConfigDiff(diff) {
  const changed = diff && Array.isArray(diff.changedLines) ? diff.changedLines : [];
  if (!diff || diff.changed === false || changed.length === 0) {
    return { risk: 'none', reasons: [] };
  }

  let top = 'low';
  const reasonsByRisk = { high: new Set(), medium: new Set(), low: new Set() };
  for (const line of changed) {
    const { risk, reason } = classifyLine(line.text);
    reasonsByRisk[risk].add(reason);
    if (RISK_ORDER[risk] > RISK_ORDER[top]) top = risk;
  }

  // Report the reasons that actually reached the top risk level.
  const reasons = [...reasonsByRisk[top]];
  return { risk: top, reasons };
}

module.exports = { classifyConfigDiff, classifyLine, RISK_ORDER };
