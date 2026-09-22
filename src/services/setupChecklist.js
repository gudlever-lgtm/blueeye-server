'use strict';

// "Why is this screen empty?" — answered once, for the whole product.
//
// WHY THIS EXISTS. Every screen that needs a data path nobody switched on
// looked broken rather than unconfigured: Flows, the traffic map and the
// Topology diagram all wanted an agent whose traffic source is NetFlow or
// sFlow, the Device log wanted a receiver that is off by default, and the
// switch pages wanted an SNMP credential the polling agent is allowed to use.
// Each one got a better empty state in turn, which is a fix per screen for a
// question that is really one question: what is not set up yet?
//
// EVERY ROW IS COMPUTED, NEVER TICKED. There is no "mark as done" anywhere in
// here, because a checklist you tick yourself starts lying the moment somebody
// changes the configuration it describes — and the whole point is to be true
// on the day an operator opens an empty screen, not on the day somebody set it
// up. Each row is derived from what the database actually holds.
//
// `unknown` IS A REAL ANSWER. The server cannot see whether an agent's syslog
// receiver is listening: that is local config on the host. "No device events
// have arrived" is consistent with a receiver that is off AND with a quiet
// network, and reporting the first as fact would be a claim the data does not
// support. A row that cannot be determined says so and explains what to check.
//
// THE TEXT IS NOT HERE. This says WHAT is true and hands over the numbers; the
// dashboard says it in the reader's language (`setup.*` in public/i18n.js).
// The last time a service wrote the words, a Danish label ended up in an
// English dropdown and the language switch could not touch it.

const STATE = Object.freeze({
  OK: 'ok',
  PARTIAL: 'partial',
  TODO: 'todo',
  UNKNOWN: 'unknown',
});

// How long without a device event before we stop treating it as evidence the
// syslog/trap path works. A week: quieter than any real network goes, and long
// enough that a weekend does not turn a working install red.
const DEVICE_EVENT_WINDOW_DAYS = 7;

// The traffic sources that actually produce flow records. `proc` and `snmp`
// are per-interface counters — they carry no 5-tuple, so no amount of waiting
// turns them into flows.
const FLOW_SOURCES = Object.freeze(['netflow', 'sflow']);

const asArray = (v) => (Array.isArray(v) ? v : []);
const count = (rows, pred) => asArray(rows).reduce((n, r) => (pred(r) ? n + 1 : n), 0);

function sourceOf(agent) {
  const mc = agent && agent.monitor_config;
  return String((mc && mc.source) || 'proc');
}

