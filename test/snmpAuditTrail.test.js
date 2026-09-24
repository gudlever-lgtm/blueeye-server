'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

// SNMP device and credential-profile changes reach the hash-chained audit_log.
//
// They never did. Both routes called the compliance logger with the
// audit_EVENTS shape ({ action, targetType, targetId, targetLabel }), the
// logger passed `category: undefined` through, and MySQL refused the row
// ("Column 'category' cannot be null"). The logger swallowed that — as it must,
// an audit failure never fails the request — so the only trace was a WARN line
// in a field run. The fake repository accepted anything, which is why no test
// noticed.
//
// Pinned here: the rows are actually written (category, action, target,
// detail), the logger translates the other shape rather than losing it, and a
// call it cannot store fails loudly in strict mode (which the test app uses).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  makeApp, makeAuditLogRepo, makeSnmpDevicesRepo, makeSnmpProfilesRepo, makeAgentsRepo, authHeader,
} = require('../test-support/fakes');
const { createAuditLogger, normaliseAuditEvent } = require('../src/services/complianceLogger');

const admin = (app, method, path, body) => request(app)[method](path)
  .set('Authorization', authHeader('admin')).send(body);

test('creating, changing and deleting an SNMP device writes audit_log rows', async () => {
  const auditLogRepo = makeAuditLogRepo();
  const app = makeApp({
    auditLogRepo,
    snmpDevicesRepo: makeSnmpDevicesRepo(),
    agentsRepo: makeAgentsRepo({ findById: async () => null }),
  });
  const created = await admin(app, 'post', '/api/snmp-devices', { host: '10.20.0.2', displayName: 'Core', community: 's3cret-community' });
  assert.equal(created.status, 201);
  const id = created.body.device.id;
  assert.equal((await admin(app, 'patch', `/api/snmp-devices/${id}`, { community: 'an0ther-secret' })).status, 200);
  assert.equal((await admin(app, 'delete', `/api/snmp-devices/${id}`)).status, 204);

  const rows = auditLogRepo.rows.filter((r) => r.category === 'snmp');
  assert.deepEqual(rows.map((r) => r.action), ['snmp_device.create', 'snmp_device.update', 'snmp_device.delete']);
  for (const r of rows) {
    assert.equal(r.target, String(id));
    assert.match(r.detail, /10\.20\.0\.2/);
    assert.equal(r.outcome, 'success');
    assert.ok(r.actorUserId != null || r.actorEmail != null, 'the actor is read off the request');
  }
  assert.match(rows[1].detail, /changed: community/, 'the changed FIELD is named');
  assert.ok(!JSON.stringify(auditLogRepo.rows).includes('s3cret') && !JSON.stringify(auditLogRepo.rows).includes('an0ther'),
    'a community string reached the audit trail');
});

test('creating, changing and deleting a credential profile writes audit_log rows', async () => {
  const auditLogRepo = makeAuditLogRepo();
  const app = makeApp({ auditLogRepo, snmpProfilesRepo: makeSnmpProfilesRepo() });
  const created = await admin(app, 'post', '/api/snmp-profiles', { name: 'Core v2c', version: '2c', community: 'not-public-at-all' });
  assert.equal(created.status, 201);
  const id = created.body.profile.id;
  assert.equal((await admin(app, 'patch', `/api/snmp-profiles/${id}`, { name: 'Core v2c (renamed)' })).status, 200);
  assert.equal((await admin(app, 'delete', `/api/snmp-profiles/${id}`)).status, 200);

  const rows = auditLogRepo.rows.filter((r) => r.category === 'snmp');
  assert.deepEqual(rows.map((r) => r.action), ['snmp_profile.create', 'snmp_profile.update', 'snmp_profile.delete']);
  assert.ok(rows.every((r) => r.target === String(id)));
  assert.match(rows[0].detail, /Core v2c/);
  assert.ok(!JSON.stringify(auditLogRepo.rows).includes('not-public-at-all'), 'the community reached the audit trail');
});

// ------------------------------------------------------------- the logger
test('the logger translates the audit_events shape instead of losing the row', () => {
  assert.deepEqual(
    normaliseAuditEvent({ action: 'snmp_device.create', targetType: 'snmp_device', targetId: 7, targetLabel: '10.0.0.2' }).value,
    { category: 'snmp_device', action: 'snmp_device.create', target: '7', detail: '10.0.0.2' },
  );
  // No dotted action: the target type is the category.
  assert.equal(normaliseAuditEvent({ action: 'login', targetType: 'session' }).value.category, 'session');
  // The logger's own shape passes through untouched.
  assert.deepEqual(
    normaliseAuditEvent({ category: 'user', action: 'user_create', target: 'a@b.dk', detail: 'x' }).value,
    { category: 'user', action: 'user_create', target: 'a@b.dk', detail: 'x' },
  );
  assert.match(normaliseAuditEvent({}).error, /no action/);
  assert.match(normaliseAuditEvent({ action: 'orphan' }).error, /no category/);
});

test('strict: a call the trail cannot store throws; lenient: it is logged and skipped, never sent to the table', async () => {
  const repo = makeAuditLogRepo();
  const strict = createAuditLogger({ auditLogRepo: repo, strict: true });
  await assert.rejects(() => strict.record(null, { action: 'orphan' }), /has no category/);
  await assert.rejects(() => strict.record(null, {}), /no action/);

  const warnings = [];
  const lenient = createAuditLogger({ auditLogRepo: repo, logger: { warn: (m) => warnings.push(m) } });
  assert.equal(await lenient.record(null, { action: 'orphan' }), null);
  assert.equal(repo.rows.length, 0);
  assert.match(warnings[0], /audit_log record skipped: audit event "orphan" has no category/);

  // The old SNMP call, verbatim, is now a stored row in either mode.
  await lenient.record(null, { action: 'snmp_device.delete', targetType: 'snmp_device', targetId: '3', targetLabel: '10.0.0.3' });
  assert.equal(repo.rows.length, 1);
  assert.equal(repo.rows[0].category, 'snmp_device');
});

test('a repository failure is still swallowed in strict mode: only a MALFORMED call throws', async () => {
  const warnings = [];
  const logger = createAuditLogger({
    auditLogRepo: { record: async () => { throw new Error('db down'); } },
    logger: { warn: (m) => warnings.push(m) },
    strict: true,
  });
  assert.equal(await logger.record(null, { category: 'snmp', action: 'x' }), null);
  assert.match(warnings[0], /db down/);
});

test('the fake audit_log refuses what MySQL refuses', async () => {
  const repo = makeAuditLogRepo();
  await assert.rejects(() => repo.record({ action: 'x' }), /Column 'category' cannot be null/);
  await assert.rejects(() => repo.record({ category: 'x' }), /Column 'action' cannot be null/);
});
