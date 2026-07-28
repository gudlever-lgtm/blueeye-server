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
  const { pool } = makePool({ row: { code_enc: secretBox.encrypt('ROUND-TRIP-CODE'), status: 'active' } });
  const repo = createEnrollmentCodesRepository({ pool }, { secretBox });

  const row = await repo.findById(5);
  assert.equal(row.code, 'ROUND-TRIP-CODE');
  assert.equal(row.code_enc, undefined, 'the ciphertext must not leak out of the repository');
});

test('findById yields null when there is nothing decryptable, and never reads a cleartext column', async () => {
  const secretBox = createSecretBox({ key: 'test-key-for-enrollment-codes' });

  // A row minted before migration 076: the migration dropped the cleartext, so
  // there is nothing to show. The code is still redeemable — only re-displaying
  // the install command is lost, and the endpoint says so rather than guessing.
  const preMigration = makePool({ row: { code_enc: null } });
  assert.equal((await createEnrollmentCodesRepository({ pool: preMigration.pool }, { secretBox }).findById(5)).code, null);

  // Ciphertext we cannot decrypt (wrong app secret) must not throw.
  const wrongKey = makePool({ row: { code_enc: secretBox.encrypt('X') } });
  const other = createSecretBox({ key: 'a-different-app-secret' });
  assert.equal((await createEnrollmentCodesRepository({ pool: wrongKey.pool }, { secretBox: other }).findById(5)).code, null);

  // The dropped column must not be selected at all.
  const { pool, queries } = makePool({ row: { code_enc: null } });
  await createEnrollmentCodesRepository({ pool }, { secretBox }).findById(5);
  assert.doesNotMatch(queries[0].sql, /e\.code\b(?!_)/, 'the cleartext column no longer exists');
});

test('findByCode matches on the hash alone', async () => {
  const { pool, queries } = makePool({ row: {} });
  const repo = createEnrollmentCodesRepository({ pool });

  await repo.findByCode('LOOKUP-ME');
  const { sql, params } = queries[0];
  assert.match(sql, /WHERE e\.code_hash = \?/);
  // Migration 076 backfilled the hash for pre-existing codes, so there is no
  // cleartext fallback to make — and no dropped column to reference.
  assert.doesNotMatch(sql, /e\.code\b(?!_)/);
  assert.deepEqual(params, [sha256('LOOKUP-ME')]);
});

test('without a secret box a code is simply not recoverable (fails safe)', async () => {
  const { pool, queries } = makePool({ row: { code_enc: 'v1.gcm.x.y.z' } });
  const repo = createEnrollmentCodesRepository({ pool });

  await repo.create({ code: 'NO-BOX-CODE', created_by: 1, expiresInMinutes: 60 });
  assert.equal(queries[0].params[0], sha256('NO-BOX-CODE'), 'the hash is still written, so enrollment works');
  assert.equal(queries[0].params[1], null, 'nothing recoverable is stored');

  assert.equal((await repo.findById(5)).code, null);
});

// ---- migration 076 ---------------------------------------------------------
//
// The statement ORDER in this migration is load-bearing: the hash is backfilled
// FROM the cleartext, so dropping the column first would leave every existing
// code unredeemable — every agent mid-install would fail with "invalid code",
// and the codes cannot be recovered. Assert the shape so a later edit that
// reorders or removes the backfill fails here instead of in production.

const fs = require('node:fs');
const path = require('node:path');

test('migration 076 backfills the hash before dropping the cleartext column', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '076_enrollment_code_at_rest.sql'), 'utf8');

  const addHash = sql.indexOf('ADD COLUMN code_hash');
  const backfill = sql.search(/UPDATE\s+enrollment_codes\s+SET\s+code_hash\s*=\s*SHA2\(code, 256\)/);
  const dropColumn = sql.search(/DROP COLUMN code\b/);

  assert.ok(addHash > -1, 'code_hash must be added');
  assert.ok(backfill > -1, 'the hash must be backfilled from the cleartext');
  assert.ok(dropColumn > -1, 'the cleartext column must be dropped');
  assert.ok(addHash < backfill, 'the column must exist before it is backfilled');
  assert.ok(backfill < dropColumn, 'the backfill must read the cleartext before it is dropped');

  // The encrypted-at-rest column and the lookup index are part of the same step.
  assert.match(sql, /ADD COLUMN code_enc/);
  assert.match(sql, /CREATE UNIQUE INDEX uq_enrollment_codes_code_hash/);
});

test('migration 076 is a no-op when it has already been applied', () => {
  // This migration shipped as 072 and was renumbered when main took that number.
  // schema_migrations tracks migrations by FILENAME, so any database that ran the
  // 072 file has no row for 076 and WILL run it again — and the container runs
  // `migrate && server`, so an unguarded re-run takes the whole server down, not
  // just the migration. Every step therefore checks information_schema first.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '076_enrollment_code_at_rest.sql'), 'utf8');

  for (const guarded of ['code_hash', 'code_enc', 'code']) {
    assert.match(
      sql,
      new RegExp(`information_schema\\.COLUMNS[\\s\\S]*?COLUMN_NAME = '${guarded}'`),
      `the ${guarded} step must check whether it already exists`
    );
  }
  assert.match(sql, /information_schema\.STATISTICS[\s\S]*?INDEX_NAME = 'uq_enrollment_codes_code_hash'/);

  // Each guard must actually gate a statement — an IF(...) with a no-op branch —
  // rather than compute a variable nobody reads.
  assert.equal((sql.match(/SET @sql := IF\(/g) || []).length, 5, 'all five steps are gated');
  assert.equal((sql.match(/'DO 0'/g) || []).length, 5, 'each gate has a no-op branch');
  assert.equal((sql.match(/PREPARE stmt FROM @sql/g) || []).length, 5);
});
