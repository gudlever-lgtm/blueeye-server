'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakePool, ok } = require('./fakePool');
const { createTestsRepository } = require('../testsRepository');

const DEFINITION = {
  version: 1,
  name: 'Customer Login',
  steps: [
    { type: 'open', url: '/login' },
    { type: 'fill', target: { type: 'label', value: 'Username' }, value: '{{credential.username}}' },
    { type: 'click', target: { type: 'role', role: 'button', name: 'Login' } },
    { type: 'assert_visible', target: { type: 'text', value: 'Dashboard' } },
  ],
};

function testRow(over = {}) {
  return {
    id: 4,
    tenant_id: null,
    application_id: 3,
    name: 'Customer Login',
    description: null,
    definition: JSON.stringify(DEFINITION),
    version: 1,
    credential_id: 2,
    enabled: 1,
    created_by: 9,
    created_at: new Date('2026-09-01T10:00:00Z'),
    updated_at: new Date('2026-09-01T10:00:00Z'),
    ...over,
  };
}

const selectTest = (over = {}) => [/^SELECT .* FROM service_test_tests t LEFT JOIN service_test_applications .* WHERE t\.id = \?/i, () => [[testRow(over)]]];
const selectSteps = [/^SELECT id,test_id,position.* FROM service_test_test_steps/i, () => [[]]];

test('create() writes the definition, the step rows and version 1 in one transaction', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_test_tests/i, () => ok({ insertId: 4 })],
    [/^DELETE FROM service_test_test_steps/i, () => ok()],
    [/^INSERT INTO service_test_test_steps/i, () => ok()],
    [/^INSERT INTO service_test_test_versions/i, () => ok()],
    selectTest(), selectSteps,
  ]);
  const repo = createTestsRepository({ db: { pool } });
  await repo.create({ application_id: 3, name: 'Customer Login', definition: DEFINITION, credential_id: 2, created_by: 9 });

  assert.equal(pool.tx.begun, 1);
  assert.equal(pool.tx.committed, 1);
  assert.equal(pool.tx.released, 1);
  assert.equal(pool.matching(/^INSERT INTO service_test_test_steps/i).length, 4, 'one row per DSL step');
  const version = pool.matching(/^INSERT INTO service_test_test_versions/i)[0];
  assert.match(version.sql, /VALUES \(\?, 1, \?, \?\)/, 'the first save is snapshotted as version 1');
  assert.deepEqual(JSON.parse(version.params[1]), DEFINITION);
});

test('create() assigns step positions from array order, so the designer never has to', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_test_tests/i, () => ok({ insertId: 4 })],
    [/^DELETE FROM service_test_test_steps/i, () => ok()],
    [/^INSERT INTO service_test_test_steps/i, () => ok()],
    [/^INSERT INTO service_test_test_versions/i, () => ok()],
    selectTest(), selectSteps,
  ]);
  await createTestsRepository({ db: { pool } }).create({ application_id: 3, name: 'T', definition: DEFINITION });

  const inserts = pool.matching(/^INSERT INTO service_test_test_steps/i);
  assert.deepEqual(inserts.map((c) => c.params[1]), [0, 1, 2, 3]);
  assert.deepEqual(inserts.map((c) => c.params[2]), ['open', 'fill', 'click', 'assert_visible']);
});

test('create() rolls back when any part of the write fails', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_test_tests/i, () => ok({ insertId: 4 })],
    [/^DELETE FROM service_test_test_steps/i, () => ok()],
    [/^INSERT INTO service_test_test_steps/i, () => { throw new Error('constraint'); }],
  ]);
  const repo = createTestsRepository({ db: { pool } });
  await assert.rejects(() => repo.create({ application_id: 3, name: 'T', definition: DEFINITION }), /constraint/);
  assert.equal(pool.tx.committed, 0);
  assert.equal(pool.tx.rolledBack, 1);
  assert.equal(pool.tx.released, 1);
});

test('save() bumps the version, snapshots the new definition and rewrites the steps', async () => {
  const pool = makeFakePool([
    [/^SELECT version, definition FROM service_test_tests WHERE id = \? FOR UPDATE/i, () => [[{ version: 2, definition: JSON.stringify(DEFINITION) }]]],
    [/^UPDATE service_test_tests SET/i, () => ok()],
    [/^DELETE FROM service_test_test_steps/i, () => ok()],
    [/^INSERT INTO service_test_test_steps/i, () => ok()],
    [/^INSERT INTO service_test_test_versions/i, () => ok()],
    selectTest({ version: 3 }), selectSteps,
  ]);
  const repo = createTestsRepository({ db: { pool } });
  await repo.save(4, { definition: DEFINITION, updated_by: 9 });

  const update = pool.matching(/^UPDATE service_test_tests SET/i)[0];
  assert.equal(update.params[1], 3, 'version 2 becomes version 3');
  assert.equal(pool.matching(/^INSERT INTO service_test_test_versions/i)[0].params[1], 3);
  assert.match(pool.calls[0].sql, /FOR UPDATE/, 'the version bump must be serialised, or two saves collide on one number');
});

