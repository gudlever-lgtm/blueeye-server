'use strict';

// Why a DNS or TCP probe failed — accepted from the agent, stored, and said in
// the finding. Before this a DNS NXDOMAIN, a resolver timeout and a SERVFAIL all
// read "N/M targets not responding", and a TCP RST read exactly like a silent
// drop, so an ACL blocking one port could not be told from a dead service.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateProbeResults, MAX_HOP_IPS } = require('../src/validation/probeValidation');
const { toRow, fromRow, COLUMNS } = require('../src/repositories/probeResultsRepository');
const { evaluateProbeFindings } = require('../src/analysis/probeFindings');
const { describeFailure, splitHostPort } = require('../src/analysis/probeFailure');

const T = '2026-06-01T12:00:00.000Z';
const at = () => new Date(T);
const one = (r) => validateProbeResults({ results: [r] });

// --- ingest --------------------------------------------------------------------

test('dns errorCode, tcp failure/errorCode and the resolver are accepted and bounded', () => {
  const dns = one({ type: 'dns', target: 'x.example', ok: false, errorCode: 'enotfound', resolver: '192.0.2.53' }).value.results[0];
  assert.equal(dns.errorCode, 'ENOTFOUND', 'normalised to the errno shape');
  assert.equal(dns.resolver, '192.0.2.53');
  assert.equal(dns.failure, null, 'failure is a TCP classification only');

  const tcp = one({ type: 'tcp', target: '192.0.2.1:443', ok: false, failure: 'refused', errorCode: 'ECONNREFUSED' }).value.results[0];
  assert.equal(tcp.failure, 'refused');
  assert.equal(tcp.errorCode, 'ECONNREFUSED');

  // Free text and unknown classes are dropped, not stored: both end up in a
  // finding sentence.
  const bad = one({ type: 'tcp', target: 'h:1', ok: false, failure: 'exploded', errorCode: 'x'.repeat(40) }).value.results[0];
  assert.equal(bad.failure, null);
  assert.equal(bad.errorCode, null);
  assert.equal(one({ type: 'dns', target: 'h', ok: false, errorCode: 'not a code; drop table' }).value.results[0].errorCode, null);
  assert.equal(one({ type: 'dns', target: 'h', ok: false, resolver: '-rf /' }).value.results[0].resolver, null);
  // Another probe type never carries them.
  const ping = one({ type: 'ping', target: 'h', ok: false, errorCode: 'ETIMEOUT', failure: 'timeout' }).value.results[0];
  assert.equal(ping.errorCode, null);
  assert.equal(ping.failure, null);
});

test('an older agent that sends none of the new fields is still accepted, with nulls', () => {
  const r = one({ type: 'dns', target: 'x.example', ok: false }).value.results[0];
  assert.equal(r.errorCode, null);
  assert.equal(r.resolver, null);
  const hop = one({ type: 'traceroute', target: 'h', ok: true, hops: [{ hop: 1, ip: '10.0.0.1', rttMs: 1 }] }).value.results[0].hops[0];
  assert.equal(hop.ips, null, 'an agent that sent no list did not claim only one member answered');
  const silent = one({ type: 'traceroute', target: 'h', ok: true, hops: [{ hop: 1, ip: null, ips: [] }] }).value.results[0].hops[0];
  assert.equal(silent.ips, null);
  const single = one({ type: 'traceroute', target: 'h', ok: true, hops: [{ hop: 1, ip: '10.0.0.1', ips: ['10.0.0.1'] }] }).value.results[0].hops[0];
  assert.deepEqual(single.ips, ['10.0.0.1'], 'a reported one-member list is kept — it IS a measurement');
});

test('hop.ips keeps every distinct responding address, first == ip, bounded', () => {
  const ips = ['203.0.113.1', '203.0.113.2', '203.0.113.1', '', null];
  const hop = one({ type: 'traceroute', target: 'h', ok: true, hops: [{ hop: 3, ip: '203.0.113.1', ips, rttMs: 4 }] }).value.results[0].hops[0];
  assert.deepEqual(hop.ips, ['203.0.113.1', '203.0.113.2']);
  const many = Array.from({ length: 30 }, (_, i) => `198.51.100.${i + 1}`);
  const wide = one({ type: 'tcptraceroute', target: 'h', ok: true, hops: [{ hop: 1, ip: many[0], ips: many }] }).value.results[0].hops[0];
  assert.equal(wide.ips.length, MAX_HOP_IPS);
  assert.equal(wide.ips[0], many[0]);
  // An agent that sends only `ips` still gets a representative `ip`.
  const noIp = one({ type: 'traceroute', target: 'h', ok: true, hops: [{ hop: 1, ips: ['192.0.2.9'] }] }).value.results[0].hops[0];
  assert.equal(noIp.ip, '192.0.2.9');
  assert.ok(many.every((ip) => ip.length <= 45));
});

test('the repository writes and reads the three columns', () => {
  const row = toRow(3, { type: 'tcp', target: 'h:22', ok: false, failure: 'timeout', errorCode: 'ETIMEDOUT' });
  assert.equal(row[COLUMNS.indexOf('failure')], 'timeout');
  assert.equal(row[COLUMNS.indexOf('error_code')], 'ETIMEDOUT');
  assert.equal(row[COLUMNS.indexOf('resolver')], null);
  assert.equal(row.length, COLUMNS.length);
  const back = fromRow({ id: 1, agent_id: 3, ts: new Date(T), type: 'dns', target: 'h', ok: 0, error_code: 'ESERVFAIL', failure: null, resolver: '192.0.2.53' });
  assert.equal(back.errorCode, 'ESERVFAIL');
  assert.equal(back.resolver, '192.0.2.53');
  assert.equal(fromRow({ id: 2, agent_id: 3, ts: new Date(T), type: 'ping', target: 'h', ok: 1 }).failure, null);
});

