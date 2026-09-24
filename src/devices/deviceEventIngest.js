'use strict';

const crypto = require('crypto');
const net = require('net');
const { buildHostResolver } = require('../topology/hostResolver');
const { LINK_EVENTS, statusFromEvent } = require('./switchPortStateService');
const { canonicalIp } = require('./sflowCounterIngest');

// Turns a batch of raw device events, as received by one agent, into stored
// rows: resolve who sent each one, decide how it folds, hand it to the
// repository.
//
// TWO JOBS, AND THEY ARE SEPARATE ON PURPOSE.
//
// 1. WHO SENT IT. The agent knows only the source IP. A row is far more useful
//    against a device the inventory already knows — it joins the timeline, the
//    correlator and search — so the IP is resolved against what the server
//    already has. TWO ID SPACES, two columns (migration 133):
//      a) a polled SWITCH first — the sender address against snmp_devices.host
//         (IP literals, canonical form), stored as `snmp_device_id`. A switch's
//         own syslog and traps are what this whole feature is for, and they
//         belong to the switch, not to whichever agent received them.
//      b) an AGENT host — the agents' own reported IPs and legacy SNMP monitor
//         targets, via the SAME buildHostResolver the topology graph uses, as
//         `device_id` (which is, and always was, an agent id).
//      c) failing both, arp_entries — but ONLY as a bridge to (b): the MAC
//         behind the sender address, and whether that MAC is also behind an
//         address an agent reports as its OWN (a multi-homed host sending from
//         an address it did not list). The agent that merely SAW the address
//         in its neighbour table is the observer, never the owner — crediting
//         it put a whole switch's log on the collector host's timeline.
//    Failing all three, the row is stored with both ids NULL and the source IP
//    intact. Discarding it would throw away the one message that explains an
//    outage because the inventory was incomplete, which is exactly when
//    inventories are incomplete.
//
// 2. HOW IT FOLDS. A device logging the same line every second produces one row
//    per five-minute bucket, not three hundred. The bucket is IN the key, so
//    folding can never reach across windows: a link flap this morning stays a
//    separate row from one last week, and a rate that changes over time is
//    still readable as a sequence of rows.

// Folding window. Five minutes is short enough that a flapping port reads as a
// sequence rather than one eternal row, and long enough to collapse the burst a
// single event produces.
const FOLD_BUCKET_MS = 5 * 60 * 1000;

// Resolver cache TTL. The agent inventory changes on the scale of days; a batch
// arrives every 30 seconds. Rebuilding the map per batch would be a full table
// read per agent per flush for data that has not moved.
const RESOLVER_TTL_MS = 60 * 1000;

function shortHash(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 24);
}

// Builds the key that decides folding. Everything that makes two lines "the
// same event" goes in; everything that makes them different stays out.
//
// The summary is HASHED rather than included: it is up to 512 characters and
// the column is 160. Hashing also means the key never carries message text into
// an index, which keeps a masked credential from reappearing in a key even if
// the masking ever missed one.
//
// The identity is the switch when there is one (`s<id>`), else the agent
// (`d<id>`), else the address: the two ids are different spaces, and switch 4
// and agent 4 are different senders.
function buildDedupKey(event, deviceId, bucketMs = FOLD_BUCKET_MS, { snmpDeviceId = null } = {}) {
  const bucket = Math.floor(new Date(event.receivedAt).getTime() / bucketMs);
  const who = snmpDeviceId != null ? `s${snmpDeviceId}`
    : (deviceId != null ? `d${deviceId}` : `ip:${event.sourceIp}`);
  const what = shortHash([event.eventType, event.ifname || '', event.summary].join('\u0000'));
  return `${who}|${event.transport}|${event.eventType}|${what}|${bucket}`.slice(0, 160);
}

// The key an address is compared by: an IP literal in canonical form (IPv6
// compressed, an IPv4-mapped IPv6 sender read as the IPv4 it is), or null for
// anything that is not an IP literal — a switch registered by DNS name has no
// address an event can be matched to, and a guessed match is worse than none.
function addressKey(value) {
  let v = String(value == null ? '' : value).trim().toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped && net.isIPv4(mapped[1])) v = mapped[1];
  return canonicalIp(v);
}