test('save() returns null for an unknown test and rolls back cleanly', async () => {
  const pool = makeFakePool([
    [/^SELECT version, definition FROM service_test_tests WHERE id = \? FOR UPDATE/i, () => [[]]],
  ]);
  const repo = createTestsRepository({ db: { pool } });
  assert.equal(await repo.save(999, { definition: DEFINITION }), null);
  assert.equal(pool.tx.rolledBack, 1);
  assert.equal(pool.tx.released, 1);
});

test('save() keeps the stored definition when the caller only renames', async () => {
  const pool = makeFakePool([
    [/^SELECT version, definition FROM service_test_tests WHERE id = \? FOR UPDATE/i, () => [[{ version: 1, definition: JSON.stringify(DEFINITION) }]]],
    [/^UPDATE service_test_tests SET/i, () => ok()],
    [/^DELETE FROM service_test_test_steps/i, () => ok()],
    [/^INSERT INTO service_test_test_steps/i, () => ok()],
    [/^INSERT INTO service_test_test_versions/i, () => ok()],
    selectTest(), selectSteps,
  ]);
  await createTestsRepository({ db: { pool } }).save(4, { name: 'Renamed' });

  const stored = JSON.parse(pool.matching(/^UPDATE service_test_tests SET/i)[0].params[0]);
  assert.deepEqual(stored, DEFINITION, 'a rename must not empty the test');
  assert.equal(pool.matching(/^INSERT INTO service_test_test_steps/i).length, 4);
});

test('findById() parses the definition and returns null for an unknown id', async () => {
  const found = makeFakePool([selectTest(), selectSteps]);
  const repo = createTestsRepository({ db: { pool: found } });
  const t = await repo.findById(4);
  assert.equal(t.definition.name, 'Customer Login');
  assert.equal(t.definition.steps.length, 4);
  assert.equal(t.enabled, true);

  const missing = makeFakePool([[/^SELECT .* FROM service_test_tests t LEFT JOIN service_test_applications .* WHERE t\.id = \?/i, () => [[]]]]);
  assert.equal(await createTestsRepository({ db: { pool: missing } }).findById(999), null);
});

test('a corrupt definition degrades to an empty test rather than throwing on a read', async () => {
  const pool = makeFakePool([selectTest({ definition: '{oops' }), selectSteps]);
  const t = await createTestsRepository({ db: { pool } }).findById(4);
  assert.deepEqual(t.definition, { version: 1, steps: [] });
});

test('versions() returns newest first with parsed definitions', async () => {
  const pool = makeFakePool([[/^SELECT id,test_id,version,definition.* FROM service_test_test_versions/i, () => [[
    { id: 2, test_id: 4, version: 2, definition: JSON.stringify(DEFINITION), created_by: 9, created_at: new Date() },
    { id: 1, test_id: 4, version: 1, definition: '{bad', created_by: 9, created_at: new Date() },
  ]]]]);
  const list = await createTestsRepository({ db: { pool } }).versions(4);
  assert.deepEqual(list.map((v) => v.version), [2, 1]);
  assert.equal(list[0].definition.name, 'Customer Login');
  assert.equal(list[1].definition, null);
  assert.match(pool.calls[0].sql, /ORDER BY version DESC/);
});

test('remove() reports whether a row was deleted', async () => {
  const pool = makeFakePool([[/^DELETE FROM service_test_tests/i, () => ok({ affectedRows: 0 })]]);
  assert.equal(await createTestsRepository({ db: { pool } }).remove(4), false);
});

test('the list carries the application name and groups by it', async () => {
  // A test name is only unique within its application: four applications can
  // each have a "Login", and a flat alphabetical list puts them in a row with
  // nothing to tell them apart.
  const pool = makeFakePool([[/^SELECT .* FROM service_test_tests t LEFT JOIN service_test_applications/i, () => [[
    testRow({ id: 1, application_id: 3, name: 'Login', application_name: 'Customer Portal' }),
    testRow({ id: 2, application_id: 7, name: 'Login', application_name: 'Partner Portal' }),
  ]]]]);
  const list = await createTestsRepository({ db: { pool } }).list();
  assert.deepEqual(list.map((t) => t.application_name), ['Customer Portal', 'Partner Portal']);

  const sql = pool.matching(/LEFT JOIN service_test_applications/i)[0].sql;
  assert.match(sql, /ORDER BY a\.name, t\.name/, 'tests must group under their application');
  assert.match(sql, /LEFT JOIN/, 'a test whose application row is missing must still list');
});

test('a test scoped to one application is filtered in SQL, not in JS', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_tests t LEFT JOIN service_test_applications/i, () => [[testRow()]]]]);
  await createTestsRepository({ db: { pool } }).list({ applicationId: 3 });
  const call = pool.matching(/LEFT JOIN service_test_applications/i)[0];
  assert.match(call.sql, /WHERE t\.application_id = \?/);
  assert.deepEqual(call.params, [3]);
});
