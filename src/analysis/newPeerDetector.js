'use strict';

const crypto = require('crypto');
const { scopeKey } = require('../repositories/knownPeersRepository');

// "Nothing at this site has ever talked to that network before" — as a
// finding.
//
// THE GAP THIS CLOSES. Every detector in this product compares a number
// against a number: a z-score against a median, a rate against a threshold, a
// counter against its own history. None of them can express the question an
// investigation actually opens with — has this ever happened before? — because
// nothing was keeping the answer. flow_records carries the ASN and the country
// of every external endpoint and is purged after about a week, so "this server
// has never had outbound traffic to a network in that country" was not a
// question the server could answer, let alone raise.
//
// known_peers (migration 142) is that memory, and this is what reads it. Each
// hour the external conversations of the previous complete hour are reduced to
// the set of (ASN, country) a scope reached; anything the memory has never held
// is new, and new gets a finding.
//
// IT IS THE known_devices PATTERN, ONE LAYER OUT. A MAC nobody at this site has
// seen becomes `device.new` (src/discovery/newDeviceDetector.js). A network
// nobody at this site has reached becomes `peer.new_asn` / `peer.new_country`.
// Same scope string, same 400-day horizon, same flood guard, on purpose: an
// operator should not have to learn two models for one idea.
//
// WHAT IT MEANS, AND WHAT IT DOES NOT. New is not bad. A new ASN is a CDN
// moving a customer, a supplier changing hosting, someone installing software
// that phones a different update server. That is why `peer.new_asn` is INFO by
// default — it is a fact for the record and for correlation, not a page. A new
// COUNTRY is the rarer and sharper one (a site's traffic footprint is usually
// stable at country level for months), so it defaults to WARN. Neither says
// "exfiltration". Both say what changed, when, and which internal address did
// it, which is what an investigation needs in the first minute.
//
// THE FLOOD GUARD. The first run against an empty memory would call every
// network on the internet new at once. Two things stop that: migration 142
// seeds the table from the flow records that still exist, and a scope stays
// SILENT until its memory is at least `baselineHours` old — it is still
// written during that time, it simply raises nothing. The same rule the
// new-device detector applies to an agent's first ARP report, for the same
// reason.
//
// Leader-only, off the ingest hot path, best-effort throughout.

const HOUR_MS = 60 * 60 * 1000;
const SEVERITIES = new Set(['INFO', 'WARN', 'CRIT']);

function toInt(v, d) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function severityOf(v, d) { const s = String(v || '').toUpperCase(); return SEVERITIES.has(s) ? s : d; }

function loadNewPeerConfig(env = process.env) {
  return {
    enabled: env.NEW_PEER_ALERTS_ENABLED !== 'false',
    // How old a scope's memory must be before it is allowed to call anything
    // new. 24 hours by default: long enough that a seeded-then-restarted
    // server is not a siren, short enough to be useful on day two.
    baselineHours: Math.max(0, toInt(env.NEW_PEER_BASELINE_HOURS, 24)),
    // A new autonomous system. Common and usually benign, so a record rather
    // than a page by default.
    asnSeverity: severityOf(env.NEW_PEER_ASN_SEVERITY, 'INFO'),
    // A new country. Rare, and the one an operator asked for.
    countrySeverity: severityOf(env.NEW_PEER_COUNTRY_SEVERITY, 'WARN'),
    // Turn either kind off entirely without touching the memory, which keeps
    // being written — so switching it back on does not start from zero.
    asnEnabled: env.NEW_PEER_ASN_ENABLED !== 'false',
    countryEnabled: env.NEW_PEER_COUNTRY_ENABLED !== 'false',
    // Per scope, per run. Above it, one summary finding instead of a flood —
    // a site that changes upstream provider meets fifty new ASNs in one hour
    // and that is one event.
    maxPerScope: Math.max(1, toInt(env.NEW_PEER_MAX_PER_SCOPE, 10)),
    intervalMinutes: Math.max(1, toInt(env.NEW_PEER_JOB_INTERVAL_MINUTES, 60)),
    // How much flow a peer needs before a first sighting counts. A single
    // stray packet to a misrouted address is not a relationship; the default
    // is deliberately tiny, because the point is to catch the small first
    // conversation, not to require a large one.
    minBytes: Math.max(0, toInt(env.NEW_PEER_MIN_BYTES, 1)),
  };
}

