'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAlertDispatchLogRepository } = require('../src/repositories/alertDispatchLogRepository');

// A minimal fake pool: returns canned rows and records the last SQL + params.
function fakePool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return handler(sql, params, calls.length);
    },
  };
}

test('record inserts a row and returns the new id', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /INSERT INTO alert_dispatch_log/);
    assert.deepEqual(params.slice(0, 2), ['finding', 'f-1']);
    return [{ insertId: 5 }];
  });
  const repo = createAlertDispatchLogRepository({ pool });
  const id = await repo.record({ subjectType: 'finding', subjectId: 'f-1', hostId: 9, metric: 'cpu', severity: 'WARN', channels: 'syslog', sentAt: new Date() });
  assert.equal(id, 5);
});

test('existsForCluster queries the cluster subject and returns a boolean', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /subject_type = 'cluster'/);
    assert.deepEqual(params, ['7']);
    return [[{ 1: 1 }]];
  });
  const repo = createAlertDispatchLogRepository({ pool });
  assert.equal(await repo.existsForCluster(7), true);

  const empty = createAlertDispatchLogRepository({ pool: fakePool(() => [[]]) });
  assert.equal(await empty.existsForCluster(7), false);
});

test('listAlertedFindings returns [] for empty input without querying', async () => {
  let queried = false;
  const repo = createAlertDispatchLogRepository({ pool: fakePool(() => { queried = true; return [[]]; }) });
  assert.deepEqual(await repo.listAlertedFindings([]), []);
  assert.equal(queried, false);
});

test('listAlertedFindings returns the subset of finding ids that were alerted', async () => {
  const pool = fakePool((sql, params) => {
    assert.match(sql, /subject_type = 'finding'/);
    assert.match(sql, /IN \(\?, \?\)/);
    assert.deepEqual(params, ['a', 'b']);
    return [[{ subject_id: 'a' }]]; // only 'a' was alerted
  });
  const repo = createAlertDispatchLogRepository({ pool });
  assert.deepEqual(await repo.listAlertedFindings(['a', 'b']), ['a']);
});
