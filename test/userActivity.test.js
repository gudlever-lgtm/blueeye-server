'use strict';

// Unit tests for the User Logs read model (src/audit/userActivity.js) — pure,
// no HTTP. The flag rules are the point: each one has to fire when it should,
// stay quiet when it shouldn't, and say why.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUserActivity, describeAction, flagsFor, isUserEntry, splitAction, summarize,
  FAILED_LOGIN_BURST,
} = require('../src/audit/userActivity');

// A canonical entry (the shape audit/categories.js produces).
function entry(over = {}) {
  return {
    source: 'events',
    id: over.id || `events:${Math.random()}`,
    ts: over.ts || '2026-09-13T10:00:00.000Z',
    category: over.category ?? 'user',
    action: over.action ?? 'user.update',
    outcome: over.outcome ?? 'success',
    actor: { type: 'user', id: 7, label: 'lars@example.dk', role: 'admin', ...(over.actor || {}) },
    target: { type: 'user', id: '9', label: 'someone@example.dk', ...(over.target || {}) },
    ip: over.ip ?? '10.0.0.5',
    detail: over.detail ?? null,
    method: over.method ?? 'PUT',
    path: over.path ?? '/users/9',
    status: over.status === undefined ? 200 : over.status,
    occurrences: over.occurrences ?? 1,
  };
}

// ---- shape -----------------------------------------------------------------