function createDeviceEventIngest({
  deviceEventsRepo,
  agentsRepo,
  arpEntriesRepo = null,
  // THE SWITCH-PORT PATH (migration 118), and since migration 133 the switch
  // a stored event names. A link.down / link.up /
  // link.admin_down from a switch the server POLLS is also a fact about one of
  // that switch's ports, and it used to stop at the Device Log. With these
  // three wired, such an event is tied to the polled device by the address it
  // came from (snmp_devices.host) and to the port by its name, and handed to
  // the switch-port history — which is what gives it a place in the changes
  // feed and, for an uplink or a flapping port, a finding.
  //
  // `device_id` on a stored event is an AGENT id (the hostResolver maps
  // addresses to agents), and nothing here changes what that column means:
  // the switch goes in `snmp_device_id`, resolved from the same map.
  snmpDevicesRepo = null,
  deviceInterfacesRepo = null,
  switchPortStateService = null,
  logger = null,
  foldBucketMs = FOLD_BUCKET_MS,
  resolverTtlMs = RESOLVER_TTL_MS,
  now = () => Date.now(),
}) {
  let cachedResolver = null;
  let cachedAt = 0;
  let cachedSwitches = null;
  let switchesAt = 0;

  // address -> snmp_devices row, rebuilt at most once per TTL for the same
  // reason the agent resolver is: the inventory moves on the scale of days.
  // Keyed by addressKey, so only IP-literal hosts are in it. Two devices on
  // one address (different ports) resolve to the first — the lower id, as
  // list() orders — the same "first claimant wins" rule hostResolver applies.
  async function getSwitches() {
    if (!snmpDevicesRepo || typeof snmpDevicesRepo.list !== 'function') return new Map();
    if (cachedSwitches && now() - switchesAt < resolverTtlMs) return cachedSwitches;
    try {
      const rows = await snmpDevicesRepo.list({});
      cachedSwitches = new Map();
      for (const d of rows || []) {
        const key = d && typeof d.host === 'string' ? addressKey(d.host) : null;
        if (key && !cachedSwitches.has(key)) cachedSwitches.set(key, d);
      }
      switchesAt = now();
    } catch (err) {
      if (logger) logger.warn(`device-event ingest: could not refresh the switch list (${err.message})`);
      if (!cachedSwitches) return new Map();
    }
    return cachedSwitches;
  }

  // Finds the port an event names. The trap path names it by ifName (the
  // agent resolves ifIndex through the topology poll's own table); a syslog
  // line usually spells it the long way ("GigabitEthernet1/0/12"), which is
  // what ifDescr holds. Exact matches only, case aside: a guessed port is worse
  // than none.
  function findPort(ports, ifname) {
    const want = String(ifname).trim().toLowerCase();
    if (!want) return null;
    return ports.find((p) => String(p.ifName || '').toLowerCase() === want)
      || ports.find((p) => String(p.ifDescr || '').toLowerCase() === want)
      || null;
  }

  // Hands every link event in a batch that can be tied to a polled switch port
  // to the switch-port history. Best-effort: the events are already stored.
  async function recordSwitchPorts(agentId, events) {
    if (!switchPortStateService || !snmpDevicesRepo || !deviceInterfacesRepo) return 0;
    const links = events
      .filter((e) => e && LINK_EVENTS.includes(e.eventType) && e.ifname && e.sourceIp)
      .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
    if (!links.length) return 0;

    const switches = await getSwitches();
    const portsByDevice = new Map();
    let recorded = 0;
    for (const e of links) {
      const device = switches.get(addressKey(e.sourceIp));
      if (!device) continue;
      try {
        if (!portsByDevice.has(device.id)) {
          portsByDevice.set(device.id, await deviceInterfacesRepo.listForDevice(device.id, { limit: 4096 }));
        }
        const port = findPort(portsByDevice.get(device.id), e.ifname);
        if (!port) continue;
        const out = await switchPortStateService.recordEvent({
          agentId,
          device,
          port,
          eventType: e.eventType,
          source: e.transport === 'trap' ? 'trap' : 'syslog',
          at: new Date(e.receivedAt),
        });
        // The row the service just updated is the port's state for the next
        // event in this same batch.
        if (out.transition || out.flapped) recorded += 1;
        const nextState = statusFromEvent(e.eventType, port);
        if (nextState) Object.assign(port, nextState);
      } catch (err) {
        if (logger) logger.warn(`device-event ingest: port history failed for ${e.sourceIp} ${e.ifname} (${err.message})`);
      }
    }
    return recorded;
  }

  // The IP→agent map, rebuilt at most once per TTL. A failure to rebuild keeps
  // the previous map rather than resolving nothing: a stale answer about which
  // switch sent a line is better than none, and the next batch retries.
  async function getResolver() {
    if (cachedResolver && now() - cachedAt < resolverTtlMs) return cachedResolver;
    try {
      const agents = await agentsRepo.findAll();
      cachedResolver = buildHostResolver(agents);
      cachedAt = now();
    } catch (err) {
      if (logger) logger.warn(`device-event ingest: could not refresh host resolver (${err.message})`);
      if (!cachedResolver) return { resolve: () => null, size: 0 };
    }
    return cachedResolver;
  }

  // Second-chance resolution through the ARP table, one lookup per DISTINCT
  // unresolved IP in the batch — not per row. A switch mid-outage sends the
  // same address hundreds of times, and that must cost one query (two when
  // the address has a MAC worth following).
  //
  // An arp_entries row says "agent A SAW address X at MAC M". A is the
  // observer. What can identify the SENDER is M: when the same MAC is also
  // behind an address some agent reports as its OWN (capabilities.ips), X is
  // another address of that agent's host. That — and only that — resolves.
  // A MAC that leads to two different agents resolves to neither.
  async function resolveViaArp(ips, resolver) {
    const found = new Map();
    if (!arpEntriesRepo || !ips.size) return found;
    for (const ip of ips) {
      try {
        const rows = await arpEntriesRepo.findByIp({ ip, limit: 1 });
        // findByIp orders by last_seen DESC, so the freshest sighting wins —
        // the same "newest observation" rule universal search applies.
        const mac = rows && rows.length ? rows[0].mac : null;
        if (!mac || typeof arpEntriesRepo.findByMac !== 'function') continue;
        const siblings = await arpEntriesRepo.findByMac({ mac, limit: 25 });
        const owners = new Set();
        for (const r of siblings || []) {
          const owner = r && r.ip !== ip ? resolver.resolve(r.ip) : null;
          if (owner != null) owners.add(Number(owner));
        }
        if (owners.size === 1) found.set(ip, [...owners][0]);
      } catch (err) {
        if (logger) logger.debug(`device-event ingest: ARP lookup failed for ${ip} (${err.message})`);
      }
    }
    return found;
  }

  // Ingests one agent's batch. Returns a summary the route reports verbatim, so
  // an operator seeing "202 accepted" can tell a repeat batch from a broken
  // pipeline, and an unresolved sender from a dropped one.
  async function ingest(agentId, events) {
    const rows = Array.isArray(events) ? events : [];
    if (!rows.length) return { inserted: 0, folded: 0, resolved: 0, unresolved: 0 };

    const resolver = await getResolver();
    // The polled switches, FIRST: a switch's own events belong to the switch.
    let switches = new Map();
    try {
      switches = await getSwitches();
    } catch (err) {
      if (logger) logger.warn(`device-event ingest: switch lookup failed (${err.message})`);
    }

    const unresolvedIps = new Set();
    const withDevice = rows.map((e) => {
      const sw = switches.get(addressKey(e.sourceIp)) || null;
      const snmpDeviceId = sw && sw.id != null ? Number(sw.id) : null;
      // Still asked when the sender is a switch: a legacy SNMP-monitor agent
      // row (monitor_config.snmp.host) or an agent host on the same box is
      // that agent's timeline too, and the two columns do not compete.
      const deviceId = resolver.resolve(e.sourceIp);
      if (deviceId == null && snmpDeviceId == null) unresolvedIps.add(e.sourceIp);
      return { event: e, deviceId, snmpDeviceId };
    });

    const viaArp = await resolveViaArp(unresolvedIps, resolver);

    let resolved = 0;
    let unresolved = 0;
    const prepared = withDevice.map(({ event, deviceId, snmpDeviceId }) => {
      const id = deviceId ?? viaArp.get(event.sourceIp) ?? null;
      if (id == null && snmpDeviceId == null) unresolved += 1; else resolved += 1;
      return {
        ...event,
        deviceId: id,
        snmpDeviceId,
        dedupKey: buildDedupKey(event, id, foldBucketMs, { snmpDeviceId }),
      };
    });

    const { inserted, folded } = await deviceEventsRepo.createMany(agentId, prepared);

    // After the write, like every other bookkeeping step: the event is stored
    // whatever happens to the port history.
    let portTransitions = 0;
    try {
      portTransitions = await recordSwitchPorts(agentId, rows);
    } catch (err) {
      if (logger) logger.warn(`device-event ingest: switch-port history failed (${err.message})`);
    }
    return { inserted, folded, resolved, unresolved, portTransitions };
  }

  // Drops the cached resolver. Called when an agent is created or deleted so a
  // device that just came into the inventory resolves on its next line instead
  // of waiting out the TTL.
  function invalidateResolver() {
    cachedResolver = null;
    cachedAt = 0;
    cachedSwitches = null;
    switchesAt = 0;
  }

  return { ingest, invalidateResolver, buildDedupKey };
}

module.exports = {
  createDeviceEventIngest,
  buildDedupKey,
  addressKey,
  FOLD_BUCKET_MS,
};
