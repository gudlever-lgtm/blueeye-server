'use strict';

// A small, realistic switched network for the L2 path / device-locator specs
// (test/l2Path.test.js, test/deviceLocator.test.js, test/l2PathApi.test.js).
//
//                 sw-core (1)
//            Gi0/1 /      \ Gi0/2
//        Gi0/48  /          \ Gi0/48
//           sw-a (2)        sw-b (3)             sw-c (4)
//           Gi0/5 |     Gi0/7 |  Gi0/8 |  Gi0/10 \.. unmanaged ..\ Gi0/47
//             pc-a        pc-b    printer                         Gi0/3 | pc-c
//           (vlan 10)  (vlan 10) (vlan 20)                          (vlan 10)
//
// * sw-core <-> sw-a is reported by BOTH ends: sw-core over LLDP (chassis id =
//   a port MAC of sw-a), sw-a over CDP (device id = the name "sw-core").
// * sw-core <-> sw-b is reported by sw-core only (remote port "Gi0/48").
// * sw-b <-> sw-c has NO managed link: an unmanaged switch sits between sw-b
//   Gi0/10 and sw-c Gi0/47, and sw-b sees an LLDP neighbour it cannot place
//   ("desk-switch") on Gi0/10.
// * Uplinks carry many MACs; access ports carry one.

const MAC = {
  pcA: 'aa:00:00:00:00:0a',
  pcB: 'aa:00:00:00:00:0b',
  printer: 'aa:00:00:00:00:0c',
  pcC: 'b8:27:eb:00:00:0d', // Raspberry Pi OUI
  router: 'cc:00:00:00:00:01',
};

const T = (min) => new Date(Date.UTC(2026, 8, 24, 12, 0, 0) - min * 60000).toISOString();

const devices = [
  { id: 1, host: '10.0.0.1', displayName: 'sw-core', locationId: 1, enabled: true, lastOkAt: T(1) },
  { id: 2, host: '10.0.0.2', displayName: 'sw-a', locationId: 1, enabled: true, lastOkAt: T(1), sysLocation: 'Building 3, room 2.14, rack B' },
  { id: 3, host: '10.0.0.3', displayName: 'sw-b', locationId: 1, enabled: true, lastOkAt: T(1) },
  { id: 4, host: '10.0.0.4', displayName: 'sw-c', locationId: 2, enabled: true, lastOkAt: T(1) },
];

const deviceMacs = [
  { deviceId: 1, physAddress: '00:11:11:00:00:01' },
  { deviceId: 2, physAddress: '00:22:22:00:00:30' },
  { deviceId: 3, physAddress: '00:33:33:00:00:30' },
  { deviceId: 4, physAddress: '00:44:44:00:00:30' },
];

const neighbours = [
  // sw-core sees sw-a by MAC and sw-b by MAC (LLDP).
  { id: 1, deviceId: 1, localIfName: 'Gi0/1', remoteChassisId: '00:22:22:00:00:30', remotePortId: 'Gi0/48', remoteSysName: 'sw-a.corp' },
  { id: 2, deviceId: 1, localIfName: 'Gi0/2', remoteChassisId: '0033.3300.0030', remotePortId: 'Gi0/48', remoteSysName: null },
  // sw-a sees sw-core by NAME over CDP.
  { id: 3, deviceId: 2, localIfName: 'Gi0/48', remoteChassisId: 'sw-core', remotePortId: 'GigabitEthernet0/1', remoteSysName: 'sw-core', protocol: 'cdp' },
  // sw-b sees an unmanaged desk switch on Gi0/10.
  { id: 4, deviceId: 3, localIfName: 'Gi0/10', remoteChassisId: 'de:5k:00', remotePortId: '1', remoteSysName: 'desk-switch' },
];

