'use strict';

// Maintenance windows / alert silencing. During a planned-work window, findings
// are still detected and recorded (and visible in the dashboard) — only the
// outbound *notifications* (email/webhook/syslog) are suppressed, so a planned
// change doesn't page anyone. Windows can be global, per-location or per-agent.

function isWindowActive(w, nowMs) {
  const from = w && w.from ? Date.parse(w.from) : NaN;
  const to = w && w.to ? Date.parse(w.to) : NaN;
  return Number.isFinite(from) && Number.isFinite(to) && nowMs >= from && nowMs <= to;
}

// Does this window cover a finding from (agentId, locationId)? Global covers
// everything; agent/location match their target id.
function windowMatches(w, { agentId, locationId }) {
  if (!w || !w.scope || w.scope === 'global') return true;
  if (w.scope === 'agent') return String(w.targetId) === String(agentId);
  if (w.scope === 'location') return locationId != null && String(w.targetId) === String(locationId);
  return false;
}

// Builds an async (finding) => matching active window | null, for the dispatcher
// to consult before sending. Windows are cached briefly so a burst of findings
// doesn't hammer the settings store; the agent's location is resolved lazily and
// only when a location-scoped window is actually active (avoids a DB hit per
// finding in the common case).
function createSilencer({ getWindows, getAgentLocationId, now = () => Date.now(), cacheMs = 10000 }) {
  let cache = null;
  let cacheAt = 0;
  async function windows() {
    const t = now();
    if (cache && t - cacheAt < cacheMs) return cache;
    let w = [];
    try { w = (await getWindows()) || []; } catch { w = []; }
    cache = w;
    cacheAt = t;
    return w;
  }
  return async function silencedBy(finding) {
    if (!finding) return null;
    const active = (await windows()).filter((w) => isWindowActive(w, now()));
    if (!active.length) return null;
    const agentId = finding.hostId;
    // Global + per-agent need no DB lookup.
    for (const w of active) {
      if (w.scope === 'global' || (w.scope === 'agent' && String(w.targetId) === String(agentId))) return w;
    }
    // Per-location: resolve the agent's location once, only if needed.
    const locWindows = active.filter((w) => w.scope === 'location');
    if (locWindows.length && typeof getAgentLocationId === 'function') {
      let locationId = null;
      try { locationId = await getAgentLocationId(agentId); } catch { locationId = null; }
      for (const w of locWindows) {
        if (locationId != null && String(w.targetId) === String(locationId)) return w;
      }
    }
    return null;
  };
}

module.exports = { isWindowActive, windowMatches, createSilencer };
