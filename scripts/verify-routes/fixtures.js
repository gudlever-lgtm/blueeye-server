'use strict';

// Fixtures for scripts/verify-routes-against-mysql.js: the stand-in licence
// server, the scratch working directory the booted server runs in, and the
// agent payloads that drive every ingest path.
//
// The payload shapes follow the agent's wire contract (blueeye-agent
// PROTOCOL.md) and the server's own validators, so what reaches the
// repositories is what a real agent sends — not the minimum a validator lets
// through.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const { canonicalize } = require(path.join(ROOT, 'src', 'lib', 'canonicalize'));

// ------------------------------------------------------------------ licence
// A local blueeye-licens stand-in. The server verifies proofs against
// LICENSE_PUBLIC_KEY (honoured in production only with TRUST_ANCHOR_OVERRIDE_ACK,
// see src/license/trustAnchorGuard.js), so a key pair made here and a server
// that signs `valid:true` for every feature is the one way to run the REAL
// licence manager with everything unlocked — no licence gate short-circuits a
// route before it reaches its repository.
function startFakeLicens({ features, plan = 'professional', maxAgents = 100 }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let validations = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.startsWith('/validate')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      validations += 1;
      const payload = {
        valid: true,
        serverId: body.serverId,
        nonce: body.nonce,
        licenseKey: body.licenseKey,
        customer: 'verify-routes',
        plan,
        features,
        limits: { max_agents: maxAgents },
        expiry: new Date(Date.now() + 365 * 86400000).toISOString(),
        proof_issued_at: new Date().toISOString(),
      };
      const signature = crypto.sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey).toString('base64');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ payload, signature }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        publicKeyB64: Buffer.from(publicPem, 'utf8').toString('base64'),
        validations: () => validations,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------- work dir
