'use strict';

// src/topology/deviceLocator.js — "where is X" and "A to B, switch by switch"
// over repositories, plus the inventory merge. The network is
// test-support/l2TopologyFixture.js; the repos are minimal in-memory ones with
// the real method shapes.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createDeviceLocator, buildInventory } = require('../src/topology/deviceLocator');
const { parseEndpoint } = require('../src/validation/l2PathValidation');
const { createArpEntriesRepository } = require('../src/repositories/arpEntriesRepository');
const F = require('../test-support/l2TopologyFixture');

const NOW = new Date('2026-09-24T12:00:00Z');
const make = (over = {}, extra = {}) => createDeviceLocator({ ...F.repos(over), now: () => NOW, ...extra });
const ep = (s) => parseEndpoint(s);

// ============================================================ locate
test('locate an IP: ARP -> MAC -> access port, with site, VLAN name, port state and vendor', async () => {
  const out = await make().where({ q: ep('10.1.10.5') });
  assert.equal(out.agentId, 7, 'the address is an agent\'s own');
  assert.equal(out.label, 'PC A');
  assert.equal(out.location.deviceName, 'sw-a');
  assert.equal(out.location.ifName, 'Gi0/5');
  assert.equal(out.location.vlan, 10);
  assert.equal(out.vlanName, 'office');
  assert.deepEqual(out.site, { id: 1, name: 'HQ' });
  assert.equal(out.location.sysLocation, 'Building 3, room 2.14, rack B', "the switch's own sysLocation");
  assert.equal(out.port.operStatus, 'up');
  assert.equal(out.port.speedMbps, 1000);
  assert.equal(out.port.alias, 'desk 12');
  assert.deepEqual(out.macs.map((m) => m.mac), [F.MAC.pcA]);
  // Provenance: who told us the MAC, and every switch that has it.
  assert.ok(out.reportedBy.some((r) => r.source === 'arp' && r.agentId === 8));
  assert.ok(out.reportedBy.some((r) => r.source === 'fdb' && r.deviceName === 'sw-core' && r.ifName === 'Gi0/1'));
  assert.ok(out.firstSeen && out.lastSeen);
});

test('locate a MAC: vendor from the OUI, the IP from ARP', async () => {
  const out = await make().where({ q: ep('b827.eb00.000d') });
  assert.equal(out.location.deviceName, 'sw-c');
  assert.equal(out.location.ifName, 'Gi0/3');
  assert.deepEqual(out.site, { id: 2, name: 'Annex' });
  assert.equal(out.macs[0].vendor, 'Raspberry Pi');
  assert.deepEqual(out.ips, ['10.1.10.7']);
});

test('locate a hostname: a discovery candidate by its short name, never by substring', async () => {
  const out = await make().where({ q: ep('printer-2f') });
  assert.equal(out.hostname, 'printer-2f');
  assert.equal(out.location.ifName, 'Gi0/8');
  assert.equal(out.location.vlan, 20);
  assert.ok(out.reportedBy.some((r) => r.source === 'discovery'));
  assert.equal(await make().where({ q: ep('printer-2') }), null, 'a prefix of a name is not the name');
});

test('locate a switch by name: the switch is its own location', async () => {
  const out = await make().where({ q: ep('sw-b') });
  assert.equal(out.deviceId, 3);
  assert.equal(out.location.self, true);
  assert.equal(out.location.ifName, null);
});

test('locate a switch by the name it calls itself (sysName), not only by its display name or address', async () => {
  // E2E: /api/search found "DUMSYS-90" (snmp_devices.sys_name) while
  // /api/devices/locate answered 404 for the same string.
  const devices = F.clone(F.devices).map((d) => (d.id === 4 ? { ...d, sysName: 'DUMSYS-90.corp.example' } : d));
  const out = await make({ devices }).where({ q: ep('DUMSYS-90') });
  assert.ok(out, 'the short sysName finds the switch');
  assert.equal(out.deviceId, 4);
  assert.equal(out.location.self, true);
  assert.equal((await make({ devices }).where({ q: ep('dumsys-90.corp.example') })).deviceId, 4, 'the full sysName too, case-insensitively');
  assert.equal(await make({ devices }).where({ q: ep('DUMSYS-9') }), null, 'a prefix of a sysName is not the name');

  // The inventory's free-text filter reads the same name, and the rack text.
  const inv = await createDeviceLocator({ ...F.repos({ devices }), now: () => NOW }).inventory({ limit: 50, q: 'dumsys-90' });
  assert.deepEqual(inv.items.map((i) => i.key), ['switch:4']);
  const rack = await createDeviceLocator({ ...F.repos(), now: () => NOW }).inventory({ limit: 50, q: 'rack b' });
  assert.deepEqual(rack.items.map((i) => i.key), ['switch:2']);
});

