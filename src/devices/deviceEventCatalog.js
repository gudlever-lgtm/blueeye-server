'use strict';

// The vocabulary of device events: what the severities are called, and what
// each event_type means, grouped the way a technician narrows a search.
//
// ONE DEFINITION, SERVED TO THE UI. The dashboard reads this through
// GET /api/device-events/catalog rather than carrying its own copy, so the
// filter list and the stored data can never drift apart.
//
// ONE VOCABULARY FOR SYSLOG AND TRAPS. The types below are produced by two
// different agent modules — src/syslog/classify.js reads a log line,
// src/traps/translate.js reads a trap OID — and they deliberately produce the
// SAME strings. A link that went down is `link.down` whichever socket said so,
// which is what lets the device log, the timeline and the changes feed treat
// both without knowing the difference.
//
// THE LABELS HERE ARE A FALLBACK, NOT THE UI'S TEXT. The dashboard translates
// each type through `devevt.type.<type>` in public/i18n.js and only falls back
// to the label below when it has no key for that type — which is the case the
// paragraph after this one is about. They are English for the same reason every
// other default in this repo is: it is the language the code is written in, and
// a Danish string served to an English dashboard is a bug the language switch
// cannot fix.
//
// THE SERVER'S TABLE IS ALLOWED TO BE BEHIND THE AGENT'S. The agent ships the
// classifier (blueeye-agent src/syslog/classify.js) and a newer agent will send
// types this catalogue has not heard of. That is not an error: describeEventType
// returns null, the row stores and displays its raw type, and the filter still
// works because filtering is by string. The alternative — refusing an unknown
// type — would mean an agent upgrade silently dropping the events it got better
// at recognising.

// Syslog severity 0-7, index = numeric value. LOWER IS WORSE, which is the
// single most confusing thing about syslog and the reason every filter in this
// feature is named `maxSeverity`.
const SEVERITY_NAMES = Object.freeze([
  'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug',
]);

// Groups exist to make the filter usable, not to classify further. A technician
// with a fault in mind thinks "this is a layer 2 problem" long before they think
// "this is a stp.topology_change".
const EVENT_TYPE_GROUPS = Object.freeze([
  {
    key: 'link',
    types: [
      { type: 'link.down', label: 'Link down' },
      { type: 'link.up', label: 'Link up' },
      { type: 'duplex.mismatch', label: 'Duplex mismatch' },
      { type: 'port.err_disabled', label: 'Port err-disabled' },
      { type: 'port.security_violation', label: 'Port security triggered' },
      { type: 'link.admin_down', label: 'Port shut down administratively' },
      { type: 'poe.port_changed', label: 'PoE port changed state' },
      { type: 'poe.budget_exceeded', label: 'PoE budget exceeded' },
    ],
  },
  {
    key: 'l2',
    types: [
      { type: 'stp.topology_change', label: 'Spanning-tree topology change' },
      { type: 'stp.root_changed', label: 'Spanning-tree root changed' },
      { type: 'stp.loop_detected', label: 'Spanning-tree loop detected' },
      { type: 'mac.flapping', label: 'MAC flapping between ports' },
      { type: 'vlan.trunk_changed', label: 'VLAN trunk changed' },
    ],
  },
  {
    key: 'routing',
    types: [
      { type: 'ospf.adjacency_lost', label: 'OSPF adjacency lost' },
      { type: 'ospf.adjacency_up', label: 'OSPF adjacency established' },
      { type: 'bgp.session_down', label: 'BGP session down' },
      { type: 'bgp.session_up', label: 'BGP session up' },
      { type: 'hsrp.state_changed', label: 'HSRP/VRRP state changed' },
      { type: 'routing.neighbor_lost', label: 'Routing neighbour lost' },
      { type: 'ospf.config_error', label: 'OSPF configuration error' },
    ],
  },
  {
    key: 'addressing',
    types: [
      { type: 'dhcp.pool_exhausted', label: 'DHCP pool exhausted' },
      { type: 'dhcp.conflict', label: 'Address conflict' },
    ],
  },
  {
    key: 'security',
    types: [
      { type: 'auth.failure', label: 'Login failure' },
      { type: 'acl.denied', label: 'ACL denied traffic' },
      { type: 'vpn.negotiation_failed', label: 'VPN negotiation failed' },
    ],
  },
  {
    key: 'health',
    types: [
      { type: 'device.rebooted', label: 'Device rebooted' },
      { type: 'config.changed', label: 'Configuration changed' },
      { type: 'power.supply_failed', label: 'Power supply failed' },
      { type: 'fan.failed', label: 'Fan failed' },
      { type: 'temperature.alarm', label: 'Temperature alarm' },
      { type: 'ups.on_battery', label: 'UPS on battery' },
      { type: 'resource.exhausted', label: 'Resources exhausted' },
      { type: 'ups.alarm', label: 'UPS alarm' },
      { type: 'sensor.threshold', label: 'Sensor threshold exceeded' },
      { type: 'resource.threshold', label: 'Resource threshold exceeded' },
      { type: 'device.hardware_changed', label: 'Hardware changed' },
    ],
  },
  {
    key: 'other',
    types: [
      { type: 'syslog.raw', label: 'Not classified' },
    ],
  },
]);

// Flat lookup, built once.
const LABELS = new Map();
for (const group of EVENT_TYPE_GROUPS) {
  for (const t of group.types) LABELS.set(t.type, t.label);
}

// The human label for an event_type, or null when this server does not know it.
// Null is a real answer, not a failure — see the note at the top.
function describeEventType(type) {
  return LABELS.get(type) || null;
}

// Every type this catalogue knows. Exported so a test can assert the server's
// vocabulary is a SUPERSET of nothing in particular but stays internally
// consistent — and so the changes feed can map a type to a severity band.
const KNOWN_EVENT_TYPES = Object.freeze([...LABELS.keys()].sort());

// Maps a syslog severity onto the WARN/CRIT/INFO band the rest of the server
// already speaks (findings, event cases, the timeline). Syslog has eight levels
// and BlueEyes has three, so this is a narrowing and it is done in exactly one
// place. err(3) and worse is CRIT; warning(4) is WARN; the rest is INFO.
function severityBand(severity) {
  if (!Number.isInteger(severity)) return 'INFO';
  if (severity <= 3) return 'CRIT';
  if (severity === 4) return 'WARN';
  return 'INFO';
}

module.exports = {
  SEVERITY_NAMES,
  EVENT_TYPE_GROUPS,
  KNOWN_EVENT_TYPES,
  describeEventType,
  severityBand,
};
