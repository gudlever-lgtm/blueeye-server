'use strict';

// Storage contract for recordings. The specs that matter here are about what the
// SQL is allowed to do with a capture token and with the operator's raw
// observations — the rest of the module trusts these two guarantees.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { makeFakePool, ok, rows } = require('./fakePool');
const { createRecordingsRepository } = require('../recordingsRepository');

const NOW = new Date('2026-09-11T10:00:00Z');
const row = (over = {}) => ({
  id: 1, application_id: 1, name: 'Customer Login', status: 'recording',
  events: '[]', event_count: 0, base_url: 'https://customer.example.com',
  created_test_id: null, created_by: 1, expires_at: new Date('2026-09-11T10:30:00Z'),
  last_event_at: null, created_at: NOW, updated_at: NOW, ...over,
});

function repo(handlers = []) {
  // A test's own handlers come FIRST: the fake matches in order, so the default
  // below is a fallback rather than a shadow.
  const pool = makeFakePool([
    ...handlers,
    [/^SELECT .* FROM service_test_recordings r LEFT JOIN service_test_applications .* WHERE r\.id = \?/i, () => rows([row()])],
  ]);
  return { pool, repo: createRecordingsRepository({ db: { pool }, now: () => NOW }) };
}

test('the token is stored as a hash, never as itself', async () => {
  const { pool, repo: r } = repo([[/^INSERT INTO service_test_recordings/i, () => ok({ insertId: 1 })]]);
  const { token } = await r.start({ applicationId: 1, name: 'Customer Login' });

  const insert = pool.matching(/^INSERT INTO service_test_recordings/i)[0];
  assert.ok(!insert.params.includes(token), 'the plaintext token was written to the table');
  assert.ok(insert.params.includes(crypto.createHash('sha256').update(token).digest('hex')));
  assert.ok(token.length >= 40, 'the token must be long enough to be unguessable');
});

test('a token only resolves while the recording is live — never for a stopped or expired one', async () => {
  const { pool, repo: r } = repo([[/^SELECT .* FROM service_test_recordings r LEFT JOIN .* WHERE r\.token_hash = \?/i, () => rows([row()])]]);
  await r.findByToken('some-token');
  const select = pool.matching(/WHERE r\.token_hash = \?/i)[0];
  assert.match(select.sql, /r\.status = 'recording'/, 'a stopped recording must not accept events');
  assert.match(select.sql, /r\.expires_at > \?/, 'an abandoned recording must not stay open');
  assert.ok(select.params.includes(crypto.createHash('sha256').update('some-token').digest('hex')));

  assert.equal(await r.findByToken(''), null);
  assert.equal(await r.findByToken(null), null);
});

test('appending is bounded, so a runaway recorder cannot grow one column without limit', async () => {
  const stored = Array.from({ length: 1990 }, (_, i) => ({ kind: 'click', at: i }));
  const { pool, repo: r } = repo([
    [/^SELECT .* FROM service_test_recordings r LEFT JOIN service_test_applications .* WHERE r\.id = \?/i, () => rows([row({ events: JSON.stringify(stored) })])],
    [/^UPDATE service_test_recordings SET events/i, () => ok()],
  ]);
  await r.appendEvents(1, Array.from({ length: 100 }, (_, i) => ({ kind: 'click', at: 2000 + i })));

  const update = pool.matching(/^UPDATE service_test_recordings SET events/i)[0];
  const written = JSON.parse(update.params[0]);
  assert.equal(written.length, 2000, 'the cap must hold');
  assert.equal(written[written.length - 1].at, 2099, 'the newest events are the ones kept');
  assert.match(update.sql, /status = 'recording'/, 'a stopped recording must not be appended to');
  assert.equal(update.params[1], 2000, 'event_count must match what was written');
});

test('accepting clears the raw capture — the test is the artefact now', async () => {
  const { pool, repo: r } = repo([[/^UPDATE service_test_recordings SET status = 'accepted'/i, () => ok()]]);
  await r.accept(1, 42);
  const update = pool.matching(/status = 'accepted'/i)[0];
  assert.deepEqual(JSON.parse(update.params[1]), [], 'the observations outlived the recording');
  assert.equal(update.params[0], 42);
});

test('the purge only ever removes abandoned recordings', async () => {
  const { pool, repo: r } = repo([[/^DELETE FROM service_test_recordings WHERE status/i, () => ok({ affectedRows: 3 })]]);
  assert.equal(await r.purgeExpired(), 3);
  const del = pool.matching(/^DELETE FROM service_test_recordings WHERE status/i)[0];
  assert.match(del.sql, /status = 'recording'/, 'an accepted recording must survive the purge');
  assert.match(del.sql, /expires_at < \?/);
});

test('the shaped row never carries the token hash back out', async () => {
  const { repo: r } = repo();
  const found = await r.findById(1);
  assert.equal(found.token_hash, undefined);
  assert.deepEqual(found.events, []);
  // A row whose JSON is unreadable degrades to an empty recording rather than
  // throwing on the way to a screen.
  const { repo: broken } = repo([[/^SELECT .* WHERE r\.id = \?/i, () => rows([row({ events: '{not json' })])]]);
  assert.deepEqual((await broken.findById(1)).events, []);
});

test('the list is bounded and filters do not reach the SQL as text', async () => {
  const { pool, repo: r } = repo([[/^SELECT .* FROM service_test_recordings r LEFT JOIN/i, () => rows([row()])]]);
  await r.list({ applicationId: 7, status: 'stopped', limit: 100000 });
  const select = pool.matching(/ORDER BY r\.created_at DESC/i)[0];
  assert.match(select.sql, /LIMIT 200/, 'the limit must be clamped');
  assert.deepEqual(select.params, [7, 'stopped'], 'filters must be parameters, not interpolated');
  assert.match(select.sql, /LEFT JOIN service_test_applications/i, 'the list must name the application');
});