// Reduces an hour of (agent, asn, country) rows to one entry per
// (scope, kind, key), keeping the heaviest conversation's addresses as
// evidence. Pure — the job's grouping is testable without a database.
//
// `scopeOf` maps an agent id to its scope string ('site:3' / 'agent:7'); a row
// whose agent is unknown is dropped rather than guessed into a scope.
function groupPeers(rows, scopeOf, { asn = true, country = true, minBytes = 1 } = {}) {
  const byScope = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const scope = scopeOf(r.agentId);
    if (!scope) continue;
    const bytes = Number(r.bytes) || 0;
    if (bytes < minBytes) continue;
    const add = (kind, key, name) => {
      if (key == null) return;
      if (!byScope.has(scope)) byScope.set(scope, new Map());
      const peers = byScope.get(scope);
      const id = `${kind}|${key}`;
      const prev = peers.get(id);
      if (prev && prev.bytes >= bytes) { prev.flowCount += Number(r.flowCount) || 0; return; }
      peers.set(id, {
        kind,
        key: String(key),
        name: name ?? (prev ? prev.name : null),
        bytes,
        flowCount: (prev ? prev.flowCount : 0) + (Number(r.flowCount) || 0),
        srcIp: r.srcIp ?? null,
        extIp: r.extIp ?? null,
        agentId: r.agentId,
        firstSeen: r.firstSeen ?? null,
        lastSeen: r.lastSeen ?? null,
      });
    };
    if (asn && r.asn != null) add('asn', r.asn, r.asnName ?? null);
    if (country && r.country) add('country', r.country, null);
  }
  return byScope;
}

