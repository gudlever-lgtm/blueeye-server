'use strict';

// How an agent's capabilities report is split between agents.capabilities (a
// small JSON blob of what the agent can do) and the per-report ingest tables
// it also carries, which have their own tables and must not bloat the blob.
// Kept out of src/validation/: these are not validators, and the validation
// gate sweeps every function exported there.

// The per-report ingest tables and their bounds. The agent caps ARP at 2000
// entries, connections at 500 and LLDP at 64; the bounds leave headroom for
// older or differently configured agents without letting one report grow
// without limit (the JSON body limit still applies on top).
const BULK_CAPABILITY_LIMITS = { arp: 5000, connections: 2000, lldp: 512 };

// What is persisted in agents.capabilities: everything except the ingest
// tables, which live in arp_entries / host_connections / lldp_neighbors.
function capabilitiesForStorage(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return capabilities;
  const out = { ...capabilities };
  for (const key of Object.keys(BULK_CAPABILITY_LIMITS)) delete out[key];
  return out;
}

module.exports = { BULK_CAPABILITY_LIMITS, capabilitiesForStorage };
