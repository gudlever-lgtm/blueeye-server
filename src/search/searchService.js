'use strict';

const { classify, makeHit, compareHits, dedupe } = require('./query');
const { serviceForPort, WELL_KNOWN } = require('../flows/services');

// The universal search fan-out (Fase 1).
//
// Every resolver is independent and may fail on its own backend. One dead source
// must not blank the field — a technician mid-event needs the four answers we
// CAN give, not a 500 because the CMDB is unreachable. So this fans out with
// Promise.allSettled and reports what it could not reach in `failedSources`,
// mirroring targetTimelineService's partial-failure policy.
//
// Every hit carries `source` and `last_seen`, because "which table did this come
// from and how old is it" is the difference between an answer the technician can
// act on and one that quietly sends them to a host that moved three weeks ago.

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
// How far back flow records are consulted for "which agent saw this IP". Flows
// are retained ~7 days, so a longer window just scans for nothing.
const FLOW_WINDOW_HOURS = 24 * 7;

function createSearchService({
  agentsRepo,
  locationsRepo = null,
  flowsRepo = null,
  arpEntriesRepo = null,
  lldpNeighborsRepo = null,
  discoveredDevicesRepo = null,
  cmdbSearch = null,
  eventCasesRepo = null,
  eventClustersRepo = null,
  ticketSearch = null,
  ipamSearch = null,
  logger = null,
} = {}) {
  // Agent list is needed by nearly every resolver (to turn an id into a name and
  // a site). Fetched ONCE per search and shared, rather than per resolver.
  //
  // Known limitation, deliberately left: this is a full findAll(). It is what the
  // previous /api/search did, and at a few hundred agents it is cheaper than the
  // round-trips it replaces. It is the first thing to convert to indexed SQL
  // prefix queries when a deployment's agent count makes it hurt — see
  // docs/universal-search.md.
  async function loadAgents() {
    if (!agentsRepo || typeof agentsRepo.findAll !== 'function') return [];
    return (await agentsRepo.findAll()) || [];
  }

  const agentLabel = (a) => a.display_name || a.hostname || `agent ${a.id}`;
  const agentTarget = (id) => `agent:${id}`;

  // --- resolvers -------------------------------------------------------------
  // Each takes (ctx) and returns an array of hits. Each may throw; the caller
  // records the failure and carries on.

  // 1. IP — exact. Three independent sources, because "which host IS this
  //    address" and "which agent SAW this address" are different questions and
  //    the technician usually cannot tell which one they need.
  async function resolveIp(ctx) {
    const { q, agents } = ctx;
    const hits = [];

    // (a) The address belongs to a monitored host (agent capabilities.ips).
    for (const a of agents) {
      const ips = (a.capabilities && Array.isArray(a.capabilities.ips)) ? a.capabilities.ips : [];
      if (ips.some((ip) => String(ip).toLowerCase() === q.toLowerCase())) {
        hits.push(makeHit({
          type: 'ip',
          display_name: `${q} — ${agentLabel(a)}`,
          target: agentTarget(a.id),
          confidence: 'exact',
          source: 'agents.capabilities.ips',
          last_seen: a.last_seen || null,
          detail: a.location_name || null,
        }));
      }
    }

    // (b) The address has an ARP/neighbour binding (migration 073).
    if (arpEntriesRepo && typeof arpEntriesRepo.findByIp === 'function') {
      const rows = await arpEntriesRepo.findByIp({ ip: q, limit: 25 });
      const byId = new Map(agents.map((a) => [Number(a.id), a]));
      for (const r of rows) {
        const seenBy = byId.get(r.agentId);
        hits.push(makeHit({
          type: 'ip',
          display_name: `${q} → ${r.mac}`,
          target: agentTarget(r.agentId),
          confidence: 'exact',
          source: `arp_entries (${r.source})`,
          last_seen: r.lastSeen,
          detail: seenBy ? `seen by ${agentLabel(seenBy)}${r.interface ? ` on ${r.interface}` : ''}` : null,
        }));
      }
    }

    // (c) The address merely appeared in traffic. Weaker: a transit agent sees
    //     addresses that do not live at its site, so this says "look here",
    //     not "it is here".
    if (flowsRepo && typeof flowsRepo.agentIdsForIp === 'function') {
      const since = new Date(ctx.now.getTime() - FLOW_WINDOW_HOURS * 3600 * 1000);
      const ids = await flowsRepo.agentIdsForIp({ ip: q, since, until: ctx.now });
      const byId = new Map(agents.map((a) => [Number(a.id), a]));
      for (const id of ids || []) {
        const a = byId.get(Number(id));
        hits.push(makeHit({
          type: 'ip',
          display_name: `${q} — seen in traffic at ${a ? agentLabel(a) : `agent ${id}`}`,
          target: `flows:${id}:${q}`,
          confidence: 'medium',
          source: 'flow_records',
          last_seen: a ? a.last_seen || null : null,
        }));
      }
    }

    return hits;
  }

  // 2. MAC — exact on the normalised form. The query was normalised by
  //    classify(), using the SAME function the ingest parser uses, which is what
  //    makes three spellings of one MAC resolve identically.
  async function resolveMac(ctx) {
    const { mac, agents } = ctx;
    const hits = [];
    const byId = new Map(agents.map((a) => [Number(a.id), a]));

    if (arpEntriesRepo && typeof arpEntriesRepo.findByMac === 'function') {
      const rows = await arpEntriesRepo.findByMac({ mac, limit: 25 });
      for (const r of rows) {
        const seenBy = byId.get(r.agentId);
        hits.push(makeHit({
          type: 'mac',
          display_name: `${mac} → ${r.ip}`,
          target: agentTarget(r.agentId),
          confidence: 'exact',
          source: `arp_entries (${r.source})`,
          last_seen: r.lastSeen,
          detail: [
            seenBy ? `seen by ${agentLabel(seenBy)}` : null,
            r.interface ? `on ${r.interface}` : null,
            // A recently-moved binding is exactly the thing a technician chasing
            // an intermittent fault wants flagged, not buried.
            r.macChangedAt ? `binding changed ${r.macChangedAt}` : null,
          ].filter(Boolean).join(' · ') || null,
        }));
      }
    }

    // LLDP chassis ids are often MACs — but they identify a SWITCH CHASSIS, not
    // a client. Reported at low confidence and labelled, so it reads as "a switch
    // announces this address" rather than "your laptop is here".
    if (lldpNeighborsRepo && typeof lldpNeighborsRepo.listAll === 'function') {
      const edges = (await lldpNeighborsRepo.listAll()) || [];
      const seen = new Set();
      for (const e of edges) {
        const localMatch = String(e.local_chassis_id || '').toLowerCase().replace(/-/g, ':') === mac;
        const remoteMatch = String(e.remote_chassis_id || '').toLowerCase().replace(/-/g, ':') === mac;
        if (!localMatch && !remoteMatch) continue;
        const agentId = Number(e.local_agent_id);
        if (seen.has(agentId)) continue;
        seen.add(agentId);
        const a = byId.get(agentId);
        hits.push(makeHit({
          type: 'mac',
          display_name: `${mac} — LLDP chassis of ${a ? agentLabel(a) : `agent ${agentId}`}`,
          target: agentTarget(agentId),
          confidence: 'low',
          source: 'lldp_neighbors',
          last_seen: e.last_seen || null,
          detail: localMatch ? 'this device' : 'a neighbour of this device',
        }));
      }
    }

    return hits;
  }

  // 3. Hostname / DNS / agent name — prefix beats substring, never exact-only.
  async function resolveHost(ctx) {
    const { lower, agents } = ctx;
    const hits = [];

    for (const a of agents) {
      const host = String(a.hostname || '').toLowerCase();
      const name = String(a.display_name || '').toLowerCase();
      let confidence = null;
      // An exact hostname is as good as an identifier.
      if (host === lower || name === lower) confidence = 'exact';
      else if (host.startsWith(lower) || name.startsWith(lower)) confidence = 'high';
      else if (host.includes(lower) || name.includes(lower)) confidence = 'medium';
      if (!confidence) continue;

      hits.push(makeHit({
        type: 'host',
        display_name: agentLabel(a),
        target: agentTarget(a.id),
        confidence,
        source: 'agents',
        last_seen: a.last_seen || null,
        detail: [a.location_name || null, a.status || null].filter(Boolean).join(' · ') || null,
      }));
    }

    return hits;
  }

  // 4. Site / location.
  async function resolveSite(ctx) {
    if (!locationsRepo || typeof locationsRepo.findAll !== 'function') return [];
    const { lower } = ctx;
    const locs = (await locationsRepo.findAll()) || [];
    const hits = [];
    for (const l of locs) {
      const name = String(l.name || '').toLowerCase();
      let confidence = null;
      if (name === lower) confidence = 'exact';
      else if (name.startsWith(lower)) confidence = 'high';
      else if (name.includes(lower)) confidence = 'medium';
      if (!confidence) continue;
      hits.push(makeHit({
        type: 'site',
        display_name: l.name,
        target: `location:${l.id}`,
        confidence,
        source: 'locations',
        // Locations carry no last_seen. Reported as null rather than faked from
        // a related row — an undated answer is honest, an invented date is not.
        last_seen: null,
      }));
    }
    return hits;
  }

  // 5. Agent id — an exact numeric id.
  async function resolveAgentId(ctx) {
    const a = ctx.agents.find((x) => Number(x.id) === ctx.agentId);
    if (!a) return [];
    return [makeHit({
      type: 'host',
      display_name: agentLabel(a),
      target: agentTarget(a.id),
      confidence: 'exact',
      source: 'agents.id',
      last_seen: a.last_seen || null,
      detail: a.location_name || null,
    })];
  }

  // 6. Service / application.
  //
  // The only service model this codebase has is the well-known port table in
  // src/flows/services.js — a static IANA lookup, not a service inventory. So a
  // service search answers "which port is this, and who is talking on it",
  // which is what the flow explorer can actually act on. It does not pretend to
  // resolve an application the product does not model.
  async function resolveService(ctx) {
    const { q, lower, isPort, port, agents } = ctx;
    const hits = [];

    if (isPort) {
      const name = serviceForPort(port);
      hits.push(makeHit({
        type: 'service',
        display_name: name ? `${port} — ${name}` : `port ${port}`,
        target: `flows:port:${port}`,
        confidence: 'exact',
        source: 'flows/services.js',
        last_seen: null,
      }));
      if (flowsRepo && typeof flowsRepo.agentIdsForPort === 'function') {
        const ids = await flowsRepo.agentIdsForPort({
          port,
          since: new Date(ctx.now.getTime() - FLOW_WINDOW_HOURS * 3600 * 1000),
          until: ctx.now,
        });
        const byId = new Map(agents.map((a) => [Number(a.id), a]));
        for (const id of ids || []) {
          const a = byId.get(Number(id));
          hits.push(makeHit({
            type: 'service',
            display_name: `port ${port} — active at ${a ? agentLabel(a) : `agent ${id}`}`,
            target: `flows:${id}:port:${port}`,
            confidence: 'medium',
            source: 'flow_records',
            last_seen: a ? a.last_seen || null : null,
          }));
        }
      }
      return hits;
    }

    // A service NAME ("https", "rdp") → the port(s) it conventionally runs on.
    for (const [p, name] of WELL_KNOWN) {
      const n = name.toLowerCase();
      let confidence = null;
      if (n === lower) confidence = 'high';
      else if (n.startsWith(lower)) confidence = 'medium';
      else if (n.includes(lower)) confidence = 'low';
      if (!confidence) continue;
      hits.push(makeHit({
        type: 'service',
        display_name: `${name} (port ${p})`,
        target: `flows:port:${p}`,
        confidence,
        source: 'flows/services.js',
        last_seen: null,
      }));
    }
    return hits;
  }

  // 7. Discovered (not yet monitored) devices — an IP or rDNS name that active
  //    discovery found. Often exactly the thing a technician is looking for:
  //    the host causing trouble is frequently one nobody enrolled.
  async function resolveDiscovered(ctx) {
    if (!discoveredDevicesRepo || typeof discoveredDevicesRepo.search !== 'function') return [];
    const rows = (await discoveredDevicesRepo.search({ q: ctx.q, limit: 10 })) || [];
    return rows.map((d) => makeHit({
      type: 'device',
      display_name: d.hostname ? `${d.hostname} (${d.ip})` : d.ip,
      target: `discovered:${d.id}`,
      confidence: String(d.ip) === ctx.q ? 'exact' : 'medium',
      source: 'discovered_devices',
      last_seen: d.lastSeen || d.last_seen || null,
      detail: d.status || null,
    }));
  }

  // 8. CMDB assets.
  //
  // Runs LAST and is the only resolver that leaves the building: it is a live
  // HTTP call to the customer's ServiceNow/Nautobot. The caller debounces, and a
  // failure here is reported as a failed source rather than failing the search —
  // the local answers are still worth serving.
  //
  // CMDB connectors return no timestamp, so last_seen is null. That is the
  // honest answer, and the UI shows it as such rather than implying freshness.
  async function resolveAsset(ctx) {
    if (typeof cmdbSearch !== 'function') return [];
    const assets = (await cmdbSearch(ctx.q)) || [];
    return assets.slice(0, 10).map((a) => makeHit({
      type: 'asset',
      display_name: a.name || a.label || a.id || 'asset',
      target: `cmdb:${a.id || a.name}`,
      confidence: 'medium',
      source: `cmdb:${a.source || 'asset'}`,
      last_seen: null,
      detail: a.location || null,
    }));
  }

  // 9. Events — event cases (the operator-facing unit) and cross-agent clusters.
  //
  // Matches an event's numeric id exactly, words from its title, and the device
  // it sits on — the last one only for events still OPEN, because "what is going
  // on with fw-aarhus" wants the live cases, not every resolved one since March.
  // Reads the same list the Events tab reads (bounded, newest first) and filters
  // in JS — same known limitation as loadAgents(), same reason.
  const EVENT_SCAN_LIMIT = 500;
  const EVENT_HITS_MAX = 10;

  async function resolveEvent(ctx) {
    const { lower, isNumeric, agentId } = ctx;
    const hits = [];

    if (eventCasesRepo && typeof eventCasesRepo.list === 'function') {
      const rows = (await eventCasesRepo.list({ limit: EVENT_SCAN_LIMIT })) || [];
      for (const ev of rows) {
        const title = String(ev.title || '').toLowerCase();
        const device = [ev.agentName, ev.agentHostname].filter(Boolean).map((x) => String(x).toLowerCase());
        const open = ev.status === 'open' || ev.status === 'investigating';
        let confidence = null;
        let via = 'title';
        if (isNumeric && Number(ev.id) === agentId) confidence = 'exact';
        else if (title.startsWith(lower)) confidence = 'high';
        else if (title.includes(lower)) confidence = 'medium';
        else if (open && device.some((d) => d === lower || d.startsWith(lower))) { confidence = 'medium'; via = 'device'; }
        if (!confidence) continue;
        hits.push(makeHit({
          type: 'event',
          display_name: `#${ev.id} ${ev.title || ''}`.trim(),
          target: `event:${ev.id}`,
          confidence,
          source: via === 'device' ? 'event_cases (open on this device)' : 'event_cases',
          last_seen: ev.lastEventAt || ev.firstEventAt || null,
          detail: [ev.severity, ev.status, ev.agentName || ev.agentHostname || null, ev.locationName || null]
            .filter(Boolean).join(' · ') || null,
        }));
        if (hits.length >= EVENT_HITS_MAX) break;
      }
    }

    if (eventClustersRepo && typeof eventClustersRepo.list === 'function') {
      const rows = (await eventClustersRepo.list({ limit: 200 })) || [];
      for (const c of rows) {
        const cause = String(c.suspectedCommonCause || '').toLowerCase();
        let confidence = null;
        if (isNumeric && Number(c.id) === agentId) confidence = 'exact';
        else if (cause && cause.startsWith(lower)) confidence = 'high';
        else if (cause && cause.includes(lower)) confidence = 'medium';
        if (!confidence) continue;
        hits.push(makeHit({
          type: 'event',
          display_name: `Situation #${c.id}${c.suspectedCommonCause ? ` — ${c.suspectedCommonCause}` : ''}`,
          target: `cluster:${c.id}`,
          confidence,
          source: 'event_clusters',
          last_seen: c.alertLastAt || c.detectedAt || null,
          detail: [c.status, c.alertMemberCount != null ? `${c.alertMemberCount} findings` : null, c.itsmTicketRef || null]
            .filter(Boolean).join(' · ') || null,
        }));
      }
    }

    return hits;
  }

  // 10. Tickets — two sources with very different cost.
  //
  // (a) LOCAL: the ITSM reference a situation (event cluster) was raised as.
  //     Typing the ticket number the service desk quoted lands on the situation
  //     behind it, with a screen to open. Cheap, always current.
  async function resolveTicketRef(ctx) {
    if (!eventClustersRepo || typeof eventClustersRepo.list !== 'function') return [];
    const { lower } = ctx;
    const rows = (await eventClustersRepo.list({ limit: 200 })) || [];
    const hits = [];
    for (const c of rows) {
      const ref = String(c.itsmTicketRef || '');
      if (!ref) continue;
      const r = ref.toLowerCase();
      let confidence = null;
      if (r === lower) confidence = 'exact';
      else if (r.startsWith(lower)) confidence = 'high';
      else if (r.includes(lower)) confidence = 'medium';
      if (!confidence) continue;
      hits.push(makeHit({
        type: 'ticket',
        display_name: `${ref} — Situation #${c.id}`,
        target: `cluster:${c.id}`,
        confidence,
        source: 'event_clusters.itsm_ticket_ref',
        last_seen: c.alertLastAt || c.detectedAt || null,
        detail: [c.status, c.suspectedCommonCause || null].filter(Boolean).join(' · ') || null,
      }));
    }
    return hits;
  }

  // (b) REMOTE: the customer's ITSM (ServiceNow) searched live — number, words
  //     from the short description, and the correlation id BlueEyes stamped on
  //     tickets it raised. Leaves the building like the CMDB resolver; a dead
  //     ITSM is a failed source, not a failed search. Tickets have no screen
  //     here, so each hit carries a deep link.
  async function resolveItsm(ctx) {
    if (typeof ticketSearch !== 'function') return [];
    const { lower } = ctx;
    const tickets = (await ticketSearch(ctx.q)) || [];
    return tickets.slice(0, 10).map((t) => {
      const number = t.number ? String(t.number) : null;
      const confidence = number && number.toLowerCase() === lower ? 'exact'
        : number && number.toLowerCase().startsWith(lower) ? 'high'
          : 'medium';
      return makeHit({
        type: 'ticket',
        display_name: number ? `${number} — ${t.title || ''}`.trim() : (t.title || t.id),
        target: `ticket:${t.integrationId}:${t.id}`,
        confidence,
        source: `itsm:${t.source}${t.integrationName ? ` (${t.integrationName})` : ''}`,
        last_seen: t.updatedAt || null,
        detail: [t.state || null, t.priority ? `P${t.priority}` : null].filter(Boolean).join(' · ') || null,
        url: t.url || null,
      });
    });
  }

  // 11. IPAM — prefixes and addresses from the customer's Nautobot. Answers the
  //     question none of the local sources can: "which subnet is this, and what
  //     is it for" — the prefix description is where the network team wrote
  //     down what the range is. A partial IP ("10.1.") is deliberately routed
  //     here and nowhere else. Deep-linked like tickets.
  async function resolveIpam(ctx) {
    if (typeof ipamSearch !== 'function') return [];
    const { q, lower } = ctx;
    const rows = (await ipamSearch(q)) || [];
    return rows.slice(0, 10).map((x) => {
      const addr = String(x.address || '');
      const a = addr.toLowerCase();
      // "10.1.0.5" against an address row "10.1.0.5/24" is the same host.
      const bare = a.replace(/\/\d+$/, '');
      const confidence = a === lower || bare === lower ? 'exact'
        : a.startsWith(lower) ? 'high'
          : 'medium';
      return makeHit({
        type: 'ipam',
        display_name: x.description ? `${addr} — ${x.description}` : (x.dnsName ? `${addr} — ${x.dnsName}` : addr),
        target: `ipam:${x.kind}:${x.id}`,
        confidence,
        source: `ipam:${x.source}`,
        last_seen: x.updatedAt || null,
        detail: [x.kind === 'prefix' ? 'prefix' : 'address', x.status || null, x.vrf ? `VRF ${x.vrf}` : null, x.location || null]
          .filter(Boolean).join(' · ') || null,
        url: x.url || null,
      });
    });
  }

  // 12. Username.
  //
  // NOT IMPLEMENTED — and deliberately left empty rather than approximated.
  //
  // The Fase 0 audit found no end-user identity source anywhere in this product:
  // `users` holds dashboard STAFF logins (admin/operator/viewer), and LDAP/OIDC/
  // SAML authenticate those same staff accounts. There is no RADIUS/802.1X
  // accounting, no NAC integration, no DHCP lease store and no AD computer
  // inventory — nothing that maps a person to an address, a port or a device.
  //
  // Resolving a username against dashboard staff would return "the operator
  // named lars", not "the machine lars is sitting at" — a confidently wrong
  // answer to the question actually being asked, which is worse than no answer.
  //
  // TODO(identity): implement when an end-user identity source exists. The most
  // likely candidates, in order of how much they would actually help:
  //   1. RADIUS/802.1X accounting (user → MAC → the ARP table we now have)
  //   2. DHCP lease ingest (hostname → IP), if the customer's DHCP can export
  //   3. AD/LDAP computer objects (user → assigned workstation name)
  // Whichever lands, it should produce hits keyed to the existing types (host/
  // ip/mac) rather than a new one — the technician wants the DEVICE, and the
  // username is just the way in.
  async function resolveUser() {
    return [];
  }

  // --- fan-out ---------------------------------------------------------------

  const RESOLVERS = [
    { family: 'ip', name: 'ip', run: resolveIp },
    { family: 'mac', name: 'mac', run: resolveMac },
    { family: 'host', name: 'host', run: resolveHost },
    { family: 'host', name: 'discovered', run: resolveDiscovered },
    { family: 'site', name: 'site', run: resolveSite },
    { family: 'agentId', name: 'agentId', run: resolveAgentId },
    { family: 'service', name: 'service', run: resolveService },
    { family: 'host', name: 'cmdb', run: resolveAsset },
    { family: 'event', name: 'event', run: resolveEvent },
    { family: 'ticket', name: 'ticketRef', run: resolveTicketRef },
    { family: 'ticket', name: 'itsm', run: resolveItsm },
    { family: 'ipam', name: 'ipam', run: resolveIpam },
    { family: 'user', name: 'user', run: resolveUser },
  ];

  // Runs the search. Returns
  //   { query, hits, total, truncated, partial, failedSources, unresolved }
  //
  // `unresolved` names the resolver families that exist but have no data source
  // wired (today: `user`). Surfacing it beats silently returning nothing — the
  // technician learns the field cannot answer that question, instead of
  // concluding their search term was wrong.
  async function search(rawQuery, { limit = DEFAULT_LIMIT, now = new Date() } = {}) {
    const ctx = classify(rawQuery);
    if (!ctx) return { query: '', hits: [], total: 0, truncated: false, partial: false, failedSources: [], unresolved: [] };

    const cap = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    ctx.now = now instanceof Date ? now : new Date(now);
    ctx.agents = await loadAgents(); // before fan-out: a failure here IS fatal (500)

    const active = RESOLVERS.filter((r) => ctx.families.includes(r.family));
    const settled = await Promise.allSettled(active.map((r) => r.run(ctx)));

    const hits = [];
    const failedSources = [];
    settled.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        hits.push(...(Array.isArray(res.value) ? res.value : []));
      } else {
        failedSources.push(active[i].name);
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`search: resolver "${active[i].name}" failed (${res.reason && res.reason.message})`);
        }
      }
    });

    const ordered = dedupe(hits).sort(compareHits);
    const unresolved = ctx.families.includes('user') ? ['user'] : [];

    return {
      query: ctx.q,
      hits: ordered.slice(0, cap),
      total: ordered.length,
      truncated: ordered.length > cap,
      partial: failedSources.length > 0,
      failedSources,
      unresolved,
    };
  }

  return { search };
}

module.exports = { createSearchService, DEFAULT_LIMIT, MAX_LIMIT };
