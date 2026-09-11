'use strict';

// Storage contract for the reaction layer's two tables. Same approach as the
// other repository specs: a scripted pool, so what is asserted is the statement
// issued and the parameters bound — not that a hand-rolled SQL engine agrees
// with itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeFakePool, ok, rows } = require('./fakePool');
const { createCertificatesRepository } = require('../certificatesRepository');
const { createIncidentsRepository } = require('../incidentsRepository');

const NOW = new Date('2026-09-10T12:00:00.000Z');
const now = () => NOW;

const CERT_ROW = {
  id: 4, application_id: 1, environment_id: null, host: 'portal.kunde.dk', port: 443,
  url: 'https://portal.kunde.dk', subject: 'CN=portal.kunde.dk', issuer: 'O=CA',
  serial_number: '01', fingerprint: 'AA', alt_names: 'DNS:portal.kunde.dk, DNS:www.portal.kunde.dk',
  valid_from: NOW, valid_to: NOW, days_remaining: 12, status: 'expiring', error_message: null, checked_at: NOW,
};

// ------------------------------------------------------------ certificates
test('a check upserts on (application, host, port) — the table is state, not history', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_test_certificates/i, () => ok()],
    [/^SELECT .* FROM service_test_certificates WHERE application_id = \? AND host = \?/i, () => rows([CERT_ROW])],
  ]);
  const repo = createCertificatesRepository({ db: { pool }, now });
  const stored = await repo.record(1, { host: 'portal.kunde.dk', port: 443, status: 'expiring', days_remaining: 12 });

  const [insert] = pool.matching(/^INSERT INTO service_test_certificates/i);
  assert.match(insert.sql, /ON DUPLICATE KEY UPDATE/i);
  assert.equal(insert.params[0], 1);
  assert.equal(insert.params[2], 'portal.kunde.dk');
  assert.equal(insert.params[15].getTime(), NOW.getTime(), 'checked_at defaults to the clock, not to the database');
  assert.equal(stored.status, 'expiring');
  assert.deepEqual(stored.alt_names, ['portal.kunde.dk', 'www.portal.kunde.dk'], 'the DNS: prefixes are the wire format, not the answer');
});

test('over-long certificate fields are truncated to their columns rather than erroring the write', async () => {
  const pool = makeFakePool([
    [/^INSERT INTO service_test_certificates/i, () => ok()],
    [/^SELECT .* FROM service_test_certificates WHERE application_id = \?/i, () => rows([])],
  ]);
  const repo = createCertificatesRepository({ db: { pool }, now });
  await repo.record(1, {
    host: 'h'.repeat(400), port: 443, subject: 's'.repeat(900), issuer: 'i'.repeat(900),
    error_message: 'e'.repeat(4000), status: 'invalid',
  });
  const [insert] = pool.matching(/^INSERT INTO service_test_certificates/i);
  assert.equal(insert.params[2].length, 255);
  assert.equal(insert.params[5].length, 512);
  assert.equal(insert.params[6].length, 512);
  assert.equal(insert.params[14].length, 1000);
});

test('the list is ordered by soonest expiry, with the unknowable ones last', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_certificates/i, () => rows([CERT_ROW])]]);
  const repo = createCertificatesRepository({ db: { pool }, now });
  await repo.list({ applicationId: 1, status: 'expiring' });
  const [call] = pool.matching(/^SELECT .* FROM service_test_certificates/i);
  assert.match(call.sql, /ORDER BY \(valid_to IS NULL\) ASC, valid_to ASC/i);
  assert.deepEqual(call.params, [1, 'expiring']);
});

test('pruning with no remaining targets clears the application rather than building an empty NOT ()', async () => {
  const pool = makeFakePool([[/^DELETE FROM service_test_certificates/i, () => ok({ affectedRows: 3 })]]);
  const repo = createCertificatesRepository({ db: { pool }, now });
  assert.equal(await repo.pruneMissing(1, []), 3);
  const [call] = pool.matching(/^DELETE FROM service_test_certificates/i);
  assert.ok(!/NOT \(\)/.test(call.sql), 'an empty NOT () would be a syntax error against MySQL');

  const pool2 = makeFakePool([[/^DELETE FROM service_test_certificates/i, () => ok({ affectedRows: 1 })]]);
  const repo2 = createCertificatesRepository({ db: { pool: pool2 }, now });
  await repo2.pruneMissing(1, [{ host: 'a.dk', port: 443 }, { host: 'b.dk', port: 8443 }]);
  const [call2] = pool2.matching(/^DELETE FROM service_test_certificates/i);
  assert.match(call2.sql, /NOT \(\(host = \? AND port = \?\) OR \(host = \? AND port = \?\)\)/);
  assert.deepEqual(call2.params, [1, 'a.dk', 443, 'b.dk', 8443]);
});

// --------------------------------------------------------------- incidents
const INCIDENT_ROW = {
  id: 9, application_id: 1, environment_id: null, test_id: null,
  subject_type: 'certificate', subject_key: 'certificate:portal.kunde.dk:443',
  subject_label: 'Portal — portal.kunde.dk', kind: 'certificate_expiring', severity: 'WARN',
  status: 'open', summary: 'expires in 12 days', likely_cause: 'renewal', explanation: 'x',
  evidence: '["Days remaining: 12"]', occurrences: 2, opened_at: NOW, last_seen_at: NOW,
  resolved_at: null, resolved_by: null, resolution: null, notified_at: NOW, notified_severity: 'WARN',
};

