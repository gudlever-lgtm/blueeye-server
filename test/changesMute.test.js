'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// "Mute this rule" on the Changes page (migration 116).
//
//   GET    /api/changes                   — every row carries muteKey + mutedUntil
//   POST   /api/changes/mute {key, hours} — viewer+, the caller's own view
//   DELETE /api/changes/mute/:key         — unmute; 404 when nothing live to undo
//
// The rules this file protects: a mute covers every row of one source + type on
// every host, only for the caller, and only until it runs out.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp,
  makeAgentsRepo,
  makeUsersRepo,
  makeAuditEventsRepo,
  makeAuditLogRepo,
  authHeader,
  throwingAsync,
} = require('../test-support/fakes');
const { createAuditLogger } = require('../src/services/complianceLogger');
const { muteKeyFor, makeEvent } = require('../src/changes/changeFeed');
const { MAX_MUTE_HOURS } = require('../src/routes/changes');

const minutesAgo = (n) => new Date(Date.now() - n * 60000);
const KEY = 'a'.repeat(64);

// Agents 7 and 8 both went offline — two rows of ONE rule (agent.offline) on
// two hosts — and agent 7 came back: a different rule (agent.online).
function appWith({ usersRepo = makeUsersRepo(), ...rest } = {}) {
  const now = new Date().toISOString();
  return makeApp({
    agentsRepo: makeAgentsRepo({
      findAll: async () => [
        { id: 7, hostname: 'sw-core', display_name: 'Core switch', last_seen: now, capabilities: {} },
        { id: 8, hostname: 'sw-edge', display_name: null, last_seen: now, capabilities: {} },
      ],
    }),
    auditEventsRepo: makeAuditEventsRepo({
      findByActor: async () => [
        { id: 1, action: 'agent.offline', actorId: 7, lastSeenAt: minutesAgo(30).toISOString() },
        { id: 2, action: 'agent.offline', actorId: 8, lastSeenAt: minutesAgo(25).toISOString() },
        { id: 3, action: 'agent.online', actorId: 7, lastSeenAt: minutesAgo(20).toISOString() },
      ],
    }),
    usersRepo,
    ...rest,
  });
}

const feed = (app, id = 1) =>
  request(app).get('/api/changes?window=24h').set('Authorization', authHeader('viewer', { id }));
const mute = (app, body, role = 'viewer', id = 1) =>
  request(app).post('/api/changes/mute').set('Authorization', authHeader(role, { id })).send(body);
const unmute = (app, key, role = 'viewer', id = 1) =>
  request(app).delete(`/api/changes/mute/${key}`).set('Authorization', authHeader(role, { id }));

// ------------------------------------------------------------------ the key
test('the muteKey is source + type: the same on every host, different per type', () => {
  const ev = (type, agentId, severity) => makeEvent({ timestamp: new Date(), source: 'agent', type, severity, summary: 's', agentId, kind: 'agent_state' });
  assert.equal(muteKeyFor(ev('agent.offline', 7, 'WARN')), muteKeyFor(ev('agent.offline', 8, 'CRIT')));
  assert.notEqual(muteKeyFor(ev('agent.offline', 7, 'WARN')), muteKeyFor(ev('agent.online', 7, 'WARN')));
  assert.match(muteKeyFor(ev('agent.offline', 7, 'WARN')), /^[0-9a-f]{64}$/);
});

test('every feed row carries a muteKey and starts unmuted', async () => {
  const res = await feed(appWith());
  assert.equal(res.status, 200);
  for (const e of res.body.events) {
    assert.match(e.muteKey, /^[0-9a-f]{64}$/);
    assert.equal(e.mutedUntil, null);
  }
  assert.equal(res.body.muted, 0);
});

// ------------------------------------------------------------------ happy path
test('muting a rule mutes it on every host, for 24h by default, for that user only', async () => {
  const app = appWith();
  const offline = (await feed(app)).body.events.find((e) => e.type === 'agent.offline');

  const before = Date.now();
  const res = await mute(app, { key: offline.muteKey });
  assert.equal(res.status, 200);
  assert.equal(res.body.key, offline.muteKey);
  const until = Date.parse(res.body.mutedUntil);
  assert.ok(Math.abs(until - (before + 24 * 3600 * 1000)) < 5000, 'default mute is not 24h');

  const mine = (await feed(app)).body;
  const muted = mine.events.filter((e) => e.mutedUntil);
  assert.deepEqual(muted.map((e) => e.type), ['agent.offline', 'agent.offline'], 'the mute did not cover both hosts');
  assert.equal(mine.events.find((e) => e.type === 'agent.online').mutedUntil, null, 'the mute spilled onto another rule');
  assert.equal(mine.muted, 2);

  const theirs = (await feed(app, 2)).body;
  assert.ok(theirs.events.every((e) => e.mutedUntil === null), 'a mute leaked into another user\'s view');
});