const fdb = [
  // pc-a: access on sw-a Gi0/5, learned on every uplink toward the others.
  { deviceId: 2, mac: MAC.pcA, vlan: 10, ifName: 'Gi0/5', portMacCount: 1, status: 'learned', firstSeen: T(600), lastSeen: T(1) },
  { deviceId: 1, mac: MAC.pcA, vlan: 10, ifName: 'Gi0/1', portMacCount: 30, status: 'learned', lastSeen: T(1) },
  { deviceId: 3, mac: MAC.pcA, vlan: 10, ifName: 'Gi0/48', portMacCount: 40, status: 'learned', lastSeen: T(1) },
  { deviceId: 4, mac: MAC.pcA, vlan: 10, ifName: 'Gi0/47', portMacCount: 50, status: 'learned', lastSeen: T(2) },
  // pc-b: access on sw-b Gi0/7.
  { deviceId: 3, mac: MAC.pcB, vlan: 10, ifName: 'Gi0/7', portMacCount: 1, status: 'learned', firstSeen: T(900), lastSeen: T(1) },
  { deviceId: 1, mac: MAC.pcB, vlan: 10, ifName: 'Gi0/2', portMacCount: 30, status: 'learned', lastSeen: T(1) },
  { deviceId: 2, mac: MAC.pcB, vlan: 10, ifName: 'Gi0/48', portMacCount: 40, status: 'learned', lastSeen: T(1) },
  // printer: VLAN 20 on sw-b Gi0/8.
  { deviceId: 3, mac: MAC.printer, vlan: 20, ifName: 'Gi0/8', portMacCount: 1, status: 'learned', lastSeen: T(3) },
  { deviceId: 1, mac: MAC.printer, vlan: 20, ifName: 'Gi0/2', portMacCount: 30, status: 'learned', lastSeen: T(3) },
  // pc-c: behind the unmanaged switch, access on sw-c Gi0/3.
  { deviceId: 4, mac: MAC.pcC, vlan: 10, ifName: 'Gi0/3', portMacCount: 1, status: 'learned', lastSeen: T(1) },
  { deviceId: 3, mac: MAC.pcC, vlan: 10, ifName: 'Gi0/10', portMacCount: 12, status: 'learned', lastSeen: T(1) },
  { deviceId: 1, mac: MAC.pcC, vlan: 10, ifName: 'Gi0/2', portMacCount: 30, status: 'learned', lastSeen: T(1) },
  // The router is the core's own MAC.
  { deviceId: 1, mac: MAC.router, vlan: 1, ifName: null, portMacCount: 0, status: 'self', lastSeen: T(1) },
];

const interfaces = {
  1: [
    { id: 101, deviceId: 1, ifName: 'Gi0/1', ifAlias: 'to sw-a', operStatus: 'up', adminStatus: 'up', speedMbps: 10000, lastSeen: T(1) },
    { id: 102, deviceId: 1, ifName: 'Gi0/2', ifAlias: 'to sw-b', operStatus: 'up', adminStatus: 'up', speedMbps: 10000, lastSeen: T(1) },
  ],
  2: [
    { id: 205, deviceId: 2, ifName: 'Gi0/5', ifAlias: 'desk 12', operStatus: 'up', adminStatus: 'up', speedMbps: 1000, lastSeen: T(1) },
    { id: 248, deviceId: 2, ifName: 'Gi0/48', ifAlias: 'uplink', operStatus: 'up', adminStatus: 'up', speedMbps: 10000, lastSeen: T(1) },
  ],
  3: [
    { id: 307, deviceId: 3, ifName: 'Gi0/7', ifAlias: null, operStatus: 'up', adminStatus: 'up', speedMbps: 100, lastSeen: T(1) },
    { id: 308, deviceId: 3, ifName: 'Gi0/8', ifAlias: 'printer', operStatus: 'up', adminStatus: 'up', speedMbps: 100, lastSeen: T(1) },
    { id: 310, deviceId: 3, ifName: 'Gi0/10', ifAlias: 'desk switch', operStatus: 'up', adminStatus: 'up', speedMbps: 1000, lastSeen: T(1) },
    { id: 348, deviceId: 3, ifName: 'Gi0/48', ifAlias: 'uplink', operStatus: 'up', adminStatus: 'up', speedMbps: 10000, lastSeen: T(1) },
  ],
  4: [
    { id: 403, deviceId: 4, ifName: 'Gi0/3', operStatus: 'up', adminStatus: 'up', speedMbps: 1000, lastSeen: T(1) },
    { id: 447, deviceId: 4, ifName: 'Gi0/47', operStatus: 'up', adminStatus: 'up', speedMbps: 1000, lastSeen: T(1) },
  ],
};

