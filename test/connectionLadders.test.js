'use strict';

// The other three ladders — two-way, local host and device location — and the
// registry that holds all four.
//
// The registry's own rules are tested once here rather than four times: an
// order that breaks a causal chain is refused, a disabled rung is reported
// rather than dropped, and nothing is ever promoted from "not measured" to
// "fine". Each ladder then gets the cases it exists for.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ladders = require('../src/connectionTest/ladders');
const { STATUS } = ladders;
const { LOCALES } = require('../src/connectionTest/i18n');

const rungOf = (r, layer) => r.layers.find((l) => l.layer === layer);
const walk = (ladder, ctx, opts = {}) => ladders.walk({ ladder, ctx, ...opts });

// ------------------------------------------------------------- the registry

test('every ladder is registered once, with rungs that all have evaluators', () => {
  assert.deepEqual(ladders.ids(), ['reachability', 'two_way', 'local_host', 'device_location']);
  for (const def of ladders.catalogue()) {
    assert.ok(def.layers.length >= 4, `${def.id} has ${def.layers.length} rungs`);
    for (const l of def.locked) assert.ok(def.layers.includes(l), `${def.id}: locked "${l}" is not a rung`);
    assert.deepEqual(def.movable, def.layers.filter((l) => !def.locked.includes(l)));
  }
});

test('every ladder states what it needs before it can run', () => {
  const needs = Object.fromEntries(ladders.catalogue().map((d) => [d.id, d.needs]));
  assert.deepEqual(needs.reachability, { agents: 1, target: 'host' });
  assert.deepEqual(needs.two_way, { agents: 2, target: 'none' });
  assert.deepEqual(needs.local_host, { agents: 1, target: 'none' });
  // Device location measures nothing new, so it needs no agent at all.
  assert.deepEqual(needs.device_location, { agents: 0, target: 'device' });
});

test('no ladder lets its causal chain be reordered', () => {
  for (const def of ladders.all()) {
    assert.equal(ladders.validateOrder(def, [...def.layers]), null, def.id);
    if (def.locked.length < 2) continue;
    // Swap the first two locked rungs — the one move that must always fail.
    const bad = [...def.layers];
    const i = bad.indexOf(def.locked[0]);
    const j = bad.indexOf(def.locked[1]);
    [bad[i], bad[j]] = [bad[j], bad[i]];
    assert.match(ladders.validateOrder(def, bad), /causal chain/, def.id);
  }
});

test('every movable rung may go anywhere, on every ladder', () => {
  for (const def of ladders.all()) {
    for (const m of ladders.movableOf(def)) {
      const rest = def.layers.filter((l) => l !== m);
      assert.equal(ladders.validateOrder(def, [m, ...rest]), null, `${def.id}: ${m} could not go first`);
      assert.equal(ladders.validateOrder(def, [...rest, m]), null, `${def.id}: ${m} could not go last`);
    }
  }
});

test('a config that cannot be honoured falls back field by field, on every ladder', () => {
  for (const def of ladders.all()) {
    for (const junk of [null, 'str', [], { order: 'nope' }, { order: ['x'] }, { enabled: 'no' }, { certWarnDays: -5 }, { ports: [] }]) {
      const c = ladders.resolveConfig(def, junk);
      assert.deepEqual(c.order, [...def.layers], `${def.id} / ${JSON.stringify(junk)}`);
      for (const l of def.layers) assert.equal(c.enabled[l], true);
    }
  }
});

test('walking an unknown ladder throws rather than guessing which one was meant', () => {
  assert.throws(() => ladders.walk({ ladder: 'nope', ctx: {} }), /unknown ladder/);
});

// --------------------------------------------------------------- two-way

const ping = (ok, loss, rtt) => ({ type: 'ping', target: 'x', ok, lossPct: loss, rttMs: rtt });
const trace = (ips) => ({ type: 'traceroute', target: 'x', ok: true, hops: ips.map((ip, i) => ({ hop: i + 1, ip })) });
const mtuRow = (bytes) => ({ type: 'path_mtu', target: 'x', ok: true, mtu: { pathMtu: bytes } });
const twoWay = (forward, reverse, opts = {}) =>
  walk('two_way', { forward, reverse, fromName: 'probe-01', toName: 'probe-02' }, opts);

