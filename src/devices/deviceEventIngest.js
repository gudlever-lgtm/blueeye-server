'use strict';

const crypto = require('crypto');
const { buildHostResolver } = require('../topology/hostResolver');

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
  logger = null,
  foldBucketMs = FOLD_BUCKET_MS,
  resolverTtlMs = RESOLVER_TTL_MS,
  now = () => Date.now(),
}) {
  let cachedResolver = null;
  let cachedAt = 0;

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
    return { inserted, folded, resolved, unresolved };
  }

  // Drops the cached resolver. Called when an agent is created or deleted so a
  // device that just came into the inventory resolves on its next line instead
  // of waiting out the TTL.
  function invalidateResolver() {
    cachedResolver = null;
    cachedAt = 0;
  }

  return { ingest, invalidateResolver, buildDedupKey };
}

module.exports = {
  createDeviceEventIngest,
  buildDedupKey,
  FOLD_BUCKET_MS,
};