test('only user-caused entries are kept — agent and system activity is not user activity', () => {
  const rows = buildUserActivity([
    entry(),
    entry({ actor: { type: 'agent', id: 1, label: 'srv-01' } }),
    entry({ actor: { type: 'system', id: null, label: 'scheduler' } }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(isUserEntry(entry({ actor: { type: 'agent' } })), false);
});

test('a row carries user id, name, email, timestamp and the action', () => {
  const [row] = buildUserActivity([entry()], {
    directory: { 7: { name: 'Lars Hansen', email: 'lars@example.dk', role: 'admin' } },
  });
  assert.equal(row.userId, 7);
  assert.equal(row.name, 'Lars Hansen');
  assert.equal(row.email, 'lars@example.dk');
  assert.equal(row.ts, '2026-09-13T10:00:00.000Z');
  assert.equal(row.action, 'user.update');
  assert.equal(row.actionLabel, 'Updated user');
  assert.equal(row.deletedUser, false);
});

test('a user deleted since is marked, and still shows the address that acted', () => {
  const [row] = buildUserActivity([entry()], { directory: { 1: { name: 'Someone else', email: 'x@y.dk' } } });
  assert.equal(row.deletedUser, true);
  assert.equal(row.name, null);
  assert.equal(row.email, 'lars@example.dk');
});

test('rows come back newest-first', () => {
  const rows = buildUserActivity([
    entry({ id: 'a', ts: '2026-09-13T08:00:00.000Z' }),
    entry({ id: 'c', ts: '2026-09-13T12:00:00.000Z' }),
    entry({ id: 'b', ts: '2026-09-13T10:00:00.000Z' }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['c', 'b', 'a']);
});

test('describeAction turns both action spellings into plain language', () => {
  assert.equal(describeAction('user.create'), 'Created user');
  assert.equal(describeAction('user_create'), 'Created user');
  assert.equal(describeAction('auth.login'), 'Signed in');
  assert.equal(describeAction('agent.delete'), 'Deleted agent');
  assert.equal(describeAction('licence_upload'), 'Uploaded licence');
  // An action nobody mapped stays readable rather than going blank.
  assert.equal(describeAction('widget.frobnicate'), 'widget — frobnicate');
  assert.equal(describeAction(null), '—');
  assert.deepEqual(splitAction('user.create'), { resource: 'user', verb: 'create', rest: [] });
});

// ---- flag rules ------------------------------------------------------------

test('an action the role was not allowed to perform is flagged critical', () => {
  const { level, flags } = flagsFor(entry({ outcome: 'denied', status: 403 }));
  assert.equal(level, 'critical');
  assert.ok(flags.some((f) => f.code === 'denied'));
  assert.match(flags.find((f) => f.code === 'denied').message, /role does not allow/);
});

test('a 5xx is flagged as possibly half-applied; a 4xx as rejected', () => {
  assert.equal(flagsFor(entry({ status: 500, outcome: 'failure' })).flags[0].code, 'server-error');
  assert.match(flagsFor(entry({ status: 500, outcome: 'failure' })).flags[0].message, /half-applied/);
  assert.equal(flagsFor(entry({ status: 404, outcome: 'failure' })).flags[0].code, 'rejected');
  assert.match(flagsFor(entry({ status: 404 })).flags[0].message, /HTTP 404/);
});

test('a plain successful action is not flagged', () => {
  const { level, flags } = flagsFor(entry({ action: 'location.update', path: '/locations/2' }));
  assert.equal(level, 'none');
  assert.deepEqual(flags, []);
});

test('a delete is flagged as irreversible even when it succeeded', () => {
  const { level, flags } = flagsFor(entry({ action: 'location.delete', method: 'DELETE' }));
  assert.equal(level, 'notice');
  assert.ok(flags.some((f) => f.code === 'destructive'));
});

test('actions that change access or trust are flagged for review', () => {
  for (const action of ['user.update', 'api-token.create', 'license_upload', 'ldap.update']) {
    const { flags } = flagsFor(entry({ action }));
    assert.ok(flags.some((f) => f.code === 'privileged'), action);
  }
  // A normal sign-in is not "a privilege change" just because auth matches.
  assert.equal(flagsFor(entry({ action: 'auth.login', status: 200 })).level, 'none');
});

test(`${FAILED_LOGIN_BURST} failed sign-ins inside the window are flagged as a burst`, () => {
  const at = (m) => `2026-09-13T10:0${m}:00.000Z`;
  const rows = buildUserActivity([
    entry({ id: '1', action: 'auth.login', outcome: 'failure', status: 401, ts: at(0) }),
    entry({ id: '2', action: 'auth.login', outcome: 'failure', status: 401, ts: at(1) }),
    entry({ id: '3', action: 'auth.login', outcome: 'failure', status: 401, ts: at(2) }),
  ]);
  // Newest-first: the third failure is the one that completes the burst.
  assert.equal(rows[0].flagLevel, 'critical');
  assert.ok(rows[0].flags.some((f) => f.code === 'failed-login-burst'));
  assert.equal(rows[2].flags.some((f) => f.code === 'failed-login-burst'), false);
});

test('failed sign-ins spread beyond the window are not a burst', () => {
  const rows = buildUserActivity([
    entry({ id: '1', action: 'auth.login', outcome: 'failure', status: 401, ts: '2026-09-13T08:00:00.000Z' }),
    entry({ id: '2', action: 'auth.login', outcome: 'failure', status: 401, ts: '2026-09-13T09:00:00.000Z' }),
    entry({ id: '3', action: 'auth.login', outcome: 'failure', status: 401, ts: '2026-09-13T10:00:00.000Z' }),
  ]);
  assert.equal(rows.every((r) => !r.flags.some((f) => f.code === 'failed-login-burst')), true);
});

test("one user's failures do not build a burst on another user's account", () => {
  const login = (id, actorId, ts) => entry({ id, action: 'auth.login', outcome: 'failure', status: 401, ts, actor: { type: 'user', id: actorId, label: `u${actorId}@x.dk` } });
  const rows = buildUserActivity([
    login('1', 1, '2026-09-13T10:00:00.000Z'),
    login('2', 2, '2026-09-13T10:01:00.000Z'),
    login('3', 3, '2026-09-13T10:02:00.000Z'),
  ]);
  assert.equal(rows.some((r) => r.flags.some((f) => f.code === 'failed-login-burst')), false);
});

test('a sign-in from an address the account has not used here is flagged, but never the first row', () => {
  const rows = buildUserActivity([
    entry({ id: '1', action: 'auth.login', ip: '10.0.0.5', ts: '2026-09-13T09:00:00.000Z' }),
    entry({ id: '2', action: 'auth.login', ip: '203.0.113.9', ts: '2026-09-13T09:30:00.000Z' }),
  ]);
  assert.ok(rows[0].flags.some((f) => f.code === 'new-address'));
  assert.match(rows[0].flags.find((f) => f.code === 'new-address').message, /203\.0\.113\.9/);
  assert.equal(rows[1].flags.length, 0);
});

test('every flag carries an explanation', () => {
  const rows = buildUserActivity([
    entry({ action: 'user.delete', method: 'DELETE' }),
    entry({ outcome: 'denied', status: 403 }),
    entry({ status: 500, outcome: 'failure' }),
  ]);
  for (const row of rows) {
    for (const flag of row.flags) {
      assert.ok(flag.code && flag.level && flag.message, JSON.stringify(flag));
      assert.ok(flag.message.length > 10, flag.message);
    }
  }
});

test('the summary counts rows, flags by level and distinct users', () => {
  const rows = buildUserActivity([
    entry({ id: '1' }),
    entry({ id: '2', outcome: 'denied', status: 403 }),
    entry({ id: '3', action: 'location.delete', actor: { type: 'user', id: 8, label: 'b@x.dk' } }),
    entry({ id: '4', action: 'location.update', status: 502, outcome: 'failure' }),
  ]);
  const s = summarize(rows);
  assert.equal(s.total, 4);
  assert.equal(s.critical, 1);
  assert.equal(s.warn, 1);
  assert.equal(s.notice, 2); // the delete, plus the privileged user.update
  assert.equal(s.flagged, 4);
  assert.equal(s.users, 2);
});

test('limit trims from the newest end', () => {
  const rows = buildUserActivity([
    entry({ id: 'a', ts: '2026-09-13T08:00:00.000Z' }),
    entry({ id: 'b', ts: '2026-09-13T09:00:00.000Z' }),
  ], { limit: 1 });
  assert.deepEqual(rows.map((r) => r.id), ['b']);
});