test('loss on the return path only is named as the return path', () => {
  const r = twoWay([ping(true, 0, 12)], [ping(true, 40, 14)]);
  assert.equal(r.stopsAt, 'direction');
  const d = rungOf(r, 'direction');
  assert.equal(d.forward_loss_pct, 0);
  assert.equal(d.reverse_loss_pct, 40);
  // The sentence has to name the case a one-way test gets wrong.
  assert.match(d.because, /stateful firewall that never saw the outbound SYN/);
  assert.match(d.because, /probe-02 → probe-01/);
});

test('loss on the outbound path says a test at the far end will look fine', () => {
  const r = twoWay([ping(true, 30, 12)], [ping(true, 0, 14)]);
  assert.equal(r.stopsAt, 'direction');
  assert.match(rungOf(r, 'direction').because, /will report that everything is fine/);
});

test('loss in both directions is the link, not a one-sided rule', () => {
  const r = twoWay([ping(true, 30, 12)], [ping(true, 25, 14)]);
  assert.match(rungOf(r, 'direction').because, /That is the link or the host/);
});

test('one direction that answers nothing stops before the comparison', () => {
  const r = twoWay([ping(true, 0, 12)], [ping(false, 100, null)]);
  assert.equal(r.stopsAt, 'reverse');
  assert.match(rungOf(r, 'reverse').because, /One direction works and this one does not/);
  // Nothing above the break may claim to be an answer. Here symmetry was never
  // measured either, and "not tested" is the truer of the two — a rung above
  // the break keeps `unknown` rather than being relabelled `unreached`, because
  // it would have had nothing to say whatever happened below it.
  assert.equal(rungOf(r, 'symmetry').status, STATUS.UNKNOWN);
});

test('only one direction measured is untested, never "symmetric"', () => {
  const r = twoWay([ping(true, 0, 12), trace(['10.0.0.1', '10.1.0.1'])], []);
  assert.equal(rungOf(r, 'reverse').status, STATUS.UNKNOWN);
  assert.equal(rungOf(r, 'symmetry').status, STATUS.UNKNOWN);
  assert.equal(r.stopsAt, null);
});

test('different paths are worth knowing without being a fault', () => {
  const r = twoWay(
    [ping(true, 0, 12), trace(['10.0.0.1', '10.1.0.1', '10.9.9.9'])],
    [ping(true, 0, 12), trace(['192.168.5.1', '172.16.4.1', '10.9.9.9'])]
  );
  assert.equal(rungOf(r, 'symmetry').status, STATUS.SUSPECT);
  assert.equal(r.stopsAt, null, 'asymmetric routing on its own is not a break');
  assert.match(rungOf(r, 'symmetry').because, /Normal on the internet/);
});

test('two round trips that cost very different time are reported as two paths, not one slow leg', () => {
  const r = twoWay([ping(true, 0, 20)], [ping(true, 0, 140)]);
  assert.equal(rungOf(r, 'latency').status, STATUS.SUSPECT);
  assert.match(rungOf(r, 'latency').because, /Both are ROUND trips/);
  // A sub-millisecond LAN never trips it.
  assert.equal(rungOf(twoWay([ping(true, 0, 0.2)], [ping(true, 0, 0.5)]), 'latency').status, STATUS.OK);
});

test('an MTU that differs per direction names the smaller one to clamp to', () => {
  const r = twoWay([ping(true, 0, 12), mtuRow(1500)], [ping(true, 0, 12), mtuRow(1400)]);
  assert.equal(rungOf(r, 'mtu').status, STATUS.SUSPECT);
  assert.match(rungOf(r, 'mtu').because, /clamp to 1400/);
});

test('both directions clean is clear, in this ladder\'s own words', () => {
  // A genuinely symmetric pair: the return trace walks the SAME routers in the
  // opposite order, which is what the far end actually reports.
  const r = twoWay(
    [ping(true, 0, 12), trace(['10.0.0.1', '10.1.0.1', '10.2.0.1', '10.9.9.9']), mtuRow(1500)],
    [ping(true, 0, 13), trace(['10.9.9.9', '10.2.0.1', '10.1.0.1', '10.0.0.1']), mtuRow(1500)]
  );
  assert.equal(r.verdict.outcome, 'clear');
  assert.match(r.verdict.text, /the link between these two is not the problem/);
});

