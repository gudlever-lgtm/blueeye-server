'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractFlows, parsePair } = require('../extractFlows');

const NOW = () => new Date('2026-01-01T00:00:00Z');

test('extracts the explicit traffic.flows schema', () => {
  const payload = { traffic: { flows: [
    { srcIp: '10.0.0.5', dstIp: '8.8.8.8', proto: 'tcp', srcPort: 50000, dstPort: 443, bytes: 1200, packets: 8, flows: 2 },
    { srcIp: '10.0.0.5', dstIp: '1.1.1.1', protocol: 'udp', bytes: 90 },
  ] } };
  const out = extractFlows(7, payload, NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].agentId, 7);
  assert.equal(out[0].dstIp, '8.8.8.8');
  assert.equal(out[0].proto, 'tcp');
  assert.equal(out[0].bytes, 1200);
  assert.equal(out[1].proto, 'udp'); // accepts `protocol` alias
  assert.equal(out[1].flows, 1); // defaults to 1
  assert.ok(out[0].ts instanceof Date);
});

test('falls back to parsing topTalkers pairs for IPs', () => {
  const payload = { traffic: { topTalkers: [
    { pair: '10.0.0.5:50000 <-> 8.8.8.8:443', bytes: 500, proto: 'tcp' },
    { pair: 'no-ip-here', bytes: 10 },
    { pair: '192.168.0.2 - 1.1.1.1', bytes: 20 },
  ] } };
  const out = extractFlows(3, payload, NOW);
  assert.equal(out.length, 2); // the IP-less pair is skipped
  assert.equal(out[0].srcIp, '10.0.0.5');
  assert.equal(out[0].dstIp, '8.8.8.8');
  assert.equal(out[0].dstPort, 443);
  assert.equal(out[1].dstIp, '1.1.1.1');
});

test('uses payload timestamp when present', () => {
  const out = extractFlows(1, { at: '2026-02-02T02:02:02Z', traffic: { flows: [{ srcIp: '10.0.0.1', dstIp: '8.8.8.8' }] } });
  assert.equal(out[0].ts.toISOString(), '2026-02-02T02:02:02.000Z');
});

test('returns [] for payloads without traffic/flows', () => {
  assert.deepEqual(extractFlows(1, null, NOW), []);
  assert.deepEqual(extractFlows(1, {}, NOW), []);
  assert.deepEqual(extractFlows(1, { traffic: {} }, NOW), []);
});

test('parsePair extracts two endpoints or null', () => {
  assert.deepEqual(parsePair('1.2.3.4:80 -> 5.6.7.8:90'), { src: { ip: '1.2.3.4', port: 80 }, dst: { ip: '5.6.7.8', port: 90 } });
  assert.equal(parsePair('only 1.2.3.4'), null);
  assert.equal(parsePair(null), null);
});
