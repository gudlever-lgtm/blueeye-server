'use strict';

// A small, deterministic fixture of probe results that, fed through the incident
// derivation service with the seeded global thresholds (latency warn 150 /
// crit 300; packet_loss warn 2 / crit 5; reachability critical on failure;
// debounce 3), yields exactly ONE warning incident and ONE critical incident.
//
//   - target "edge-gw"  : three consecutive latency samples at ~200 ms
//                         (>= warn 150, < crit 300)  => latency WARNING
//   - target "8.8.8.8"  : three consecutive failed probes
//                         (ok = false)               => reachability CRITICAL
//
// Rows are oldest-first (the order probeResultsRepo.findByAgent returns).

const BASE = Date.parse('2026-06-01T00:00:00Z');
const at = (minutes) => new Date(BASE + minutes * 60000);

const incidentProbeFixture = [
  { ts: at(0), type: 'http', target: 'edge-gw', ok: true, rttMs: 200, lossPct: 0 },
  { ts: at(1), type: 'http', target: 'edge-gw', ok: true, rttMs: 205, lossPct: 0 },
  { ts: at(2), type: 'http', target: 'edge-gw', ok: true, rttMs: 198, lossPct: 0 },

  { ts: at(0), type: 'ping', target: '8.8.8.8', ok: false },
  { ts: at(1), type: 'ping', target: '8.8.8.8', ok: false },
  { ts: at(2), type: 'ping', target: '8.8.8.8', ok: false },
];

module.exports = { incidentProbeFixture, FIXTURE_BASE: BASE, fixtureAt: at };
