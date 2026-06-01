'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSettingsRepository } = require('../src/repositories/settingsRepository');

function makeFakePool() {
  const store = new Map();
  const queries = [];
  return {
    store,
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/^INSERT INTO app_settings/i.test(sql)) {
        store.set(params[0], params[1]); // value stored as JSON string
        return [{ affectedRows: 1 }];
      }
      if (/^SELECT value FROM app_settings/i.test(sql)) {
        return store.has(params[0]) ? [[{ value: store.get(params[0]) }]] : [[]];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test('set stores JSON and get parses it back', async () => {
  const pool = makeFakePool();
  const repo = createSettingsRepository({ pool });
  await repo.set('map', { tileUrl: 'x', maxZoom: 12 });
  assert.match(pool.queries[0].sql, /ON DUPLICATE KEY UPDATE/);
  const got = await repo.get('map');
  assert.deepEqual(got, { tileUrl: 'x', maxZoom: 12 });
});

test('get returns null for a missing key and tolerates bad JSON', async () => {
  const pool = makeFakePool();
  const repo = createSettingsRepository({ pool });
  assert.equal(await repo.get('nope'), null);
  pool.store.set('broken', '{not json');
  assert.equal(await repo.get('broken'), null);
});
