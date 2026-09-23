'use strict';

const crypto = require('crypto');
const { buildHostResolver } = require('../topology/hostResolver');
const { LINK_EVENTS, statusFromEvent } = require('./switchPortStateService');

// Turns a batch of raw device events, as received by one agent, into stored
// rows: resolve who sent each one, decide how it folds, hand it to the
// repository.
//
// TWO JOBS, AND THEY ARE SEPARATE ON PURPOSE.
//
// 1. WHO SENT IT. The agent knows only the source IP. A row is far more useful
//    against a device the inventory already knows — it joins the timeline, the
//    correlator and search — so the IP is resolved against what the server
//    already has:
//      a) the agents' own reported IPs and SNMP monitor targets, via the SAME
//         buildHostResolver the topology graph uses. One resolver, one answer;
//         two would eventually disagree.
//      b) failing that, arp_entries — the IP↔MAC table an agent reports from
//         its own neighbour cache.
//    Failing BOTH, the row is stored with device_id NULL and the source IP
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
function buildDedupKey(event, deviceId, bucketMs = FOLD_BUCKET_MS) {
  const bucket = Math.floor(new Date(event.receivedAt).getTime() / bucketMs);
  const who = deviceId != null ? `d${deviceId}` : `ip:${event.sourceIp}`;
  const what = shortHash([event.eventType, event.ifname || '', event.summary].join('\u0000'));
  return `${who}|${event.transport}|${event.eventType}|${what}|${bucket}`.slice(0, 160);
}

function createDeviceEventIngest({
  deviceEventsRepo,
  agentsRepo,
  arpEntriesRepo = null,
  // THE SWITCH-PORT PATH (migration 118). A link.down / link.up /
  // link.admin_down from a switch the server POLLS is also a fact about one of
  // that switch's ports, and it used to stop at the Device Log. With these
  // three wired, such an event is tied to the polled device by the address it
  // came from (snmp_devices.host) and to the port by its name, and handed to
  // the switch-port history — which is what gives it a place in the changes
  // feed and, for an uplink or a flapping port, a finding.
  //
  // This is a SEPARATE resolution from the one above on purpose: `device_id`
  // on a stored event is an AGENT id (the hostResolver maps addresses to
  // agents), and nothing here changes what that column means.
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

  // host -> snmp_devices row, rebuilt at most once per TTL for the same reason
  // the agent resolver is: the inventory moves on the scale of days.
  async function getSwitches() {
    if (cachedSwitches && now() - switchesAt < resolverTtlMs) return cachedSwitches;
    try {
      const rows = await snmpDevicesRepo.list({});
      cachedSwitches = new Map();
      for (const d of rows || []) {
        if (d && typeof d.host === 'string') cachedSwitches.set(d.host.trim().toLowerCase(), d);
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
      const device = switches.get(String(e.sourceIp).trim().toLowerCase());
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
  // same address hundreds of times, and that must cost one query.
  async function resolveViaArp(ips) {
    const found = new Map();
    if (!arpEntriesRepo || !ips.size) return found;
    for (const ip of ips) {
      try {
        const rows = await arpEntriesRepo.findByIp({ ip, limit: 1 });
        // findByIp orders by last_seen DESC, so the freshest sighting wins —
        // the same "newest observation" rule universal search applies.
        if (rows && rows.length && rows[0].agentId != null) found.set(ip, Number(rows[0].agentId));
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

    const unresolvedIps = new Set();
    const withDevice = rows.map((e) => {
      const deviceId = resolver.resolve(e.sourceIp);
      if (deviceId == null) unresolvedIps.add(e.sourceIp);
      return { event: e, deviceId };
    });

    const viaArp = await resolveViaArp(unresolvedIps);

    let resolved = 0;
    let unresolved = 0;
    const prepared = withDevice.map(({ event, deviceId }) => {
      const id = deviceId ?? viaArp.get(event.sourceIp) ?? null;
      if (id == null) unresolved += 1; else resolved += 1;
      return {
        ...event,
        deviceId: id,
        dedupKey: buildDedupKey(event, id, foldBucketMs),
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
  FOLD_BUCKET_MS,
};