// ------------------------------------------------------------- local host

const iface = (over = {}) => [{ name: 'eth0', virtual: false, status: 'ok', linkDown: false, ...over }];
const localHost = (ctx, opts = {}) => walk('local_host', ctx, opts);

test('a virtual interface never decides that this host has a link fault', () => {
  const r = localHost({ interfaces: [{ name: 'docker0', virtual: true, linkDown: true }], results: [] });
  // The docker bridge is filtered out entirely, so there is nothing to read.
  assert.equal(rungOf(r, 'link').status, STATUS.UNKNOWN);
  assert.equal(r.stopsAt, null);
});

test('a link that is down stops everything above it', () => {
  const r = localHost({ interfaces: iface({ linkDown: true }), results: [] });
  assert.equal(r.stopsAt, 'link');
  // Duplex was not reported either, so it stays "not tested" rather than being
  // relabelled — and either way it is not allowed to read as healthy.
  assert.equal(rungOf(r, 'duplex').status, STATUS.UNKNOWN);
  // A rung above the break that DID measure something is the one that gets
  // relabelled, so the screen never shows a green tick under a red rung.
  const withDuplex = localHost({ interfaces: iface({ linkDown: true, duplex: 'full' }), results: [] });
  assert.equal(rungOf(withDuplex, 'duplex').status, STATUS.UNREACHED);
  assert.equal(rungOf(withDuplex, 'duplex').would_have_said, STATUS.OK);
});

test('late collisions name a duplex mismatch rather than congestion', () => {
  const r = localHost({ interfaces: iface({ lateCollPerSec: 4 }), results: [] });
  assert.equal(r.stopsAt, 'duplex');
  assert.match(rungOf(r, 'duplex').because, /not congestion/);
});

test('duplex that was not reported is unknown, never "fine"', () => {
  const r = localHost({ interfaces: iface({}), results: [] });
  assert.equal(rungOf(r, 'duplex').status, STATUS.UNKNOWN);
  assert.match(rungOf(r, 'duplex').because, /not the same as nothing being wrong/);
});

test('errors at low utilisation are called a cable, not congestion', () => {
  const r = localHost({ interfaces: iface({ duplex: 'full', errPerSec: 6, utilPct: 3 }), results: [] });
  assert.equal(rungOf(r, 'errors').status, STATUS.FAILED);
  assert.match(rungOf(r, 'errors').because, /never congestion/);
});

test('nobody answering a DHCPDISCOVER is a fault, and two servers answering is another', () => {
  const none = localHost({ interfaces: iface({ duplex: 'full' }), results: [{ type: 'dhcp', target: 'eth0', ok: true, dhcp: { offers: [] } }] });
  assert.equal(rungOf(none, 'dhcp').status, STATUS.FAILED);
  assert.match(rungOf(none, 'dhcp').because, /Existing leases keep working/);

  const several = localHost({
    interfaces: iface({ duplex: 'full' }),
    results: [{ type: 'dhcp', target: 'eth0', ok: true, dhcp: { offers: [{ serverId: '10.0.0.1' }, { serverId: '10.0.0.9' }] } }],
  });
  assert.equal(rungOf(several, 'dhcp').status, STATUS.FAILED);
  assert.match(rungOf(several, 'dhcp').because, /security finding/);
});

test('a DHCP test that could not RUN says nothing about the network', () => {
  const r = localHost({
    interfaces: iface({ duplex: 'full' }),
    results: [{ type: 'dhcp', target: 'eth0', ok: false, detail: 'needs root for port 68' }],
  });
  assert.equal(rungOf(r, 'dhcp').status, STATUS.UNKNOWN);
  assert.match(rungOf(r, 'dhcp').because, /says nothing about the network/);
});

test('the gateway is the first hop of a traceroute, read off the wire', () => {
  const r = localHost({
    interfaces: iface({ duplex: 'full' }),
    results: [{ type: 'traceroute', target: '1.1.1.1', ok: true, hops: [{ hop: 1, ip: '10.0.0.1', lossPct: 0, rttMs: 1 }, { hop: 2, ip: '8.8.8.8' }] }],
  });
  assert.equal(rungOf(r, 'gateway').status, STATUS.OK);
  assert.equal(rungOf(r, 'gateway').gateway, '10.0.0.1');
});

