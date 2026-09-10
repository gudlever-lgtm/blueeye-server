'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakePool, ok } = require('./fakePool');
const { createCredentialsRepository } = require('../credentialsRepository');
const { createSecretBox } = require('../../../lib/secretBox');

const secretBox = createSecretBox({ key: 'test-key-for-service-test-credentials' });
const PASSWORD = 'hunter2-correct-horse';

function row(over = {}) {
  return {
    id: 1,
    tenant_id: null,
    application_id: 3,
    label: 'Portal test user',
    username: 'svc-test',
    secret_encrypted: secretBox.encrypt(PASSWORD),
    created_by: 9,
    created_at: new Date('2026-09-01T10:00:00Z'),
    updated_at: new Date('2026-09-01T10:00:00Z'),
    ...over,
  };
}

const selectOne = [/^SELECT .* FROM service_test_credentials WHERE id = \?/i, () => [[row()]]];
const selectList = [/^SELECT .* FROM service_test_credentials WHERE application_id = \?/i, () => [[row(), row({ id: 2, label: 'Admin user' })]]];

// The security property this whole file exists to pin down.
test('no read path returns the password — list() and findById() report only that one is stored', async () => {
  const pool = makeFakePool([selectOne, selectList]);
  const repo = createCredentialsRepository({ db: { pool }, secretBox });

  const one = await repo.findById(1);
  const many = await repo.list({ applicationId: 3 });

  for (const shaped of [one, ...many]) {
    assert.equal(shaped.has_secret, true);
    assert.equal(shaped.secret, undefined, 'plaintext must never be shaped into a read');
    assert.equal(shaped.secret_encrypted, undefined, 'not even the ciphertext leaves the repository');
    assert.ok(!JSON.stringify(shaped).includes(PASSWORD));
  }
});

test('findByIdWithSecret() is the only path that decrypts', async () => {
  const pool = makeFakePool([selectOne]);
  const repo = createCredentialsRepository({ db: { pool }, secretBox });
  const withSecret = await repo.findByIdWithSecret(1);
  assert.equal(withSecret.secret, PASSWORD);
  assert.equal(withSecret.username, 'svc-test');
});

test('a credential with no stored secret reports has_secret false and decrypts to null', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_credentials WHERE id = \?/i, () => [[row({ secret_encrypted: null })]]]]);
  const repo = createCredentialsRepository({ db: { pool }, secretBox });
  assert.equal((await repo.findById(1)).has_secret, false);
  assert.equal((await repo.findByIdWithSecret(1)).secret, null);
});

test('an undecryptable secret yields null rather than a wrong value', async () => {
  // What a rotated SECRET_ENCRYPTION_KEY or a tampered row looks like.
  const pool = makeFakePool([[/^SELECT .* FROM service_test_credentials WHERE id = \?/i, () => [[row({ secret_encrypted: 'v1.gcm.aaaa.bbbb.cccc' })]]]]);
  const repo = createCredentialsRepository({ db: { pool }, secretBox });
  assert.equal((await repo.findByIdWithSecret(1)).secret, null);
});

test('findById() returns null for an unknown id', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_credentials WHERE id = \?/i, () => [[]]]]);
  const repo = createCredentialsRepository({ db: { pool }, secretBox });
  assert.equal(await repo.findById(999), null);
  assert.equal(await repo.findByIdWithSecret(999), null);
});

test('create() encrypts before the value reaches the database', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_test_credentials/i, () => ok({ insertId: 1 })],
    selectOne,
  ]);
  const repo = createCredentialsRepository({ db: { pool }, secretBox });
  await repo.create({ application_id: 3, label: 'L', username: 'u', secret: PASSWORD });

  const insert = pool.matching(/^INSERT INTO service_test_credentials/i)[0];
  const stored = insert.params[3];
  assert.notEqual(stored, PASSWORD, 'the plaintext must not be a query parameter');
  assert.match(stored, /^v1\.gcm\./, 'stored in the documented self-describing envelope');
  assert.equal(secretBox.decrypt(stored), PASSWORD);
});

test('update() without a secret field leaves the stored password untouched', async () => {
  const pool = makeFakePool([[/^UPDATE service_test_credentials/i, () => ok()], selectOne]);
  const repo = createCredentialsRepository({ db: { pool }, secretBox });
  await repo.update(1, { label: 'Renamed' });

  const update = pool.matching(/^UPDATE service_test_credentials/i)[0];
  assert.ok(!/secret_encrypted/.test(update.sql), 'renaming must not rewrite the secret column');
});

test('update() with an empty secret clears it — the deliberate way to remove a password', async () => {
  const pool = makeFakePool([[/^UPDATE service_test_credentials/i, () => ok()], selectOne]);
  const repo = createCredentialsRepository({ db: { pool }, secretBox });
  await repo.update(1, { secret: '' });

  const update = pool.matching(/^UPDATE service_test_credentials/i)[0];
  assert.match(update.sql, /secret_encrypted = \?/);
  assert.equal(update.params[0], null);
});

test('update() with no known fields issues no UPDATE at all', async () => {
  const pool = makeFakePool([selectOne]);
  const repo = createCredentialsRepository({ db: { pool }, secretBox });
  await repo.update(1, {});
  assert.equal(pool.matching(/^UPDATE/i).length, 0);
});

test('remove() reports whether a row was actually deleted', async () => {
  const gone = makeFakePool([[/^DELETE FROM service_test_credentials/i, () => ok({ affectedRows: 1 })]]);
  const missing = makeFakePool([[/^DELETE FROM service_test_credentials/i, () => ok({ affectedRows: 0 })]]);
  assert.equal(await createCredentialsRepository({ db: { pool: gone }, secretBox }).remove(1), true);
  assert.equal(await createCredentialsRepository({ db: { pool: missing }, secretBox }).remove(1), false);
});