// --- the finding says which failure it was ----------------------------------------

const reach = (rows) => evaluateProbeFindings(7, rows, { now: at }).find((f) => f.metric === 'probe.reachability');
const dnsRow = (errorCode, extra = {}) => ({ ts: T, type: 'dns', target: 'intranet.example', ok: false, lossPct: 100, errorCode, ...extra });
const okPing = { ts: T, type: 'ping', target: '192.0.2.10', ok: true, rttMs: 3, lossPct: 0, jitterMs: 1 };

test('DNS: NXDOMAIN, timeout, SERVFAIL and refused read as four different findings', () => {
  const nx = reach([dnsRow('ENOTFOUND', { resolver: '192.0.2.53' }), okPing]);
  assert.match(nx.explanation, /NXDOMAIN/);
  assert.match(nx.explanation, /name does not exist/);
  assert.match(nx.explanation, /resolver 192\.0\.2\.53/, 'the resolver is named when known');
  assert.equal(nx.evidence[0].failure, 'NXDOMAIN');
  assert.equal(nx.evidence[0].resolver, '192.0.2.53');

  const to = reach([dnsRow('ETIMEOUT'), okPing]);
  assert.match(to.explanation, /timeout/);
  assert.match(to.explanation, /did not answer/);
  assert.doesNotMatch(to.explanation, /NXDOMAIN/);

  const sf = reach([dnsRow('ESERVFAIL'), okPing]);
  assert.match(sf.explanation, /SERVFAIL/);

  const rf = reach([dnsRow('ECONNREFUSED'), okPing]);
  assert.match(rf.explanation, /refused/);
  assert.match(rf.explanation, /port 53/);
});

test('DNS: a row with no code says the agent did not report why, rather than guessing', () => {
  const f = reach([dnsRow(null), okPing]);
  assert.match(f.explanation, /did not report why/);
  assert.equal(f.evidence[0].failure, null);
});

test('TCP: refused (RST) and timeout (silent drop) are told apart', () => {
  const refused = reach([{ ts: T, type: 'tcp', target: '192.0.2.20:502', ok: false, failure: 'refused', errorCode: 'ECONNREFUSED' }, okPing]);
  assert.match(refused.explanation, /actively refused \(RST\)/);
  assert.match(refused.explanation, /service down or an ACL/);
  const timeout = reach([{ ts: T, type: 'tcp', target: '192.0.2.20:502', ok: false, failure: 'timeout' }, okPing]);
  assert.match(timeout.explanation, /silently dropped \(firewall\/filter\) or the host is down/);
  assert.doesNotMatch(timeout.explanation, /RST/);
  // An errno alone is enough to classify when the agent sent no class.
  const byCode = reach([{ ts: T, type: 'tcp', target: '192.0.2.20:502', ok: false, errorCode: 'ECONNREFUSED' }, okPing]);
  assert.equal(byCode.evidence[0].failure, 'refused');
});

test('TCP: ICMP to the same host ok while TCP fails names the filter', () => {
  const rows = [
    { ts: T, type: 'tcp', target: '192.0.2.20:443', ok: false, failure: 'timeout' },
    { ts: T, type: 'ping', target: '192.0.2.20', ok: true, rttMs: 2, lossPct: 0, jitterMs: 0 },
  ];
  const f = reach(rows);
  assert.match(f.explanation, /ICMP to 192\.0\.2\.20 ok, TCP\/443 blocked — likely filter\/ACL or service down/);
  assert.equal(f.evidence[0].icmpOk, true);

  // Ping down too: the host is gone, which is a different sentence.
  const down = reach([
    { ts: T, type: 'tcp', target: '192.0.2.20:443', ok: false, failure: 'timeout' },
    { ts: T, type: 'ping', target: '192.0.2.20', ok: false, lossPct: 100 },
    okPing,
  ]);
  assert.match(down.explanation, /ICMP to 192\.0\.2\.20 fails as well/);
  assert.doesNotMatch(down.explanation, /blocked/);
});

test('only the NEWEST ping counts for the cross-check', () => {
  const rows = [ // newest-first
    { ts: T, type: 'tcp', target: '192.0.2.20:443', ok: false, failure: 'timeout' },
    { ts: T, type: 'ping', target: '192.0.2.20', ok: false, lossPct: 100 },
    { ts: '2026-06-01T11:00:00.000Z', type: 'ping', target: '192.0.2.20', ok: true, rttMs: 2, lossPct: 0 },
  ];
  assert.equal(describeFailure(rows[0], rows).icmpOk, false);
});

test('a reachability finding about a ping target reads exactly as before', () => {
  const f = reach([{ ts: T, type: 'ping', target: '1.1.1.1', ok: false, lossPct: 100 }, okPing]);
  assert.equal(f.explanation, '1/2 probe target(s) not responding (e.g. 1.1.1.1).');
});

test('host:port splitting handles IPv4, bracketed and bare IPv6', () => {
  assert.deepEqual(splitHostPort('192.0.2.1:443'), { host: '192.0.2.1', port: 443 });
  assert.deepEqual(splitHostPort('[2001:db8::1]:22'), { host: '2001:db8::1', port: 22 });
  assert.deepEqual(splitHostPort('2001:db8::1:22'), { host: '2001:db8::1', port: 22 });
  assert.deepEqual(splitHostPort('nohost'), { host: 'nohost', port: null });
});
