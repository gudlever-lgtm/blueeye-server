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
const { createDeviceInterfacesRepository } = require(path.join(ROOT, 'src/repositories/deviceInterfacesRepository'));
const { createDeviceCounterSamplesRepository } = require(path.join(ROOT, 'src/repositories/deviceCounterSamplesRepository'));
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

  const global = await repo.create({ name: 'Global default', version: '2c', community: 'globalsecret' });
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

  // At most one global default, enforced in code because MySQL treats NULLs as
  // distinct and a unique index would allow twenty.
  const byDefault = await repo.findGlobalDefault();
  assert.strictEqual(byDefault.id, global.id, 'the oldest location-less profile is the default');

  const listed = await repo.list();
  assert.ok(listed.length >= 2);
  assert.ok(!JSON.stringify(listed).includes('globalsecret'), 'a listing must never carry a secret');

  assert.strictEqual(await repo.deviceCount(global.id), 0);
  assert.strictEqual(await repo.remove(v3.id), true);
  assert.strictEqual(await repo.findById(v3.id), null);
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
