'use strict';

// Specs for the remaining Service Tests repositories: applications,
// environments, the host allowlist, discovery, suggestions and schedules.
// Grouped in one file because each is thin CRUD over one table — the behaviour
// worth pinning down is partial-update semantics, the atomic claim, and the
// queries the scheduler and the retention job depend on.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakePool, ok } = require('./fakePool');
const { createApplicationsRepository } = require('../applicationsRepository');
const { createEnvironmentsRepository } = require('../environmentsRepository');
const { createAllowedHostsRepository } = require('../allowedHostsRepository');
const { createDiscoveryRepository } = require('../discoveryRepository');
const { createSuggestionsRepository } = require('../suggestionsRepository');
const { createSchedulesRepository } = require('../schedulesRepository');

const NOW = new Date('2026-09-10T12:00:00.000Z');
const now = () => NOW;

// ------------------------------------------------------------ applications
const appRow = (over = {}) => ({
  id: 3, tenant_id: null, name: 'Customer Portal', description: null,
  base_url: 'https://customer.example.com', enabled: 1, created_by: 9,
  created_at: NOW, updated_at: NOW, ...over,
});
const selectApp = (over = {}) => [/^SELECT .* FROM service_test_applications WHERE id = \?/i, () => [[appRow(over)]]];

test('applications: create() defaults to enabled and shapes the row', async () => {
  const pool = makeFakePool([[/^INSERT INTO service_test_applications/i, () => ok({ insertId: 3 })], selectApp()]);
  const app = await createApplicationsRepository({ db: { pool } })
    .create({ name: 'Customer Portal', base_url: 'https://customer.example.com', created_by: 9 });
  assert.equal(app.enabled, true);
  assert.equal(pool.matching(/^INSERT/i)[0].params[3], 1);
});

test('applications: a partial update never silently re-enables a disabled application', async () => {
  const pool = makeFakePool([[/^UPDATE service_test_applications/i, () => ok()], selectApp()]);
  await createApplicationsRepository({ db: { pool } }).update(3, { name: 'Renamed' });
  const update = pool.matching(/^UPDATE/i)[0];
  assert.match(update.sql, /SET name = \?/);
  assert.ok(!/enabled/.test(update.sql), 'a field the caller omitted must not be written');
});

test('applications: update() with nothing known issues no statement', async () => {
  const pool = makeFakePool([selectApp()]);
  await createApplicationsRepository({ db: { pool } }).update(3, { bogus: 1 });
  assert.equal(pool.matching(/^UPDATE/i).length, 0);
});

test('applications: enabled:false is written as 0, not dropped as falsy', async () => {
  const pool = makeFakePool([[/^UPDATE service_test_applications/i, () => ok()], selectApp({ enabled: 0 })]);
  await createApplicationsRepository({ db: { pool } }).update(3, { enabled: false });
  assert.equal(pool.matching(/^UPDATE/i)[0].params[0], 0);
});

test('applications: findById() returns null for an unknown id', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_applications WHERE id = \?/i, () => [[]]]]);
  assert.equal(await createApplicationsRepository({ db: { pool } }).findById(99), null);
});

// ------------------------------------------------------------ environments
const envRow = (over = {}) => ({
  id: 1, tenant_id: null, application_id: 3, name: 'Production',
  base_url: 'https://customer.example.com', type: 'production', enabled: 1,
  created_at: NOW, updated_at: NOW, ...over,
});

test('environments: list() scopes to an application when asked and lists all otherwise', async () => {
  const pool = makeFakePool([
    [/^SELECT .* FROM service_test_environments WHERE application_id = \?/i, () => [[envRow()]]],
    [/^SELECT .* FROM service_test_environments ORDER BY/i, () => [[envRow(), envRow({ id: 2 })]]],
  ]);
  const repo = createEnvironmentsRepository({ db: { pool } });
  assert.equal((await repo.list({ applicationId: 3 })).length, 1);
  assert.equal((await repo.list()).length, 2);
});

test('environments: an unspecified type falls back to custom', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_test_environments/i, () => ok({ insertId: 1 })],
    [/^SELECT .* FROM service_test_environments WHERE id = \?/i, () => [[envRow({ type: 'custom' })]]],
  ]);
  await createEnvironmentsRepository({ db: { pool } }).create({ application_id: 3, name: 'Ad hoc', base_url: 'https://x.example.com' });
  assert.equal(pool.matching(/^INSERT/i)[0].params[3], 'custom');
});

// ------------------------------------------------------------ allowlist
const hostRow = (over = {}) => ({
  id: 1, tenant_id: null, application_id: 3, entry_type: 'cidr', value: '10.20.0.0/16',
  note: 'Kundens LAN', created_by: 9, created_at: NOW, updated_at: NOW, ...over,
});