test('an address nobody has a MAC for says so; an unknown one is null (404 upstream)', async () => {
  const noArp = await make({ arp: [] }).where({ q: ep('10.1.10.5') });
  assert.equal(noArp.location, null);
  assert.ok(noArp.uncertainties.some((u) => u.code === 'noMac'));
  assert.equal(await make().where({ q: ep('10.99.99.99') }), null);
});

test('a MAC no switch has learned is notInFdb; one only on uplinks is uplinkOnly', async () => {
  const gone = await make({ fdb: F.clone(F.fdb).filter((r) => r.mac !== F.MAC.pcB) }).where({ q: ep(F.MAC.pcB) });
  assert.ok(gone.uncertainties.some((u) => u.code === 'notInFdb'));
  const up = await make({ fdb: F.clone(F.fdb).filter((r) => !(r.mac === F.MAC.pcB && r.ifName === 'Gi0/7')) }).where({ q: ep(F.MAC.pcB) });
  const u = up.uncertainties.find((x) => x.code === 'uplinkOnly');
  assert.ok(u);
  assert.ok(u.evidence.seenOn.some((s) => s.name === 'sw-core'));
});

test('one IP behind two MACs is flagged and the freshest port wins', async () => {
  const arp = [...F.clone(F.arp), { agentId: 9, ip: '10.1.10.6', mac: F.MAC.pcC, lastSeen: F.T(1) }];
  const out = await make({ arp }).where({ q: ep('10.1.10.6') });
  assert.ok(out.uncertainties.some((u) => u.code === 'ipMultipleMacs'));
  assert.ok(out.uncertainties.some((u) => u.code === 'ambiguousEndpoint'));
  assert.equal(out.alternatives.length, 1);
});

// ============================================================ path
test('path pc-a -> pc-b: one VLAN, three hops, ports decorated with state, speed, errors and utilisation', async () => {
  const out = await make().path({ from: ep('agent:7'), to: ep('10.1.10.6') });
  assert.equal(out.routed, false);
  assert.deepEqual(out.vlans, { from: 10, to: 10, shared: true });
  assert.equal(out.complete, true);
  assert.equal(out.segments.length, 1);
  const hops = out.segments[0].hops;
  assert.deepEqual(hops.map((h) => h.name), ['sw-a', 'sw-core', 'sw-b']);
  const up = hops[0].egress.port;
  assert.equal(up.ifName, 'Gi0/48');
  assert.equal(up.operStatus, 'up');
  assert.equal(up.speedMbps, 10000);
  assert.equal(up.counters.inDiscPps, 2);
  assert.equal(up.counters.inUtilPct, 41.5);
  assert.equal(hops[0].ingress.port.counters, null, 'no sample is null, never zero');
  assert.deepEqual(hops[1].vlans, [10]);
  assert.equal(hops[0].siteName, 'HQ');
  assert.equal(out.graph.links, 2);
  assert.equal(out.from.label, 'PC A');
});

test('path across VLANs with no router ARP: routed, the gateway unknown, the physical path flagged as such', async () => {
  const out = await make().path({ from: ep('10.1.10.5'), to: ep('10.1.20.9') });
  assert.equal(out.routed, true);
  assert.deepEqual(out.vlans, { from: 10, to: 20, shared: false });
  assert.ok(out.uncertainties.some((u) => u.code === 'differentVlans' && /traffic is routed; the L2 path ends at the gateway/.test(u.message)));
  assert.ok(out.uncertainties.some((u) => u.code === 'gatewayUnknown'));
  assert.equal(out.segments.length, 1);
  assert.equal(out.segments[0].physicalOnly, true);
});

