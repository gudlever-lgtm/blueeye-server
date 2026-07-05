'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveServerId, deriveServerId, readMachineId, hostAttributes } = require('../serverIdentity');

const fakeFs = (files) => ({
  readFileSync(p) {
    if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
    const err = new Error(`ENOENT: ${p}`);
    err.code = 'ENOENT';
    throw err;
  },
});

const fakeOs = ({ hostname = 'host-a', platform = 'linux', arch = 'x64', ifaces = {} }) => ({
  hostname: () => hostname,
  platform: () => platform,
  arch: () => arch,
  networkInterfaces: () => ifaces,
});

test('LICENSE_SERVER_ID always wins and is reported as configured', () => {
  const r = resolveServerId({ env: { LICENSE_SERVER_ID: 'gnf-server-1' }, fs: fakeFs({}), os: fakeOs({}) });
  assert.equal(r.serverId, 'gnf-server-1');
  assert.equal(r.source, 'configured');
});

test('a blank LICENSE_SERVER_ID falls through to derivation', () => {
  const r = resolveServerId({ env: { LICENSE_SERVER_ID: '   ' }, fs: fakeFs({ '/etc/machine-id': 'abc123\n' }), os: fakeOs({}) });
  assert.equal(r.source, 'machine-id');
  assert.match(r.serverId, /^be-[0-9a-f]{20}$/);
});

test('machine-id is preferred and is deterministic', () => {
  const deps = { env: {}, fs: fakeFs({ '/etc/machine-id': 'deadbeef\n' }), os: fakeOs({ hostname: 'whatever' }) };
  const a = resolveServerId(deps);
  const b = resolveServerId(deps);
  assert.equal(a.source, 'machine-id');
  assert.equal(a.serverId, b.serverId, 'same host → same id across calls');
});

test('machine-id changes the id independently of host attributes', () => {
  const os = fakeOs({ hostname: 'same' });
  const one = deriveServerId({ env: {}, os, fs: fakeFs({ '/etc/machine-id': 'id-one' }) });
  const two = deriveServerId({ env: {}, os, fs: fakeFs({ '/etc/machine-id': 'id-two' }) });
  assert.notEqual(one, two);
});

test('falls back to /var/lib/dbus/machine-id when /etc/machine-id is absent', () => {
  const r = resolveServerId({ env: {}, fs: fakeFs({ '/var/lib/dbus/machine-id': 'dbusid' }), os: fakeOs({}) });
  assert.equal(r.source, 'machine-id');
});

test('falls back to host attributes when no machine-id file exists', () => {
  const ifaces = {
    eth0: [{ mac: 'aa:bb:cc:dd:ee:ff', internal: false }],
    lo: [{ mac: '00:00:00:00:00:00', internal: true }],
  };
  const r = resolveServerId({ env: {}, fs: fakeFs({}), os: fakeOs({ ifaces }) });
  assert.equal(r.source, 'host-attributes');
  assert.match(r.serverId, /^be-[0-9a-f]{20}$/);
});

test('host-attributes basis ignores internal and zero MACs, sorts the rest', () => {
  const a = hostAttributes(fakeOs({ ifaces: {
    eth1: [{ mac: 'bb:bb:bb:bb:bb:bb', internal: false }],
    eth0: [{ mac: 'aa:aa:aa:aa:aa:aa', internal: false }],
    lo: [{ mac: '00:00:00:00:00:00', internal: true }],
  } }));
  const b = hostAttributes(fakeOs({ ifaces: {
    eth0: [{ mac: 'aa:aa:aa:aa:aa:aa', internal: false }],
    eth1: [{ mac: 'bb:bb:bb:bb:bb:bb', internal: false }],
  } }));
  assert.equal(a, b, 'interface ordering does not change the basis');
  assert.ok(a.includes('aa:aa:aa:aa:aa:aa') && a.includes('bb:bb:bb:bb:bb:bb'));
  assert.ok(!a.includes('00:00:00:00:00:00'));
});

test('different hosts with no machine-id derive different ids', () => {
  const one = deriveServerId({ env: {}, fs: fakeFs({}), os: fakeOs({ hostname: 'host-a', ifaces: { eth0: [{ mac: 'aa:aa:aa:aa:aa:aa', internal: false }] } }) });
  const two = deriveServerId({ env: {}, fs: fakeFs({}), os: fakeOs({ hostname: 'host-b', ifaces: { eth0: [{ mac: 'bb:bb:bb:bb:bb:bb', internal: false }] } }) });
  assert.notEqual(one, two);
});

test('readMachineId returns null when nothing is readable', () => {
  assert.equal(readMachineId(fakeFs({})), null);
});
