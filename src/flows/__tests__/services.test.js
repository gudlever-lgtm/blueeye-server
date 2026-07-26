'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { serviceForPort, labelPorts, WELL_KNOWN } = require('../services');

test('serviceForPort names well-known service ports', () => {
  assert.equal(serviceForPort(443), 'HTTPS');
  assert.equal(serviceForPort(80), 'HTTP');
  assert.equal(serviceForPort(53), 'DNS');
  assert.equal(serviceForPort(22), 'SSH');
  assert.equal(serviceForPort(3389), 'RDP');
  assert.equal(serviceForPort(3306), 'MySQL');
});

test('serviceForPort refines a few ports by protocol (QUIC on udp/443)', () => {
  assert.equal(serviceForPort(443, 'tcp'), 'HTTPS');
  assert.equal(serviceForPort(443, 'udp'), 'HTTP/3 (QUIC)');
  assert.equal(serviceForPort(443, 'UDP'), 'HTTP/3 (QUIC)'); // case-insensitive
  assert.equal(serviceForPort(53, 'udp'), 'DNS'); // unchanged either way
});

test('serviceForPort returns null for ephemeral, unknown and invalid ports', () => {
  assert.equal(serviceForPort(54018), null); // ephemeral client socket
  assert.equal(serviceForPort(60000), null);
  assert.equal(serviceForPort(3000), null); // unknown / dev server
  assert.equal(serviceForPort(0), null);
  assert.equal(serviceForPort(70000), null);
  assert.equal(serviceForPort('nope'), null);
  assert.equal(serviceForPort(undefined), null);
});

test('serviceForPort never throws on bad input', () => {
  assert.equal(serviceForPort(null), null);
  assert.equal(serviceForPort({}), null);
  assert.equal(serviceForPort(443, {}), 'HTTPS'); // odd proto ignored
});

test('labelPorts adds a service field and copies rows', () => {
  const rows = [
    { port: 443, proto: 'tcp', bytes: 900, flowCount: 2 },
    { port: 54018, proto: 'tcp', bytes: 100, flowCount: 1 },
  ];
  const out = labelPorts(rows);
  assert.equal(out[0].service, 'HTTPS');
  assert.equal(out[1].service, null);
  // originals untouched, other fields preserved
  assert.equal(rows[0].service, undefined);
  assert.equal(out[0].bytes, 900);
  assert.equal(out[0].flowCount, 2);
});

test('labelPorts tolerates a non-array', () => {
  assert.deepEqual(labelPorts(null), []);
  assert.deepEqual(labelPorts(undefined), []);
});

test('WELL_KNOWN holds only valid port numbers', () => {
  for (const port of WELL_KNOWN.keys()) {
    assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535, `bad port ${port}`);
  }
});
