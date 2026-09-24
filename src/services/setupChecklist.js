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
// A SOURCE THAT COULD NOT BE READ IS UNKNOWN TOO, NEVER ZERO. The gather step
// (src/routes/setup.js) hands over `null` for a repository that threw — not
// `[]` — and every row built on it is UNKNOWN with `detail.reason =
// 'unreadable'`. Reading a failed agents query as "no agents" put "enrol an
// agent" on the list of an install with forty of them.
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

// Why a row is UNKNOWN, when the reason is not the row's own nature (the
// device log is unknown by design; see below).
const REASON = Object.freeze({
  UNREADABLE: 'unreadable',
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
//   agents          agent rows (null: could not be read)
//   snmpDevices     snmp_devices rows (repository shape; null: could not be read)
//   credentialed    how many enabled devices resolved a credential
//   deviceEvents    how many device events arrived inside the window
//   geoipRanges     how many IP ranges the GeoIP database holds
//   locations       location rows (null: could not be read)
//   failed          names of the scalar facts above (credentialed,
//                   deviceEvents, geoipRanges) whose source THREW, as opposed
//                   to being absent — both arrive as null, only one is a failure
//
// `null` for a list means the source could not be READ; a missing key (or
// undefined) still means "nothing there", which is what a fresh install is.
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
  const failed = new Set(asArray(f.failed));
  // Tags a row's detail when the fact behind it could not be read.
  const why = (fact, detail) => (failed.has(fact) ? { ...detail, reason: REASON.UNREADABLE } : detail);
  const checks = [];
  const add = (key, state, detail, unlocks, fix) => checks.push({ key, state, detail, unlocks, fix });
  // A row whose source could not be read: UNKNOWN, says why, and carries no
  // numbers — any count here would be an invented zero.
  const unreadable = (key, unlocks, fix) => add(key, STATE.UNKNOWN, { reason: REASON.UNREADABLE }, unlocks, fix);

  // ---- 1. agents ----------------------------------------------------------
  const agentRows = asArray(agents);
  const online = count(agentRows, (a) => a && a.status === 'online');
  if (agents === null) {
    unreadable('agents', ['fleet', 'probes', 'analysis'], 'enrollment');
  } else {
    add(
      'agents',
      agentRows.length === 0 ? STATE.TODO : (online === 0 ? STATE.PARTIAL : STATE.OK),
      { total: agentRows.length, online },
      ['fleet', 'probes', 'analysis'],
      'enrollment',
    );
  }

  // ---- 2. a traffic source that carries flows -----------------------------
  // The single most common reason a screen is empty here, and the one nobody
  // guesses: an sFlow exporter running on the HOST does nothing until the
  // agent is told to collect it, so "we run sFlow" and "this agent reports
  // flows" are different statements.
  const flowAgents = count(agentRows, (a) => FLOW_SOURCES.includes(sourceOf(a)));
  if (agents === null) {
    unreadable('flowSource', ['flows', 'topology', 'map'], 'agents');
  } else {
    add(
      'flowSource',
      agentRows.length === 0 ? STATE.TODO : (flowAgents === 0 ? STATE.TODO : STATE.OK),
      { flowAgents, total: agentRows.length, sources: FLOW_SOURCES.slice() },
      ['flows', 'topology', 'map'],
      'agents',
    );
  }

  // ---- 3. switches to poll ------------------------------------------------
  // Unreadable: this row is UNKNOWN, and the two per-device rows below are
  // left out — the same as for an install with no switches, because there is
  // no device list to count credentials or sites against.
  const devices = asArray(snmpDevices).filter((d) => d && d.enabled !== false);
  if (snmpDevices === null) {
    unreadable('snmpDevices', ['snmpDevice', 'interfaces', 'topology'], 'snmp');
  } else {
    add(
      'snmpDevices',
      devices.length === 0 ? STATE.TODO : STATE.OK,
      { enabled: devices.length, total: asArray(snmpDevices).length },
      ['snmpDevice', 'interfaces', 'topology'],
      'snmp',
    );
  }

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
      why('credentialed', { credentialed: withCred, devices: devices.length }),
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
    why('deviceEvents', { events, windowDays: DEVICE_EVENT_WINDOW_DAYS }),
    ['deviceLog'],
    null,
  );

  // ---- 7. GeoIP -----------------------------------------------------------
  const ranges = Number.isInteger(geoipRanges) ? geoipRanges : null;
  add(
    'geoip',
    ranges === null ? STATE.UNKNOWN : (ranges > 0 ? STATE.OK : STATE.TODO),
    why('geoipRanges', { ranges }),
    ['destinations', 'map'],
    'map',
  );

  // ---- 8. sites with coordinates -----------------------------------------
  // A site with no coordinates cannot be drawn, so the maps show a fleet that
  // is apparently nowhere.
  const sites = asArray(locations);
  const located = count(sites, (l) => l && l.latitude != null && l.longitude != null);
  if (locations === null) {
    unreadable('siteCoordinates', ['sites', 'map'], 'locations');
  } else {
    add(
      'siteCoordinates',
      sites.length === 0 ? STATE.TODO : (located === 0 ? STATE.TODO : (located < sites.length ? STATE.PARTIAL : STATE.OK)),
      { located, total: sites.length },
      ['sites', 'map'],
      'locations',
    );
  }

  // "Outstanding" counts only what an admin can act on. An UNKNOWN row is not
  // work: the Device log can never be proven set up from here, and a checklist
  // that can never finish is one people learn to ignore.
  //
  // But "complete" is a claim, and it needs every row to have been LOOKED AT.
  // A row whose source could not be read may be hiding exactly the work the
  // banner would be saying is done, so `complete` is false while any source is
  // unreadable, and `status` tells the banner which of three things to say:
  //
  //   outstanding  there is work on the list
  //   unknown      no work that can be seen, but some rows could not be
  //                determined — the banner says so instead of "complete"
  //   complete     every row determined, nothing outstanding
  const outstanding = checks.filter((c) => c.state === STATE.TODO || c.state === STATE.PARTIAL);
  const unknown = checks.filter((c) => c.state === STATE.UNKNOWN);
  const unreadableRows = unknown.filter((c) => c.detail && c.detail.reason === REASON.UNREADABLE);
  let status = 'complete';
  if (outstanding.length) status = 'outstanding';
  else if (unknown.length) status = 'unknown';

  return {
    checks,
    outstanding: outstanding.length,
    unknown: unknown.length,
    unreadable: unreadableRows.length,
    complete: outstanding.length === 0 && unreadableRows.length === 0,
    status,
  };
}

module.exports = {
  buildSetupChecklist,
  STATE,
  REASON,
  FLOW_SOURCES,
  DEVICE_EVENT_WINDOW_DAYS,
};
