'use strict';

// Where an agent is, for the map: its own position when one is set (migration
// 136, PUT /agents/:id/position), else its site's. The traceroute map measures
// every hop from this point, so the agent's own position wins — it exists for
// exactly the agents whose site does not describe where they run (a cloud data
// centre, a VPN exit).
//
//   agentPosition(agent) -> { lat, lng, source: 'agent' | 'site' } | null
function agentPosition(agent) {
  if (!agent) return null;
  const ok = (a, b) => Number.isFinite(a) && Number.isFinite(b);
  if (ok(agent.latitude, agent.longitude)) return { lat: agent.latitude, lng: agent.longitude, source: 'agent' };
  if (ok(agent.location_lat, agent.location_lng)) return { lat: agent.location_lat, lng: agent.location_lng, source: 'site' };
  return null;
}

module.exports = { agentPosition };
