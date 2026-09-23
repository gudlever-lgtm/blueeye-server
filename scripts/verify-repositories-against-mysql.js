'use strict';

// Runs the repositories against a REAL MySQL.
//
// The repository specs use a scripted pool: they assert the statement issued and
// the parameters bound, which is the right thing to assert — it is the contract,
// and it does not require a server. What it cannot catch is whether the SQL is
// VALID. A column renamed in a migration, a placeholder count that disagrees
// with the parameter list, an ENUM value the table does not have: every one of
// those passes a scripted pool and fails on the first real insert.
//
// That last one is not hypothetical. A placeholder/parameter mismatch in the
// discovery repository was caught by eye, and a foreign key whose signedness did
// not match took a server container down on deploy.
//
// So this executes each repository's real statements against a real database and
// reads the rows back. It is not a substitute for the specs — it asserts almost
// nothing about MEANING — it only answers "does this SQL run, and does what came
// back look like what went in".
//
//   DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD=secret \
//     node scripts/verify-repositories-against-mysql.js
//
// It creates a scratch database, migrates it, exercises the repositories, and
// drops it again — on success or failure.

const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const env = process.env;
const HOST = env.DB_HOST || '127.0.0.1';
const PORT = Number(env.DB_PORT || 3306);
const USER = env.DB_USER || 'root';
const PASSWORD = env.DB_PASSWORD || '';
const DB = `be_repo_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const { createObservationsRepository } = require(path.join(ROOT, 'src/serviceTests/storage/observationsRepository'));
const { createIncidentsRepository } = require(path.join(ROOT, 'src/serviceTests/storage/incidentsRepository'));
const { createAiAnalysesRepository } = require(path.join(ROOT, 'src/serviceTests/storage/aiAnalysesRepository'));
const { createRunsRepository } = require(path.join(ROOT, 'src/serviceTests/storage/runsRepository'));
const { createSnmpDevicesRepository } = require(path.join(ROOT, 'src/repositories/snmpDevicesRepository'));
const { createUsersRepository } = require(path.join(ROOT, 'src/repositories/usersRepository'));
const { createDeviceInterfacesRepository } = require(path.join(ROOT, 'src/repositories/deviceInterfacesRepository'));
const { createDeviceCounterSamplesRepository } = require(path.join(ROOT, 'src/repositories/deviceCounterSamplesRepository'));
const { createFdbEntriesRepository } = require(path.join(ROOT, 'src/repositories/fdbEntriesRepository'));
const { createSnmpCredentialProfilesRepository } = require(path.join(ROOT, 'src/repositories/snmpCredentialProfilesRepository'));
const { AUTH_PROTOS, PRIV_PROTOS } = require(path.join(ROOT, 'src/validation/snmpProfileValidation'));

// A stand-in for the real secretBox. The encryption itself is tested
// elsewhere; what these checks need is a value that goes into a BLOB column
// and comes back out, so a token that is not the plain text is enough.
const fakeSecretBox = {
  encrypt: (v) => Buffer.from(`enc:${v}`),
  decrypt: (v) => String(v).replace(/^enc:/, ''),
};

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('change acks: upsert, millisecond round trip, per-user read, undo', async (pool) => {
  // User 1 is the seeded admin (see the migration chain).
  const repo = createUsersRepository({ pool });
  const key = 'd'.repeat(64);
  const first = new Date(Date.now() - 5000);
  first.setMilliseconds(123);
  await repo.ackChange(1, key, first);
  let acks = await repo.listChangeAcks(1);
  assert.strictEqual(acks.get(key).getTime(), first.getTime(), 'DATETIME(3) lost the milliseconds');

  const later = new Date(first.getTime() + 1000);
  await repo.ackChange(1, key, later); // the upsert moves it, never duplicates
  acks = await repo.listChangeAcks(1);
  assert.strictEqual(acks.size, 1);
  assert.strictEqual(acks.get(key).getTime(), later.getTime());

  // Older than the TTL: not read, and pruned by the next ack.
  await pool.query('INSERT INTO change_acks (user_id, ack_key, acked_at) VALUES (1, ?, NOW(3) - INTERVAL 31 DAY)', ['e'.repeat(64)]);
  assert.strictEqual((await repo.listChangeAcks(1)).has('e'.repeat(64)), false);
  await repo.ackChange(1, key, later);
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM change_acks WHERE ack_key = ?", ['e'.repeat(64)]);
  assert.strictEqual(Number(n), 0, 'the expired row was not pruned');

  assert.strictEqual((await repo.listChangeAcks(2)).size, 0, 'another user saw this ack');
  assert.strictEqual(await repo.unackChange(1, key), true);
  assert.strictEqual(await repo.unackChange(1, key), false);
});

check('observations: a batch writes and reads back', async (pool) => {
  const repo = createObservationsRepository({ db: { pool } });
  const earlier = new Date(Date.now() - 60000);
  const written = await repo.recordMany({ run_id: 1, test_id: 1, application_id: 1 }, [
    { layer: 'api', kind: 'api.call', subject: 'https://x.dk/api/a', outcome: 'bad', value: 812, unit: 'ms', summary: 'HTTP 500', detail: { status: 500 }, observed_at: earlier },
    { layer: 'network', kind: 'network.request_failed', subject: 'https://x.dk/b', outcome: 'bad', summary: 'did not complete' },
    { layer: 'page', kind: 'page.console_errors', outcome: 'ok', value: 0, unit: 'errors', summary: 'no script errors' },
    // The coercion paths: an ENUM the table does not have, and an unmeasured value.
    { layer: 'quantum', kind: 'x', outcome: 'maybe', value: '   ' },
  ]);
  assert.strictEqual(written, 4, 'four rows should have been written');

  const back = await repo.forRun(1);
  assert.strictEqual(back.length, 4);
  assert.strictEqual(back[0].summary, 'HTTP 500', 'ordered by when they were observed');
  assert.deepStrictEqual(back[0].detail, { status: 500 }, 'a JSON column must survive the round trip');
  assert.strictEqual(back[0].value, 812);
  const coerced = back.find((o) => o.kind === 'x');
  assert.strictEqual(coerced.layer, 'application', 'an unknown layer must land on a valid one');
  assert.strictEqual(coerced.outcome, 'unknown');
  assert.strictEqual(coerced.value, null, 'an unmeasured value must not read back as zero');

  const filtered = await repo.list({ applicationId: 1, layer: 'api', outcome: 'bad' });
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(await repo.purgeOlderThan(0.0000001) >= 0, true);
});

check('incidents: open, assess, move through the lifecycle, resolve', async (pool) => {
  const repo = createIncidentsRepository({ db: { pool } });
  const opened = await repo.open({
    application_id: 1, test_id: 1, subject_type: 'test', subject_key: 'test:1',
    subject_label: 'Customer search', kind: 'http_500', severity: 'CRIT',
    summary: 'HTTP 500 from /api/customer/search', likely_cause: 'the application',
    correlated_layer: 'api', confidence: 68,
    impact: 'high', impact_reason: 'a critical journey cannot complete',
    affected_journeys: [{ id: 2, name: 'Find customer' }],
    explanation: 'x', evidence: ['HTTP 500'],
  });
  assert.ok(opened.id, 'the incident was not created');
  assert.strictEqual(opened.confidence, 68);
  assert.strictEqual(opened.correlated_layer, 'api');
  assert.strictEqual(opened.impact, 'high');
  assert.deepStrictEqual(opened.affected_journeys, [{ id: 2, name: 'Find customer' }]);

  const found = await repo.findOpen('test:1');
  assert.strictEqual(found.id, opened.id, 'an open incident must be findable by its subject');

  const assessed = await repo.recordAssessment(opened.id, { confidence: 0, impactReason: 'revised' });
  assert.strictEqual(assessed.confidence, 0, 'zero confidence is a value, not an absence');

  let moved = await repo.transition(opened.id, 'investigating', { by: 1 });
  assert.strictEqual(moved.ok, true, moved.reason || '');
  assert.ok(moved.incident.acknowledged_at, 'picking it up should acknowledge it');

  moved = await repo.transition(opened.id, 'open', { by: 1 });
  assert.strictEqual(moved.ok, true, 'investigating → open is allowed');

  moved = await repo.transition(opened.id, 'closed', {});
  assert.strictEqual(moved.ok, false, 'open → closed is not a legal move');

  moved = await repo.transition(opened.id, 'resolved', { by: 1, note: 'the next check was healthy' });
  assert.strictEqual(moved.ok, true, moved.reason || '');
  assert.ok(moved.incident.resolved_at);
  assert.strictEqual(moved.incident.resolution, 'the next check was healthy');

  moved = await repo.transition(opened.id, 'closed', { by: 1 });
  assert.strictEqual(moved.ok, true, moved.reason || '');
  moved = await repo.transition(opened.id, 'open', {});
  assert.strictEqual(moved.ok, false, 'a closed incident must stay closed');

  return opened.id;
});

check('incidents: the timeline writes in one statement and reads forwards', async (pool) => {
  const repo = createIncidentsRepository({ db: { pool } });
  const opened = await repo.open({
    application_id: 1, subject_type: 'test', subject_key: 'test:2', subject_label: 'Sign in',
    kind: 'timeout', severity: 'WARN', summary: 'timed out', explanation: 'x', evidence: [],
  });
  const first = new Date(Date.now() - 120000);
  const second = new Date(Date.now() - 60000);
  const written = await repo.addEvents(opened.id, [
    { kind: 'opened', summary: 'Sign in started failing', source: 'run', occurred_at: first, detail: { run_id: 5 } },
    { kind: 'correlated', summary: 'Likely a server problem', source: 'correlation', occurred_at: second },
    { kind: 'x', summary: 'y', source: 'telepathy' },
  ]);
  assert.strictEqual(written, 3);

  const timeline = await repo.timeline(opened.id);
  assert.strictEqual(timeline.length, 3);
  assert.strictEqual(timeline[0].kind, 'opened', 'a timeline is read forwards');
  assert.deepStrictEqual(timeline[0].detail, { run_id: 5 });
  assert.strictEqual(timeline[2].source, 'run', 'an unknown source must land on a valid one');
});

check('incidents: the aggregate queries all run', async (pool) => {
  const repo = createIncidentsRepository({ db: { pool } });
  // These are the queries a dashboard opens with, and a broken one is a page
  // that will not load during an outage.
  assert.ok(Array.isArray(await repo.list({ limit: 10 })));
  assert.ok(Array.isArray(await repo.listBetween({ from: new Date(0), to: new Date() })));
  const counts = await repo.openCounts();
  assert.ok(typeof counts.total === 'number');
  assert.ok(Array.isArray(await repo.countByApplication()) || typeof await repo.countByApplication() === 'object');
  assert.strictEqual(typeof await repo.purgeResolvedOlderThan(90), 'number');
});

check('ai analyses: an answer is written with its context and read back', async (pool) => {
  const incidents = createIncidentsRepository({ db: { pool } });
  const repo = createAiAnalysesRepository({ db: { pool } });
  const incident = await incidents.open({
    application_id: 1, subject_type: 'test', subject_key: 'test:ai', subject_label: 'Search',
    kind: 'http_500', severity: 'CRIT', summary: 'x', explanation: 'y', evidence: [],
  });

  const stored = await repo.record({
    incident_id: incident.id,
    application_id: 1,
    kind: 'explain_incident',
    answer: 'The search endpoint is returning 500 while its neighbours answer.',
    model: 'test-model',
    context: { task: 'explain_incident', incident: { summary: 'x' }, observations: [] },
    duration_ms: 812,
    requested_by: 1,
  });
  assert.ok(stored.id, 'nothing was written');
  assert.strictEqual(stored.is_suggestion, true, 'every row in this table is a suggestion');
  assert.deepStrictEqual(stored.context.incident, { summary: 'x' }, 'a JSON column must survive the round trip');

  const back = await repo.forIncident(incident.id);
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].model, 'test-model');
  assert.strictEqual(typeof await repo.purgeOlderThan(180), 'number');

  // The incident goes; the analysis stays. Losing the record of what a provider
  // was told because somebody purged an old incident is what this table exists
  // to prevent, so there is deliberately no foreign key.
  await pool.query('DELETE FROM service_test_incidents WHERE id = ?', [incident.id]);
  const orphan = await repo.findById(stored.id);
  assert.ok(orphan, 'the analysis went with the incident it explained');
});

check('runs: the batched read returns each test\'s own newest runs', async (pool) => {
  const repo = createRunsRepository({ db: { pool } });

  // Two tests, so a batch that returned one test's runs for both — the bug a
  // fan-out invites — is visible.
  await pool.query("INSERT INTO service_test_tests (id, application_id, name, definition, version, enabled, created_by) VALUES (2, 1, 'Second', '{\"version\":1,\"steps\":[]}', 1, 1, 1)");
  const made = { 1: [], 2: [] };
  for (const testId of [1, 2]) {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const run = await repo.enqueue({ test_id: testId });
      made[testId].push(run.id);
    }
  }

  const byTest = await repo.recentForTests([1, 2], { perTest: 2 });
  assert.strictEqual(byTest.get(1).length, 2, 'the per-test cap was not applied');
  assert.strictEqual(byTest.get(2).length, 2);
  for (const testId of [1, 2]) {
    for (const run of byTest.get(testId)) {
      assert.strictEqual(run.test_id, testId, `test ${testId} was given another test's runs`);
      assert.ok(made[testId].includes(run.id));
    }
  }
  // Newest first, like list().
  assert.ok(byTest.get(1)[0].id > byTest.get(1)[1].id, 'not ordered newest first');

  // A test with no runs is an empty list, not undefined — a caller that indexes
  // straight into the result must not get a crash for an unused test.
  const withEmpty = await repo.recentForTests([1, 999999], { perTest: 2 });
  assert.deepStrictEqual(withEmpty.get(999999), []);

  // Nothing asked for, nothing read.
  for (const input of [[], null, undefined, 'no', [null, 'x']]) {
    // eslint-disable-next-line no-await-in-loop
    const empty = await repo.recentForTests(input, {});
    assert.strictEqual(empty.size, 0, `${JSON.stringify(input)} produced rows`);
  }

  // Duplicates collapse rather than fanning out twice.
  const deduped = await repo.recentForTests([1, 1, 1], { perTest: 2 });
  assert.strictEqual(deduped.size, 1);
});


