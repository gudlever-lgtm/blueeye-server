'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// Acknowledging a row on the Changes page (migration 115).
//
//   GET    /api/changes            — every row carries ackKey + acknowledgedAt
//   POST   /api/changes/ack {key}  — viewer+, the caller's own view
//   DELETE /api/changes/ack/:key   — undo; 404 when nothing to undo
//
// The rules this file protects: an ack is per user, it survives a reload, and a
// condition that happens AGAIN after it was acknowledged comes back.

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
const { ackKeyFor, makeEvent } = require('../src/changes/changeFeed');
const { isAcknowledged } = require('../src/routes/changes');

const minutesAgo = (n) => new Date(Date.now() - n * 60000);
const KEY = 'a'.repeat(64);

// Agent 7 went offline 30 min ago. Agent 9 has been silent for an hour, which
// the feed reports as a current-state row.
function agents(lastSeen9 = minutesAgo(60).toISOString()) {
  return [
    { id: 7, hostname: 'sw-core', display_name: 'Core switch', last_seen: new Date().toISOString(), capabilities: {} },
    { id: 9, hostname: 'pi', display_name: null, last_seen: lastSeen9, capabilities: {} },
  ];
}

function appWith({ usersRepo = makeUsersRepo(), transitions = null, agentList = agents(), ...rest } = {}) {
  return makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => agentList }),
    auditEventsRepo: makeAuditEventsRepo({
      findByActor: async () => transitions || [
        { id: 1, action: 'agent.offline', actorId: 7, lastSeenAt: minutesAgo(30).toISOString() },
      ],
    }),
    usersRepo,
    ...rest,
  });
}

const feed = (app, role = 'viewer', id = 1) =>
  request(app).get('/api/changes?window=24h').set('Authorization', authHeader(role, { id }));
const ack = (app, key, role = 'viewer', id = 1) =>
  request(app).post('/api/changes/ack').set('Authorization', authHeader(role, { id })).send({ key });
const unack = (app, key, role = 'viewer', id = 1) =>
  request(app).delete(`/api/changes/ack/${key}`).set('Authorization', authHeader(role, { id }));

// ------------------------------------------------------------------ the key
test('every feed row carries a 64-hex ackKey and starts unacknowledged', async () => {
  const res = await feed(appWith());
  assert.equal(res.status, 200);
  assert.ok(res.body.events.length >= 2);
  for (const e of res.body.events) {
    assert.match(e.ackKey, /^[0-9a-f]{64}$/);
    assert.equal(e.acknowledgedAt, null);
    assert.equal(e.stateKey, undefined, 'internal plumbing leaked into the response');
  }
  assert.equal(res.body.acknowledged, 0);
});

test('the ackKey is stable across reloads', async () => {
  const app = appWith();
  const a = (await feed(app)).body.events.map((e) => e.ackKey).sort();
  const b = (await feed(app)).body.events.map((e) => e.ackKey).sort();
  assert.deepEqual(a, b);
});

test('a silent agent that reports and goes silent again is a new key', () => {
  const row = (lastSeen) => makeEvent({
    timestamp: new Date(), source: 'agent', type: 'agent.heartbeat_stale', severity: 'WARN',
    summary: 's', agentId: 9, kind: 'agent_health', currentState: true, stateKey: lastSeen,
  });
  assert.equal(ackKeyFor(row('2026-09-20T10:00:00.000Z')), ackKeyFor(row('2026-09-20T10:00:00.000Z')));
  assert.notEqual(ackKeyFor(row('2026-09-20T10:00:00.000Z')), ackKeyFor(row('2026-09-21T10:00:00.000Z')));
});