function createNewPeerDetector({
  flowsRepo = null,
  knownPeersRepo = null,
  agentsRepo = null,
  locationsRepo = null,
  // store -> publish -> event case -> alert -> integrations.
  findingSink = null,
  licensed = () => true,
  config = loadNewPeerConfig({}),
  logger = null,
  now = () => new Date(),
} = {}) {
  let timer = null;
  let running = false;

  const warn = (msg) => { if (logger && typeof logger.warn === 'function') logger.warn(msg); };
  const info = (msg) => { if (logger && typeof logger.info === 'function') logger.info(msg); };

  function isOn() {
    try {
      return !!(config && config.enabled) && !!licensed()
        && !!flowsRepo && !!knownPeersRepo && !!agentsRepo && !!findingSink;
    } catch { return false; }
  }

  // agentId -> scope, and scope -> a name a human recognises. One read of the
  // agent list per run; the fleet does not move within an hour.
  async function buildScopes() {
    const agents = await agentsRepo.findAll();
    const scopeOf = new Map();
    const nameOf = new Map();
    const siteIds = new Set();
    for (const a of Array.isArray(agents) ? agents : []) {
      if (!a || a.id == null) continue;
      const siteId = a.location_id != null ? Number(a.location_id) : null;
      const scope = scopeKey({ siteId, agentId: Number(a.id) });
      if (!scope) continue;
      scopeOf.set(Number(a.id), scope);
      if (siteId != null) siteIds.add(siteId);
      else nameOf.set(scope, a.display_name || a.hostname || `agent ${a.id}`);
    }
    if (siteIds.size && locationsRepo && typeof locationsRepo.findById === 'function') {
      for (const id of siteIds) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const loc = await locationsRepo.findById(id);
          if (loc && loc.name) nameOf.set(`site:${id}`, loc.name);
        } catch { /* a scope without a name is still a scope */ }
      }
    }
    return { scopeOf, nameOf };
  }

  function buildFinding({ peer, scope, scopeName, severity, at, from, to }) {
    const hostId = String(peer.agentId);
    const isCountry = peer.kind === 'country';
    const metric = isCountry ? 'peer.new_country' : 'peer.new_asn';
    const who = scopeName ? `${scopeName} (${scope})` : scope;
    const what = isCountry
      ? `a network in ${peer.key}`
      : `AS${peer.key}${peer.name ? ` (${peer.name})` : ''}`;
    const labels = {
      scope,
      peerKind: peer.kind,
      peerKey: peer.key,
      peerName: peer.name ?? null,
      srcIp: peer.srcIp ?? null,
      extIp: peer.extIp ?? null,
      bytes: peer.bytes,
      flowCount: peer.flowCount,
    };
    return {
      id: crypto.randomUUID(),
      // The agent that observed the conversation. The peer is the subject and
      // lives in the evidence target — it is a network, not a monitored host.
      hostId,
      deviceId: null,
      interfaceId: null,
      metric,
      severity,
      kind: 'THRESHOLD',
      observed: peer.bytes,
      baseline: null,
      deviation: null,
      window: [from, to],
      explanation: `${who} sent traffic to ${what} for the first time in 400 days of recorded history `
        + `(${peer.bytes} bytes over ${peer.flowCount} flow(s)`
        + `${peer.srcIp ? `, from ${peer.srcIp}` : ''}${peer.extIp ? ` to ${peer.extIp}` : ''}). `
        + `New is not the same as wrong: a CDN moving a customer, a supplier changing hosting or newly `
        + `installed software all look like this. What it does say is that the destination is outside this `
        + `${isCountry ? 'site’s usual geography' : 'site’s usual set of networks'}, `
        + `which is worth a look when it comes from a host that has no business reaching out.`,
      evidence: [{
        hostId,
        metric,
        value: peer.bytes,
        ts: to,
        target: isCountry ? peer.key : `AS${peer.key}`,
        labels,
      }],
      correlatedWith: [],
      createdAt: at,
      acked: false,
    };
  }

  function buildSummary({ peers, scope, scopeName, at, from, to }) {
    const sample = peers.slice(0, 10).map((p) => (p.kind === 'country' ? p.key : `AS${p.key}`));
    const hostId = String(peers[0].agentId);
    return {
      id: crypto.randomUUID(),
      hostId,
      deviceId: null,
      interfaceId: null,
      metric: 'peer.new_asn',
      severity: config.asnSeverity,
      kind: 'THRESHOLD',
      observed: peers.length,
      baseline: null,
      deviation: null,
      window: [from, to],
      explanation: `${scopeName ? `${scopeName} (${scope})` : scope} reached ${peers.length} more previously unseen `
        + `network(s) in this hour than the limit of ${config.maxPerScope} per scope per run (NEW_PEER_MAX_PER_SCOPE), `
        + `so they were not raised individually: ${sample.join(', ')}${peers.length > sample.length ? ', …' : ''}. `
        + `A jump this size is usually one cause — a changed upstream provider, a new cloud service, or a `
        + `GeoIP database update — rather than ${peers.length} separate events.`,
      evidence: [{
        hostId,
        metric: 'peer.new_asn',
        value: peers.length,
        ts: to,
        labels: { scope, summary: true, count: peers.length, peers: sample },
      }],
      correlatedWith: [],
      createdAt: at,
      acked: false,
    };
  }

  // One pass over the previous complete hour.
  async function run() {
    if (!isOn() || running) return null;
    running = true;
    try {
      const t = now();
      const to = new Date(Math.floor(t.getTime() / HOUR_MS) * HOUR_MS);
      const from = new Date(to.getTime() - HOUR_MS);

      const { scopeOf, nameOf } = await buildScopes();
      const rows = await flowsRepo.externalPeersSince({ from, to });
      const grouped = groupPeers(rows, (id) => scopeOf.get(Number(id)) || null, {
        asn: config.asnEnabled,
        country: config.countryEnabled,
        minBytes: config.minBytes,
      });

      let raised = 0;
      let learned = 0;
      let warming = 0;
      for (const [scope, peers] of grouped) {
        const list = [...peers.values()];
        // The memory is written for every scope on every run, including the
        // ones still warming up — that is what ends the warm-up.
        let oldest = null;
        try { oldest = await knownPeersRepo.oldestFirstSeen(scope); } catch { oldest = null; }
        const warm = oldest != null && t.getTime() - oldest.getTime() >= config.baselineHours * HOUR_MS;

        let fresh = [];
        if (warm) {
          let known = new Set();
          try {
            known = await knownPeersRepo.knownPeers({ scope, peers: list.map((p) => ({ kind: p.kind, key: p.key })) });
          } catch (err) {
            // A memory that cannot be read means nothing is called new — never
            // that everything is.
            warn(`new-peer: could not read the peer memory for ${scope} (${err.message})`);
            known = null;
          }
          if (known) fresh = list.filter((p) => !known.has(`${p.kind}|${p.key}`));
        } else {
          warming += 1;
        }

        // Write the memory BEFORE raising: a crash between the two costs one
        // finding, where the other order costs the same finding every hour
        // forever.
        try {
          learned += await knownPeersRepo.touchMany(scope, list, to);
        } catch (err) {
          warn(`new-peer: could not write the peer memory for ${scope} (${err.message})`);
        }

        // Countries first — the sharper signal is the one that survives the cap.
        fresh.sort((a, b) => (a.kind === b.kind ? b.bytes - a.bytes : (a.kind === 'country' ? -1 : 1)));
        for (const peer of fresh.slice(0, config.maxPerScope)) {
          const severity = peer.kind === 'country' ? config.countrySeverity : config.asnSeverity;
          try {
            // eslint-disable-next-line no-await-in-loop
            const stored = await findingSink.emit(buildFinding({
              peer, scope, scopeName: nameOf.get(scope) || null, severity, at: to, from, to,
            }));
            if (stored) raised += 1;
          } catch (err) {
            warn(`new-peer: could not raise for ${scope} ${peer.kind}:${peer.key} (${err.message})`);
          }
        }
        const over = fresh.slice(config.maxPerScope);
        if (over.length) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const stored = await findingSink.emit(buildSummary({
              peers: over, scope, scopeName: nameOf.get(scope) || null, at: to, from, to,
            }));
            if (stored) raised += 1;
          } catch (err) {
            warn(`new-peer: could not raise the overflow summary for ${scope} (${err.message})`);
          }
        }
      }

      info(`new-peer: ${from.toISOString()}–${to.toISOString()} scopes ${grouped.size} (${warming} warming up), `
        + `memory rows ${learned}, raised ${raised}`);
      return { from: from.toISOString(), to: to.toISOString(), scopes: grouped.size, warming, learned, raised };
    } catch (err) {
      warn(`new-peer: run failed (${err && err.message})`);
      return null;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    run().catch(() => {});
    timer = setInterval(() => run().catch(() => {}), config.intervalMinutes * 60 * 1000);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { start, stop, run, groupPeers };
}

module.exports = { createNewPeerDetector, loadNewPeerConfig, groupPeers };