test('hours sets the length, 1..168', async () => {
  const app = appWith();
  const res = await mute(app, { key: KEY, hours: 2 });
  assert.equal(res.status, 200);
  assert.ok(Math.abs(Date.parse(res.body.mutedUntil) - (Date.now() + 2 * 3600 * 1000)) < 5000);
  assert.equal((await mute(app, { key: KEY, hours: MAX_MUTE_HOURS })).status, 200);
});

test('an expired mute mutes nothing and cannot be unmuted', async () => {
  const offlineKey = muteKeyFor({ source: 'agent', type: 'agent.offline' });
  const usersRepo = makeUsersRepo({ initialChangeMutes: { [`1|${offlineKey}`]: new Date(Date.now() - 1000).toISOString() } });
  const app = appWith({ usersRepo });
  assert.ok((await feed(app)).body.events.every((e) => e.mutedUntil === null));
  assert.equal((await unmute(app, offlineKey)).status, 404);
});

test('unmute (204) shows the rows again, and a second unmute is 404', async () => {
  const app = appWith();
  const offline = (await feed(app)).body.events.find((e) => e.type === 'agent.offline');
  await mute(app, { key: offline.muteKey });
  assert.equal((await unmute(app, offline.muteKey)).status, 204);
  assert.ok((await feed(app)).body.events.every((e) => e.mutedUntil === null));
  assert.equal((await unmute(app, offline.muteKey)).status, 404);
});

test('muting and unmuting are audited', async () => {
  const auditLogRepo = makeAuditLogRepo();
  const app = appWith({ auditLogRepo, auditLogger: createAuditLogger({ auditLogRepo }) });
  await mute(app, { key: KEY });
  await unmute(app, KEY);
  const actions = auditLogRepo.rows.map((r) => r.action);
  assert.ok(actions.includes('change_rule_muted'), actions.join(','));
  assert.ok(actions.includes('change_rule_unmuted'), actions.join(','));
});

// ------------------------------------------------------------------ 401 / 403
test('401 without a token on every mute route', async () => {
  const app = appWith();
  assert.equal((await request(app).post('/api/changes/mute').send({ key: KEY })).status, 401);
  assert.equal((await request(app).delete(`/api/changes/mute/${KEY}`)).status, 401);
});

test('403 while the password must be changed', async () => {
  const app = appWith();
  const h = authHeader('viewer', { mustChangePassword: true });
  assert.equal((await request(app).post('/api/changes/mute').set('Authorization', h).send({ key: KEY })).status, 403);
  assert.equal((await request(app).delete(`/api/changes/mute/${KEY}`).set('Authorization', h)).status, 403);
});

test('viewer, operator and admin may all mute their own view', async () => {
  const app = appWith();
  for (const role of ['viewer', 'operator', 'admin']) {
    assert.equal((await mute(app, { key: KEY }, role)).status, 200, role);
  }
});

// ------------------------------------------------------------------ 400 / 404
test('400 for a missing or malformed key', async () => {
  const app = appWith();
  for (const key of [undefined, '', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(65), 42, ['a']]) {
    assert.equal((await mute(app, { key })).status, 400, `key=${JSON.stringify(key)}`);
  }
});

test('400 for hours outside 1..168 or not an integer', async () => {
  const app = appWith();
  for (const hours of [0, -1, MAX_MUTE_HOURS + 1, 1.5, '24', true, 1e9]) {
    assert.equal((await mute(app, { key: KEY, hours })).status, 400, `hours=${JSON.stringify(hours)}`);
  }
});

test('404 for unmuting a rule that is not muted, whatever the key looks like', async () => {
  const app = appWith();
  for (const key of [KEY, 'abc', '999999']) {
    assert.equal((await unmute(app, key)).status, 404, key);
  }
});

// ------------------------------------------------------------------ 500 / 503
test('500 when storing or removing the mute fails', async () => {
  const app = appWith({ usersRepo: makeUsersRepo({ muteChange: throwingAsync(), unmuteChange: throwingAsync() }) });
  assert.equal((await mute(app, { key: KEY })).status, 500);
  assert.equal((await unmute(app, KEY)).status, 500);
});

test('a failing mute lookup degrades the feed to partial instead of a 500', async () => {
  const app = appWith({ usersRepo: makeUsersRepo({ listChangeMutes: throwingAsync() }) });
  const res = await feed(app);
  assert.equal(res.status, 200);
  assert.equal(res.body.partial, true);
  assert.ok(res.body.failedSources.includes('mutes'));
  assert.ok(res.body.events.every((e) => e.mutedUntil === null));
});

test('503 when the deployment has no mute store; the feed does not depend on it', async () => {
  const usersRepo = makeUsersRepo();
  delete usersRepo.muteChange;
  const app = appWith({ usersRepo });
  assert.equal((await mute(app, { key: KEY })).status, 503);
  assert.equal((await unmute(app, KEY)).status, 503);
  assert.equal((await feed(app)).status, 200);
});
