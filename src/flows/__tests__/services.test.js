'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { serviceForPort, servicePortOf, labelPorts, WELL_KNOWN } = require('../services');

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

test('serviceForPort names the industrial / OT protocols by their registered ports', () => {
  assert.equal(serviceForPort(502), 'Modbus/TCP');
  assert.match(serviceForPort(102), /S7comm/);
  assert.equal(serviceForPort(2404), 'IEC 60870-5-104');
  assert.equal(serviceForPort(20000), 'DNP3');
  assert.equal(serviceForPort(44818), 'EtherNet/IP (CIP)');
  assert.equal(serviceForPort(47808), 'BACnet/IP');
  assert.equal(serviceForPort(4840), 'OPC UA');
  assert.equal(serviceForPort(1883), 'MQTT');
  assert.equal(serviceForPort(34962), 'PROFINET RT');
  assert.equal(serviceForPort(34964), 'PROFINET CM');
  assert.equal(serviceForPort(9600), 'OMRON FINS');
  assert.equal(serviceForPort(1911), 'Niagara Fox');
  assert.equal(serviceForPort(18245), 'GE SRTP');
});

test('EtherNet/IP I/O is named on 2222/udp only — 2222/tcp is usually alternate SSH', () => {
  assert.equal(serviceForPort(2222, 'udp'), 'EtherNet/IP I/O');
  assert.equal(serviceForPort(2222, 'tcp'), null);
  assert.equal(serviceForPort(2222), null);
});

test('a port that is only a configurable vendor convention is not named (MELSEC 5007)', () => {
  assert.equal(serviceForPort(5007), null);
});

test('servicePortOf picks the service end of a conversation, whichever way it was sampled', () => {
  // SCADA -> PLC poll and the PLC's reply land on the same service port.
  assert.equal(servicePortOf(51000, 502), 502);
  assert.equal(servicePortOf(502, 51000), 502);
  // Neither end named: the lower port is the conventional server end.
  assert.equal(servicePortOf(40000, 3000), 3000);
  // Both named: the destination wins (the same rule the topology SQL uses).
  assert.equal(servicePortOf(53, 443), 443);
  // One side missing -> the other; both missing (ICMP) -> null.
  assert.equal(servicePortOf(null, 502), 502);
  assert.equal(servicePortOf(502, undefined), 502);
  assert.equal(servicePortOf(null, null), null);
  assert.equal(servicePortOf('x', 0), null);
});