// The server writes caches next to its cwd (licence cache, baselines, signed
// releases, the pkg binary cache). It runs from a scratch directory so a
// verification run never touches the checkout, and every path it would write is
// pointed into that directory explicitly.
function prepareWorkDir() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-verify-routes-'));
  for (const d of ['artifacts', 'agent-releases', 'agent-binaries', 'service-test-artifacts']) {
    fs.mkdirSync(path.join(work, d), { recursive: true });
  }

  // The agent source the server packages. The sibling checkout when there is
  // one (the standard layout); otherwise a stub with a package.json, which is
  // all the source store and the binary cache need to know a version.
  const candidates = [process.env.AGENT_SOURCE_DIR, path.join(ROOT, '..', 'blueeye-agent')].filter(Boolean);
  let agentDir = candidates.find((d) => fs.existsSync(path.join(d, 'package.json')));
  if (!agentDir) {
    agentDir = path.join(work, 'agent-src');
    fs.mkdirSync(path.join(agentDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'package.json'), JSON.stringify({ name: 'blueeye-agent', version: '0.0.1-verify', main: 'src/index.js' }));
    fs.writeFileSync(path.join(agentDir, 'src', 'index.js'), "'use strict';\n");
    fs.writeFileSync(path.join(agentDir, 'uninstall.sh'), '#!/bin/sh\nexit 0\n');
  }
  let agentVersion = '0.0.1-verify';
  try { agentVersion = JSON.parse(fs.readFileSync(path.join(agentDir, 'package.json'), 'utf8')).version || agentVersion; } catch { /* stub */ }

  // Pre-seed the pkg binary cache with the agent's version, so the store loads
  // from cache instead of spending minutes cross-compiling (and downloading
  // Node base binaries) during a verification run.
  const binDir = path.join(work, 'agent-binaries');
  for (const arch of ['linux-x64', 'linux-arm64']) {
    fs.writeFileSync(path.join(binDir, `blueeye-agent-${arch}`), `#!/bin/sh\necho verify-routes stub ${arch}\n`);
  }
  fs.writeFileSync(path.join(binDir, '.agent-version'), agentVersion);

  // A legacy per-platform binary (GET /enroll/agent/:platform) and a baseline
  // screenshot for Service Assurance's image route, so both serve a real file.
  fs.writeFileSync(path.join(work, 'artifacts', 'blueeye-agent-linux-amd64'), '#!/bin/sh\necho verify-routes legacy stub\n');
  fs.mkdirSync(path.join(work, 'service-test-artifacts', 'baselines'), { recursive: true });
  fs.writeFileSync(path.join(work, 'service-test-artifacts', 'baselines', 'verify.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

  // A tiny offline GeoIP table (the provider's CSV shape), so flow enrichment
  // and the geo views have something real to read.
  fs.writeFileSync(path.join(work, 'geoip.csv'), [
    '# lo,hi,country,asn,asn name',
    '185.15.56.0,185.15.59.255,NL,14907,Wikimedia Foundation',
    '193.0.0.0,193.0.23.255,NL,3333,RIPE NCC',
    '80.62.0.0,80.63.255.255,DK,3292,TDC',
  ].join('\n'));

  return { work, agentDir, agentVersion };
}

// ------------------------------------------------------------ agent payloads
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

function procTraffic({ ethStatus = 'up', errors = 0 } = {}) {
  const iface = (name, oper, extra = {}) => ({
    iface: name,
    rxBytes: 1250000, txBytes: 830000, rxPackets: 1100, txPackets: 900,
    rxBytesPerSec: 1250000, txBytesPerSec: 830000,
    rxErrors: errors, txErrors: 0, rxDrop: 0, txDrop: 0,
    operStatus: oper, speedMbps: oper === 'up' ? 1000 : null,
    duplex: oper === 'up' ? 'full' : null,
    rxFrameErrors: errors, rxFifoErrors: 0, txCollisions: 0, txCarrierErrors: 0,
    ...extra,
  });
  const interfaces = [iface('eth0', ethStatus), iface('eth1', 'up', { duplex: 'half', txCollisions: 12 })];
  const totals = interfaces.reduce((t, i) => {
    for (const k of ['rxBytes', 'txBytes', 'rxPackets', 'txPackets', 'rxErrors', 'txErrors', 'rxDrop', 'txDrop', 'rxBytesPerSec', 'txBytesPerSec']) t[k] = (t[k] || 0) + i[k];
    return t;
  }, {});
  return { intervalMs: 1000, elapsedSec: 1.002, interfaces, totals };
}

const systemMetrics = () => ({
  cpuPercent: 23.5, cpuCount: 8, loadavg: [0.4, 0.3, 0.2],
  memTotalBytes: 16e9, memUsedBytes: 7e9, memFreeBytes: 9e9, memUsedPercent: 43.7, uptimeSec: 86400,
});

function resultEnvelope(traffic, { name = 'auto-report', msAgo = 0 } = {}) {
  return {
    name, commandId: null, ok: true,
    startedAt: iso(msAgo + 1000), finishedAt: iso(msAgo),
    traffic, system: systemMetrics(),
  };
}

function sflowTraffic() {
  const flows = [
    { srcIp: '10.20.0.84', dstIp: '185.15.58.224', proto: 'tcp', srcPort: 51000, dstPort: 443, bytes: 912000, packets: 700, flows: 3 },
    { srcIp: '10.20.0.84', dstIp: '10.20.0.10', proto: 'tcp', srcPort: 51002, dstPort: 445, bytes: 402000, packets: 320, flows: 2 },
    { srcIp: '10.20.0.85', dstIp: '193.0.6.139', proto: 'udp', srcPort: 53000, dstPort: 53, bytes: 12000, packets: 40, flows: 8 },
    { srcIp: '10.20.0.86', dstIp: '10.20.0.12', proto: 'tcp', srcPort: 50100, dstPort: 502, bytes: 64000, packets: 400, flows: 1 },
    { srcIp: '10.20.0.84', dstIp: '80.62.10.1', proto: 'tcp', srcPort: 51010, dstPort: 22, bytes: 30000, packets: 90, flows: 1 },
  ];
  const sum = (k) => flows.reduce((s, f) => s + f[k], 0);
  return {
    source: 'sflow', datagrams: 120, droppedDatagrams: 0, sampled: true,
    totals: { bytes: sum('bytes'), packets: sum('packets'), flows: sum('flows') },
    byPort: [{ port: 443, bytes: 912000, packets: 700, flows: 3 }, { port: 445, bytes: 402000, packets: 320, flows: 2 }],
    byProtocol: [{ protocol: 'tcp', bytes: 1408000, packets: 1510, flows: 7 }, { protocol: 'udp', bytes: 12000, packets: 40, flows: 8 }],
    topTalkers: flows.map((f) => ({ pair: `${f.srcIp}->${f.dstIp}`, bytes: f.bytes, packets: f.packets, flows: f.flows })),
    flows,
  };
}

// One result per probe type, plus a short failing history for a ping target so
// the outage/finding derivation has something to derive from.
function probeResults() {
  const hops = [
    { hop: 1, ip: '10.20.0.1', ips: ['10.20.0.1'], sent: 3, recv: 3, lossPct: 0, rttMs: 0.6, minMs: 0.5, maxMs: 0.8, jitterMs: 0.1 },
    { hop: 2, ip: '80.62.10.1', ips: ['80.62.10.1', '80.62.10.2'], sent: 3, recv: 3, lossPct: 0, rttMs: 4.2, minMs: 3.9, maxMs: 4.6, jitterMs: 0.3 },
    { hop: 3, ip: null, ips: [], sent: 3, recv: 0, lossPct: 100, rttMs: null, minMs: null, maxMs: null, jitterMs: null },
    { hop: 4, ip: '185.15.58.224', ips: ['185.15.58.224'], sent: 3, recv: 3, lossPct: 0, rttMs: 18.1, minMs: 17.5, maxMs: 19.0, jitterMs: 0.5 },
  ];
  const out = [];
  // Failing history for the gateway: 100 % loss, a minute apart.
  for (let i = 6; i >= 1; i -= 1) {
    out.push({ ts: iso(i * 60000), type: 'ping', target: '10.20.0.1', ok: false, attempts: 3, success: 0, rttMs: null, lossPct: 100 });
  }
  out.push(
    { ts: iso(), type: 'ping', target: '1.1.1.1', ok: true, attempts: 4, success: 4, rttMs: 12.1, minMs: 11.2, maxMs: 13.4, jitterMs: 0.6, lossPct: 0 },
    { ts: iso(), type: 'tcp', target: '10.20.0.10:445', ok: false, attempts: 3, success: 0, lossPct: 100, failure: 'refused', errorCode: 'ECONNREFUSED' },
    { ts: iso(), type: 'tcp', target: '185.15.58.224:443', ok: true, attempts: 3, success: 3, rttMs: 18.4, lossPct: 0, failure: null, errorCode: null },
    { ts: iso(), type: 'dns', target: 'intranet.kunde.dk', ok: false, attempts: 3, success: 0, lossPct: 100, errorCode: 'ENOTFOUND', resolver: '10.20.0.53' },
    { ts: iso(), type: 'dns', target: 'wikipedia.org', ok: true, attempts: 3, success: 3, rttMs: 3.3, lossPct: 0, detail: '185.15.58.224', errorCode: null, resolver: '10.20.0.53' },
    { ts: iso(), type: 'rdns', target: '185.15.58.224', ok: true, rttMs: 2.1, ptrNames: ['text-lb.esams.wikimedia.org'], forwardConfirmed: true },
    { ts: iso(), type: 'traceroute', target: '185.15.58.224', ok: true, rttMs: 18.1, hops, hopCount: 4, queries: 3 },
    { ts: iso(), type: 'tcptraceroute', target: '185.15.58.224:443', ok: true, rttMs: 18.3, hops, hopCount: 4, queries: 3, port: 443 },
    { ts: iso(), type: 'http', target: 'https://portal.kunde.dk/', ok: true, rttMs: 142, status: 200, certExpiryDays: 2, detail: 'CN=portal.kunde.dk' },
    { ts: iso(), type: 'curl', target: 'https://portal.kunde.dk/api/health', ok: false, rttMs: 88, status: 503, bytes: 120, contentType: 'application/json', detail: 'expectStatus 200 != 503' },
    { ts: iso(), type: 'pageload', target: 'https://portal.kunde.dk/', ok: true, rttMs: 820, status: 200, bytes: 540000, elements: [
      { url: 'https://portal.kunde.dk/app.js', kind: 'script', status: 200, bytes: 220000, ms: 120 },
      { url: 'https://portal.kunde.dk/logo.png', kind: 'image', status: 404, bytes: 0, ms: 30 },
    ], detail: '2 elements' },
    { ts: iso(), type: 'transaction', target: 'login-flow', ok: true, rttMs: 410, status: 200, bytes: 9000, elements: [
      { url: 'https://portal.kunde.dk/login', kind: 'step 1 POST', status: 200, bytes: 4000, ms: 210 },
    ], detail: '1 step' },
    { ts: iso(), type: 'path_mtu', target: '185.15.58.224', ok: true, pathMtu: 1480, mtuDropAtHop: 2, blackholeDetected: false, icmpFragNeededSeen: true, mssObserved: 1440, mssSupported: true, ipVersion: 4, durationMs: 900,
      hops: [{ hop: 1, ip: '10.20.0.1', maxMtu: 1500, status: 'ok' }, { hop: 2, ip: '80.62.10.1', maxMtu: 1480, status: 'fragmentation_needed' }] },
    { ts: iso(), type: 'tls', target: 'portal.kunde.dk:443', ok: true, rttMs: 35, protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', authorized: true, subject: 'CN=portal.kunde.dk', issuer: "CN=R11,O=Let's Encrypt", validFrom: iso(80 * 86400000), validTo: iso(-2 * 86400000), expiryDays: 2, expired: false, notYetValid: false, selfSigned: false, hostnameMatches: true, chainLength: 3, fingerprint: 'AA:BB:CC', serialNumber: '0123', altNames: ['portal.kunde.dk'] },
    { ts: iso(), type: 'dhcp', target: 'eth0', ok: true, rttMs: 14, iface: 'eth0', timeoutMs: 3000, serverCount: 2, detail: '2 servers answered',
      offers: [
        { serverId: '10.20.0.1', offeredIp: '10.20.0.150', leaseSec: 86400, router: '10.20.0.1', dns: ['10.20.0.53'], subnetMask: '255.255.255.0', relay: null },
        { serverId: '10.20.0.99', offeredIp: '10.20.0.201', leaseSec: 3600, router: '10.20.0.99', dns: ['8.8.8.8'], subnetMask: '255.255.255.0', relay: null },
      ] },
    { ts: iso(), type: 'traceroute', target: '10.99.0.1', ok: false, error: 'traceroute not installed' },
  );
  return { results: out };
}

// Capabilities report. `round` 2 changes the LLDP neighbour set, which is what
// makes the topology-change diff write a row.
function capabilities({ round = 1 } = {}) {
  const lldp = round === 1
    ? [
      { localPort: 'eth0', remoteChassisId: '00:1b:44:11:3a:b7', remotePort: 'Gi1/0/24', linkState: 'up' },
      { localPort: 'eth1', remoteChassisId: '00:1b:44:11:3a:c8', remotePort: 'Gi1/0/2', linkState: 'up' },
    ]
    : [
      { localPort: 'eth0', remoteChassisId: '00:1b:44:11:3a:b7', remotePort: 'Gi1/0/23', linkState: 'up' },
    ];
  return {
    capabilities: {
      sources: ['proc', 'snmp', 'netflow', 'sflow'],
      agentVersion: '0.39.1',
      managed: 'systemd',
      nic: [{ iface: 'eth0', driver: 'e1000e', driverVersion: '3.2.6-k', firmwareVersion: '0.13-4', busInfo: '0000:00:1f.6', pciId: '8086:15b8' }],
      ips: ['10.20.0.84', 'fd00:20::84'],
      unavailable: { lldp: null },
      lldp,
      lldpChassisId: '52:54:00:ab:cd:ef',
      arp: [
        { ip: '10.20.0.1', mac: '00:1b:44:11:3a:01', interface: 'eth0' },
        { ip: '10.20.0.10', mac: '00:1b:44:11:3a:10', interface: 'eth0' },
        { ip: '10.20.0.12', mac: '00:1b:44:11:3a:12', interface: 'eth0' },
        { ip: '10.20.0.99', mac: '00:1b:44:11:3a:99', interface: 'eth0' },
      ],
      connections: [
        { srcIp: '10.20.0.84', dstIp: '10.20.0.10', dstPort: 445, connCount: 4 },
        { srcIp: '10.20.0.84', dstIp: '10.20.0.12', dstPort: 502, connCount: 1 },
        { srcIp: '10.20.0.85', dstIp: '10.20.0.84', dstPort: 22, connCount: 2 },
      ],
    },
  };
}

// One SNMP topology cycle for the primary device, plus a poll error for the
// second. Round 2 takes a port down, moves a MAC to another port and swaps an
// LLDP neighbour — the three things the diff paths exist for.
function snmpTopology({ deviceId, errorDeviceId, round = 1 }) {
  const ifRow = (ifIndex, ifName, oper, extra = {}) => ({
    ifIndex, ifName, nameSource: 'ifName', ifAlias: `uplink ${ifIndex}`, ifDescr: `GigabitEthernet0/${ifIndex}`,
    ifType: 6, speedMbps: 1000, adminStatus: 'up', operStatus: oper, physAddress: `00:1b:44:22:00:0${ifIndex}`, ...extra,
  });
  const device = {
    deviceId,
    sysUpTimeTicks: 12345600 + round * 6000,
    sysName: 'sw-core-1',
    sysDescr: 'Cisco IOS Software, C3850 Software (CAT3K_CAA-UNIVERSALK9-M), Version 16.12.4',
    sysLocation: 'Bygning 3, rum 2.14, rack B',
    sysContact: 'noc@kunde.dk',
    sysObjectId: '1.3.6.1.4.1.9.1.1745',
    interfaces: [ifRow(1, 'Gi0/1', 'up'), ifRow(2, 'Gi0/2', round === 1 ? 'up' : 'down'), ifRow(3, 'Gi0/3', 'up')],
    fdb: [
      { mac: '00:1b:44:11:3a:10', vlan: 20, bridgePort: 1, ifIndex: 1, ifName: 'Gi0/1', status: 'learned', portMacCount: 1 },
      { mac: '00:1b:44:11:3a:12', vlan: 20, bridgePort: round === 1 ? 2 : 3, ifIndex: round === 1 ? 2 : 3, ifName: round === 1 ? 'Gi0/2' : 'Gi0/3', status: 'learned', portMacCount: 1 },
      { mac: '00:1b:44:11:3a:99', vlan: 30, bridgePort: 3, ifIndex: 3, ifName: 'Gi0/3', status: 'learned', portMacCount: 2 },
    ],
    fdbTruncated: false,
    fdbTotal: 3,
    vlans: [{ vlan: 20, name: 'Kontor' }, { vlan: 30, name: 'OT' }],
    supported: ['if', 'fdb', 'lldp', 'vlan', 'cdp', 'arp', 'entity'],
    neighbours: [
      { protocol: 'lldp', localPort: 1, localIfIndex: 1, localIfName: 'Gi0/1', remoteChassisId: round === 1 ? 'aa:bb:cc:11:22:33' : 'aa:bb:cc:11:22:44', remotePortId: 'Gi1/0/5', remotePortDesc: 'to core', remoteSysName: round === 1 ? 'sw-acc-2' : 'sw-acc-3' },
      { protocol: 'cdp', localPort: 3, localIfIndex: 3, localIfName: 'Gi0/3', remoteChassisId: 'sw-dist-1', remotePortId: 'Gi1/0/48', remotePortDesc: null, remoteSysName: 'sw-dist-1', remoteAddress: '10.14.0.11', remotePlatform: 'cisco WS-C3850-48P' },
    ],
    arp: [
      { ip: '10.20.0.84', mac: '00:1b:44:11:3a:84', ifIndex: 20, ifName: 'Vlan20' },
      { ip: '10.20.0.10', mac: '00:1b:44:11:3a:10', ifIndex: 20, ifName: 'Vlan20' },
    ],
    arpSource: 'ipNetToPhysical',
    arpTruncated: false,
    arpTotal: 2,
    inventory: [
      { entIndex: 1, class: 'chassis', name: 'Switch 1', descr: 'WS-C3850-48P', model: 'WS-C3850-48P', serial: 'FOC1234X0AB', vendor: 'Cisco Systems, Inc.', hardwareRev: 'V07', firmwareRev: '16.12.4', softwareRev: '16.12.04' },
      { entIndex: 1000, class: 'module', name: 'Module 1', descr: 'PSU', model: 'PWR-C1-715WAC', serial: 'LIT1234ABC', vendor: 'Cisco Systems, Inc.', hardwareRev: 'V02', firmwareRev: null, softwareRev: null },
    ],
  };
  return {
    devices: [device],
    errors: errorDeviceId ? [{ deviceId: errorDeviceId, error: 'Request timed out', code: 'RequestTimedOutError' }] : [],
  };
}

// Two counter snapshots a minute apart turn into rates.
function snmpCounters({ deviceId, round = 1 }) {
  const base = round === 1 ? 0 : 1;
  const row = (ifIndex, ifName, duplex, errs) => ({
    ifIndex, ifName, duplex,
    inOctets: 1e9 + base * 75e6 * ifIndex, outOctets: 5e8 + base * 30e6 * ifIndex,
    inUcastPkts: 1e6 + base * 60000, outUcastPkts: 8e5 + base * 50000,
    inMcastPkts: 1000 + base * 10, inBcastPkts: 500 + base * 5, outMcastPkts: 900, outBcastPkts: 400,
    inErrors: errs * (1 + base * 40), outErrors: 0, inDiscards: base * 3, outDiscards: 0,
    fcsErrors: errs * (1 + base * 40), alignmentErrors: 0, lateCollisions: duplex === 'half' ? base * 25 : 0, carrierSenseErrors: 0,
  });
  return {
    devices: [{
      deviceId,
      readAt: new Date(Date.now() - (round === 1 ? 60000 : 0)).toISOString(),
      sysUpTimeTicks: 12345600 + (round === 1 ? 0 : 6000),
      hc: true,
      renumbered: [],
      interfaces: [row(1, 'Gi0/1', 'full', 0), row(2, 'Gi0/2', 'half', 2), row(3, 'Gi0/3', 'full', 1)],
    }],
    errors: [],
  };
}

function deviceEvents({ sourceIp }) {
  return {
    events: [
      { sourceIp, receivedAt: iso(), deviceTime: iso(1500), transport: 'syslog', facility: 23, severity: 3, eventType: 'link.down', host: 'sw-core-1', tag: 'LINK-3-UPDOWN', ifname: 'Gi0/2', summary: 'Interface GigabitEthernet0/2, changed state to down', raw: '<187>Sep 24 10:00:00 sw-core-1 %LINK-3-UPDOWN: Interface GigabitEthernet0/2, changed state to down', detail: { state: 'down' } },
      { sourceIp, receivedAt: iso(), transport: 'trap', severity: 4, eventType: 'link.up', host: 'sw-core-1', ifname: 'Gi0/2', summary: 'linkUp ifIndex=2', detail: { trapOid: '1.3.6.1.6.3.1.1.5.4', ifIndex: 2 } },
      { sourceIp: '10.20.0.250', receivedAt: iso(), transport: 'syslog', severity: 5, eventType: 'port.security_violation', summary: 'port-security violation on Fa0/3', occurrences: 3 },
      { sourceIp: 'not-an-ip', receivedAt: iso(), severity: 3 },
    ],
  };
}

function discoveryResults() {
  return {
    scope: ['10.20.0.0/24'],
    addresses: 254,
    probed: 254,
    candidates: [
      { ip: '10.20.0.12', hostname: 'plc-hal-1', openPorts: [102, 502], icmp: true },
      { ip: '10.20.0.99', hostname: null, openPorts: [67, 80], icmp: true },
      { ip: '10.20.0.140', hostname: 'printer-3', openPorts: [9100], icmp: false },
    ],
  };
}

function speedtestResult() {
  return {
    result: {
      type: 'speedtest', ts: iso(), target: '127.0.0.1', ok: true,
      downMbps: 940.12, upMbps: 880.0, downBytes: 10485760, upBytes: 10485760, downMs: 89, upMs: 95,
    },
  };
}

module.exports = {
  startFakeLicens,
  prepareWorkDir,
  payloads: {
    procTraffic, sflowTraffic, resultEnvelope, probeResults, capabilities,
    snmpTopology, snmpCounters, deviceEvents, discoveryResults, speedtestResult,
  },
  iso,
};
