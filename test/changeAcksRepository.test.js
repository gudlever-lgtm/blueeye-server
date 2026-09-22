'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// usersRepository's Changes-page acknowledgements (migration 115), against a
// scripted pool: the statement and its parameters are the contract.
// scripts/verify-repositories-against-mysql.js runs the same calls on MySQL.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createUsersRepository, CHANGE_ACK_TTL_DAYS } = require('../src/repositories/usersRepository');
const { MAX_WINDOW_MS } = require('../src/routes/changes');

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

const KEY = 'b'.repeat(64);

test('an acknowledgement lasts exactly as long as the longest window the page can show', () => {
  assert.equal(CHANGE_ACK_TTL_DAYS * 24 * 3600 * 1000, MAX_WINDOW_MS);
});

test('listChangeAcks reads only the caller\'s live acknowledgements into a Map', async () => {
  const at = new Date('2026-09-22T10:00:00.123Z');
  const pool = fakePool((sql, params) => {
    assert.match(sql, /FROM change_acks/);
    assert.match(sql, /WHERE user_id = \? AND acked_at >= \(NOW\(3\) - INTERVAL 30 DAY\)/);
    assert.deepEqual(params, [4]);
    return [[{ ack_key: KEY, acked_at: at }, { ack_key: 'c'.repeat(64), acked_at: '2026-09-21T10:00:00.000Z' }]];
  });
  const acks = await createUsersRepository({ pool }).listChangeAcks(4);
  assert.equal(acks.size, 2);
  assert.equal(acks.get(KEY).getTime(), at.getTime());
  assert.ok(acks.get('c'.repeat(64)) instanceof Date);
});

test('ackChange upserts, then prunes the caller\'s expired rows', async () => {
  const at = new Date('2026-09-22T10:00:00.000Z');
  const pool = fakePool(() => [{ affectedRows: 1 }]);
  assert.equal(await createUsersRepository({ pool }).ackChange(4, KEY, at), at);
  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].sql, /INSERT INTO change_acks \(user_id, ack_key, acked_at\) VALUES \(\?, \?, \?\) ON DUPLICATE KEY UPDATE acked_at = VALUES\(acked_at\)/);
  assert.deepEqual(pool.calls[0].params, [4, KEY, at]);
  assert.match(pool.calls[1].sql, /DELETE FROM change_acks WHERE user_id = \? AND acked_at < \(NOW\(3\) - INTERVAL 30 DAY\)/);
  assert.deepEqual(pool.calls[1].params, [4]);
});

test('unackChange deletes one row and reports whether there was one', async () => {
  let affected = 1;
  const pool = fakePool((sql, params) => {
    assert.match(sql, /DELETE FROM change_acks WHERE user_id = \? AND ack_key = \?/);
    assert.deepEqual(params, [4, KEY]);
    return [{ affectedRows: affected }];
  });
  const repo = createUsersRepository({ pool });
  assert.equal(await repo.unackChange(4, KEY), true);
  affected = 0;
  assert.equal(await repo.unackChange(4, KEY), false);
});

// ---------------------------------------------------------------- mutes (116)
test('listChangeMutes reads only the caller\'s LIVE mutes', async () => {
  const until = new Date('2026-09-23T10:00:00.000Z');
  const pool = fakePool((sql, params) => {
    assert.match(sql, /SELECT mute_key, muted_until FROM change_mutes WHERE user_id = \? AND muted_until > NOW\(3\)/);
    assert.deepEqual(params, [4]);
    return [[{ mute_key: KEY, muted_until: until }]];
  });
  const mutes = await createUsersRepository({ pool }).listChangeMutes(4);
  assert.equal(mutes.get(KEY).getTime(), until.getTime());
});

test('muteChange upserts the end time, then prunes the caller\'s expired mutes', async () => {
  const until = new Date('2026-09-23T10:00:00.000Z');
  const pool = fakePool(() => [{ affectedRows: 1 }]);
  assert.equal(await createUsersRepository({ pool }).muteChange(4, KEY, until), until);
  assert.match(pool.calls[0].sql, /INSERT INTO change_mutes \(user_id, mute_key, muted_until\) VALUES \(\?, \?, \?\) ON DUPLICATE KEY UPDATE muted_until = VALUES\(muted_until\)/);
  assert.deepEqual(pool.calls[0].params, [4, KEY, until]);
  assert.match(pool.calls[1].sql, /DELETE FROM change_mutes WHERE user_id = \? AND muted_until <= NOW\(3\)/);
  assert.deepEqual(pool.calls[1].params, [4]);
});

test('unmuteChange removes only a live mute and reports whether there was one', async () => {
  let affected = 1;
  const pool = fakePool((sql, params) => {
    assert.match(sql, /DELETE FROM change_mutes WHERE user_id = \? AND mute_key = \? AND muted_until > NOW\(3\)/);
    assert.deepEqual(params, [4, KEY]);
    return [{ affectedRows: affected }];
  });
  const repo = createUsersRepository({ pool });
  assert.equal(await repo.unmuteChange(4, KEY), true);
  affected = 0;
  assert.equal(await repo.unmuteChange(4, KEY), false);
});
