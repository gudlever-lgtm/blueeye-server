'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIntegrationsRepository } = require('../src/repositories/integrationsRepository');

// A fake pool that records SQL and returns a canned row for id=1.
function fakePool() {
  const queries = [];
  const row = {
    id: 1, type: 'servicenow', name: 'SN', base_url: 'https://x', auth_type: 'basic',
    enabled: 1, config_json: '{"table":"incident"}', credentials_encrypted: 'v1.gcm.iv.tag.ct',
    created_at: 'now', updated_at: 'now',
  };
  return {
    queries,
    row,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/^INSERT INTO integrations/i.test(sql)) return [{ insertId: 1 }];
      if (/FROM integrations WHERE id = \?/i.test(sql)) return [params[0] === 1 ? [{ ...row }] : []];
      if (/FROM integrations WHERE name = \?/i.test(sql)) return [[]];
      if (/FROM integrations WHERE enabled = 1/i.test(sql)) return [[{ ...row }]];
      if (/FROM integrations ORDER BY id/i.test(sql)) return [[{ ...row }]];
      if (/^UPDATE integrations/i.test(sql)) return [{ affectedRows: 1 }];
      if (/^DELETE FROM integrations/i.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
    },
  };
}

const lastSelectFor = (pool, re) => pool.queries.filter((q) => re.test(q.sql)).map((q) => q.sql).pop();

test('findAll / findById select the SAFE columns only (never credentials_encrypted)', async () => {
  const pool = fakePool();
  const repo = createIntegrationsRepository({ pool });
  await repo.findAll();
  await repo.findById(1);
  for (const q of pool.queries) {
    if (/^SELECT/i.test(q.sql) && !/credentials_encrypted/.test(q.sql)) continue;
    if (/^SELECT/i.test(q.sql)) assert.fail(`safe read leaked the secret column: ${q.sql}`);
  }
});

test('findByIdWithSecret / findEnabledWithSecret DO include credentials_encrypted', async () => {
  const pool = fakePool();
  const repo = createIntegrationsRepository({ pool });
  await repo.findByIdWithSecret(1);
  await repo.findEnabledWithSecret();
  assert.match(lastSelectFor(pool, /WHERE id = \?/), /credentials_encrypted/);
  assert.match(lastSelectFor(pool, /enabled = 1/), /credentials_encrypted/);
});

test('create stores the encrypted blob + JSON config and normalises enabled to 0/1', async () => {
  const pool = fakePool();
  const repo = createIntegrationsRepository({ pool });
  await repo.create({ type: 'servicenow', name: 'SN', baseUrl: 'https://x', authType: 'basic', credentialsEncrypted: 'v1.gcm.a.b.c', enabled: true, config: { table: 'incident' } });
  const insert = pool.queries.find((q) => /^INSERT INTO integrations/i.test(q.sql));
  assert.ok(insert);
  assert.equal(insert.params[4], 'v1.gcm.a.b.c'); // credentials_encrypted
  assert.equal(insert.params[5], 1); // enabled -> 1
  assert.equal(insert.params[6], JSON.stringify({ table: 'incident' }));
});

test('mapRow returns enabled as a boolean and config_json parsed', async () => {
  const pool = fakePool();
  const repo = createIntegrationsRepository({ pool });
  const row = await repo.findById(1);
  assert.equal(row.enabled, true);
  assert.deepEqual(row.config_json, { table: 'incident' });
});

test('update only sets the provided fields', async () => {
  const pool = fakePool();
  const repo = createIntegrationsRepository({ pool });
  await repo.update(1, { enabled: false });
  const upd = pool.queries.find((q) => /^UPDATE integrations/i.test(q.sql));
  assert.match(upd.sql, /enabled = \?/);
  assert.ok(!/credentials_encrypted/.test(upd.sql)); // secret untouched when not in patch
});