test('a gateway losing a little is the ICMP rate-limit caveat, not a break', () => {
  const r = localHost({
    interfaces: iface({ duplex: 'full' }),
    results: [{ type: 'traceroute', target: '1.1.1.1', ok: true, hops: [{ hop: 1, ip: '10.0.0.1', lossPct: 20 }] }],
  });
  assert.equal(rungOf(r, 'gateway').status, STATUS.SUSPECT);
  assert.match(rungOf(r, 'gateway').because, /rate-limiting its OWN ICMP/);
  assert.equal(r.stopsAt, null);
});

test('a slow resolver is worth a sentence, and a dead one stops the ladder', () => {
  const slow = localHost({ interfaces: iface({ duplex: 'full' }), results: [{ type: 'dns', target: 'x', ok: true, rttMs: 2400, resolver: '10.0.0.53' }] });
  assert.equal(rungOf(slow, 'resolver').status, STATUS.SUSPECT);
  const dead = localHost({ interfaces: iface({ duplex: 'full' }), results: [{ type: 'dns', target: 'x', ok: false, errorCode: 'ETIMEOUT', resolver: '10.0.0.53' }] });
  assert.equal(dead.stopsAt, 'resolver');
});

test('a healthy host says so in its own words', () => {
  const r = localHost({
    interfaces: iface({ duplex: 'full', errPerSec: 0, dropPerSec: 0, utilPct: 5, speedMbps: 1000 }),
    results: [
      { type: 'dhcp', target: 'eth0', ok: true, dhcp: { offers: [{ serverId: '10.0.0.1' }] } },
      { type: 'traceroute', target: '1.1.1.1', ok: true, hops: [{ hop: 1, ip: '10.0.0.1', lossPct: 0, rttMs: 1 }] },
      { type: 'dns', target: 'x', ok: true, rttMs: 9, resolver: '10.0.0.53' },
    ],
  });
  assert.equal(r.verdict.outcome, 'clear');
  assert.match(r.verdict.text, /this host is not the problem/);
});

// --------------------------------------------------------- device location

const located = (over = {}) => ({
  label: '10.0.0.5',
  macs: [{ mac: 'aa:bb:cc:dd:ee:ff', vendor: 'Dell' }],
  location: { deviceId: 2, deviceName: 'sw-core-1', ifName: 'Gi1/0/7', vlan: 20, portMacCount: 1 },
  port: { known: true, ifName: 'Gi1/0/7', adminStatus: 'up', operStatus: 'up', speedMbps: 1000, counters: { inErrPps: 0, outErrPps: 0, inDiscPps: 0, outDiscPps: 0, inUtilPct: 3, outUtilPct: 2 } },
  vlanName: 'users',
  ...over,
});
const where = (ctx, opts = {}) => walk('device_location', { query: '10.0.0.5', ...ctx }, opts);

test('a device nothing has seen is a finding with a sentence, not a blank', () => {
  const r = where({ located: null });
  assert.equal(r.stopsAt, 'identity');
  assert.match(rungOf(r, 'identity').because, /no agent, switch, ARP table/);
});

test('an address with no MAC is named as a coverage gap, not a missing device', () => {
  const r = where({ located: located({ macs: [], location: null, port: null }) });
  assert.equal(r.stopsAt, 'identity');
  assert.match(rungOf(r, 'identity').because, /coverage gap on that segment, not a missing device/);
});

test('a MAC no forwarding table holds says the switches are not polled', () => {
  const r = where({ located: located({ location: null, port: null }) });
  assert.equal(r.stopsAt, 'switch');
  assert.match(rungOf(r, 'switch').because, /not polled here/);
});

test('an uplink is not reported as the port the device is on', () => {
  const r = where({ located: located({ location: { deviceId: 2, deviceName: 'sw-core-1', ifName: 'Te1/1/1', vlan: 20, portMacCount: 42 } }) });
  assert.equal(rungOf(r, 'port').status, STATUS.SUSPECT);
  assert.match(rungOf(r, 'port').because, /the direction the device lies in/);
});

