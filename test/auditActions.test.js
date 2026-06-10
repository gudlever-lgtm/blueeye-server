'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { describeRequest, redactBody, isSecretKey, isMutating } = require('../src/audit/actions');

// ---- describeRequest -------------------------------------------------------

test('describeRequest maps login', () => {
  const d = describeRequest('POST', '/auth/login');
  assert.equal(d.action, 'auth.login');
  assert.equal(d.targetType, 'session');
});

test('describeRequest maps resource CRUD with verb + id', () => {
  assert.equal(describeRequest('POST', '/users').action, 'user.create');
  assert.equal(describeRequest('PUT', '/users/7').action, 'user.update');
  const del = describeRequest('DELETE', '/users/7');
  assert.equal(del.action, 'user.delete');
  assert.equal(del.targetType, 'user');
  assert.equal(del.targetId, '7');
});

test('describeRequest names agent sub-actions', () => {
  const d = describeRequest('POST', '/agents/5/run-test');
  assert.equal(d.action, 'agent.run-test');
  assert.equal(d.targetType, 'agent');
  assert.equal(d.targetId, '5');
  assert.equal(describeRequest('POST', '/agents/5/probe').action, 'agent.probe');
  assert.equal(describeRequest('DELETE', '/agents/5').action, 'agent.delete');
});

test('describeRequest strips /api and keeps the settings sub-area as target', () => {
  const d = describeRequest('PUT', '/api/settings/map');
  assert.equal(d.action, 'settings.update');
  assert.equal(d.targetType, 'map');
});

test('describeRequest carries the nis2 kind + id', () => {
  const d = describeRequest('PUT', '/api/nis2/risks/12');
  assert.equal(d.action, 'nis2.update');
  assert.equal(d.targetType, 'risks');
  assert.equal(d.targetId, '12');
});

test('describeRequest handles query strings and trailing slashes', () => {
  assert.equal(describeRequest('POST', '/users/?foo=1').action, 'user.create');
});

// ---- redactBody ------------------------------------------------------------

test('redactBody removes secret-looking fields', () => {
  const out = redactBody({ email: 'a@b.c', password: 'hunter2', apiKey: 'x', role: 'admin' });
  assert.equal(out.email, 'a@b.c');
  assert.equal(out.role, 'admin');
  assert.equal(out.password, '[redacted]');
  assert.equal(out.apiKey, '[redacted]');
});

test('redactBody summarises nested objects/arrays and caps long strings', () => {
  const out = redactBody({ config: { a: 1 }, list: [1, 2, 3], note: 'x'.repeat(300) });
  assert.equal(out.config, '[object]');
  assert.equal(out.list, '[array(3)]');
  assert.ok(out.note.length <= 201 && out.note.endsWith('…'));
});

test('redactBody returns null for non-objects/empty', () => {
  assert.equal(redactBody(null), null);
  assert.equal(redactBody('nope'), null);
  assert.equal(redactBody([1, 2]), null);
  assert.equal(redactBody({}), null);
});

test('isSecretKey catches common secret names; isMutating only POST/PUT/PATCH/DELETE', () => {
  for (const k of ['password', 'currentPassword', 'token', 'bindPassword', 'tileApiKey', 'key']) {
    assert.equal(isSecretKey(k), true, k);
  }
  assert.equal(isSecretKey('email'), false);
  assert.equal(isMutating('GET'), false);
  assert.equal(isMutating('post'), true);
  assert.equal(isMutating('DELETE'), true);
});
