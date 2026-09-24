'use strict';

// Gathers the coverage report's sources and hands them to the pure rules in
// ./coverageGaps.js. Owns no data: every read is an existing repository.
//
// EVERY SOURCE IS BEST-EFFORT AND FAILS TO "NOT READ", NOT TO EMPTY. A store
// that is not wired on this install is `unavailable`, one that threw is
// `failed`, and the checks that needed it are SKIPPED in the answer. An empty
// array in its place would make every gap it could have found silently
// disappear, and the report would claim coverage it never checked.
//
// BOUNDED. Every read has a cap; a read that comes back AT its cap is marked
// `capped`, and the checks built on it say PARTIAL. The per-device credential
// resolution is the one loop here (the resolver only answers one device at a
// time — the setup checklist makes the same walk) and it is capped too.
//
// Cost, for the record: one query per source (thirteen, run concurrently),
// plus one resolver call per enabled switch without its own community, up to
// MAX_CREDENTIAL_LOOKUPS. Nothing here scales with traffic volume: flows are
// read as MAX(ts) per agent, ARP as one row per /24, the forwarding table as
// three columns of learned MACs on up ports.

const { buildCoverageReport, DEFAULT_LIMIT } = require('./coverageGaps');
const { silentLogger } = require('../logger');

const PORT_MAC_LIMIT = 20000;
const DEVICE_MAC_LIMIT = 50000;
const NEIGHBOUR_LIMIT = 20000;
const ARP_SUBNET_LIMIT = 500;
const MAX_CREDENTIAL_LOOKUPS = 500;
// Neighbour-table and forwarding rows older than this describe a network that
// may no longer exist; ARP rows are refreshed less often, hence the week.
const FDB_WINDOW_MS = 24 * 3600 * 1000;
const NEIGHBOUR_WINDOW_MS = 7 * 24 * 3600 * 1000;
const ARP_WINDOW_MS = 7 * 24 * 3600 * 1000;