test('allowlist: add() is idempotent — re-adding an entry updates its note instead of failing', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_test_allowed_hosts/i, () => ok()],
    [/^SELECT .* FROM service_test_allowed_hosts WHERE application_id = \? AND value = \?/i, () => [[hostRow()]]],
  ]);
  const entry = await createAllowedHostsRepository({ db: { pool } })
    .add({ application_id: 3, entry_type: 'cidr', value: '10.20.0.0/16', note: 'Kundens LAN', created_by: 9 });

  assert.equal(entry.value, '10.20.0.0/16');
  assert.match(pool.matching(/^INSERT/i)[0].sql, /ON DUPLICATE KEY UPDATE/, 're-importing a list must be a no-op, not an error');
});

test('allowlist: addMany() writes every entry under one application', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_test_allowed_hosts/i, () => ok()],
    [/^SELECT .* FROM service_test_allowed_hosts WHERE application_id = \? AND value = \?/i, () => [[hostRow()]]],
  ]);
  const added = await createAllowedHostsRepository({ db: { pool } }).addMany(3, [
    { entry_type: 'host', value: 'portal.kunde.dk' },
    { entry_type: 'cidr', value: '10.20.0.0/16' },
    { entry_type: 'ip', value: '10.20.30.40' },
  ], 9);

  assert.equal(added.length, 3);
  const inserts = pool.matching(/^INSERT/i);
  assert.deepEqual(inserts.map((c) => c.params[0]), [3, 3, 3], 'every entry lands on the requested application');
  assert.deepEqual(inserts.map((c) => c.params[1]), ['host', 'cidr', 'ip']);
});

test('allowlist: addMany() tolerates an empty list', async () => {
  const pool = makeFakePool([]);
  assert.deepEqual(await createAllowedHostsRepository({ db: { pool } }).addMany(3, []), []);
  assert.deepEqual(await createAllowedHostsRepository({ db: { pool } }).addMany(3, null), []);
});

test('allowlist: removeAllForApplication() reports how many entries it cleared', async () => {
  const pool = makeFakePool([[/^DELETE FROM service_test_allowed_hosts WHERE application_id = \?/i, () => ok({ affectedRows: 4 })]]);
  assert.equal(await createAllowedHostsRepository({ db: { pool } }).removeAllForApplication(3), 4);
});

// ------------------------------------------------------------ discovery
const discRow = (over = {}) => ({
  id: 7, tenant_id: null, application_id: 3, environment_id: 1, status: 'queued',
  scope_url: 'https://customer.example.com', budgets: JSON.stringify({ maxPages: 100 }),
  page_count: 0, form_count: 0, element_count: 0, request_count: 0, login_count: 0,
  error_message: null, started_at: null, ended_at: null, claimed_by: null, claimed_at: null,
  requested_by: 9, created_at: NOW, updated_at: NOW, ...over,
});
const selectDisc = (over = {}) => [/^SELECT .* FROM service_test_discoveries WHERE id = \?/i, () => [[discRow(over)]]];

test('discovery: claimNext() uses the same conditional-claim contract as runs', async () => {
  const pool = makeFakePool([
    [/^SELECT id FROM service_test_discoveries WHERE status = 'queued'/i, () => [[{ id: 7 }]]],
    [/^UPDATE service_test_discoveries SET status = 'running'/i, () => ok({ affectedRows: 1 })],
    selectDisc({ status: 'running' }),
  ]);
  const claimed = await createDiscoveryRepository({ db: { pool }, now }).claimNext('worker-a');
  assert.equal(claimed.status, 'running');
  assert.match(pool.matching(/^UPDATE service_test_discoveries SET status = 'running'/i)[0].sql,
    /WHERE id = \? AND status = 'queued'/);
});

test('discovery: a lost claim race returns null', async () => {
  const pool = makeFakePool([
    [/^SELECT id FROM service_test_discoveries WHERE status = 'queued'/i, () => [[{ id: 7 }]]],
    [/^UPDATE service_test_discoveries SET status = 'running'/i, () => ok({ affectedRows: 0 })],
  ]);
  assert.equal(await createDiscoveryRepository({ db: { pool }, now }).claimNext('worker-b'), null);
});

test('discovery: latestForApplication() asks only for a completed crawl', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_discoveries WHERE application_id = \? AND status = 'complete'/i, () => [[discRow({ status: 'complete' })]]]]);
  const latest = await createDiscoveryRepository({ db: { pool }, now }).latestForApplication(3);
  assert.equal(latest.status, 'complete');
  assert.match(pool.calls[0].sql, /ORDER BY created_at DESC, id DESC LIMIT 1/);
});