test('non-collapsible rows (a config capture) key on the record, so one ack never covers the next', () => {
  const cfg = (id) => makeEvent({ timestamp: new Date(), source: 'config', type: 'config.captured', severity: 'INFO', summary: 's', refId: id, agentId: 3, kind: 'config' });
  assert.notEqual(ackKeyFor(cfg(1)), ackKeyFor(cfg(2)));
  const probe = (id) => makeEvent({ timestamp: new Date(), source: 'probe', type: 'probe.loss.degraded', severity: 'WARN', summary: 's', refId: id, agentId: 3, kind: 'probe', metric: 'loss' });
  assert.equal(ackKeyFor(probe(1)), ackKeyFor(probe(2)), 'repeats of one condition must share a key');
});

test('isAcknowledged: newer activity re-opens a transition row; a current-state row holds', () => {
  const at = new Date('2026-09-22T12:00:00.000Z');
  assert.equal(isAcknowledged({ timestamp: '2026-09-22T11:59:59.999Z' }, at), true);
  assert.equal(isAcknowledged({ timestamp: '2026-09-22T12:00:00.001Z' }, at), false);
  assert.equal(isAcknowledged({ timestamp: '2026-09-22T13:00:00.000Z', currentState: true }, at), true);
  assert.equal(isAcknowledged({ timestamp: '2026-09-22T11:00:00.000Z' }, undefined), false);
});

// ------------------------------------------------------------------ happy path
test('acknowledging a row marks it on the next load, for that user only', async () => {
  const usersRepo = makeUsersRepo();
  const app = appWith({ usersRepo });
  const row = (await feed(app)).body.events.find((e) => e.type === 'agent.offline');

  const res = await ack(app, row.ackKey);
  assert.equal(res.status, 200);
  assert.equal(res.body.key, row.ackKey);
  assert.ok(!Number.isNaN(Date.parse(res.body.acknowledgedAt)));

  const mine = (await feed(app)).body;
  assert.ok(mine.events.find((e) => e.ackKey === row.ackKey).acknowledgedAt);
  assert.equal(mine.acknowledged, 1);
  assert.ok(mine.groups.flatMap((g) => g.events).find((e) => e.ackKey === row.ackKey).acknowledgedAt,
    'the grouped copy disagrees with the flat list');

  const theirs = (await feed(app, 'viewer', 2)).body;
  assert.equal(theirs.events.find((e) => e.ackKey === row.ackKey).acknowledgedAt, null,
    'an acknowledgement leaked into another user\'s view');
});

test('a current-state row (silent agent) stays acknowledged although its timestamp is always now', async () => {
  const app = appWith();
  const row = (await feed(app)).body.events.find((e) => e.type === 'agent.heartbeat_stale');
  assert.ok(row, 'fixture should produce a stale-heartbeat row');
  assert.equal((await ack(app, row.ackKey)).status, 200);
  const again = (await feed(app)).body.events.find((e) => e.type === 'agent.heartbeat_stale');
  assert.ok(again.acknowledgedAt);
});

test('THE REOPEN RULE: the same condition happening again after the ack comes back', async () => {
  let transitions = [{ id: 1, action: 'agent.offline', actorId: 7, lastSeenAt: minutesAgo(30).toISOString() }];
  const usersRepo = makeUsersRepo();
  const app = makeApp({
    agentsRepo: makeAgentsRepo({ findAll: async () => agents(new Date().toISOString()) }),
    auditEventsRepo: makeAuditEventsRepo({ findByActor: async () => transitions }),
    usersRepo,
  });
  const row = (await feed(app)).body.events.find((e) => e.type === 'agent.offline');
  await ack(app, row.ackKey);
  assert.ok((await feed(app)).body.events.find((e) => e.type === 'agent.offline').acknowledgedAt);

  // It went offline again, after the ack (and inside the window, which ends now).
  await new Promise((r) => setTimeout(r, 5));
  transitions = [...transitions, { id: 2, action: 'agent.offline', actorId: 7, lastSeenAt: new Date().toISOString() }];
  const back = (await feed(app)).body.events.find((e) => e.type === 'agent.offline');
  assert.equal(back.ackKey, row.ackKey, 'a repeat must fold into the same row');
  assert.equal(back.acknowledgedAt, null, 'a new occurrence stayed hidden behind an old acknowledgement');
});

