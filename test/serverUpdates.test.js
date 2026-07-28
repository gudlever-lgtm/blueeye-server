'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const request = require('supertest');

const { makeApp, makeLicenseManager, makeSourceStore, authHeader } = require('../test-support/fakes');
const { createServerUpdateService } = require('../src/services/serverUpdateService');
const pkg = require('../package.json');

const viewer = () => authHeader('viewer');
const admin = () => authHeader('admin');
const operator = () => authHeader('operator');

// Release info as the license manager exposes it after a verified proof.
const releases = (over = {}) => ({
  server: { version: '99.0.0', releasedAt: '2026-07-20' },
  agent: { version: '99.1.0', releasedAt: null },
  checkedAt: '2026-07-28T09:00:00.000Z',
  ...over,
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blueeye-update-'));
}

// A spawn double: returns a child-like emitter and records how it was called.
function makeSpawn() {
  const calls = [];
  const impl = (command, args, options) => {
    const child = new EventEmitter();
    // A pid that is certainly alive (this test process), so the "is it still
    // running?" liveness check behaves like a real in-flight update.
    child.pid = process.pid;
    child.unref = () => {};
    calls.push({ command, args, options, child });
    return child;
  };
  impl.calls = calls;
  return impl;
}

// ---- GET /system/version: what the licence proof reported -------------------

test('GET /system/version reports a published server update as available', async () => {
  const app = makeApp({
    licenseManager: makeLicenseManager({ availableReleases: releases() }),
    agentSourceStore: makeSourceStore({ sourceVersion: () => '0.1.0' }),
  });
  const res = await request(app).get('/system/version').set('Authorization', viewer());

  assert.equal(res.status, 200);
  assert.equal(res.body.upstream.known, true);
  assert.equal(res.body.upstream.server.version, '99.0.0');
  assert.equal(res.body.upstream.server.releasedAt, '2026-07-20');
  assert.equal(res.body.upstream.serverUpdateAvailable, true);
  assert.equal(res.body.upstream.agentUpdateAvailable, true); // 99.1.0 > 0.1.0 source
  assert.equal(res.body.upstream.checkedAt, '2026-07-28T09:00:00.000Z');
});

test('GET /system/version reports no update when the published version is not newer', async () => {
  const app = makeApp({
    licenseManager: makeLicenseManager({
      availableReleases: releases({ server: { version: pkg.version, releasedAt: null }, agent: { version: '0.0.1', releasedAt: null } }),
    }),
    agentSourceStore: makeSourceStore({ sourceVersion: () => '0.1.0' }),
  });
  const res = await request(app).get('/system/version').set('Authorization', viewer());
  assert.equal(res.body.upstream.known, true);
  assert.equal(res.body.upstream.serverUpdateAvailable, false);
  assert.equal(res.body.upstream.agentUpdateAvailable, false);
});

test('GET /system/version says "unknown" when the licens server publishes nothing', async () => {
  // The pre-feature situation (older licens server): no claim either way, so the
  // dashboard shows nothing rather than guessing.
  const res = await request(makeApp()).get('/system/version').set('Authorization', viewer());
  assert.equal(res.body.upstream.known, false);
  assert.equal(res.body.upstream.serverUpdateAvailable, false);
  assert.equal(res.body.update.configured, false);
});

// ---- POST /system/server-update -------------------------------------------

test('POST /system/server-update is 503 when no update command is configured', async () => {
  const res = await request(makeApp()).post('/system/server-update').set('Authorization', admin());
  assert.equal(res.status, 503);
  assert.equal(res.body.configured, false);
  assert.match(res.body.error, /SERVER_UPDATE_COMMAND/);
});

test('POST /system/server-update requires an admin', async () => {
  const dir = tmpDir();
  const serverUpdateService = createServerUpdateService({
    command: '/opt/blueeye/deploy.sh',
    logPath: path.join(dir, 'update.log'),
    statePath: path.join(dir, 'state.json'),
    spawnImpl: makeSpawn(),
  });
  const app = makeApp({ serverUpdateService });
  assert.equal((await request(app).post('/system/server-update').set('Authorization', operator())).status, 403);
  assert.equal((await request(app).post('/system/server-update')).status, 401);
  assert.equal((await request(app).get('/system/server-update').set('Authorization', operator())).status, 403);
});

test('POST /system/server-update starts the configured command with the published target', async () => {
  const dir = tmpDir();
  const spawnImpl = makeSpawn();
  const serverUpdateService = createServerUpdateService({
    command: '/opt/blueeye/deploy.sh',
    args: ['--yes'],
    logPath: path.join(dir, 'update.log'),
    statePath: path.join(dir, 'state.json'),
    cwd: dir,
    spawnImpl,
  });
  const app = makeApp({
    serverUpdateService,
    licenseManager: makeLicenseManager({ availableReleases: releases() }),
  });

  const res = await request(app).post('/system/server-update').set('Authorization', admin());
  assert.equal(res.status, 202);
  assert.equal(res.body.running, true);
  assert.equal(res.body.targetVersion, '99.0.0');

  // Exactly the configured command — nothing from the request reaches argv, and
  // no shell is involved.
  assert.equal(spawnImpl.calls.length, 1);
  assert.equal(spawnImpl.calls[0].command, '/opt/blueeye/deploy.sh');
  assert.deepEqual(spawnImpl.calls[0].args, ['--yes']);
  assert.equal(spawnImpl.calls[0].options.shell, undefined);
  assert.equal(spawnImpl.calls[0].options.detached, true);
  assert.equal(spawnImpl.calls[0].options.env.BLUEEYE_UPDATE_TARGET_VERSION, '99.0.0');
});

test('a second update while one is running is refused with 409', async () => {
  const dir = tmpDir();
  const serverUpdateService = createServerUpdateService({
    command: '/opt/blueeye/deploy.sh',
    logPath: path.join(dir, 'update.log'),
    statePath: path.join(dir, 'state.json'),
    // A pid that is definitely alive: this test process.
    spawnImpl: () => Object.assign(new EventEmitter(), { pid: process.pid, unref() {} }),
  });
  const app = makeApp({ serverUpdateService });

  assert.equal((await request(app).post('/system/server-update').set('Authorization', admin())).status, 202);
  const second = await request(app).post('/system/server-update').set('Authorization', admin());
  assert.equal(second.status, 409);
  assert.equal(second.body.running, true);
});

test('GET /system/server-update returns the log tail and the run outcome', async () => {
  const dir = tmpDir();
  const logPath = path.join(dir, 'update.log');
  const spawnImpl = makeSpawn();
  const serverUpdateService = createServerUpdateService({
    command: '/opt/blueeye/deploy.sh', logPath, statePath: path.join(dir, 'state.json'), spawnImpl,
  });
  const app = makeApp({ serverUpdateService });

  await request(app).post('/system/server-update').set('Authorization', admin());
  fs.appendFileSync(logPath, 'pulling repos\ndone\n');
  spawnImpl.calls[0].child.emit('exit', 0, null);

  const res = await request(app).get('/system/server-update').set('Authorization', admin());
  assert.equal(res.status, 200);
  assert.equal(res.body.running, false);
  assert.equal(res.body.lastRun.outcome, 'success');
  assert.match(res.body.log, /pulling repos/);
});

test('a non-zero exit is reported as failed', async () => {
  const dir = tmpDir();
  const spawnImpl = makeSpawn();
  const serverUpdateService = createServerUpdateService({
    command: '/opt/blueeye/deploy.sh', logPath: path.join(dir, 'update.log'), statePath: path.join(dir, 'state.json'), spawnImpl,
  });
  const app = makeApp({ serverUpdateService });

  await request(app).post('/system/server-update').set('Authorization', admin());
  spawnImpl.calls[0].child.emit('exit', 2, null);

  const res = await request(app).get('/system/server-update').set('Authorization', admin());
  assert.equal(res.body.lastRun.outcome, 'failed');
  assert.equal(res.body.lastRun.exitCode, 2);
});

test('a run whose process vanished without an exit code is reported, not left "running"', async () => {
  // The normal case for a deploy that restarts this server: the process that
  // recorded the run is gone, so nothing ever wrote the exit code.
  const dir = tmpDir();
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    finishedAt: null, exitCode: null, pid: 999999999, requestedBy: 'admin@example.com', targetVersion: '99.0.0',
  }));
  const svc = createServerUpdateService({ command: '/opt/blueeye/deploy.sh', logPath: path.join(dir, 'update.log'), statePath });

  const status = svc.status();
  assert.equal(status.running, false);
  assert.equal(status.lastRun.outcome, 'ended');
  assert.match(status.lastRun.note, /restarts the server/);
});

test('the update service is inert without a configured command', () => {
  const svc = createServerUpdateService({});
  assert.equal(svc.isConfigured(), false);
  assert.deepEqual(svc.start({ requestedBy: 'admin' }), { started: false, reason: 'not_configured' });
  assert.equal(svc.status().command, null);
});