function createCoverageService({
  agentsRepo = null,
  locationsRepo = null,
  snmpDevicesRepo = null,
  snmpProfilesRepo = null,
  flowsRepo = null,
  deviceInterfacesRepo = null,
  fdbEntriesRepo = null,
  snmpNeighborsRepo = null,
  lldpNeighborsRepo = null,
  arpEntriesRepo = null,
  discoveredDevicesRepo = null,
  logger = silentLogger,
  now = () => new Date(),
} = {}) {
  const has = (repo, method) => !!repo && typeof repo[method] === 'function';

  // One source: `unavailable` when this install has no such store, `failed`
  // when it threw, otherwise its value and whether it hit `cap`.
  async function read(name, available, fn, cap = null) {
    if (!available) return [name, { status: 'unavailable' }];
    try {
      const value = await fn();
      const capped = cap != null && Array.isArray(value) && value.length >= cap;
      return [name, { status: 'ok', value, capped }];
    } catch (err) {
      logger.warn(`coverage: ${name} unavailable (${err && err.message})`);
      return [name, { status: 'failed' }];
    }
  }

  // deviceId -> { resolved, blocked } for every enabled switch that has a
  // polling agent and no community of its own. The others need no answer: a
  // device's own community always wins, and one with no poller is reported
  // as such rather than as a credential problem.
  async function resolveCredentials(devices) {
    const out = new Map();
    const ask = devices.filter((d) => d && d.enabled !== false && d.agentId != null && !d.hasCommunity);
    for (const d of ask.slice(0, MAX_CREDENTIAL_LOOKUPS)) {
      // eslint-disable-next-line no-await-in-loop
      const chain = await snmpProfilesRepo.resolveForAgent({
        profileId: d.credentialProfileId, locationId: d.locationId, agentId: d.agentId,
      });
      out.set(Number(d.id), {
        resolved: !!(chain && chain.profileId),
        blocked: chain && chain.blocked != null ? Number(chain.blocked) : null,
      });
    }
    return { map: out, capped: ask.length > MAX_CREDENTIAL_LOOKUPS };
  }

  async function report({ limit = DEFAULT_LIMIT } = {}) {
    const at = now();
    const ago = (ms) => new Date(at.getTime() - ms);

    const first = Object.fromEntries(await Promise.all([
      read('agents', has(agentsRepo, 'findAll'), () => agentsRepo.findAll()),
      read('locations', has(locationsRepo, 'findAll'), () => locationsRepo.findAll()),
      read('snmpDevices', has(snmpDevicesRepo, 'list'), () => snmpDevicesRepo.list({})),
      read('flows', has(flowsRepo, 'lastFlowAtByAgent'), () => flowsRepo.lastFlowAtByAgent()),
      read('deviceMacs', has(deviceInterfacesRepo, 'listMacs'),
        () => deviceInterfacesRepo.listMacs({ limit: DEVICE_MAC_LIMIT }), DEVICE_MAC_LIMIT),
      read('portMacs', has(fdbEntriesRepo, 'listUpPortMacs'),
        () => fdbEntriesRepo.listUpPortMacs({ since: ago(FDB_WINDOW_MS), limit: PORT_MAC_LIMIT }), PORT_MAC_LIMIT),
      read('deviceNeighbours', has(snmpNeighborsRepo, 'listAll'),
        () => snmpNeighborsRepo.listAll({ limit: NEIGHBOUR_LIMIT }), NEIGHBOUR_LIMIT),
      read('agentNeighbours', has(lldpNeighborsRepo, 'listAll'),
        () => lldpNeighborsRepo.listAll({ since: ago(NEIGHBOUR_WINDOW_MS), limit: NEIGHBOUR_LIMIT }), NEIGHBOUR_LIMIT),
      read('arpSubnets', has(arpEntriesRepo, 'subnetSummary'),
        () => arpEntriesRepo.subnetSummary({ since: ago(ARP_WINDOW_MS), limit: ARP_SUBNET_LIMIT }), ARP_SUBNET_LIMIT),
      read('discovered', has(discoveredDevicesRepo, 'list'), async () => {
        const rows = await discoveredDevicesRepo.list({ status: 'discovered', limit });
        // The total, so a capped list still counts every candidate. A store
        // that cannot count leaves the total as what was listed.
        let total = Array.isArray(rows) ? rows.length : 0;
        if (typeof discoveredDevicesRepo.countByStatus === 'function') {
          const counts = await discoveredDevicesRepo.countByStatus();
          if (counts && Number.isInteger(Number(counts.discovered))) total = Math.max(total, Number(counts.discovered));
        }
        return { rows: Array.isArray(rows) ? rows : [], total };
      }),
    ]));

    // Second round: the two reads that need the first.
    const agents = first.agents.status === 'ok' && Array.isArray(first.agents.value) ? first.agents.value : [];
    const agentIpList = [];
    for (const a of agents) {
      const ips = a && a.capabilities && Array.isArray(a.capabilities.ips) ? a.capabilities.ips : [];
      for (const ip of ips) if (typeof ip === 'string' && ip) agentIpList.push(ip);
    }
    const devices = first.snmpDevices.status === 'ok' && Array.isArray(first.snmpDevices.value)
      ? first.snmpDevices.value : null;

    const second = Object.fromEntries(await Promise.all([
      read('agentMacs', has(arpEntriesRepo, 'macsForIps') && first.agents.status === 'ok',
        () => arpEntriesRepo.macsForIps(agentIpList)),
      (async () => {
        if (!devices || !has(snmpProfilesRepo, 'resolveForAgent')) {
          return ['credentials', { status: devices ? 'unavailable' : 'failed' }];
        }
        const [, res] = await read('credentials', true, () => resolveCredentials(devices));
        if (res.status !== 'ok') return ['credentials', res];
        return ['credentials', { status: 'ok', value: res.value.map, capped: res.value.capped }];
      })(),
    ]));

    return {
      generatedAt: at.toISOString(),
      ...buildCoverageReport({ sources: { ...first, ...second }, now: at, limit }),
    };
  }

  return { report };
}

module.exports = {
  createCoverageService,
  PORT_MAC_LIMIT,
  DEVICE_MAC_LIMIT,
  NEIGHBOUR_LIMIT,
  ARP_SUBNET_LIMIT,
  MAX_CREDENTIAL_LOOKUPS,
};
