'use strict';

// WHAT CAN THIS AGENT ACTUALLY RUN?
//
// The dashboard used to answer that by offering every probe type on every agent
// and letting the run fail — "traceroute: command not found" arrives a few
// seconds later, on a host with no shell to go and look at. The catalogue
// answers it BEFORE the run, from what the agent itself reported on its last
// capabilities cycle (src/capabilities.js in blueeye-agent): its `sources`, and
// the `unavailable` map that says WHY an optional one is missing.
//
// Two rules the list obeys:
//   * a test is `available: false` only when the agent SAID so. An unknown
//     capability is not a no — an older agent in the field reports fewer
//     fields, and greying its tests out would be a regression dressed as a
//     feature;
//   * `reason` is the agent's own words where it has them. "net-snmp is missing
//     — reinstall the agent, or run npm install in its directory" is a sentence
//     an operator can act on; "unavailable" is not.
//
// Pure module: no repositories, no I/O. The route hands it an agent row.

// `kind` is the vocabulary a package item already uses (see
// testPackageRunner.itemToCommand) — probe / throughput / speedtest — so the
// Tests tab and a saved package name the same things the same way.
const TEST_CATALOGUE = [
  { type: 'ping', kind: 'probe', needsTarget: true },
  { type: 'tcp', kind: 'probe', needsTarget: true, needsPort: true },
  { type: 'dns', kind: 'probe', needsTarget: true },
  { type: 'traceroute', kind: 'probe', needsTarget: true },
  { type: 'tcptraceroute', kind: 'probe', needsTarget: true, needsPort: true },
  { type: 'curl', kind: 'probe', needsTarget: true },
  { type: 'pageload', kind: 'probe', needsTarget: true },
  { type: 'run-test', kind: 'throughput', requiresSource: true },
  { type: 'speedtest', kind: 'speedtest' },
  { type: 'burst', kind: 'burst', needsTarget: true },
  { type: 'poll-snmp', kind: 'snmp', requiresSnmp: true },
];

function capsOf(agent) {
  const c = agent && agent.capabilities;
  return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
}

// The tests this agent can run, each with a verdict and — when the answer is
// no — the agent's own explanation.
function runnableTests(agent) {
  const caps = capsOf(agent);
  const sources = Array.isArray(caps.sources) ? caps.sources : null;
  const unavailable = (caps.unavailable && typeof caps.unavailable === 'object' && !Array.isArray(caps.unavailable))
    ? caps.unavailable
    : {};

  return TEST_CATALOGUE.map((entry) => {
    const out = {
      type: entry.type,
      kind: entry.kind,
      needsTarget: !!entry.needsTarget,
      needsPort: !!entry.needsPort,
      available: true,
      reason: null,
    };
    // An agent that has never reported its sources gets the benefit of the
    // doubt — see the second rule at the top of this file.
    if (sources === null) return out;
    if (entry.requiresSnmp && !sources.includes('snmp')) {
      out.available = false;
      out.reason = unavailable.snmp || 'This agent reports no SNMP source.';
    } else if (entry.requiresSource && sources.length === 0) {
      out.available = false;
      out.reason = 'This agent reports no traffic source.';
    }
    return out;
  });
}

module.exports = { TEST_CATALOGUE, runnableTests };
