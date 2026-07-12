'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { diagnoseConnection } = require('../src/ws/connectionDiagnosis');

const NOW = Date.parse('2026-07-05T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const baseAgent = { id: 9, status: 'offline', last_seen: iso(60 * 60 * 1000) };
const liveBase = {
  connected: false,
  sockets: 0,
  session: null,
  licenseRejectedAt: null,
  authFailures: [],
  licenseAcceptsNew: true,
};

test('connected: live sockets win over everything else', () => {
  const d = diagnoseConnection({
    agent: { ...baseAgent, status: 'online' },
    live: { ...liveBase, connected: true, sockets: 1, session: { ip: '10.0.0.5', connectedAt: iso(1000), disconnectedAt: null, closeCode: null } },
    now: NOW,
  });
  assert.equal(d.connected, true);
  assert.equal(d.state, 'connected');
  assert.match(d.explanation, /1 live connection/);
});

test('license-blocked: a recent license rejection explains the disconnect', () => {
  const d = diagnoseConnection({
    agent: baseAgent,
    live: { ...liveBase, licenseRejectedAt: iso(30 * 1000), licenseAcceptsNew: false },
    now: NOW,
  });
  assert.equal(d.state, 'license-blocked');
  assert.match(d.explanation, /license/i);
  // The one server-side-fixable cause: hints point at the license, not the host.
  assert.ok(d.hints.some((h) => /license/i.test(h)));
});

test('license-blocked: an OLD rejection no longer counts as the cause', () => {
  const d = diagnoseConnection({
    agent: baseAgent,
    live: { ...liveBase, licenseRejectedAt: iso(30 * 60 * 1000) },
    now: NOW,
  });
  assert.notEqual(d.state, 'license-blocked');
});

test('auth-rejected: recent 401s from the agent last-known address', () => {
  const d = diagnoseConnection({
    agent: baseAgent,
    live: {
      ...liveBase,
      session: { ip: '10.0.0.5', connectedAt: iso(3600 * 1000), disconnectedAt: iso(600 * 1000), closeCode: 1006 },
      authFailures: [{ at: iso(20 * 1000), ip: '10.0.0.5' }, { at: iso(15 * 1000), ip: '10.0.0.5' }],
    },
    now: NOW,
  });
  assert.equal(d.state, 'auth-rejected');
  assert.match(d.explanation, /401/);
  assert.match(d.explanation, /10\.0\.0\.5/);
  assert.ok(d.hints.some((h) => /re-enroll/i.test(h)));
});

test('auth failures from OTHER addresses do not flip the verdict, but are noted', () => {
  const d = diagnoseConnection({
    agent: baseAgent,
    live: {
      ...liveBase,
      session: { ip: '10.0.0.5', connectedAt: iso(3600 * 1000), disconnectedAt: iso(600 * 1000), closeCode: 1006 },
      authFailures: [{ at: iso(20 * 1000), ip: '192.168.7.7' }],
    },
    now: NOW,
  });
  assert.equal(d.state, 'unreachable');
  assert.match(d.explanation, /192\.168\.7\.7/);
});

test('reconnecting: a fresh drop inside the backoff grace window', () => {
  const d = diagnoseConnection({
    agent: baseAgent,
    live: { ...liveBase, session: { ip: '10.0.0.5', connectedAt: iso(3600 * 1000), disconnectedAt: iso(10 * 1000), closeCode: 1006 } },
    now: NOW,
  });
  assert.equal(d.state, 'reconnecting');
  assert.match(d.explanation, /close code 1006/);
});

test('unreachable: offline past the grace window with no attempts seen', () => {
  const d = diagnoseConnection({
    agent: baseAgent,
    live: { ...liveBase, session: { ip: '10.0.0.5', connectedAt: iso(7200 * 1000), disconnectedAt: iso(3600 * 1000), closeCode: 1006 } },
    now: NOW,
  });
  assert.equal(d.state, 'unreachable');
  // The core architectural fact must be stated: the server cannot dial out.
  assert.match(d.explanation, /initiated by the agent/);
  assert.ok(d.hints.some((h) => /systemctl/.test(h)));
});

test('unreachable (windows): hints speak PowerShell / services, never systemctl', () => {
  const d = diagnoseConnection({
    agent: { ...baseAgent, platform: 'win32' },
    live: { ...liveBase, session: { ip: '10.0.0.5', connectedAt: iso(7200 * 1000), disconnectedAt: iso(3600 * 1000), closeCode: 1006 } },
    now: NOW,
  });
  assert.equal(d.state, 'unreachable');
  assert.ok(d.hints.some((h) => /Restart-Service|Get-Service|services\.msc/.test(h)));
  assert.ok(!d.hints.some((h) => /systemctl|journalctl/.test(h)));
});

test('never-connected (windows): install check names the Windows service, not systemctl', () => {
  const d = diagnoseConnection({
    agent: { id: 9, status: 'offline', last_seen: null, platform: 'win32' },
    live: { ...liveBase },
    now: NOW,
  });
  assert.equal(d.state, 'never-connected');
  assert.ok(d.hints.some((h) => /Get-Service|services\.msc/.test(h)));
  assert.ok(!d.hints.some((h) => /systemctl/.test(h)));
});

test('auth-rejected (windows): restart hint uses Restart-Service, not systemctl', () => {
  const d = diagnoseConnection({
    agent: { ...baseAgent, platform: 'win32' },
    live: {
      ...liveBase,
      session: { ip: '10.0.0.5', connectedAt: iso(3600 * 1000), disconnectedAt: iso(600 * 1000), closeCode: 1006 },
      authFailures: [{ at: iso(20 * 1000), ip: '10.0.0.5' }],
    },
    now: NOW,
  });
  assert.equal(d.state, 'auth-rejected');
  assert.ok(d.hints.some((h) => /re-enroll/i.test(h)));
  assert.ok(d.hints.some((h) => /Restart-Service/.test(h)));
  assert.ok(!d.hints.some((h) => /systemctl/.test(h)));
});

test('unreachable (macos): hints use launchctl, not systemctl', () => {
  const d = diagnoseConnection({
    agent: { ...baseAgent, platform: 'darwin' },
    live: { ...liveBase, session: { ip: '10.0.0.5', connectedAt: iso(7200 * 1000), disconnectedAt: iso(3600 * 1000), closeCode: 1006 } },
    now: NOW,
  });
  assert.equal(d.state, 'unreachable');
  assert.ok(d.hints.some((h) => /launchctl/.test(h)));
  assert.ok(!d.hints.some((h) => /systemctl/.test(h)));
});

test('unreachable (docker-managed linux): hints use docker, not systemctl', () => {
  const d = diagnoseConnection({
    agent: { ...baseAgent, platform: 'linux', capabilities: { managed: 'docker' } },
    live: { ...liveBase, session: { ip: '10.0.0.5', connectedAt: iso(7200 * 1000), disconnectedAt: iso(3600 * 1000), closeCode: 1006 } },
    now: NOW,
  });
  assert.equal(d.state, 'unreachable');
  assert.ok(d.hints.some((h) => /docker/.test(h)));
  assert.ok(!d.hints.some((h) => /systemctl/.test(h)));
});

test('linux systemd remains the default when platform is absent', () => {
  const d = diagnoseConnection({
    agent: { ...baseAgent, platform: 'linux' },
    live: { ...liveBase, session: { ip: '10.0.0.5', connectedAt: iso(7200 * 1000), disconnectedAt: iso(3600 * 1000), closeCode: 1006 } },
    now: NOW,
  });
  assert.equal(d.state, 'unreachable');
  assert.ok(d.hints.some((h) => /systemctl/.test(h)));
});

test('never-connected: no last_seen and no session', () => {
  const d = diagnoseConnection({
    agent: { id: 9, status: 'offline', last_seen: null },
    live: { ...liveBase },
    now: NOW,
  });
  assert.equal(d.state, 'never-connected');
});

test('works without live evidence (WS hub not available)', () => {
  const d = diagnoseConnection({ agent: baseAgent, live: null, now: NOW });
  assert.equal(d.connected, false);
  assert.equal(d.state, 'unreachable');
  assert.ok(Array.isArray(d.evidence) && d.evidence.length > 0);
});

test('every verdict carries explanation + evidence + hints', () => {
  const variants = [
    { agent: baseAgent, live: { ...liveBase, connected: true, sockets: 2 }, now: NOW },
    { agent: baseAgent, live: { ...liveBase, licenseRejectedAt: iso(1000) }, now: NOW },
    { agent: baseAgent, live: null, now: NOW },
    { agent: { id: 9, status: 'offline', last_seen: null }, live: { ...liveBase }, now: NOW },
  ];
  for (const v of variants) {
    const d = diagnoseConnection(v);
    assert.equal(typeof d.explanation, 'string');
    assert.ok(d.explanation.length > 20);
    assert.ok(Array.isArray(d.evidence) && d.evidence.length > 0);
    assert.ok(Array.isArray(d.hints) && d.hints.length > 0);
  }
});
