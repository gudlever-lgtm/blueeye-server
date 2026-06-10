'use strict';

// Server-side mirror of the agent's installable diagnostic-tool allowlist. The
// AGENT enforces its own allowlist as the real security boundary (see
// blueeye-agent/src/toolInstaller.js); this copy lets the server reject an
// unknown tool early (400) and map a "<x> not installed" probe failure to the
// tool that would fix it (auto-install). Keep in lockstep with the agent.
const INSTALLABLE_TOOLS = Object.freeze(['traceroute', 'mtr', 'tcptraceroute']);

function isAllowedTool(tool) {
  return INSTALLABLE_TOOLS.includes(String(tool || '').trim().toLowerCase());
}

// Maps a probe execution failure to the tool that provides the missing binary,
// or null when it isn't a "tool is missing" failure we can auto-fix. Only fires
// on the explicit "<bin> not installed" reason the agent reports — never on
// ordinary reachability loss (which carries no such reason).
function toolForProbeFailure(type, reason) {
  const t = String(type || '').toLowerCase();
  const r = String(reason || '').toLowerCase();
  if (!/not installed/.test(r)) return null;
  if (t === 'traceroute') return 'traceroute';
  return null;
}

module.exports = { INSTALLABLE_TOOLS, isAllowedTool, toolForProbeFailure };
