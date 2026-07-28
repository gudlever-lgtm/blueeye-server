'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createEnrollmentCodesRepository } = require('../src/repositories/enrollmentCodesRepository');
const { createSecretBox } = require('../src/lib/secretBox');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// A fake pool that records every statement and answers the two shapes the
// repository issues (INSERT ... then SELECT the row back).
function makePool({ row = {} } = {}) {
  const queries = [];
  return {
    queries,
    pool: {
      async query(sql, params) {
        queries.push({ sql, params });
        if (/^INSERT INTO enrollment_codes/.test(sql.trim())) return [{ insertId: 5 }];
        return [[{ id: 5, ...row }]];
      },
    },
  };
}

test('creating a code never writes the code itself to the database', async () => {
  const { pool, queries } = makePool();
  const secretBox = createSecretBox({ key: 'test-key-for-enrollment-codes' });
  const repo = createEnrollmentCodesRepository({ pool }, { secretBox });

  const created = await repo.create({ code: 'SUPER-SECRET-CODE', created_by: 1, expiresInMinutes: 60 });

  const insert = queries[0];
  assert.match(insert.sql, /INSERT INTO enrollment_codes \(code_hash, code_enc/);
  assert.ok(!/\(code,/.test(insert.sql), 'the cleartext column must not be written');
  assert.equal(insert.params[0], sha256('SUPER-SECRET-CODE'), 'lookups match on the hash');
  for (const p of insert.params) {
    assert.notEqual(p, 'SUPER-SECRET-CODE', 'no parameter carries the cleartext code');
  }
  // The ciphertext is self-describing and does not contain the plaintext.
  assert.match(insert.params[1], /^v1\.gcm\./);
  assert.ok(!insert.params[1].includes('SUPER-SECRET-CODE'));

  // …but the caller still gets it back in memory, once, to show the operator.
  assert.equal(created.code, 'SUPER-SECRET-CODE');
});

test('findById decrypts the stored code for the install-command endpoint', async () => {
  const secretBox = createSecretBox({ key: 'test-key-for-enrollment-codes' });
  const { pool } = makePool({ row: { code: null, code_enc: secretBox.encrypt('ROUND-TRIP-CODE'), status: 'active' } });
  const repo = createEnrollmentCodesRepository({ pool }, { secretBox });

  const row = await repo.findById(5);
  assert.equal(row.code, 'ROUND-TRIP-CODE');
  assert.equal(row.code_enc, undefined, 'the ciphertext must not leak out of the repository');
});

test('findById falls back to a legacy cleartext row, and yields null when neither is usable', async () => {
  const secretBox = createSecretBox({ key: 'test-key-for-enrollment-codes' });

  // Written before migration 076: cleartext still present, no ciphertext.
  const legacy = makePool({ row: { code: 'LEGACY-CODE', code_enc: null } });
  assert.equal((await createEnrollmentCodesRepository({ pool: legacy.pool }, { secretBox }).findById(5)).code, 'LEGACY-CODE');

  // Spent/expired legacy row whose cleartext the migration stripped.
  const stripped = makePool({ row: { code: null, code_enc: null } });
  assert.equal((await createEnrollmentCodesRepository({ pool: stripped.pool }, { secretBox }).findById(5)).code, null);

  // Ciphertext we cannot decrypt (wrong app secret) must not throw.
  const wrongKey = makePool({ row: { code: null, code_enc: secretBox.encrypt('X') } });
  const other = createSecretBox({ key: 'a-different-app-secret' });
  assert.equal((await createEnrollmentCodesRepository({ pool: wrongKey.pool }, { secretBox: other }).findById(5)).code, null);
});

test('findByCode matches on the hash and still finds legacy rows', async () => {
  const { pool, queries } = makePool({ row: {} });
  const repo = createEnrollmentCodesRepository({ pool });

  await repo.findByCode('LOOKUP-ME');
  const { sql, params } = queries[0];
  assert.match(sql, /WHERE e\.code_hash = \?/);
  assert.match(sql, /e\.code_hash IS NULL AND e\.code = \?/, 'legacy rows are still resolvable');
  assert.equal(params[0], sha256('LOOKUP-ME'));
});

test('without a secret box a code is simply not recoverable (fails safe)', async () => {
  const { pool, queries } = makePool({ row: { code: null, code_enc: 'v1.gcm.x.y.z' } });
  const repo = createEnrollmentCodesRepository({ pool });

  await repo.create({ code: 'NO-BOX-CODE', created_by: 1, expiresInMinutes: 60 });
  assert.equal(queries[0].params[0], sha256('NO-BOX-CODE'), 'the hash is still written, so enrollment works');
  assert.equal(queries[0].params[1], null, 'nothing recoverable is stored');

  assert.equal((await repo.findById(5)).code, null);
});
