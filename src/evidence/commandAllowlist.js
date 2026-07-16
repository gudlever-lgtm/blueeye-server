'use strict';

// Server-side READ-ONLY evidence command allowlist (Fase 6). This is the single
// source of truth for WHAT an evidence snapshot may ask an agent to collect. Every
// item is a read-only diagnostic; there is no write/mutate item, and the agent
// enforces its OWN copy of this list (defense in depth — see blueeye-agent
// src/evidenceAllowlist.js). Bump COMMAND_SET_VERSION on any change so a stored
// snapshot records which contract produced it.
//
// The candidate set (per the Fase-6 brief), all reusing collectors the agent
// already has — no new SNMP OID scope:
//   iface.counters  — interface error/discard/utilisation counters (nicInfo)
//   arp.table       — ARP/neighbour (MAC) table extract for the segment (system)
//   snmp.reads      — the SNMP reads the collector already supports (snmpMonitor)
//   agent.state     — agent-local state: connection status, last collection times

const COMMAND_SET_VERSION = 'evidence-v1';

// name -> { readOnly: true, description }. `readOnly:true` is asserted on every
// entry; a would-be write item simply is not here (and the agent refuses it).
const ALLOWLIST = Object.freeze({
  'iface.counters': { readOnly: true, description: 'Interface error/discard/utilisation counters' },
  'arp.table': { readOnly: true, description: 'ARP/MAC table extract for the affected segment' },
  'snmp.reads': { readOnly: true, description: 'Allowlisted SNMP reads already supported by the collector' },
  'agent.state': { readOnly: true, description: 'Agent connection status + last collection timestamps' },
});

const DEFAULT_ITEMS = Object.freeze(Object.keys(ALLOWLIST));

function isAllowed(name) {
  return Object.prototype.hasOwnProperty.call(ALLOWLIST, name) && ALLOWLIST[name].readOnly === true;
}

// Splits a requested item list into { allowed, refused } — refused are anything
// not on the read-only allowlist. Empty/omitted input → the full default set.
function partition(items) {
  const list = Array.isArray(items) && items.length ? items : DEFAULT_ITEMS;
  const allowed = [];
  const refused = [];
  for (const name of list) {
    if (isAllowed(name)) allowed.push(name); else refused.push(name);
  }
  return { allowed: [...new Set(allowed)], refused: [...new Set(refused)] };
}

module.exports = { COMMAND_SET_VERSION, ALLOWLIST, DEFAULT_ITEMS, isAllowed, partition };
