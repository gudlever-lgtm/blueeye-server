'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ipv4ToInt, isIpv4, isPrivate, externalEndpoint } = require('../privateIp');

test('ipv4ToInt parses valid IPv4 and rejects junk', () => {
  assert.equal(ipv4ToInt('0.0.0.0'), 0);
  assert.equal(ipv4ToInt('255.255.255.255'), 4294967295);
  assert.equal(ipv4ToInt('1.2.3.4'), 16909060);
  assert.equal(ipv4ToInt('256.0.0.1'), null);
  assert.equal(ipv4ToInt('1.2.3'), null);
  assert.equal(ipv4ToInt('not-an-ip'), null);
  assert.equal(isIpv4('8.8.8.8'), true);
  assert.equal(isIpv4('::1'), false);
});

test('isPrivate flags RFC1918 + special-use ranges', () => {
  for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.1.2.3']) {
    assert.equal(isPrivate(ip), true, `${ip} should be private`);
  }
});

test('isPrivate treats public addresses as routable', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '80.1.2.3', '172.32.0.1', '192.169.0.1']) {
    assert.equal(isPrivate(ip), false, `${ip} should be public`);
  }
});

test('isPrivate handles IPv6 special-use and unparseable input safely', () => {
  assert.equal(isPrivate('::1'), true);
  assert.equal(isPrivate('::'), true);
  assert.equal(isPrivate('fc00::1'), true);
  assert.equal(isPrivate('fe80::1'), true);
  assert.equal(isPrivate('2001:4860:4860::8888'), false);
  assert.equal(isPrivate(''), true); // unknown -> non-geo
  assert.equal(isPrivate('garbage'), true);
  assert.equal(isPrivate(null), true);
});

test('externalEndpoint picks the public peer and direction', () => {
  assert.equal(externalEndpoint('10.0.0.5', '192.168.1.9'), null); // both private -> internal
  assert.deepEqual(externalEndpoint('10.0.0.5', '8.8.8.8'), { ip: '8.8.8.8', direction: 'out' });
  assert.deepEqual(externalEndpoint('8.8.8.8', '10.0.0.5'), { ip: '8.8.8.8', direction: 'in' });
  assert.deepEqual(externalEndpoint('1.1.1.1', '8.8.8.8'), { ip: '8.8.8.8', direction: 'out' }); // both public -> dst
});