test('administratively down is told apart from a port that fell over', () => {
  const down = where({ located: located({ port: { known: true, ifName: 'Gi1/0/7', adminStatus: 'down', operStatus: 'down' } }) });
  assert.equal(down.stopsAt, 'state');
  assert.match(rungOf(down, 'state').because, /somebody shut it/);
  const fell = where({ located: located({ port: { known: true, ifName: 'Gi1/0/7', adminStatus: 'up', operStatus: 'down' } }) });
  assert.match(rungOf(fell, 'state').because, /is down/);
  assert.ok(!/somebody shut it/.test(rungOf(fell, 'state').because));
});

test('a port that is erring is a fault and one that is discarding is worth knowing', () => {
  const err = where({ located: located({ port: { known: true, ifName: 'Gi1/0/7', adminStatus: 'up', operStatus: 'up', counters: { inErrPps: 5, outErrPps: 0, inDiscPps: 0, outDiscPps: 0, inUtilPct: 4, outUtilPct: 1 } } }) });
  assert.equal(err.stopsAt, 'counters');
  const disc = where({ located: located({ port: { known: true, ifName: 'Gi1/0/7', adminStatus: 'up', operStatus: 'up', counters: { inErrPps: 0, outErrPps: 0, inDiscPps: 9, outDiscPps: 0, inUtilPct: 80, outUtilPct: 1 } } }) });
  assert.equal(rungOf(disc, 'counters').status, STATUS.SUSPECT);
  assert.equal(disc.stopsAt, null);
});

test('a VLAN is a fact until the caller says which one it should be', () => {
  assert.equal(rungOf(where({ located: located() }), 'vlan').status, STATUS.OK);
  const wrong = where({ located: located(), expectVlan: 30 });
  assert.equal(wrong.stopsAt, 'vlan');
  assert.match(rungOf(wrong, 'vlan').because, /expected on 30/);
});

test('a switch that is its own location has no access port to look at', () => {
  const r = where({ located: located({ location: { deviceId: 2, deviceName: 'sw-core-1', self: true, ifName: null, vlan: null } }) });
  assert.equal(rungOf(r, 'port').status, STATUS.NA);
  assert.equal(rungOf(r, 'state').status, STATUS.NA);
  assert.equal(r.stopsAt, null);
});

test('a found device on a healthy port says so in its own words', () => {
  const r = where({ located: located() });
  assert.equal(r.verdict.outcome, 'clear');
  assert.match(r.verdict.text, /the port it is on is healthy/);
});

// ---------------------------------------------------------------- language

test('every ladder answers in Danish without translating a protocol name', () => {
  const cases = [
    ['two_way', { forward: [ping(true, 0, 12)], reverse: [ping(true, 40, 14)], fromName: 'probe-01', toName: 'probe-02' }, /returvejen/, 'SYN'],
    ['local_host', { interfaces: iface({ lateCollPerSec: 3 }), results: [] }, /late collisions/, 'duplex'],
    ['device_location', { query: 'x', located: located({ port: { known: true, ifName: 'Gi1/0/7', adminStatus: 'down', operStatus: 'down' } }) }, /administrativt nede/, 'Gi1/0/7'],
  ];
  for (const [id, ctx, danish, term] of cases) {
    const r = walk(id, ctx, { locale: 'da' });
    assert.equal(r.locale, 'da');
    assert.match(r.verdict.text, danish, id);
    assert.ok(r.verdict.text.includes(term), `${id}: "${term}" was translated`);
  }
});

test('a disabled rung is reported as disabled on every ladder, in both languages', () => {
  for (const def of ladders.all()) {
    const off = def.layers[def.layers.length - 1];
    for (const loc of LOCALES) {
      const r = ladders.walk({ ladder: def, ctx: {}, config: { enabled: { [off]: false } }, locale: loc });
      const rg = rungOf(r, off);
      assert.equal(rg.disabled, true, `${def.id}/${loc}`);
      assert.equal(rg.status, STATUS.UNKNOWN);
      assert.equal(r.layers.length, def.layers.length, `${def.id}: the ladder shrank`);
    }
  }
});