test('path across VLANs with a router ARP table: A->gateway and gateway->B segments', async () => {
  // sw-core routes: its ARP table holds both addresses.
  const deviceArpRepo = {
    findByIp: async ({ ip }) => (['10.1.10.5', '10.1.20.9'].includes(ip) ? [{ deviceId: 1, ip, mac: 'x', lastSeen: F.T(1) }] : []),
  };
  const out = await make({}, { deviceArpRepo }).path({ from: ep('10.1.10.5'), to: ep('10.1.20.9') });
  assert.equal(out.gateway.deviceId, 1);
  assert.equal(out.segments.length, 2);
  assert.deepEqual(out.segments.map((s) => [s.from, s.to, s.hops.map((h) => h.name)]), [
    ['from', 'gateway', ['sw-a', 'sw-core']],
    ['gateway', 'to', ['sw-core', 'sw-b']],
  ]);
  assert.ok(!out.uncertainties.some((u) => u.code === 'gatewayUnknown'));
});

test('a gateway the caller names splits the path there', async () => {
  const out = await make().path({ from: ep('10.1.10.5'), to: ep('10.1.20.9'), gateway: ep('sw-core') });
  assert.equal(out.segments.length, 2);
  assert.equal(out.gateway.label, 'sw-core');
});

test('the router ARP repo is used for IP -> MAC when agents have not seen the address', async () => {
  const deviceArpRepo = {
    findByIp: async ({ ip }) => (ip === '10.1.10.50' ? [{ deviceId: 1, ip, mac: F.MAC.pcB, lastSeen: F.T(1) }] : []),
  };
  const out = await make({}, { deviceArpRepo }).where({ q: ep('10.1.10.50') });
  assert.equal(out.location.ifName, 'Gi0/7');
  assert.ok(out.macs[0].sources.includes('routerArp'));
});

test('path to an endpoint behind a missing LLDP link names the gap', async () => {
  const out = await make().path({ from: ep('10.1.10.5'), to: ep('10.1.10.7') });
  assert.equal(out.complete, false);
  assert.ok(out.uncertainties.some((u) => u.code === 'missingLink'));
  assert.ok(out.segments[0].hops.some((h) => h.type === 'gap'));
});

test('an endpoint nothing knows is notFound, naming which', async () => {
  const out = await make().path({ from: ep('10.1.10.5'), to: ep('nobody') });
  assert.deepEqual(out.notFound, ['to']);
});

test('no switch inventory at all is unavailable, not "not found"', async () => {
  const out = await createDeviceLocator({ agentsRepo: F.repos().agentsRepo }).path({ from: ep('10.1.10.5'), to: ep('10.1.10.6') });
  assert.deepEqual(out, { unavailable: true });
});

test('a decoration that fails is named in sources and the path still comes back', async () => {
  const r = F.repos();
  r.counterSamplesRepo = { latestForDevice: async () => { throw new Error('tsdb down'); } };
  const out = await createDeviceLocator({ ...r, now: () => NOW }).path({ from: ep('agent:7'), to: ep('10.1.10.6') });
  assert.equal(out.sources.counters, 'failed');
  assert.equal(out.segments[0].hops.length, 3);
});

test('an essential read that fails throws (500 upstream)', async () => {
  const r = F.repos();
  r.fdbEntriesRepo.findByMac = async () => { throw new Error('db down'); };
  await assert.rejects(createDeviceLocator(r).path({ from: ep('10.1.10.5'), to: ep('10.1.10.6') }), /db down/);
});