// Builds the checklist from plain facts. Pure: no I/O, so the rules are
// testable without a database and the gather step below can be best-effort.
//
//   agents          agent rows
//   snmpDevices     snmp_devices rows (repository shape)
//   credentialed    how many enabled devices resolved a credential
//   deviceEvents    how many device events arrived inside the window
//   geoipRanges     how many IP ranges the GeoIP database holds
//   locations       location rows
function buildSetupChecklist(facts) {
  // Not a destructured parameter with a default: a default only fills in for
  // `undefined`. This runs on a screen whose whole job is to work on an
  // install where nothing is configured yet, and a null from a caller that
  // meant "I have nothing" must produce a checklist, not a stack trace.
  const f = facts && typeof facts === 'object' ? facts : {};
  const {
    agents = [], snmpDevices = [], credentialed = null,
    deviceEvents = null, geoipRanges = null, locations = [],
  } = f;
  const checks = [];
  const add = (key, state, detail, unlocks, fix) => checks.push({ key, state, detail, unlocks, fix });

  // ---- 1. agents ----------------------------------------------------------
  const agentRows = asArray(agents);
  const online = count(agentRows, (a) => a && a.status === 'online');
  add(
    'agents',
    agentRows.length === 0 ? STATE.TODO : (online === 0 ? STATE.PARTIAL : STATE.OK),
    { total: agentRows.length, online },
    ['fleet', 'probes', 'analysis'],
    'enrollment',
  );

  // ---- 2. a traffic source that carries flows -----------------------------
  // The single most common reason a screen is empty here, and the one nobody
  // guesses: an sFlow exporter running on the HOST does nothing until the
  // agent is told to collect it, so "we run sFlow" and "this agent reports
  // flows" are different statements.
  const flowAgents = count(agentRows, (a) => FLOW_SOURCES.includes(sourceOf(a)));
  add(
    'flowSource',
    agentRows.length === 0 ? STATE.TODO : (flowAgents === 0 ? STATE.TODO : STATE.OK),
    { flowAgents, total: agentRows.length, sources: FLOW_SOURCES.slice() },
    ['flows', 'topology', 'map'],
    'agents',
  );

  // ---- 3. switches to poll ------------------------------------------------
  const devices = asArray(snmpDevices).filter((d) => d && d.enabled !== false);
  add(
    'snmpDevices',
    devices.length === 0 ? STATE.TODO : STATE.OK,
    { enabled: devices.length, total: asArray(snmpDevices).length },
    ['snmpDevice', 'interfaces', 'topology'],
    'snmp',
  );

  // ---- 4. a credential each switch may actually use -----------------------
  // Counted rather than assumed: a community exists, a site has it, and the
  // polling agent is granted it are three separate conditions, and a device
  // that fails any of them is not polled at all.
  if (devices.length) {
    const withCred = Number.isInteger(credentialed) ? credentialed : null;
    add(
      'snmpCredentials',
      withCred === null ? STATE.UNKNOWN
        : (withCred === 0 ? STATE.TODO : (withCred < devices.length ? STATE.PARTIAL : STATE.OK)),
      { credentialed: withCred, devices: devices.length },
      ['snmpDevice', 'topology'],
      'snmpcommunities',
    );

    // ---- 5. the site that connects a switch to its site's communities -----
    const sited = count(devices, (d) => d && d.locationId != null);
    add(
      'snmpSites',
      sited === 0 ? STATE.TODO : (sited < devices.length ? STATE.PARTIAL : STATE.OK),
      { sited, devices: devices.length },
      ['snmpDevice'],
      'snmp',
    );
  }

  // ---- 6. the device log --------------------------------------------------
  // UNKNOWN when nothing has arrived, never TODO. Whether an agent's syslog
  // and trap receivers are listening is local config on that host and this
  // server cannot see it; "nothing arrived" is equally consistent with a
  // receiver that is off and a network that has been quiet.
  const events = Number.isInteger(deviceEvents) ? deviceEvents : null;
  add(
    'deviceLog',
    events === null ? STATE.UNKNOWN : (events > 0 ? STATE.OK : STATE.UNKNOWN),
    { events, windowDays: DEVICE_EVENT_WINDOW_DAYS },
    ['deviceLog'],
    null,
  );

  // ---- 7. GeoIP -----------------------------------------------------------
  const ranges = Number.isInteger(geoipRanges) ? geoipRanges : null;
  add(
    'geoip',
    ranges === null ? STATE.UNKNOWN : (ranges > 0 ? STATE.OK : STATE.TODO),
    { ranges },
    ['destinations', 'map'],
    'map',
  );

  // ---- 8. sites with coordinates -----------------------------------------
  // A site with no coordinates cannot be drawn, so the maps show a fleet that
  // is apparently nowhere.
  const sites = asArray(locations);
  const located = count(sites, (l) => l && l.latitude != null && l.longitude != null);
  add(
    'siteCoordinates',
    sites.length === 0 ? STATE.TODO : (located === 0 ? STATE.TODO : (located < sites.length ? STATE.PARTIAL : STATE.OK)),
    { located, total: sites.length },
    ['sites', 'map'],
    'locations',
  );

  // "Complete" counts only what an admin can act on. An UNKNOWN row is not a
  // failure and must not hold the banner open forever: the Device log can
  // never be proven set up from here, and a checklist that can never finish is
  // one people learn to ignore.
  const outstanding = checks.filter((c) => c.state === STATE.TODO || c.state === STATE.PARTIAL);

  return {
    checks,
    outstanding: outstanding.length,
    complete: outstanding.length === 0,
  };
}

module.exports = {
  buildSetupChecklist,
  STATE,
  FLOW_SOURCES,
  DEVICE_EVENT_WINDOW_DAYS,
};