// Newest counter sample per interface id.
const counters = {
  2: new Map([[248, { ts: T(1), inErrPps: 0, outErrPps: 0.5, inDiscPps: 2, outDiscPps: 0, inUtilPct: 41.5, outUtilPct: 12 }]]),
};

const agents = [
  { id: 7, hostname: 'pc-a', display_name: 'PC A', location_id: 1, status: 'online', last_seen: T(1), capabilities: { ips: ['10.1.10.5'] } },
];
const sites = [{ id: 1, name: 'HQ' }, { id: 2, name: 'Annex' }];

// Agent 7 (pc-a) cannot see its own address; agent 8 (another host) can.
const arp = [
  { agentId: 8, ip: '10.1.10.5', mac: MAC.pcA, lastSeen: T(2), firstSeen: T(700) },
  { agentId: 7, ip: '10.1.10.6', mac: MAC.pcB, lastSeen: T(2), firstSeen: T(800) },
  { agentId: 7, ip: '10.1.20.9', mac: MAC.printer, lastSeen: T(4), firstSeen: T(800) },
  { agentId: 7, ip: '10.1.10.7', mac: MAC.pcC, lastSeen: T(2), firstSeen: T(800) },
];

// Deep enough copies that a spec cannot leak a mutation into the next.
const clone = (v) => JSON.parse(JSON.stringify(v));

// Minimal repositories over the fixture — the method shapes the real ones have.
function repos(over = {}) {
  const f = { devices: clone(devices), neighbours: clone(neighbours), fdb: clone(fdb), arp: clone(arp), agents: clone(agents), ...over };
  return {
    snmpDevicesRepo: { list: async () => f.devices },
    snmpNeighborsRepo: { listAll: async ({ limit }) => f.neighbours.slice(0, limit) },
    deviceInterfacesRepo: {
      listMacs: async () => clone(deviceMacs),
      listForDevice: async (id) => clone(interfaces[id] || []),
    },
    fdbEntriesRepo: {
      findByMac: async (mac, { limit }) => f.fdb.filter((r) => r.mac === mac).slice(0, limit),
      listVlans: async (id) => (id === 2 ? [{ vlan: 10, name: 'office' }] : []),
      listUpPortMacs: async () => f.fdb.filter((r) => r.ifName && r.status === 'learned')
        .map((r) => ({ deviceId: r.deviceId, ifName: r.ifName, mac: r.mac, portMacCount: r.portMacCount })),
    },
    counterSamplesRepo: { latestForDevice: async (id) => counters[id] || new Map() },
    arpEntriesRepo: {
      findByIp: async ({ ip, limit }) => f.arp.filter((r) => r.ip === ip).slice(0, limit),
      findByMac: async ({ mac, limit }) => f.arp.filter((r) => r.mac === mac).slice(0, limit),
      listRecent: async ({ limit }) => f.arp.slice(0, limit),
    },
    agentsRepo: { findAll: async () => f.agents, findById: async (id) => f.agents.find((a) => a.id === id) || null },
    locationsRepo: { findAll: async () => clone(sites) },
    discoveredDevicesRepo: {
      findByIp: async (ip) => (ip === '10.1.20.9' ? { id: 3, ip, hostname: 'printer-2f', foundByAgentId: 7, lastSeen: T(30), firstSeen: T(3000) } : null),
      search: async ({ q }) => (String(q).startsWith('printer') ? [{ id: 3, ip: '10.1.20.9', hostname: 'printer-2f', lastSeen: T(30) }] : []),
      list: async () => [
        { id: 3, ip: '10.1.20.9', hostname: 'printer-2f', status: 'discovered', foundByAgentId: 7, lastSeen: T(30) },
        { id: 4, ip: '10.1.10.5', hostname: 'pc-a.corp', status: 'discovered', lastSeen: T(30) },
        { id: 5, ip: '10.9.9.9', hostname: null, status: 'discovered', lastSeen: T(30) },
      ],
    },
    lldpNeighborsRepo: { listByAgent: async () => [] },
  };
}

module.exports = { MAC, T, devices, deviceMacs, neighbours, fdb, interfaces, counters, agents, sites, arp, repos, clone };