test('undo removes the acknowledgement (204), and a second undo is 404', async () => {
  const app = appWith();
  const row = (await feed(app)).body.events[0];
  await ack(app, row.ackKey);
  assert.equal((await unack(app, row.ackKey)).status, 204);
  assert.equal((await feed(app)).body.events.find((e) => e.ackKey === row.ackKey).acknowledgedAt, null);
  assert.equal((await unack(app, row.ackKey)).status, 404);
});

test('acknowledging is audited', async () => {
  const auditLogRepo = makeAuditLogRepo();
  const app = appWith({ auditLogRepo, auditLogger: createAuditLogger({ auditLogRepo }) });
  await ack(app, KEY);
  await unack(app, KEY);
  const actions = auditLogRepo.rows.map((r) => r.action);
  assert.ok(actions.includes('change_acknowledged'), actions.join(','));
  assert.ok(actions.includes('change_unacknowledged'), actions.join(','));
});

// ------------------------------------------------------------------ 401 / 403
test('401 without a token on every ack route', async () => {
  const app = appWith();
  assert.equal((await request(app).post('/api/changes/ack').send({ key: KEY })).status, 401);
  assert.equal((await request(app).delete(`/api/changes/ack/${KEY}`)).status, 401);
});

test('403 while the password must be changed', async () => {
  const app = appWith();
  const h = authHeader('viewer', { mustChangePassword: true });
  assert.equal((await request(app).post('/api/changes/ack').set('Authorization', h).send({ key: KEY })).status, 403);
  assert.equal((await request(app).delete(`/api/changes/ack/${KEY}`).set('Authorization', h)).status, 403);
});

test('viewer, operator and admin may all acknowledge their own view', async () => {
  const app = appWith();
  for (const role of ['viewer', 'operator', 'admin']) {
    assert.equal((await ack(app, KEY, role)).status, 200, role);
  }
});

// ------------------------------------------------------------------ 400 / 404
test('400 for a missing or malformed key', async () => {
  const app = appWith();
  for (const key of [undefined, '', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(65), 42, ['a']]) {
    assert.equal((await ack(app, key)).status, 400, `key=${JSON.stringify(key)}`);
  }
});

test('404 for undoing an ack that does not exist, whatever the key looks like', async () => {
  const app = appWith();
  for (const key of [KEY, 'abc', '999999']) {
    assert.equal((await unack(app, key)).status, 404, key);
  }
});

test('an unknown path under /api/changes is 404', async () => {
  const res = await request(appWith()).get('/api/changes/nope').set('Authorization', authHeader('viewer'));
  assert.equal(res.status, 404);
});

// ------------------------------------------------------------------ 500 / 503
test('500 when storing or removing the ack fails', async () => {
  const usersRepo = makeUsersRepo({ ackChange: throwingAsync(), unackChange: throwingAsync() });
  const app = appWith({ usersRepo });
  assert.equal((await ack(app, KEY)).status, 500);
  assert.equal((await unack(app, KEY)).status, 500);
});

test('a failing acknowledgement lookup degrades the feed to partial instead of a 500', async () => {
  const app = appWith({ usersRepo: makeUsersRepo({ listChangeAcks: throwingAsync() }) });
  const res = await feed(app);
  assert.equal(res.status, 200);
  assert.equal(res.body.partial, true);
  assert.ok(res.body.failedSources.includes('acknowledgements'));
  assert.ok(res.body.events.every((e) => e.acknowledgedAt === null));
});

test('503 when the deployment has no acknowledgement store', async () => {
  const usersRepo = makeUsersRepo();
  delete usersRepo.ackChange;
  const app = appWith({ usersRepo });
  assert.equal((await ack(app, KEY)).status, 503);
  assert.equal((await unack(app, KEY)).status, 503);
  assert.equal((await feed(app)).status, 200, 'the feed must not depend on it');
});
