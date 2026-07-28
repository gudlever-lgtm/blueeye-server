'use strict';

// Unit tests for the pure ARP/neighbour parser (src/identity/arpTable.js).
// Byte-level cases per format, because the input is real command output and the
// failure mode of a wrong guess is a search that confidently returns the wrong
// host.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArpTable,
  normalizeReportedArp,
  normalizeMac,
  isUsableMac,
  isIp,
  isIpv4,
  isIpv6,
  stripZone,
} = require('../src/identity/arpTable');

// ------------------------------------------------------------ normalizeMac
test('normalizeMac accepts colon, dash, bare and Cisco-dotted forms', () => {
  const want = 'aa:bb:cc:dd:ee:ff';
  assert.equal(normalizeMac('aa:bb:cc:dd:ee:ff'), want);
  assert.equal(normalizeMac('AA:BB:CC:DD:EE:FF'), want);
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), want);
  assert.equal(normalizeMac('AA-BB-CC-DD-EE-FF'), want);
  assert.equal(normalizeMac('aabbccddeeff'), want);
  assert.equal(normalizeMac('AABBCCDDEEFF'), want);
  assert.equal(normalizeMac('aabb.ccdd.eeff'), want);
  assert.equal(normalizeMac('AABB.CCDD.EEFF'), want);
  assert.equal(normalizeMac('  aa:bb:cc:dd:ee:ff  '), want);
});

test('normalizeMac rejects anything that is not a MAC', () => {
  for (const bad of ['', null, undefined, 'not-a-mac', '192.168.1.1', 'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:ff:00', 'zz:bb:cc:dd:ee:ff', 'aabbccddee']) {
    assert.equal(normalizeMac(bad), null, `${JSON.stringify(bad)} must not parse as a MAC`);
  }
});

test('isUsableMac drops incomplete, broadcast and multicast addresses', () => {
  assert.equal(isUsableMac('00:11:22:33:44:55'), true);
  assert.equal(isUsableMac('00:00:00:00:00:00'), false); // incomplete
  assert.equal(isUsableMac('ff:ff:ff:ff:ff:ff'), false); // broadcast
  assert.equal(isUsableMac('01:00:5e:00:00:fb'), false); // IPv4 multicast
  assert.equal(isUsableMac('33:33:00:00:00:01'), false); // IPv6 multicast
  assert.equal(isUsableMac('01:80:c2:00:00:0e'), false); // IEEE reserved (LLDP)
  assert.equal(isUsableMac('03:00:00:00:00:01'), false); // group bit set → multicast
});

test('isUsableMac keeps locally-administered unicast addresses', () => {
  // 0xaa = 10101010: the LOW bit (group/multicast) is clear, the second bit
  // (locally administered) is set. Common for VMs and containers, and a perfectly
  // valid host identity — dropping these would blind the search to virtualised
  // hosts, which is most of them.
  assert.equal(isUsableMac('aa:bb:cc:dd:ee:ff'), true);
  assert.equal(isUsableMac('02:42:ac:11:00:02'), true); // Docker
});

// ------------------------------------------------------------------- IP shape
test('IP shape helpers separate addresses from other columns', () => {
  assert.equal(isIpv4('192.168.1.1'), true);
  assert.equal(isIpv4('192.168.1.256'), false);
  assert.equal(isIpv4('192.168.1'), false);
  assert.equal(isIpv6('fe80::1'), true);
  assert.equal(isIpv6('2001:db8::dead:beef'), true);
  assert.equal(isIpv6('00:11:22:33:44:55'), false, 'a MAC must not read as IPv6');
  assert.equal(isIp('eth0'), false);
  assert.equal(stripZone('fe80::1%eth0'), 'fe80::1');
  assert.equal(stripZone('192.168.1.1'), '192.168.1.1');
});