// ===================================================== SNMP: devices and ports
// These four tables are the counter feature (migrations 104, 108, 109, 112).
// Every statement below is one a scripted pool already asserts the SHAPE of;
// what it cannot answer is whether MySQL accepts it — a wide 20-column insert,
// a grouped self-join, an ON DUPLICATE KEY with a COALESCE, and an ENUM that
// migration 112 widened after the fact.

check('snmp credential profiles: create, resolve, and never hand back a secret', async (pool) => {
  const repo = createSnmpCredentialProfilesRepository({ pool }, { secretBox: fakeSecretBox });

  const global = await repo.create({
    name: 'Global default', version: '2c', community: 'globalsecret', isGlobalDefault: true,
  });
  assert.ok(global.id, 'the profile was not created');
  assert.strictEqual(global.community, undefined, 'the safe shape must not carry a community');
  assert.strictEqual(global.hasCommunity, true, 'but WHETHER one is set must be visible');

  // v3, which migration 112 added to the ENUM. An ENUM value the table does
  // not have is exactly the failure a scripted pool cannot see: MySQL either
  // refuses it or, in a non-strict mode, stores an empty string.
  // EVERY protocol the validator accepts must be one the column has. This is
  // the exact drift a scripted pool cannot see: the validator says yes, the
  // INSERT says "Data truncated for column", and an admin gets a 500 for a
  // setting the form offered them. Asserted against information_schema rather
  // than a copy of the list, so the schema stays the authority.
  const enumValues = async (column) => {
    const [[row]] = await pool.query(
      `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'snmp_credential_profiles'
          AND COLUMN_NAME = ?`,
      [column],
    );
    return [...String(row.t).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  };
  const sorted = (a) => [...a].sort();
  assert.deepStrictEqual(sorted(await enumValues('v3_auth_proto')), sorted(AUTH_PROTOS),
    'the auth protocols the validator accepts are not the ones the column has');
  assert.deepStrictEqual(sorted(await enumValues('v3_priv_proto')), sorted(PRIV_PROTOS),
    'the priv protocols the validator accepts are not the ones the column has');

  const v3 = await repo.create({
    name: 'Site v3', version: '3', v3User: 'blueeye',
    v3AuthProto: 'sha256', v3AuthKey: 'authauthauth',
    v3PrivProto: 'aes', v3PrivKey: 'privprivpriv',
  });
  assert.strictEqual(v3.version, '3', 'the version ENUM did not keep 3');
  assert.strictEqual(v3.v3AuthProto, 'sha256');
  assert.strictEqual(v3.v3PrivProto, 'aes');

  const resolved = await repo.resolveWithSecret(v3.id);
  assert.strictEqual(resolved.v3AuthKey, 'authauthauth', 'the one read that decrypts did not');
  assert.strictEqual(resolved.securityLevel, 'authPriv', 'the level is derived from the keys, never stated');

  // At most one global default. Its own column since migration 113: assigned
  // to no site and default for every site are opposite intentions, and the
  // absent `location_id` said both.
  const byDefault = await repo.findGlobalDefault();
  assert.strictEqual(byDefault.id, global.id, 'the flagged profile is the default');

  const listed = await repo.list();
  assert.ok(listed.length >= 2);
  assert.ok(!JSON.stringify(listed).includes('globalsecret'), 'a listing must never carry a secret');

  assert.strictEqual(await repo.deviceCount(global.id), 0);
  assert.strictEqual(await repo.remove(v3.id), true);
  assert.strictEqual(await repo.findById(v3.id), null);
});

check('snmp communities: assigned to SITES and to AGENTS, and the grant is what lets an agent walk', async (pool) => {
  const repo = createSnmpCredentialProfilesRepository({ pool }, { secretBox: fakeSecretBox });

  // Real rows on both sides: the link tables carry foreign keys, and a FK whose
  // signedness does not match is exactly the failure that took a container down.
  const [site] = await pool.query("INSERT INTO locations (name) VALUES ('Aarhus')");
  const locationId = site.insertId;
  const [agentRow] = await pool.query(
    "INSERT INTO agents (hostname, platform, arch) VALUES ('be-aarhus-01', 'linux', 'x64')",
  );
  const agentId = agentRow.insertId;

  const core = await repo.create({
    name: 'Core RO', version: '2c', community: 'coresecret', locationIds: [locationId],
  });
  const access = await repo.create({
    name: 'Access RO', version: '2c', community: 'accesssecret',
    locationIds: [locationId], agentIds: [agentId],
  });

  const back = await repo.findById(access.id);
  assert.deepStrictEqual(back.locationIds, [locationId], 'the site assignment did not round trip');
  assert.deepStrictEqual(back.agentIds, [agentId], 'the agent grant did not round trip');

  // AN AGENT WALKS ONLY WITH A COMMUNITY ASSIGNED TO IT. 'Core RO' is first in
  // the site's order and would have answered — the agent is not granted it, so
  // it is skipped as though it were not configured.
  const chain = await repo.resolveForAgent({ locationId, agentId });
  assert.strictEqual(chain.profileId, access.id, 'the first community this agent MAY use must win');
  assert.strictEqual(chain.source, 'site');

  // A community the agent is not granted is reported as blocked rather than
  // falling through: "this site has none" and "this agent may not use it" send
  // an admin to two different screens.
  const blocked = await repo.resolveForAgent({ profileId: core.id, agentId });
  assert.strictEqual(blocked.profileId, null);
  assert.strictEqual(blocked.blocked, core.id);

  // The SITE's order of preference, which must name exactly what is assigned.
  await repo.setLocationOrder(locationId, [access.id, core.id]);
  const ordered = await repo.listForLocation(locationId);
  assert.deepStrictEqual(ordered.map((p) => p.id), [access.id, core.id], 'priority did not order the site');
  await assert.rejects(
    () => repo.setLocationOrder(locationId, [access.id]),
    (err) => err.code === 'SNMP_ORDER_MISMATCH',
  );

  const forAgent = await repo.listForAgent(agentId);
  assert.deepStrictEqual(forAgent.map((p) => p.id), [access.id], 'only what this agent is granted');

  // An OMITTED list leaves the assignments alone; an explicit [] clears them.
  await repo.update(access.id, { name: 'Access RO (renamed)' });
  assert.deepStrictEqual((await repo.findById(access.id)).agentIds, [agentId]);
  await repo.update(access.id, { agentIds: [] });
  assert.deepStrictEqual((await repo.findById(access.id)).agentIds, []);

  // ON DELETE CASCADE: the assignments go with the community they belong to.
  await repo.remove(core.id);
  const [[left]] = await pool.query(
    'SELECT COUNT(*) AS n FROM snmp_profile_locations WHERE profile_id = ?', [core.id],
  );
  assert.strictEqual(Number(left.n), 0, 'a deleted community left its site assignments behind');
});

check('snmp devices: the credential chain resolves on the server, once per device', async (pool) => {
  const profiles = createSnmpCredentialProfilesRepository({ pool }, { secretBox: fakeSecretBox });
  const repo = createSnmpDevicesRepository({ pool }, {
    secretBox: fakeSecretBox, credentialProfilesRepo: profiles,
  });
  const profile = await profiles.create({ name: 'Chain default', version: '2c', community: 'fromprofile' });

  // agent_id stays null: the FK is ON DELETE SET NULL and this check is about
  // the device row, not about agents.
  const own = await repo.create({
    host: '10.14.0.11', displayName: 'Core switch',
    collect: ['if', 'fdb', 'ifcounters'], intervalSec: 300, counterIntervalSec: 60,
    community: 'fromdevice',
  });
  assert.strictEqual(own.counterIntervalSec, 60);
  assert.deepStrictEqual(own.collect, ['if', 'fdb', 'ifcounters'], 'the JSON column did not round trip');
  assert.strictEqual(own.supported, null, 'never polled is NULL, not an empty list');
  assert.strictEqual(own.community, undefined, 'the safe columns must not carry the community');

  const viaProfile = await repo.create({
    host: '10.14.0.12', credentialProfileId: profile.id, version: '2c',
  });

  // WHETHER a device has its own community is a different question from what
  // it is, and the setup checklist has to be able to ask it: a switch carrying
  // its own credential needs nothing resolved. Computed in SQL, so the
  // encrypted value never leaves the database on this path.
  const listed = await repo.list({});
  const ownListed = listed.find((d) => d.id === own.id);
  const profileListed = listed.find((d) => d.id === viaProfile.id);
  assert.strictEqual(ownListed.hasCommunity, true);
  assert.strictEqual(ownListed.community, undefined, 'and still never the value');
  assert.strictEqual(profileListed.hasCommunity, false, 'a device with none of its own says so');

  // The ONE read that decrypts, and the whole point of the chain: a device with
  // its own credential keeps it; one without inherits the profile's.
  const withSecrets = await repo.listForAgentWithSecret(null);
  assert.strictEqual(withSecrets.length, 0, 'a null agent owns no devices');

  await repo.update(own.id, { agentId: null });
  const direct = await repo.findById(own.id);
  assert.strictEqual(direct.host, '10.14.0.11');

  // recordPoll and recordCounterPoll are deliberately separate statements: a
  // failed topology poll must not move the counter reference forward.
  await repo.recordPoll(own.id, { ok: true, supported: { ifXTable: true } });
  await repo.recordCounterPoll(own.id, { uptimeTicks: 506000 });
  const polled = await repo.findById(own.id);
  assert.deepStrictEqual(polled.supported, { ifXTable: true });
  assert.strictEqual(polled.lastUptimeTicks, 506000);
  assert.ok(polled.lastOkAt, 'a successful poll must stamp last_ok_at');

  await repo.recordPoll(own.id, { ok: false, error: 'timeout' });
  const failed = await repo.findById(own.id);
  assert.strictEqual(failed.lastError, 'timeout');
  assert.ok(failed.lastOkAt, 'a failure must KEEP the last good time');

  // sysDescr (migration 116) is COALESCEd: an agent too old to send it must
  // not erase what a newer one read.
  await repo.recordPoll(own.id, { ok: true, sysDescr: 'Cisco IOS Software, C2960X, 15.2(7)E3' });
  await repo.recordPoll(own.id, { ok: true });
  const described = await repo.findById(own.id);
  assert.strictEqual(described.sysDescr, 'Cisco IOS Software, C2960X, 15.2(7)E3');

  assert.strictEqual(await profiles.deviceCount(profile.id), 1, 'the device/profile FK did not join');
  assert.strictEqual(await repo.remove(viaProfile.id), true);
});

check('device interfaces: the port NAME is the identity, and a move is reported', async (pool) => {
  const devices = createSnmpDevicesRepository({ pool }, { secretBox: fakeSecretBox });
  const repo = createDeviceInterfacesRepository({ pool });
  const device = await devices.create({ host: '10.14.0.20', displayName: 'Access switch' });

  const first = await repo.upsertMany(device.id, [
    { ifName: 'Gi0/1', ifIndex: 1, speedMbps: 1000, ifAlias: 'uplink', operStatus: 'up' },
    { ifName: 'Gi0/2', ifIndex: 2, speedMbps: 1000, operStatus: 'down' },
  ]);
  assert.ok(first.upserted >= 2, 'the wide upsert did not write');
  assert.deepStrictEqual(first.renumbered, [], 'a first sighting is not a move');

  // The whole reason the name is the key: a line card reload renumbers the
  // ports, and a counter read against the INDEX would subtract two different
  // ports from each other.
  const second = await repo.upsertMany(device.id, [
    { ifName: 'Gi0/1', ifIndex: 10001, speedMbps: 1000, operStatus: 'up' },
    { ifName: 'Gi0/2', ifIndex: 2, speedMbps: 1000, operStatus: 'down' },
  ]);
  assert.deepStrictEqual(second.renumbered, [{ ifName: 'Gi0/1', from: 1, to: 10001 }]);
  assert.strictEqual(await repo.countForDevice(device.id), 2, 'a renumber must not create a second row');

  const { byName, byIndex } = await repo.idMapForDevice(device.id);
  assert.ok(byName.get('Gi0/1'), 'the name map is what the counter path resolves through');
  assert.strictEqual(byIndex.get(10001), byName.get('Gi0/1'));

  // COALESCE on if_index_changed_at: a poll where nothing moved must not erase
  // the timestamp of the move before it.
  await repo.upsertMany(device.id, [{ ifName: 'Gi0/1', ifIndex: 10001, speedMbps: 1000 }]);
  const port = await repo.findById(byName.get('Gi0/1'));
  assert.ok(port.ifIndexChangedAt, 'a quiet poll erased the move timestamp');

  const listed = await repo.listForDevice(device.id, { limit: 10 });
  assert.strictEqual(listed.length, 2);

  // The link state the upsert used to overwrite without a trace (migration
  // 118): a port whose status moved is REPORTED, with its row id.
  const third = await repo.upsertMany(device.id, [
    { ifName: 'Gi0/1', ifIndex: 10001, speedMbps: 1000, operStatus: 'up', adminStatus: 'up' },
    { ifName: 'Gi0/2', ifIndex: 2, speedMbps: 1000, operStatus: 'up', adminStatus: 'up' },
  ]);
  const gi2 = third.statusChanges.find((c) => c.ifName === 'Gi0/2');
  assert.ok(gi2, 'a port that came up was not reported');
  assert.strictEqual(gi2.interfaceId, byName.get('Gi0/2'));
  assert.strictEqual(gi2.from.operStatus, 'down');
  assert.strictEqual(gi2.to.operStatus, 'up');

  // A trap's news is written onto the row, so the next poll does not repeat it.
  assert.strictEqual(await repo.setStatus(byName.get('Gi0/2'), { operStatus: 'down' }), true);
  assert.strictEqual((await repo.findById(byName.get('Gi0/2'))).operStatus, 'down');
});

check('device counter samples: a wide insert, a grouped self-join, and a window', async (pool) => {
  const devices = createSnmpDevicesRepository({ pool }, { secretBox: fakeSecretBox });
  const interfaces = createDeviceInterfacesRepository({ pool });
  const repo = createDeviceCounterSamplesRepository({ pool });

  const device = await devices.create({ host: '10.14.0.30', displayName: 'Counter switch' });
  await interfaces.upsertMany(device.id, [
    { ifName: 'Gi0/1', ifIndex: 1, speedMbps: 1000 },
    { ifName: 'Gi0/2', ifIndex: 2, speedMbps: 1000 },
  ]);
  const { byName } = await interfaces.idMapForDevice(device.id);
  const p1 = byName.get('Gi0/1');
  const p2 = byName.get('Gi0/2');

  const t0 = new Date(Date.now() - 120000);
  const t1 = new Date(Date.now() - 60000);
  const written = await repo.insertMany([
    { ts: t0, deviceId: device.id, interfaceId: p1, inOctets: 1000000, outOctets: 500000, inErrors: 10, discontinuity: 'first' },
    { ts: t0, deviceId: device.id, interfaceId: p2, inOctets: 7, discontinuity: 'first' },
    {
      ts: t1, deviceId: device.id, interfaceId: p1,
      inOctets: 1750000, outOctets: 600000, inErrors: 16,
      deltaSec: 60, inBps: 100000, outBps: 13333.33, inErrPps: 0.1, inUtilPct: 0.01,
      discontinuity: null,
    },
  ]);
  assert.strictEqual(written, 3, 'the wide insert did not write every row');

  // INSERT IGNORE on (interface_id, ts): a retried submit must not double-count.
  const again = await repo.insertMany([
    { ts: t1, deviceId: device.id, interfaceId: p1, inOctets: 1750000 },
  ]);
  assert.strictEqual(again, 0, 'a retried submit was counted twice');

  // The write path's read: newest per interface, inside the window.
  const latest = await repo.latestForDevice(device.id);
  assert.strictEqual(latest.size, 2);
  assert.strictEqual(latest.get(p1).inOctets, 1750000, 'the grouped self-join returned the wrong row');
  assert.strictEqual(latest.get(p1).inBps, 100000);
  assert.strictEqual(latest.get(p2).inBps, null, 'an absent rate must read back as null, never 0');

  // ... and the same read with the port name, which is the screen.
  const named = await repo.latestWithNames(device.id);
  assert.strictEqual(named.length, 2);
  assert.strictEqual(named[0].ifName, 'Gi0/1', 'ordered by ifIndex, nulls last');

  // The time bound is the difference between reading an hour and reading
  // everything. A window that starts after the samples must come back empty
  // rather than silently ignoring the predicate.
  const none = await repo.latestForDevice(device.id, { since: new Date(Date.now() + 60000) });
  assert.strictEqual(none.size, 0, 'the ts predicate was not applied');

  const series = await repo.series(p1, { from: t0, to: new Date(), maxPoints: 500 });
  assert.strictEqual(series.total, 2);
  assert.strictEqual(series.step, 1);
  assert.strictEqual(series.samples[0].inOctets, 1000000, 'a series reads forwards');
  assert.strictEqual(series.samples[0].discontinuity, 'first');

  // Downsampling takes every Nth row rather than averaging: averaging would
  // smooth away the error spike somebody opened the chart to find.
  const thin = await repo.series(p1, { from: t0, to: new Date(), maxPoints: 1 });
  assert.strictEqual(thin.step, 2);
  assert.strictEqual(thin.samples.length, 1);

  const purged = await repo.purgeBefore(new Date(Date.now() - 90000));
  assert.strictEqual(purged, 2, 'the batched delete did not remove the old rows');

  // Duplex (a string) and the late-collision rate (migration 116) round-trip.
  await repo.insertMany([{
    ts: new Date(), deviceId: device.id, interfaceId: p2, lateCollisions: 70,
    duplex: 'half', lateCollPps: 1, fcsPps: 0.5, deltaSec: 60, discontinuity: null,
  }]);
  const withDuplex = (await repo.latestForDevice(device.id)).get(p2);
  assert.strictEqual(withDuplex.duplex, 'half');
  assert.strictEqual(withDuplex.lateCollPps, 1);
  assert.strictEqual(withDuplex.lateCollisions, 70);
});

check('fdb entries: a sweep records its moves, the window counts them, VLAN names upsert', async (pool) => {
  const devices = createSnmpDevicesRepository({ pool }, { secretBox: fakeSecretBox });
  const repo = createFdbEntriesRepository({ pool });
  const device = await devices.create({ host: '10.14.0.40', displayName: 'Loop switch' });
  const mac = '00:1b:44:11:3a:b7';

  // Three sweeps, one second apart, the MAC on 12 → 24 → 12: two moves. The
  // sweep time carries milliseconds on purpose — the repository must cut it to
  // the second, or the INSERT … SELECT that records the move finds nothing.
  const base = Date.now() - 10000;
  await repo.upsertMany(device.id, [{ mac, vlan: 20, bridgePort: 12 }], { at: new Date(base + 123) });
  await repo.upsertMany(device.id, [{ mac, vlan: 20, bridgePort: 24 }], { at: new Date(base + 1456) });
  await repo.upsertMany(device.id, [{ mac, vlan: 20, bridgePort: 12 }], { at: new Date(base + 2789) });

  const [[moves]] = await pool.query('SELECT COUNT(*) AS n FROM fdb_mac_moves WHERE device_id = ?', [device.id]);
  assert.strictEqual(Number(moves.n), 2, 'a first sighting is not a move, and each real move is one row');

  const moving = await repo.movingMacs(device.id, { since: new Date(base - 1000), limit: 10 });
  assert.strictEqual(moving.length, 1);
  assert.strictEqual(moving[0].movesInWindow, 2, 'the grouped JOIN did not count the window');
  assert.strictEqual(moving[0].moveCount, 2);
  const later = await repo.movingMacs(device.id, { since: new Date(base + 60000), limit: 10 });
  assert.strictEqual(later.length, 0, 'moves before the window must not count');

  await repo.upsertVlans(device.id, [{ vlan: 20, name: 'Voice' }, { vlan: 10, name: 'Data' }]);
  await repo.upsertVlans(device.id, [{ vlan: 20, name: 'Voice-2' }]);
  const vlans = await repo.listVlans(device.id);
  assert.deepStrictEqual(vlans.map((v) => [v.vlan, v.name]), [[10, 'Data'], [20, 'Voice-2']]);

  assert.strictEqual(await repo.purgeMovesBefore(new Date(Date.now() + 60000)), 2);
  assert.strictEqual(await repo.purgeVlansBefore(new Date(Date.now() + 60000)), 2);
});

check('coverage reads: last flow per agent, ARP per /24, MACs for IPs, MACs on up ports', async (pool) => {
  const { createFlowsRepository } = require(path.join(ROOT, 'src/repositories/flowsRepository'));
  const { createArpEntriesRepository } = require(path.join(ROOT, 'src/repositories/arpEntriesRepository'));
  const { createFdbEntriesRepository } = require(path.join(ROOT, 'src/repositories/fdbEntriesRepository'));
  const [agentRow] = await pool.query(
    "INSERT INTO agents (hostname, platform, arch) VALUES ('be-coverage-01', 'linux', 'x64')",
  );
  const agentId = agentRow.insertId;

  const flows = createFlowsRepository({ pool });
  await flows.insertMany([{ agentId, ts: new Date(Date.now() - 60000), dstIp: '10.0.0.9', bytes: 1 }]);
  const last = (await flows.lastFlowAtByAgent()).find((r) => r.agentId === agentId);
  assert.ok(last && last.lastFlowAt, 'the grouped MAX(ts) did not come back');

  const arp = createArpEntriesRepository({ pool });
  await arp.upsertMany(agentId, [
    { ip: '10.77.1.5', mac: 'aa:bb:cc:00:00:01' },
    { ip: '10.77.1.6', mac: 'aa:bb:cc:00:00:02' },
    { ip: 'fe80::1', mac: 'aa:bb:cc:00:00:03' },
  ]);
  const subnets = await arp.subnetSummary({ since: new Date(Date.now() - 3600000), limit: 10 });
  const s = subnets.find((r) => r.prefix === '10.77.1');
  assert.ok(s, 'the /24 aggregate did not come back');
  assert.strictEqual(s.ips, 2);
  assert.ok(!subnets.some((r) => r.prefix.includes(':')), 'an IPv6 address became a /24');
  const macs = await arp.macsForIps(['10.77.1.5', '10.77.9.9']);
  assert.deepStrictEqual(macs.map((m) => m.mac), ['aa:bb:cc:00:00:01']);

  const devices = createSnmpDevicesRepository({ pool }, { secretBox: fakeSecretBox });
  const ifaces = createDeviceInterfacesRepository({ pool });
  const fdb = createFdbEntriesRepository({ pool });
  const device = await devices.create({ host: '10.77.1.1', displayName: 'Coverage switch' });
  await ifaces.upsertMany(device.id, [
    { ifName: 'Gi0/1', ifIndex: 1, operStatus: 'up' },
    { ifName: 'Gi0/2', ifIndex: 2, operStatus: 'down' },
  ]);
  await fdb.upsertMany(device.id, [
    { mac: 'aa:bb:cc:00:00:10', bridgePort: 1, ifIndex: 1, ifName: 'Gi0/1' },
    { mac: 'aa:bb:cc:00:00:11', bridgePort: 2, ifIndex: 2, ifName: 'Gi0/2' },
  ]);
  const up = await fdb.listUpPortMacs({ since: new Date(Date.now() - 3600000), limit: 100 });
  assert.deepStrictEqual(up.filter((r) => r.deviceId === device.id).map((r) => r.mac), ['aa:bb:cc:00:00:10'],
    'only the MAC on the UP port should come back');
});

// ============================================ agents, probes, history, NIS2
// The statements added alongside migrations 118–123: the agent-offline sweep
// and its peer-probe read, the probe failure columns, the switch-port and
// switch-LLDP history rows, the Art. 23 incident fields and their event-case
// FK, the new-device detector's reads, and the per-edge services query.

const repoOf = (file, factory) => require(path.join(ROOT, 'src/repositories', file))[factory];
const newAgent = async (pool, hostname, cols = {}) => {
  const names = ['hostname', 'platform', 'arch', ...Object.keys(cols)];
  const [res] = await pool.query(
    `INSERT INTO agents (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    [hostname, 'linux', 'x64', ...Object.values(cols)],
  );
  return res.insertId;
};
const ago = (ms) => new Date(Date.now() - ms);
const DAY = 86400000;

check('agents: the offline sweep flips only the stale, spares live sockets, and peers are read', async (pool) => {
  const repo = repoOf('agentsRepository', 'createAgentsRepository')({ pool });
  const stale = await newAgent(pool, 'be-stale', { status: 'online', last_seen: ago(600000) });
  const never = await newAgent(pool, 'be-never', { status: 'online' });
  const fresh = await newAgent(pool, 'be-fresh', { status: 'online', last_seen: new Date() });
  const socket = await newAgent(pool, 'be-socket', { status: 'online', last_seen: ago(600000) });

  const flipped = await repo.sweepStaleOffline({ olderThanSec: 300, exceptIds: [socket, 'x', -1] });
  assert.deepStrictEqual([...flipped].sort((a, b) => a - b), [stale, never].sort((a, b) => a - b));
  assert.deepStrictEqual(await repo.sweepStaleOffline({ olderThanSec: 300, exceptIds: [socket] }), [],
    'a second sweep must find nothing left to flip');
  // The one-shot form (boot) has no exceptions: the socket agent goes too.
  assert.strictEqual(await repo.markStaleOffline({ olderThanSec: 300 }), 1);
  const [states] = await pool.query('SELECT id, status FROM agents WHERE id IN (?)', [[stale, never, fresh, socket]]);
  const statusOf = new Map(states.map((r) => [Number(r.id), r.status]));
  assert.strictEqual(statusOf.get(fresh), 'online', 'a fresh agent was flipped');
  assert.strictEqual(statusOf.get(socket), 'offline');

  // Peer probes: another agent's reachability probe towards the stale agent's
  // address counts; its own, a diagnostic type, and an old one do not.
  const probes = repoOf('probeResultsRepository', 'createProbeResultsRepository')({ pool });
  await probes.createMany(fresh, [
    { type: 'ping', target: '10.20.0.5', ok: true, rttMs: 1.1, ts: ago(60000) },
    { type: 'tls', target: '10.20.0.5', ok: true, ts: ago(60000) },
    { type: 'ping', target: '10.20.0.5', ok: false, ts: ago(3 * 3600000) },
    { type: 'ping', target: '10.20.0.99', ok: true, ts: ago(60000) },
  ]);
  await probes.createMany(stale, [{ type: 'ping', target: '10.20.0.5', ok: true, ts: ago(60000) }]);
  const peers = await repo.peerProbesTowards({
    targets: ['10.20.0.5', ' 10.20.0.5 ', ''], from: ago(3600000), excludeAgentId: stale,
  });
  assert.strictEqual(peers.length, 1, 'own, diagnostic, old or other-target probes were counted');
  assert.strictEqual(peers[0].agentId, fresh);
  assert.strictEqual(peers[0].agentName, 'be-fresh', 'the LEFT JOIN did not name the agent');
  assert.strictEqual(peers[0].ok, true);
  assert.deepStrictEqual(await repo.peerProbesTowards({ targets: [], from: ago(3600000) }), []);
});

check('probe results: failure reason, resolver and ECMP hop ips round-trip; recentRuns is bounded', async (pool) => {
  const repo = repoOf('probeResultsRepository', 'createProbeResultsRepository')({ pool });
  const agentId = await newAgent(pool, 'be-probe');
  const hops = [{ ttl: 1, ip: '10.0.0.1', rttMs: 0.4 }, { ttl: 2, ip: '192.0.2.1', ips: ['192.0.2.1', '192.0.2.2'], rttMs: 3.1 }];
  const written = await repo.createMany(agentId, [
    { type: 'dns', target: 'intranet.kunde.dk', ok: false, lossPct: 100, errorCode: 'ENOTFOUND', resolver: '10.0.0.53', ts: ago(50000) },
    { type: 'tcp', target: '10.0.0.9:443', ok: false, errorCode: 'ECONNREFUSED', failure: 'refused-and-then-some', ts: ago(40000) },
    { type: 'traceroute', target: '192.0.2.200', ok: true, hops: hops.slice(0, 1), ts: ago(30000) },
    { type: 'traceroute', target: '192.0.2.200', ok: true, hops, ts: ago(20000) },
    { type: 'traceroute', target: '192.0.2.200', ok: true, hops, ts: ago(10000) },
  ]);
  assert.strictEqual(written, 5);

  const rows = await repo.findByAgent({ agentId, from: ago(3600000) });
  const dns = rows.find((r) => r.type === 'dns');
  assert.strictEqual(dns.errorCode, 'ENOTFOUND');
  assert.strictEqual(dns.resolver, '10.0.0.53');
  assert.strictEqual(dns.failure, null, 'not reported must read back as null');
  const tcp = rows.find((r) => r.type === 'tcp');
  assert.strictEqual(tcp.failure, 'refused-and-then', 'bounded to the VARCHAR(16) the column has');

  const all = await repo.recentRuns({ agentId, type: 'traceroute', target: '192.0.2.200' });
  assert.strictEqual(all.length, 3);
  assert.deepStrictEqual(all[0].hops[1].ips, ['192.0.2.1', '192.0.2.2'], 'the per-hop ips did not survive the JSON column');
  const before = await repo.recentRuns({
    agentId, type: 'traceroute', target: '192.0.2.200', before: ago(15000), from: ago(25000), limit: 5,
  });
  assert.strictEqual(before.length, 1, 'the before/from bounds were not both applied');
  assert.strictEqual(before[0].hops[1].ips.length, 2);
  assert.strictEqual((await repo.recentRuns({ agentId, type: 'traceroute', target: '192.0.2.200', limit: 1 })).length, 1);
});

check('nis2 incidents: Art. 23 fields round-trip, the event-case link survives edits and its case', async (pool) => {
  const repo = repoOf('nis2IncidentsRepository', 'createNis2IncidentsRepository')({ pool });
  const [ec] = await pool.query(
    "INSERT INTO event_cases (host_id, title, first_event_at, last_event_at) VALUES ('agent:1', 'Core down', NOW(), NOW())",
  );
  const caseId = ec.insertId;
  const ew = '2026-03-01T10:15:30.000Z';
  const created = await repo.create({
    title: 'Ransomware on file server', severity: 'high', status: 'open',
    detectedAt: '2026-03-01T08:00:00Z', nis2Relevant: true, notificationRequired: true,
    suspectedMalicious: true, crossBorderImpact: true, crossBorderDetails: 'Sister site in SE',
    authorityReference: 'CFCS-2026-0042', earlyWarningSubmittedAt: ew, eventCaseId: caseId,
  });
  assert.match(created.incidentId, /^INC-\d{4}-\d{4}$/);
  assert.strictEqual(created.suspectedMalicious, true);
  assert.strictEqual(created.crossBorderImpact, true);
  assert.strictEqual(created.crossBorderDetails, 'Sister site in SE');
  assert.strictEqual(created.authorityReference, 'CFCS-2026-0042');
  assert.strictEqual(created.earlyWarningSubmittedAt, ew, 'the submission time did not round-trip');
  assert.strictEqual(created.notificationSubmittedAt, null);
  assert.strictEqual(created.eventCaseId, caseId);

  // An edit form that does not carry the link must not sever it.
  const updated = await repo.update(created.id, {
    title: 'Ransomware on file server', severity: 'critical', status: 'contained',
    suspectedMalicious: false, notificationSubmittedAt: new Date('2026-03-03T09:00:00Z'),
  });
  assert.strictEqual(updated.severity, 'critical');
  assert.strictEqual(updated.suspectedMalicious, false);
  assert.strictEqual(updated.earlyWarningSubmittedAt, null, 'update is a full replace of the editable fields');
  assert.strictEqual(updated.notificationSubmittedAt, '2026-03-03T09:00:00.000Z');
  assert.strictEqual(updated.eventCaseId, caseId, 'an edit severed the event-case link');

  const other = await repo.create({ title: 'Unrelated', severity: 'low', status: 'open' });
  assert.strictEqual(other.eventCaseId, null);
  const linked = await repo.findByEventCase(caseId);
  assert.deepStrictEqual(linked.map((i) => i.id), [created.id]);
  assert.deepStrictEqual(await repo.findByEventCase(caseId + 1000), []);

  // The FK: a case that does not exist is refused; deleting the case keeps the
  // regulatory record and only clears the link (ON DELETE SET NULL).
  await assert.rejects(
    () => repo.create({ title: 'Dangling', severity: 'low', status: 'open', eventCaseId: caseId + 1000 }),
    (err) => err.code === 'ER_NO_REFERENCED_ROW_2',
  );
  await pool.query('DELETE FROM event_cases WHERE id = ?', [caseId]);
  const orphan = await repo.findById(created.id);
  assert.ok(orphan, 'deleting the case deleted the NIS2 incident');
  assert.strictEqual(orphan.eventCaseId, null);
  assert.ok((await repo.findAll({})).length >= 2);
});

check('switch history: port transitions and switch LLDP rows stay out of the agent\'s own lookups', async (pool) => {
  const states = repoOf('interfaceStatesRepository', 'createInterfaceStatesRepository')({ pool });
  const changes = repoOf('topologyChangesRepository', 'createTopologyChangesRepository')({ pool });
  const devices = createSnmpDevicesRepository({ pool }, { secretBox: fakeSecretBox });
  const agentId = await newAgent(pool, 'be-poller');
  const device = await devices.create({ host: '10.14.0.60', displayName: 'History switch' });

  // Same name on purpose: the agent's NIC and the switch port are both "eth0".
  const own = await states.insertTransition(agentId, {
    iface: 'eth0', fromStatus: 'up', toStatus: 'down', severity: 'WARN', summary: 'nic down', detectedAt: ago(20000),
  });
  const port = await states.insertTransition(agentId, {
    deviceId: device.id, interfaceId: 4242, source: 'trap', iface: 'eth0', fromStatus: 'up', toStatus: 'down',
    operStatus: 'down', severity: 'WARN', summary: 'port down', detectedAt: ago(10000),
  });
  const agentLatest = await states.latestForIface({ agentId, iface: 'eth0', since: ago(60000) });
  assert.strictEqual(agentLatest.id, own, 'a switch port was read as the agent\'s own interface');
  assert.strictEqual(agentLatest.deviceId, null);
  const portLatest = await states.latestForDeviceIface({ deviceId: device.id, iface: 'eth0', since: ago(60000) });
  assert.strictEqual(portLatest.id, port);
  assert.strictEqual(portLatest.source, 'trap');
  assert.strictEqual(portLatest.interfaceId, 4242);
  assert.strictEqual(await states.latestForDeviceIface({ deviceId: device.id, iface: 'eth0', since: new Date(Date.now() + 60000) }), null);
  assert.deepStrictEqual((await states.list({ deviceId: device.id })).map((t) => t.id), [port]);

  const ownChange = await changes.insert({
    agentId, changeType: 'neighbour_added', localPort: 'eth0', remoteChassisId: 'aa:bb', summary: 'agent lldp', detectedAt: ago(20000),
  });
  const devChange = await changes.insert({
    agentId, deviceId: device.id, changeType: 'neighbour_removed', localPort: 'Gi0/1', remoteChassisId: 'cc:dd',
    remotePort: 'Gi0/48', summary: 'switch lldp', detectedAt: ago(10000),
  });
  const forAgent = await changes.recentForAgent({ agentId, since: ago(60000) });
  assert.deepStrictEqual(forAgent.map((c) => Number(c.id)), [Number(ownChange)], 'recentForAgent read a switch row');
  const forDevice = await changes.recentForDevice({ deviceId: device.id, since: ago(60000) });
  assert.deepStrictEqual(forDevice.map((c) => Number(c.id)), [Number(devChange)]);
  assert.strictEqual(forDevice[0].deviceId, device.id);
  assert.strictEqual((await changes.listForAgent({ agentId })).length, 2, 'the per-agent history still lists both');
});

check('device events: the sourceIp filter ties the log to a polled switch', async (pool) => {
  const repo = repoOf('deviceEventsRepository', 'createDeviceEventsRepository')({ pool });
  const agentId = await newAgent(pool, 'be-syslog');
  const e = (sourceIp, summary) => ({
    sourceIp, receivedAt: ago(5000), severity: 3, eventType: 'link.down', summary, transport: 'trap',
  });
  await repo.createMany(agentId, [e('10.14.0.61', 'Gi0/1 down'), e('10.14.0.62', 'Gi0/2 down')]);
  const rows = await repo.list({ minutes: 10, sourceIp: '10.14.0.61', agentId, transport: 'trap' });
  assert.deepStrictEqual(rows.map((r) => r.summary), ['Gi0/1 down']);
  assert.strictEqual((await repo.list({ minutes: 10, agentId })).length, 2, 'an absent sourceIp must not filter');
});

check('new-device detector reads: known MACs per agent and per site, first-seen baselines, candidate by IP', async (pool) => {
  const arp = repoOf('arpEntriesRepository', 'createArpEntriesRepository')({ pool });
  const discovered = repoOf('discoveredDevicesRepository', 'createDiscoveredDevicesRepository')({ pool });
  const [site] = await pool.query("INSERT INTO locations (name) VALUES ('Odense')");
  const a1 = await newAgent(pool, 'be-odense-1', { location_id: site.insertId });
  const a2 = await newAgent(pool, 'be-odense-2', { location_id: site.insertId });
  const elsewhere = await newAgent(pool, 'be-elsewhere');

  assert.strictEqual(await arp.oldestFirstSeen(a1), null, 'no rows must be null, not the epoch');
  await arp.upsertMany(a1, [{ ip: '10.30.0.5', mac: 'de:ad:be:ef:00:01' }]);
  await arp.upsertMany(a2, [{ ip: '10.30.0.6', mac: 'de:ad:be:ef:00:02' }]);
  await arp.upsertMany(elsewhere, [{ ip: '10.40.0.7', mac: 'de:ad:be:ef:00:03' }]);
  assert.ok(await arp.oldestFirstSeen(a1) instanceof Date);

  const macs = ['de:ad:be:ef:00:01', 'de:ad:be:ef:00:02', 'de:ad:be:ef:00:03', 'de:ad:be:ef:00:04'];
  const mine = await arp.knownMacs({ macs, agentId: a1 });
  assert.deepStrictEqual([...mine], ['de:ad:be:ef:00:01']);
  const atSite = await arp.knownMacs({ macs, locationId: site.insertId });
  assert.deepStrictEqual([...atSite].sort(), ['de:ad:be:ef:00:01', 'de:ad:be:ef:00:02'], 'the site JOIN is wrong');
  assert.strictEqual((await arp.knownMacs({ macs: [], agentId: a1 })).size, 0);

  assert.strictEqual(await discovered.findByIp('10.30.0.50'), null);
  const seenAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
  await discovered.upsertCandidate({ ip: '10.30.0.50', hostname: 'printer', openPorts: [80, 9100], seenAt, foundByAgentId: a1 });
  const found = await discovered.findByIp('10.30.0.50');
  assert.strictEqual(found.hostname, 'printer');
  assert.deepStrictEqual(found.openPorts, [80, 9100]);
  assert.strictEqual(found.foundByAgentId, a1);
  const oldest = await discovered.oldestFirstSeen();
  assert.ok(oldest instanceof Date && oldest.getTime() <= seenAt.getTime());
});

check('flows: topology edges carry their dominant service ports, chosen in SQL', async (pool) => {
  const flows = repoOf('flowsRepository', 'createFlowsRepository')({ pool });
  const agentId = await newAgent(pool, 'be-ot');
  const f = (srcIp, srcPort, dstIp, dstPort, proto, bytes) => ({
    agentId, ts: ago(600000), srcIp, dstIp, srcPort, dstPort, proto, bytes, packets: 1, flows: 1, internal: true,
  });
  await flows.insertMany([
    f('10.1.1.5', 50123, '10.1.1.9', 502, 'tcp', 3000),
    f('10.1.1.5', 50999, '10.1.1.9', 502, 'tcp', 2000), // same service, other ephemeral port
    f('10.1.1.5', 50124, '10.1.1.9', 443, 'tcp', 1000),
    f('10.1.1.5', 40001, '10.1.1.9', 40002, 'udp', 500), // nothing named: the lower port
    f('10.1.1.5', 51000, '10.1.1.9', 22, 'tcp', 10), // a fourth service: past SERVICES_PER_EDGE
    f('10.1.1.5', null, '10.1.1.9', null, 'icmp', 5), // no port at all: no service
    f('10.1.1.9', 502, '10.1.1.5', 50123, 'tcp', 800), // the reply: its own edge, still 502
  ]);
  const edges = await flows.topologyEdges({ agentId, from: ago(3600000), to: new Date() });
  const fwd = edges.find((e) => e.srcIp === '10.1.1.5' && e.dstIp === '10.1.1.9');
  const rev = edges.find((e) => e.srcIp === '10.1.1.9' && e.dstIp === '10.1.1.5');
  assert.strictEqual(fwd.bytes, 6515, 'the edge total must still hold every service');
  assert.deepStrictEqual(fwd.services, [
    { port: 502, proto: 'tcp', bytes: 5000 },
    { port: 443, proto: 'tcp', bytes: 1000 },
    { port: 40001, proto: 'udp', bytes: 500 },
  ]);
  assert.deepStrictEqual(rev.services, [{ port: 502, proto: 'tcp', bytes: 800 }]);
  assert.deepStrictEqual(await flows.topologyEdges({ agentId, from: ago(60000), to: ago(30000) }), []);
});

check('retention: internal flows roll up bounded (top-N + one overflow row) and re-runs sum', async (pool) => {
  const { createRetentionRepo } = require(path.join(ROOT, 'src/analysis/retention/repo'));
  const { createRollup } = require(path.join(ROOT, 'src/analysis/retention/rollup'));
  const { createFlowsRepository } = require(path.join(ROOT, 'src/repositories/flowsRepository'));
  const repo = createRetentionRepo({ pool });
  const rollup = createRollup({ repo, config: { rollupIntervalMinutes: 60, internalRollupTopN: 2, batchSize: 3 } });
  const flows = createFlowsRepository({ pool });
  const agentId = await newAgent(pool, 'be-rollup');
  const ts = new Date(Math.floor(Date.now() / 3600000) * 3600000 - 2 * 3600000 + 60000); // inside one old bucket
  const f = (srcPort, dstIp, dstPort, bytes, extra = {}) => ({
    agentId, ts, srcIp: '10.2.0.5', dstIp, srcPort, dstPort, proto: 'TCP', bytes, packets: 2, flows: 1, internal: true, ...extra,
  });
  await flows.insertMany([
    f(50123, '10.2.0.9', 502, 2000), f(50999, '10.2.0.9', 502, 1000), // one key: port 502, 3000 bytes
    f(50124, '10.2.0.10', 443, 2000),
    f(50125, '10.2.0.11', 22, 500), f(50126, '10.2.0.12', 80, 100), // below the top 2: folded
    f(50127, '8.8.8.8', 53, 70, { internal: false, country: 'US', asn: 15169, direction: 'out', extIp: '8.8.8.8' }),
  ]);

  const out = await rollup.rollupFlows(new Date());
  assert.ok(out.rawDeleted >= 6, 'the raw rows before the cutoff were not deleted');
  const read = async () => {
    const [rows] = await pool.query(
      'SELECT src_ip, dst_ip, proto, service_port, bytes, packets, flow_count FROM flow_internal_rollup WHERE agent_id = ? ORDER BY bytes DESC',
      [agentId],
    );
    return rows.map((r) => [r.src_ip, r.dst_ip, r.proto, Number(r.service_port), Number(r.bytes), Number(r.flow_count)]);
  };
  assert.deepStrictEqual(await read(), [
    ['10.2.0.5', '10.2.0.9', 'tcp', 502, 3000, 2],
    ['10.2.0.5', '10.2.0.10', 'tcp', 443, 2000, 1],
    ['*', '*', '', 0, 600, 2],
  ]);
  const [[ext]] = await pool.query('SELECT COUNT(*) AS n FROM flow_rollup WHERE agent_id = ?', [agentId]);
  assert.strictEqual(Number(ext.n), 1, 'the external rollup must still run beside the internal one');

  // A late row in the same bucket: ON DUPLICATE KEY sums into the kept row.
  await flows.insertMany([f(51000, '10.2.0.9', 502, 400)]);
  await rollup.rollupFlows(new Date());
  assert.deepStrictEqual((await read())[0], ['10.2.0.5', '10.2.0.9', 'tcp', 502, 3400, 3]);
  const [[left]] = await pool.query('SELECT COUNT(*) AS n FROM flow_records WHERE agent_id = ?', [agentId]);
  assert.strictEqual(Number(left.n), 0);
});

check('retention: every new purge deletes exactly the expired rows it owns', async (pool) => {
  const { createRetentionRepo } = require(path.join(ROOT, 'src/analysis/retention/repo'));
  const { createPurge } = require(path.join(ROOT, 'src/analysis/retention/purge'));
  const devices = createSnmpDevicesRepository({ pool }, { secretBox: fakeSecretBox });
  const agentId = await newAgent(pool, 'be-purge');
  const deviceId = (await devices.create({ host: '10.14.0.70', displayName: 'Purge switch' })).id;
  const old = ago(40 * DAY);
  const recent = ago(DAY);

  // One expired and one current row per table, plus the rows a purge must
  // never take whatever their age.
  const ins = (sql, rows) => Promise.all(rows.map((p) => pool.query(sql, p)));
  await ins('INSERT INTO flow_internal_rollup (bucket, agent_id, src_ip, dst_ip) VALUES (?, ?, ?, ?)',
    [[old, agentId, 'a', 'b'], [recent, agentId, 'a', 'b']]);
  await ins("INSERT INTO probe_results (agent_id, ts, type, target) VALUES (?, ?, 'ping', 'x')",
    [[agentId, old], [agentId, recent]]);
  await ins('INSERT INTO speedtest_results (agent_id, ts) VALUES (?, ?)', [[agentId, old], [agentId, recent]]);
  await ins("INSERT INTO transaction_results (`time`, test_id, agent_id, status) VALUES (?, 1, ?, 'ok')",
    [[old, agentId], [recent, agentId]]);
  await ins("INSERT INTO probe_outages (agent_id, metric, severity, started_at, resolved_at, affected_target) VALUES (?, 'reachability', 'critical', ?, ?, 'x')",
    [[agentId, old, old], [agentId, old, recent], [agentId, old, null]]); // closed-old, closed-recent, still OPEN
  await ins("INSERT INTO topology_changes (agent_id, change_type, summary, detected_at) VALUES (?, 'neighbour_added', 's', ?)",
    [[agentId, old], [agentId, recent]]);
  await ins('INSERT INTO discovered_devices (ip, status, first_seen, last_seen) VALUES (?, ?, ?, ?)', [
    ['10.99.0.1', 'discovered', old, old], ['10.99.0.2', 'ignored', old, old],
    ['10.99.0.3', 'promoted', old, old], ['10.99.0.4', 'discovered', old, recent],
  ]);
  await ins("INSERT INTO host_connections (agent_id, src_ip, dst_ip, dst_port, last_seen) VALUES (?, '10.0.0.1', ?, 443, ?)",
    [[agentId, '10.0.0.2', old], [agentId, '10.0.0.3', recent]]);
  await ins("INSERT INTO audit_events (actor_type, action, ts, first_seen_at, last_seen_at) VALUES ('system', 'x', ?, ?, ?)",
    [[old, old, old], [old, old, recent]]); // the second still recurs: kept
  await ins("INSERT INTO device_vlans (device_id, vlan, name, first_seen, last_seen) VALUES (?, ?, 'v', ?, ?)",
    [[deviceId, 10, old, old], [deviceId, 20, old, recent]]);
  await ins("INSERT INTO fdb_mac_moves (device_id, mac, to_port, moved_at) VALUES (?, 'aa:aa:aa:aa:aa:aa', 1, ?)",
    [[deviceId, old], [deviceId, recent]]);

  const days = 30;
  const purge = createPurge({
    repo: createRetentionRepo({ pool }),
    config: {
      rollupRetentionDays: days, findingRetentionDays: 365, fdbRetentionDays: days, fdbMoveRetentionDays: days,
      probeResultRetentionDays: days, probeOutageRetentionDays: days, speedtestRetentionDays: days,
      transactionResultRetentionDays: days, topologyChangeRetentionDays: days, discoveredDeviceRetentionDays: days,
      hostConnectionRetentionDays: days, auditEventRetentionDays: days,
    },
  });
  const out = await purge.purgeExpired();
  const expect = {
    internalFlowRollups: 1, probeResults: 1, speedtestResults: 1, transactionResults: 1, probeOutages: 1,
    topologyChanges: 1, discoveredDevices: 2, hostConnections: 1, auditEvents: 1, deviceVlans: 1, fdbMoves: 1,
  };
  for (const [k, n] of Object.entries(expect)) assert.strictEqual(out[k], n, `${k}: purged ${out[k]}, expected ${n}`);

  const count = async (sql, p = []) => Number((await pool.query(sql, p))[0][0].n);
  assert.strictEqual(await count('SELECT COUNT(*) AS n FROM probe_outages WHERE agent_id = ? AND resolved_at IS NULL', [agentId]), 1,
    'an OPEN outage was purged');
  assert.deepStrictEqual(
    (await pool.query("SELECT ip FROM discovered_devices WHERE ip LIKE '10.99.0.%' ORDER BY ip"))[0].map((r) => r.ip),
    ['10.99.0.3', '10.99.0.4'], 'a promoted or recently seen candidate was purged');
  assert.strictEqual(await count("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'x'"), 1, 'a still-recurring audit event was purged');

  const again = await purge.purgeExpired();
  for (const k of Object.keys(expect)) assert.strictEqual(again[k], 0, `${k} is not idempotent`);
});

async function main() {
  const admin = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASSWORD });
  let failures = 0;
  try {
    await admin.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.info(`Migrating ${DB} …`);
    execFileSync(process.execPath, [path.join(ROOT, 'src', 'migrate.js')], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...env, DB_HOST: HOST, DB_PORT: String(PORT), DB_USER: USER, DB_PASSWORD: PASSWORD, DB_NAME: DB },
    });

    const pool = mysql.createPool({
      host: HOST, port: PORT, user: USER, password: PASSWORD, database: DB, connectionLimit: 4,
    });
    // The seeded admin is the only row the repositories can lean on, so the
    // foreign keys they write against have something to point at.
    await pool.query("INSERT INTO service_test_applications (id, name, base_url, enabled, created_by) VALUES (1, 'Portal', 'https://portal.kunde.dk', 1, 1)");
    await pool.query("INSERT INTO service_test_tests (id, application_id, name, definition, version, enabled, created_by) VALUES (1, 1, 'Search', '{\"version\":1,\"steps\":[]}', 1, 1, 1)");
    await pool.query("INSERT INTO service_test_runs (id, test_id, status, trigger_source) VALUES (1, 1, 'fail', 'manual')");

    for (const { name, fn } of checks) {
      try {
        await fn(pool);
        console.info(`  ok   ${name}`);
      } catch (err) {
        failures += 1;
        console.error(`  FAIL ${name}\n       ${err && err.message}`);
      }
    }
    await pool.end();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS \`${DB}\``).catch(() => {});
    await admin.end().catch(() => {});
  }

  if (failures) {
    console.error(`\n${failures} of ${checks.length} repository checks failed against a real MySQL.\n`);
    process.exit(1);
  }
  console.info(`\nAll ${checks.length} repository checks pass against a real MySQL.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nVerification could not run: ${err && err.message}\n`);
  console.error('It needs a MySQL it may create and drop databases on. For example:');
  console.error('  DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD=secret \\');
  console.error('    node scripts/verify-repositories-against-mysql.js\n');
  process.exit(2);
});