test('discovery: budgets round-trip as an object whether stored parsed or as text', async () => {
  const parsed = makeFakePool([selectDisc({ budgets: { maxPages: 42 } })]);
  const text = makeFakePool([selectDisc({ budgets: '{"maxPages":42}' })]);
  assert.equal((await createDiscoveryRepository({ db: { pool: parsed }, now }).findById(7)).budgets.maxPages, 42);
  assert.equal((await createDiscoveryRepository({ db: { pool: text }, now }).findById(7)).budgets.maxPages, 42);
});

test('discovery: elements record the login heuristic and the destructive flag as booleans', async () => {
  const pool = makeFakePool([[/^SELECT id,discovery_id,page_id,kind.* FROM service_test_discovery_elements/i, () => [[
    { id: 1, discovery_id: 7, page_id: 1, kind: 'input', label: 'Password', attributes: '{"type":"password"}', possible_login: 1, potentially_destructive: 0 },
    { id: 2, discovery_id: 7, page_id: 1, kind: 'button', label: 'Delete customer', attributes: '{}', possible_login: 0, potentially_destructive: 1 },
  ]]]]);
  const els = await createDiscoveryRepository({ db: { pool }, now }).elements(7);
  assert.equal(els[0].possible_login, true);
  assert.equal(els[0].attributes.type, 'password');
  assert.equal(els[1].potentially_destructive, true);
});

test('discovery: addElements() writes the flags as 0/1 and tolerates an empty list', async () => {
  const pool = makeFakePool([[/^INSERT INTO service_test_discovery_elements/i, () => ok()]]);
  const repo = createDiscoveryRepository({ db: { pool }, now });
  assert.equal(await repo.addElements(7, []), 0);
  await repo.addElements(7, [{ kind: 'button', label: 'Pay now', attributes: {}, potentially_destructive: true }]);
  const insert = pool.matching(/^INSERT INTO service_test_discovery_elements/i)[0];
  assert.equal(insert.params[5], 0);
  assert.equal(insert.params[6], 1);
});

test('discovery: reapStale() only fails a crawl a worker actually abandoned', async () => {
  const pool = makeFakePool([[/^UPDATE service_test_discoveries SET status = 'failed'/i, () => ok({ affectedRows: 1 })]]);
  assert.equal(await createDiscoveryRepository({ db: { pool }, now }).reapStale(600000), 1);
  const update = pool.calls[0];
  assert.match(update.sql, /WHERE status = 'running'/);
  assert.deepEqual(update.params[1], new Date(NOW.getTime() - 600000));
});

// ------------------------------------------------------------ suggestions
const sugRow = (over = {}) => ({
  id: 11, tenant_id: null, discovery_id: 7, application_id: 3, name: 'Login',
  description: null, confidence: 'high', reason: 'Detected username field, password field and Login button.',
  proposed_steps: JSON.stringify([{ type: 'open', url: '/login' }]), status: 'proposed',
  created_test_id: null, created_at: NOW, updated_at: NOW, ...over,
});

test('suggestions: createMany() stores confidence and the proposed steps', async () => {
  const pool = makeFakePool([[/^INSERT INTO service_test_suggestions/i, () => ok({ insertId: 11 })]]);
  const ids = await createSuggestionsRepository({ db: { pool } }).createMany(7, 3, [
    { name: 'Login', confidence: 'high', reason: 'r', proposed_steps: [{ type: 'open', url: '/login' }] },
    { name: 'Logout' },
  ]);
  assert.deepEqual(ids, [11, 11]);
  const inserts = pool.matching(/^INSERT/i);

  // Read the parameter position out of the statement's own column list rather
  // than hard-coding an index: adding a column to the INSERT shifts every one
  // after it, and a spec that pins 4 fails for a reason that has nothing to do
  // with what it is testing.
  const columns = inserts[0].sql.match(/\(([^)]*)\)\s*VALUES/i)[1].split(',').map((c) => c.trim());
  const at = (name) => columns.indexOf(name);
  assert.ok(at('confidence') >= 0, 'the INSERT no longer names confidence');

  assert.equal(inserts[0].params[at('confidence')], 'high');
  assert.equal(inserts[1].params[at('confidence')], 'medium', 'an unstated confidence is medium, never high');
  // A suggestion is a test unless it says otherwise, so an existing caller that
  // knows nothing about journeys keeps working.
  assert.equal(inserts[1].params[at('kind')], 'test');
  assert.equal(inserts[1].params[at('proposed_journey')], null);
});

