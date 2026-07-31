'use strict';

// "Where did this happen?" — the one place that turns an event's device
// identity into text a human can act on. Pure, no I/O.
//
// An event's `host_id` is the agent id, which on its own ("on 1") tells an
// operator nothing about which machine or which site to walk to. Everywhere an
// event is named — the auto-generated title, the explanation's `where`, the
// AI context — it should read "on core-sw (Copenhagen HQ)" instead.
//
// Both parts are optional by design: the agent may have been deleted (no name)
// and a site is never mandatory (no location), so the label degrades in this
// order: "name (site)" → "name" → "device <id> (site)" → "device <id>".

// Fallback used when the agent behind an event can no longer be named.
function deviceFallback(hostId) {
  return hostId == null || hostId === '' ? 'unknown device' : `device ${hostId}`;
}

// { hostId, agentName, locationName } -> "core-sw (Copenhagen HQ)".
function formatDeviceLabel({ hostId = null, agentName = null, locationName = null } = {}) {
  const who = agentName || deviceFallback(hostId);
  return locationName ? `${who} (${locationName})` : who;
}

module.exports = { formatDeviceLabel, deviceFallback };