// ============================================================ inventory
test('the inventory merges agents, switches, discovery and ARP-only hosts into one row per thing', () => {
  const inv = buildInventory({
    agents: F.clone(F.agents), devices: F.clone(F.devices), sites: F.clone(F.sites),
    discovered: [
      { id: 3, ip: '10.1.20.9', hostname: 'printer-2f', status: 'discovered', foundByAgentId: 7, lastSeen: F.T(30) },
      { id: 4, ip: '10.1.10.5', hostname: 'pc-a.corp', status: 'discovered', lastSeen: F.T(30) },
      { id: 6, ip: '10.1.10.8', hostname: null, status: 'ignored', lastSeen: F.T(30) },
    ],
    arp: F.clone(F.arp),
    portMacs: F.fdb.filter((r) => r.ifName && r.status === 'learned').map((r) => ({ deviceId: r.deviceId, ifName: r.ifName, mac: r.mac, portMacCount: r.portMacCount })),
    neighbours: F.clone(F.neighbours), deviceMacs: F.clone(F.deviceMacs),
  });
  assert.deepEqual(inv.counts, { agent: 1, switch: 4, discovered: 1, host: 2, located: 8 });
  const agent = inv.items.find((i) => i.key === 'agent:7');
  assert.deepEqual(agent.sources.sort(), ['agent', 'arp', 'discovery'], 'discovery and ARP folded into the agent');
  assert.equal(agent.location.deviceName, 'sw-a');
  assert.equal(agent.location.ifName, 'Gi0/5');
  assert.deepEqual(agent.site, { id: 1, name: 'HQ' });
  const printer = inv.items.find((i) => i.kind === 'discovered');
  assert.equal(printer.name, 'printer-2f');
  assert.equal(printer.location.ifName, 'Gi0/8');
  const pcC = inv.items.find((i) => i.key === `host:${F.MAC.pcC}`);
  assert.equal(pcC.location.deviceName, 'sw-c');
  assert.deepEqual(pcC.site, { id: 2, name: 'Annex' }, "a located host takes its switch's site");
  assert.equal(pcC.macs[0].vendor, 'Raspberry Pi');
  assert.ok(!inv.items.some((i) => i.ips.includes('10.1.10.8')), 'an ignored candidate stays ignored');
  // Ordered: agents, switches, discovered, hosts.
  assert.deepEqual([...new Set(inv.items.map((i) => i.kind))], ['agent', 'switch', 'discovered', 'host']);
});

test('inventory pages, filters by kind and text, and reports caps and failed sources', async () => {
  const r = F.repos();
  const loc = createDeviceLocator({ ...r, now: () => NOW });
  const all = await loc.inventory({ limit: 2, offset: 0 });
  assert.equal(all.items.length, 2);
  assert.ok(all.total >= 8);
  const page2 = await loc.inventory({ limit: 2, offset: 2 });
  assert.notDeepEqual(page2.items.map((i) => i.key), all.items.map((i) => i.key));
  const hosts = await loc.inventory({ limit: 50, kind: 'host' });
  assert.ok(hosts.items.every((i) => i.kind === 'host'));
  const q = await loc.inventory({ limit: 50, q: 'b8:27:eb' });
  assert.deepEqual(q.items.map((i) => i.key), [`host:${F.MAC.pcC}`]);

  r.arpEntriesRepo.listRecent = async () => { throw new Error('boom'); };
  const partial = await createDeviceLocator({ ...r, now: () => NOW }).inventory({ limit: 50 });
  assert.equal(partial.sources.arp, 'failed');
  assert.equal(partial.partial, true);
});

// ============================================================ the repo read
test('arpEntriesRepository.listRecent is windowed, newest first and capped', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return [[{ id: 1, agent_id: 3, ip: '10.0.0.5', mac: 'aa:bb:cc:dd:ee:ff', interface: null, source: 'capabilities', first_seen: NOW, last_seen: NOW, mac_changed_at: null }]];
    },
  };
  const repo = createArpEntriesRepository({ pool });
  const rows = await repo.listRecent({ since: NOW, limit: 100 });
  assert.match(calls[0].sql, /WHERE last_seen >= \?\s+ORDER BY last_seen DESC, id DESC LIMIT \?/);
  assert.deepEqual(calls[0].params, [NOW, 100]);
  assert.equal(rows[0].agentId, 3);
  await repo.listRecent({ since: NOW, limit: 10 ** 9 });
  assert.equal(calls[1].params[1], 5000, 'an out-of-range limit falls back to the default cap');
});