test('suggestions: createMany() stores a journey suggestion as one', async () => {
  const pool = makeFakePool([[/^INSERT INTO service_test_suggestions/i, () => ok({ insertId: 12 })]]);
  await createSuggestionsRepository({ db: { pool } }).createMany(7, 3, [{
    kind: 'journey',
    name: 'Sign in and use the application',
    confidence: 'medium',
    proposed_journey: { criticality: 'high', steps: [{ suggestion_name: 'Login', required: true }] },
  }]);
  const insert = pool.matching(/^INSERT/i)[0];
  const columns = insert.sql.match(/\(([^)]*)\)\s*VALUES/i)[1].split(',').map((c) => c.trim());
  const at = (name) => columns.indexOf(name);

  assert.equal(insert.params[at('kind')], 'journey');
  const plan = JSON.parse(insert.params[at('proposed_journey')]);
  assert.equal(plan.criticality, 'high');
  // Members are named, not referenced: the tests do not exist until the journey
  // is accepted.
  assert.deepEqual(plan.steps, [{ suggestion_name: 'Login', required: true }]);
});

test('suggestions: accepting is one-way — a second accept changes nothing', async () => {
  const pool = makeFakePool([
    [/^UPDATE service_test_suggestions SET status = 'accepted'/i, () => ok({ affectedRows: 0 })],
  ]);
  assert.equal(await createSuggestionsRepository({ db: { pool } }).markAccepted(11, 4), null);
  assert.match(pool.calls[0].sql, /AND status = 'proposed'/, 'an accepted suggestion must not be re-accepted into a second test');
});

test('suggestions: accepting records which test it produced', async () => {
  const pool = makeFakePool([
    [/^UPDATE service_test_suggestions SET status = 'accepted'/i, () => ok({ affectedRows: 1 })],
    [/^SELECT .* FROM service_test_suggestions WHERE id = \?/i, () => [[sugRow({ status: 'accepted', created_test_id: 4 })]]],
  ]);
  const s = await createSuggestionsRepository({ db: { pool } }).markAccepted(11, 4);
  assert.equal(s.created_test_id, 4);
  assert.deepEqual(s.proposed_steps, [{ type: 'open', url: '/login' }]);
});

test('suggestions: dismissing is also guarded on the proposed state', async () => {
  const pool = makeFakePool([[/^UPDATE service_test_suggestions SET status = 'dismissed'/i, () => ok({ affectedRows: 0 })]]);
  assert.equal(await createSuggestionsRepository({ db: { pool } }).markDismissed(11), null);
  assert.match(pool.calls[0].sql, /AND status = 'proposed'/);
});

// ------------------------------------------------------------ schedules
const schedRow = (over = {}) => ({
  id: 1, tenant_id: null, test_id: 4, environment_id: 1, interval_sec: 300,
  start_at: null, timezone: 'Europe/Copenhagen', enabled: 1, last_run_at: null,
  created_by: 9, created_at: NOW, updated_at: NOW, ...over,
});

test('schedules: findDue() asks the database for due rows rather than filtering in JS', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_schedules WHERE enabled = 1/i, () => [[schedRow()]]]]);
  const due = await createSchedulesRepository({ db: { pool }, now }).findDue();

  assert.equal(due.length, 1);
  const sql = pool.calls[0].sql;
  assert.match(sql, /enabled = 1/, 'a disabled schedule is never due');
  assert.match(sql, /start_at IS NULL OR start_at <= \?/, 'a future start time holds the schedule back');
  assert.match(sql, /DATE_SUB\(\?, INTERVAL interval_sec SECOND\)/, 'the interval is applied by the database, per row');
  assert.deepEqual(pool.calls[0].params, [NOW, NOW]);
});

test('schedules: markRun() stamps the time the run was enqueued, so a slow queue cannot double-fire', async () => {
  const pool = makeFakePool([
    [/^UPDATE service_test_schedules SET last_run_at = \?/i, () => ok()],
    [/^SELECT .* FROM service_test_schedules WHERE id = \?/i, () => [[schedRow({ last_run_at: NOW })]]],
  ]);
  await createSchedulesRepository({ db: { pool }, now }).markRun(1);
  assert.deepEqual(pool.calls[0].params, [NOW, 1]);
});

test('schedules: create() defaults to enabled in UTC', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_test_schedules/i, () => ok({ insertId: 1 })],
    [/^SELECT .* FROM service_test_schedules WHERE id = \?/i, () => [[schedRow()]]],
  ]);
  await createSchedulesRepository({ db: { pool }, now }).create({ test_id: 4, interval_sec: 300 });
  const insert = pool.matching(/^INSERT/i)[0];
  assert.equal(insert.params[4], 'UTC');
  assert.equal(insert.params[5], 1);
});

test('schedules: shape() reports enabled as a boolean, not MySQL 1/0', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_schedules WHERE id = \?/i, () => [[schedRow({ enabled: 0 })]]]]);
  assert.equal((await createSchedulesRepository({ db: { pool }, now }).findById(1)).enabled, false);
});