// ------------------------------------------------------------ /proc/net/arp
test('parses /proc/net/arp, honouring the complete flag', () => {
  // This is what the agent actually collects today (src/runtime.js).
  const text = [
    'IP address       HW type     Flags       HW address            Mask     Device',
    '192.168.1.1      0x1         0x2         00:11:22:33:44:55     *        eth0',
    '192.168.1.50     0x1         0x2         00:1a:2b:3c:4d:5e     *        eth0',
    '192.168.1.99     0x1         0x0         00:00:00:00:00:00     *        eth0',
  ].join('\n');

  const { entries, parsed, skipped } = parseArpTable(text);
  assert.equal(parsed, 2);
  assert.equal(skipped, 1, 'the incomplete (flag 0x0) row is skipped');
  assert.deepEqual(entries, [
    { ip: '192.168.1.1', mac: '00:11:22:33:44:55', interface: 'eth0' },
    { ip: '192.168.1.50', mac: '00:1a:2b:3c:4d:5e', interface: 'eth0' },
  ]);
});

// ------------------------------------------------------------------ ip neigh
test('parses ip neigh output and skips FAILED/INCOMPLETE entries', () => {
  const text = [
    '192.168.1.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE',
    '192.168.1.9 dev eth0 FAILED',
    '192.168.1.20 dev eth0 lladdr 00:1a:2b:3c:4d:5e STALE',
    '10.0.0.7 dev eth1 lladdr 02:42:ac:11:00:02 INCOMPLETE',
    'fe80::1 dev eth0 lladdr 00:11:22:33:44:66 router REACHABLE',
  ].join('\n');

  const { entries } = parseArpTable(text);
  assert.deepEqual(entries, [
    { ip: '192.168.1.1', mac: '00:11:22:33:44:55', interface: 'eth0' },
    { ip: '192.168.1.20', mac: '00:1a:2b:3c:4d:5e', interface: 'eth0' },
    { ip: 'fe80::1', mac: '00:11:22:33:44:66', interface: 'eth0' },
  ]);
});

// --------------------------------------------------------------- arp -an (BSD)
test('parses BSD/macOS arp -an and skips <incomplete>', () => {
  const text = [
    '? (192.168.1.1) at 00:11:22:33:44:55 [ether] on en0',
    '? (192.168.1.7) at <incomplete> on en0',
    'gateway (10.0.0.1) at 00:1a:2b:3c:4d:5e on en0 ifscope [ethernet]',
  ].join('\n');

  const { entries } = parseArpTable(text);
  assert.deepEqual(entries, [
    { ip: '192.168.1.1', mac: '00:11:22:33:44:55', interface: 'en0' },
    { ip: '10.0.0.1', mac: '00:1a:2b:3c:4d:5e', interface: 'en0' },
  ]);
});

// ------------------------------------------------------------- arp -a (Windows)
test('parses Windows arp -a and carries the Interface: header across rows', () => {
  const text = [
    'Interface: 192.168.1.34 --- 0xb',
    '  Internet Address      Physical Address      Type',
    '  192.168.1.1           00-11-22-33-44-55     dynamic',
    '  192.168.1.255         ff-ff-ff-ff-ff-ff     static',
    '  224.0.0.22            01-00-5e-00-00-16     static',
    '  192.168.1.60          00-1a-2b-3c-4d-5e     dynamic',
  ].join('\r\n'); // CRLF, as Windows emits

  const { entries } = parseArpTable(text);
  assert.deepEqual(entries, [
    { ip: '192.168.1.1', mac: '00:11:22:33:44:55', interface: '192.168.1.34' },
    { ip: '192.168.1.60', mac: '00:1a:2b:3c:4d:5e', interface: '192.168.1.34' },
  ]);
});