test('the open lookup is per subject and never returns a resolved row', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_incidents WHERE subject_key = \?/i, () => rows([INCIDENT_ROW])]]);
  const repo = createIncidentsRepository({ db: { pool }, now });
  const found = await repo.findOpen('certificate:portal.kunde.dk:443');
  const [call] = pool.matching(/^SELECT .* FROM service_test_incidents WHERE subject_key/i);
  assert.match(call.sql, /status = 'open'/);
  assert.deepEqual(found.evidence, ['Days remaining: 12'], 'a JSON column arrives as a string on some servers and an object on others');
});

test('a repeat observation counts up and can only raise the severity', async () => {
  const pool = makeFakePool([
    [/^UPDATE service_test_incidents SET/i, () => ok()],
    [/^SELECT .* FROM service_test_incidents WHERE id = \?/i, () => rows([INCIDENT_ROW])],
  ]);
  const repo = createIncidentsRepository({ db: { pool }, now });
  await repo.touch(9, { severity: 'CRIT', summary: 'now expired' });
  const [call] = pool.matching(/^UPDATE service_test_incidents SET/i);
  assert.match(call.sql, /occurrences = occurrences \+ 1/);
  assert.match(call.sql, /FIELD\(\?, 'INFO','WARN','CRIT'\) > FIELD\(severity, 'INFO','WARN','CRIT'\)/,
    'a service that flaps must not downgrade itself out of an alert threshold');
});

test('resolving is a no-op on an already-resolved incident', async () => {
  const pool = makeFakePool([
    [/^UPDATE service_test_incidents SET status = 'resolved'/i, () => ok({ affectedRows: 0 })],
    [/^SELECT .* FROM service_test_incidents WHERE id = \?/i, () => rows([{ ...INCIDENT_ROW, status: 'resolved' }])],
  ]);
  const repo = createIncidentsRepository({ db: { pool }, now });
  const row = await repo.resolve(9, { resolvedBy: 3 });
  const [call] = pool.matching(/^UPDATE service_test_incidents SET status = 'resolved'/i);
  assert.match(call.sql, /AND status = 'open'/);
  assert.equal(row.status, 'resolved');
});

test('the window query asks what HAPPENED, not what is wrong now', async () => {
  // The Changes feed's question. An incident opened before the window and still
  // open is deliberately absent: it did not happen during the shift being
  // reviewed, and the Health tab is where standing problems live.
  const pool = makeFakePool([[/^SELECT .* FROM service_test_incidents\s+WHERE \(opened_at BETWEEN/i, () => rows([INCIDENT_ROW])]]);
  const repo = createIncidentsRepository({ db: { pool }, now });
  const from = new Date('2026-09-11T00:00:00.000Z');
  const to = new Date('2026-09-11T12:00:00.000Z');
  const out = await repo.listBetween({ from, to });

  const [call] = pool.matching(/^SELECT .* FROM service_test_incidents WHERE \(opened_at/i);
  assert.match(call.sql, /opened_at BETWEEN \? AND \?/);
  assert.match(call.sql, /resolved_at IS NOT NULL AND resolved_at BETWEEN \? AND \?/,
    'an incident that ENDED in the window is news too');
  assert.deepEqual(call.params, [from, to, from, to]);
  assert.equal(out[0].id, INCIDENT_ROW.id);
});

test('the window query is capped however large a limit it is handed', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_incidents WHERE \(opened_at/i, () => rows([])]]);
  const repo = createIncidentsRepository({ db: { pool }, now });
  await repo.listBetween({ from: new Date(0), limit: 99999 });
  assert.match(pool.matching(/^SELECT/i)[0].sql, /LIMIT 1000/);
});

test('the open counts answer the nav badge in one query', async () => {
  const pool = makeFakePool([[/^SELECT severity, COUNT\(\*\)/i, () => rows([{ severity: 'CRIT', n: 2 }, { severity: 'WARN', n: 5 }])]]);
  const repo = createIncidentsRepository({ db: { pool }, now });
  assert.deepEqual(await repo.openCounts(), { CRIT: 2, WARN: 5, INFO: 0, total: 7 });
});

test('history is purged by resolution date, and the window is floored rather than trusted', async () => {
  const pool = makeFakePool([[/^DELETE FROM service_test_incidents/i, () => ok({ affectedRows: 12 })]]);
  const repo = createIncidentsRepository({ db: { pool }, now });
  assert.equal(await repo.purgeResolvedOlderThan(90), 12);
  const [call] = pool.matching(/^DELETE FROM service_test_incidents/i);
  assert.match(call.sql, /status = 'resolved' AND resolved_at < \?/);
  assert.equal(call.params[0].getTime(), NOW.getTime() - 90 * 86400000);

  // A missing or nonsensical window falls back to the shipped 90 days rather
  // than to zero: getting this wrong deletes history the moment it is written.
  for (const bad of [0, null, undefined, 'soon', -5]) {
    // eslint-disable-next-line no-await-in-loop
    await repo.purgeResolvedOlderThan(bad);
    const last = pool.matching(/^DELETE FROM service_test_incidents/i).pop();
    assert.equal(last.params[0].getTime(), NOW.getTime() - 90 * 86400000, `window ${String(bad)}`);
  }
});

test('a list is capped however large a limit the caller asks for', async () => {
  const pool = makeFakePool([[/^SELECT .* FROM service_test_incidents/i, () => rows([])]]);
  const repo = createIncidentsRepository({ db: { pool }, now });
  await repo.list({ limit: 99999 });
  const [call] = pool.matching(/^SELECT .* FROM service_test_incidents/i);
  assert.match(call.sql, /LIMIT 500/);
});