// ------------------------------------------------------------------- mixed
test('format detection is per line, so a concatenated payload still parses', () => {
  // Evidence payloads join items with "# name [status]" headers, so one blob can
  // legitimately hold more than one shape.
  const text = [
    '# arp.table [ok]',
    '192.168.1.1      0x1         0x2         00:11:22:33:44:55     *        eth0',
    '10.0.0.5 dev eth1 lladdr 00:1a:2b:3c:4d:5e REACHABLE',
    '? (172.16.0.9) at 00:aa:bb:cc:dd:01 [ether] on eth2',
  ].join('\n');

  const { entries, parsed } = parseArpTable(text);
  assert.equal(parsed, 3);
  assert.deepEqual(entries.map((e) => e.ip), ['192.168.1.1', '10.0.0.5', '172.16.0.9']);
});

test('an unparseable line never discards the rest of the payload', () => {
  const text = [
    'some unexpected prose from a tool that changed its output',
    '192.168.1.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE',
  ].join('\n');
  assert.equal(parseArpTable(text).parsed, 1);
});

test('the last mention of an IP wins (neighbour tables print oldest first)', () => {
  const text = [
    '192.168.1.1 dev eth0 lladdr 00:11:22:33:44:55 STALE',
    '192.168.1.1 dev eth0 lladdr 00:1a:2b:3c:4d:5e REACHABLE',
  ].join('\n');
  const { entries } = parseArpTable(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].mac, '00:1a:2b:3c:4d:5e');
});

test('empty and garbage input yield no entries without throwing', () => {
  for (const input of ['', null, undefined, '   \n\n  ', '# arp.table [ok]\n(no collector configured on this agent)']) {
    const r = parseArpTable(input);
    assert.deepEqual(r.entries, []);
    assert.equal(r.parsed, 0);
  }
});

test('skipped counts only plausible entry lines, not prose or headers', () => {
  const text = [
    'IP address       HW type     Flags       HW address            Mask     Device',
    'this is prose, not a table',
    '192.168.1.99     0x1         0x0         00:00:00:00:00:00     *        eth0',
  ].join('\n');
  // Only the incomplete row counts — otherwise the number is noise.
  assert.equal(parseArpTable(text).skipped, 1);
});

// --------------------------------------------------------- normalizeReportedArp
test('normalizeReportedArp accepts both field spellings', () => {
  const { entries } = normalizeReportedArp([
    { ip: '192.168.1.1', mac: '00:11:22:33:44:55', interface: 'eth0' },
    { address: '10.0.0.5', lladdr: '00-1A-2B-3C-4D-5E', dev: 'eth1' },
  ]);
  assert.deepEqual(entries, [
    { ip: '192.168.1.1', mac: '00:11:22:33:44:55', interface: 'eth0' },
    { ip: '10.0.0.5', mac: '00:1a:2b:3c:4d:5e', interface: 'eth1' },
  ]);
});

test('normalizeReportedArp drops malformed rows instead of throwing', () => {
  // A bad entry must not cost the whole capabilities report.
  const { entries, skipped } = normalizeReportedArp([
    null,
    'not an object',
    { ip: 'nope', mac: '00:11:22:33:44:55' },
    { ip: '192.168.1.1', mac: 'not-a-mac' },
    { ip: '192.168.1.2', mac: 'ff:ff:ff:ff:ff:ff' }, // broadcast
    { ip: '192.168.1.3', mac: '00:11:22:33:44:55' }, // the only good one
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ip, '192.168.1.3');
  assert.equal(skipped, 5);
});

test('normalizeReportedArp handles a non-array without throwing', () => {
  for (const input of [null, undefined, {}, 'nope', 42]) {
    assert.deepEqual(normalizeReportedArp(input).entries, []);
  }
});

test('normalizeReportedArp bounds an over-long interface name', () => {
  const { entries } = normalizeReportedArp([
    { ip: '192.168.1.1', mac: '00:11:22:33:44:55', interface: 'x'.repeat(200) },
  ]);
  assert.equal(entries[0].interface.length, 64, 'must fit the VARCHAR(64) column');
});
