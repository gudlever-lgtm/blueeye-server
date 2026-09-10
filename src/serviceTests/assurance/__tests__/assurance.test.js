'use strict';

// Specs for the reaction layer: what a certificate check reads, what counts as
// worth reacting to, and what the reactor does about it.
//
// Nothing here opens a socket. The TLS checker is exercised against a fake
// connect() that emits the same events Node's tls module does, and the reactor
// runs over the in-memory module from test-support/serviceTestsFakes.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  createCertificateChecker, targetFromUrl, targetsFrom, parsePeerCertificate, daysUntil, verdict, STATUS,
} = require('../certificates');
const {
  certificateReaction, certificateSummary, runReaction, CERT_KIND, SEVERITY, explain,
} = require('../policy');
const { createAssuranceReactor, createAssuranceJob } = require('../reactor');
const { KIND } = require('../../runner/classify');
const { makeServiceTests } = require('../../../../test-support/serviceTestsFakes');

const DAY = 86400000;
const at = (offsetDays) => new Date(Date.UTC(2026, 0, 1) + offsetDays * DAY);

// A socket that behaves like tls.connect's: the caller attaches listeners, then
// the event fires on the next tick.
function fakeSocket({ event = 'secureConnect', cert = {}, authorized = true, authorizationError = null, error = null } = {}) {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  socket.authorized = authorized;
  socket.authorizationError = authorizationError;
  socket.getPeerCertificate = () => cert;
  setImmediate(() => {
    if (event === 'error') socket.emit('error', error || new Error('boom'));
    else socket.emit(event);
  });
  return socket;
}

const CERT = {
  subject: { CN: 'portal.kunde.dk' },
  issuer: { O: 'Let\'s Encrypt', CN: 'R3' },
  serialNumber: '04A1',
  fingerprint256: 'AA:BB:CC',
  subjectaltname: 'DNS:portal.kunde.dk, DNS:www.portal.kunde.dk',
  valid_from: 'Oct  1 00:00:00 2025 GMT',
  valid_to: 'Mar 14 09:00:00 2026 GMT',
};

// ------------------------------------------------------------------ targets
test('only https addresses become certificate targets, and never a denied one', () => {
  assert.deepEqual(targetFromUrl('https://portal.kunde.dk/login'), { host: 'portal.kunde.dk', port: 443, url: 'https://portal.kunde.dk' });
  assert.equal(targetFromUrl('https://portal.kunde.dk:8443').port, 8443);
  assert.equal(targetFromUrl('http://portal.kunde.dk'), null, 'plain http has no certificate to watch');
  assert.equal(targetFromUrl('not a url'), null);
  assert.equal(targetFromUrl(''), null);
  assert.equal(targetFromUrl(null), null);
  assert.equal(targetFromUrl('https://127.0.0.1'), null, 'loopback is denied everywhere else too');
  assert.equal(targetFromUrl('https://169.254.169.254'), null, 'the metadata address is never reachable');
});

test('two environments on one host are one certificate, and the first attribution wins', () => {
  const targets = targetsFrom([
    { url: 'https://portal.kunde.dk', environmentId: null },
    { url: 'https://portal.kunde.dk/admin', environmentId: 7 },
    { url: 'https://staging.kunde.dk', environmentId: 9 },
    { url: 'http://legacy.kunde.dk', environmentId: 11 },
  ]);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((t) => t.host), ['portal.kunde.dk', 'staging.kunde.dk']);
  assert.equal(targets[0].environmentId, null);
  assert.equal(targets[1].environmentId, 9);
});

// -------------------------------------------------------------- parse/judge
test('a peer certificate is flattened into the columns the table holds', () => {
  const parsed = parsePeerCertificate(CERT);
  assert.equal(parsed.subject, 'CN=portal.kunde.dk');
  assert.match(parsed.issuer, /Let's Encrypt/);
  assert.equal(parsed.serial_number, '04A1');
  assert.equal(parsed.fingerprint, 'AA:BB:CC');
  assert.equal(parsed.valid_to.toISOString().slice(0, 10), '2026-03-14');
});

test('a certificate with a shape we did not expect parses to nulls rather than throwing', () => {
  for (const input of [null, undefined, {}, { subject: 'not-an-object', valid_to: 'never' }]) {
    const parsed = parsePeerCertificate(input);
    assert.equal(parsed.valid_to, null);
    assert.equal(parsed.subject, null);
  }
});

test('days remaining is floored, and negative once it has expired', () => {
  assert.equal(daysUntil(at(10), at(0)), 10);
  assert.equal(daysUntil(new Date(at(0).getTime() + DAY + 3600000), at(0)), 1, 'a day and an hour is one whole day');
  assert.equal(daysUntil(at(-3), at(0)), -3);
  assert.equal(daysUntil(null, at(0)), null);
});

test('the verdict separates expired from merely unverifiable', () => {
  assert.equal(verdict({ daysRemaining: 200, warnDays: 30 }), STATUS.OK);
  assert.equal(verdict({ daysRemaining: 30, warnDays: 30 }), STATUS.EXPIRING, 'the boundary is inside the window');
  assert.equal(verdict({ daysRemaining: -1, warnDays: 30 }), STATUS.EXPIRED);
  assert.equal(verdict({ daysRemaining: 40, warnDays: 30, authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN' }), STATUS.INVALID);
  assert.equal(verdict({ daysRemaining: -2, warnDays: 30, authorized: false, authorizationError: 'CERT_HAS_EXPIRED' }), STATUS.EXPIRED,
    'an expired certificate also fails authorisation — report the expiry, it is the actionable half');
  assert.equal(verdict({ daysRemaining: null, warnDays: 30 }), STATUS.INVALID);
});

// ------------------------------------------------------------------ checker
test('the checker reads a live certificate without trusting it', async () => {
  const calls = [];
  const checker = createCertificateChecker({
    now: () => at(0),
    connect: (opts) => { calls.push(opts); return fakeSocket({ cert: CERT }); },
  });
  const row = await checker.check({ host: 'portal.kunde.dk', port: 443, url: 'https://portal.kunde.dk' }, { warnDays: 30 });
  assert.equal(calls[0].rejectUnauthorized, false, 'refusing a bad certificate would lose the fact we came for');
  assert.equal(calls[0].servername, 'portal.kunde.dk', 'SNI, or a shared host answers with the wrong certificate');
  assert.equal(row.status, STATUS.OK);
  assert.equal(row.host, 'portal.kunde.dk');
  assert.equal(row.days_remaining, daysUntil(new Date(CERT.valid_to), at(0)));
});

test('an unauthorised certificate is reported as invalid, with the reason', async () => {
  const checker = createCertificateChecker({
    now: () => at(0),
    connect: () => fakeSocket({ cert: CERT, authorized: false, authorizationError: new Error('ERR_TLS_CERT_ALTNAME_INVALID') }),
  });
  const row = await checker.check({ host: 'portal.kunde.dk', port: 443 }, { warnDays: 30 });
  assert.equal(row.status, STATUS.INVALID);
  assert.match(row.error_message, /ALTNAME/);
});

test('nothing answering is "unreachable", not a crash — and never resolves twice', async () => {
  for (const scenario of [
    { connect: () => fakeSocket({ event: 'error', error: new Error('ECONNREFUSED') }) },
    { connect: () => fakeSocket({ event: 'timeout' }) },
    { connect: () => fakeSocket({ event: 'close' }) },
    { connect: () => fakeSocket({ cert: {} }) },
    { connect: () => { throw new Error('getaddrinfo ENOTFOUND'); } },
    { connect: () => null },
  ]) {
    const checker = createCertificateChecker({ now: () => at(0), ...scenario });
    // eslint-disable-next-line no-await-in-loop
    const row = await checker.check({ host: 'gone.kunde.dk', port: 443 });
    assert.equal(row.status, STATUS.UNREACHABLE);
    assert.ok(row.error_message, 'an unreachable target still says why');
    assert.equal(row.days_remaining, null);
  }
});

// ------------------------------------------------------------------- policy
test('certificate severity follows the operator\'s own windows', () => {
  const opts = { warnDays: 30, criticalDays: 7 };
  const cert = (over) => ({ host: 'h', port: 443, status: STATUS.OK, days_remaining: 90, ...over });
  assert.equal(certificateReaction(cert(), opts), null, 'a healthy certificate is not an incident');
  assert.deepEqual(certificateReaction(cert({ days_remaining: 20, status: STATUS.EXPIRING }), opts),
    { kind: CERT_KIND.EXPIRING, severity: SEVERITY.WARN });
  assert.deepEqual(certificateReaction(cert({ days_remaining: 3, status: STATUS.EXPIRING }), opts),
    { kind: CERT_KIND.EXPIRING, severity: SEVERITY.CRIT });
  assert.deepEqual(certificateReaction(cert({ days_remaining: -1, status: STATUS.EXPIRED }), opts),
    { kind: CERT_KIND.EXPIRED, severity: SEVERITY.CRIT });
  assert.deepEqual(certificateReaction(cert({ status: STATUS.INVALID }), opts),
    { kind: CERT_KIND.INVALID, severity: SEVERITY.CRIT });
  assert.deepEqual(certificateReaction(cert({ status: STATUS.UNREACHABLE, days_remaining: null }), opts),
    { kind: CERT_KIND.UNREACHABLE, severity: SEVERITY.WARN });
  assert.equal(certificateReaction(null, opts), null);
  assert.equal(certificateReaction(cert({ days_remaining: 20, status: STATUS.EXPIRING }), { warnDays: 5, criticalDays: 1 }), null,
    'narrowing the window quiets it without waiting for the next poll');
});

test('a certificate summary reads as a sentence, not a field dump', () => {
  const cert = { host: 'portal.kunde.dk', port: 443, days_remaining: 1 };
  assert.equal(certificateSummary(cert, CERT_KIND.EXPIRING), 'The certificate for portal.kunde.dk expires in 1 day.');
  assert.equal(certificateSummary({ ...cert, days_remaining: 0 }, CERT_KIND.EXPIRING), 'The certificate for portal.kunde.dk expires today.');
  assert.equal(certificateSummary({ ...cert, days_remaining: -2 }, CERT_KIND.EXPIRED), 'The certificate for portal.kunde.dk expired 2 days ago.');
  assert.match(certificateSummary({ ...cert, port: 8443, days_remaining: 5 }, CERT_KIND.EXPIRING), /portal\.kunde\.dk:8443/);
});

test('an outage fails loudly; a drifted test does not page anyone', () => {
  assert.equal(runReaction({ failureKind: KIND.HTTP_500, streak: 1 }, { failureStreak: 2 }), null, 'one bad run is not an outage');
  assert.deepEqual(runReaction({ failureKind: KIND.HTTP_500, streak: 2 }, { failureStreak: 2 }), { kind: KIND.HTTP_500, severity: SEVERITY.CRIT });
  assert.deepEqual(runReaction({ failureKind: KIND.TLS, streak: 2 }, { failureStreak: 2 }), { kind: KIND.TLS, severity: SEVERITY.CRIT });
  assert.deepEqual(runReaction({ failureKind: KIND.ELEMENT_NOT_FOUND, streak: 9 }, { failureStreak: 2 }),
    { kind: KIND.ELEMENT_NOT_FOUND, severity: SEVERITY.WARN }, 'a renamed button never escalates to CRIT');
  assert.deepEqual(runReaction({ failureKind: KIND.UNKNOWN, streak: 2 }, { failureStreak: 2 }), { kind: KIND.UNKNOWN, severity: SEVERITY.WARN });
  assert.deepEqual(runReaction({ failureKind: KIND.UNKNOWN, streak: 4 }, { failureStreak: 2 }), { kind: KIND.UNKNOWN, severity: SEVERITY.CRIT },
    'an unexplained failure that will not go away eventually is one');
  assert.equal(runReaction({ failureKind: null, streak: 5 }, {}), null);
});

test('every incident kind can explain itself in plain language', () => {
  for (const kind of [...Object.values(CERT_KIND), KIND.HTTP_500, KIND.TLS, 'something-we-never-shipped']) {
    const e = explain(kind);
    assert.ok(e.summary && e.cause && e.detail, `${kind} has no explanation`);
  }
});

// ------------------------------------------------------------------ reactor
function withCertificates(seen, overrides = {}) {
  return makeServiceTests({ certificates_seen: seen, ...overrides });
}

test('an expiring certificate opens one incident and notifies once, however often it is swept', async () => {
  const mod = withCertificates({ 'customer.example.com': { status: 'expiring', days_remaining: 5, valid_to: new Date(Date.now() + 5 * DAY) } });
  await mod.reactor.sweepCertificates({ force: true });
  await mod.reactor.sweepCertificates({ force: true });
  await mod.reactor.sweepCertificates({ force: true });

  const open = await mod.repositories.incidents.list({ status: 'open' });
  assert.equal(open.length, 1, 'a repeat observation touches the incident, it does not add one');
  assert.equal(open[0].kind, CERT_KIND.EXPIRING);
  assert.equal(open[0].severity, SEVERITY.CRIT, 'five days is inside the critical window');
  assert.equal(open[0].occurrences, 3);
  assert.equal(mod.notifications.length, 1, 'an alert is a state change, not a heartbeat');
});

test('an incident escalates when it gets worse, and notifies again', async () => {
  const seen = { 'customer.example.com': { status: 'expiring', days_remaining: 20, valid_to: new Date(Date.now() + 20 * DAY) } };
  const mod = withCertificates(seen);
  await mod.reactor.sweepCertificates({ force: true });
  assert.equal(mod.notifications.length, 1);
  assert.equal(mod.notifications[0].finding.severity, SEVERITY.WARN);

  seen['customer.example.com'] = { status: 'expired', days_remaining: -1, valid_to: new Date(Date.now() - DAY) };
  await mod.reactor.sweepCertificates({ force: true });

  const open = await mod.repositories.incidents.list({ status: 'open' });
  assert.equal(open.length, 1);
  assert.equal(open[0].severity, SEVERITY.CRIT);
  assert.equal(open[0].kind, CERT_KIND.EXPIRED);
  assert.equal(mod.notifications.length, 2, 'WARN → CRIT is worth saying out loud');
  assert.equal(mod.notifications[1].finding.severity, SEVERITY.CRIT);
});

test('a renewed certificate resolves the incident and says so', async () => {
  const seen = { 'customer.example.com': { status: 'expired', days_remaining: -1, valid_to: new Date(Date.now() - DAY) } };
  const mod = withCertificates(seen);
  await mod.reactor.sweepCertificates({ force: true });
  delete seen['customer.example.com'];
  await mod.reactor.sweepCertificates({ force: true });

  assert.deepEqual(await mod.repositories.incidents.list({ status: 'open' }), []);
  const [incident] = await mod.repositories.incidents.list({ status: 'resolved' });
  assert.ok(incident.resolved_at);
  assert.equal(mod.notifications.length, 2);
  assert.equal(mod.notifications[1].finding.severity, 'INFO');
  assert.match(mod.notifications[1].finding.explanation, /^Recovered:/);
});

test('two applications on one host keep their own incident', async () => {
  const mod = makeServiceTests({
    applications: [
      { name: 'Portal', base_url: 'https://shared.kunde.dk', enabled: 1 },
      { name: 'Admin', base_url: 'https://shared.kunde.dk', enabled: 1 },
    ],
    environments: [],
    certificates_seen: { 'shared.kunde.dk': { status: 'expired', days_remaining: -1 } },
  });
  await mod.reactor.sweepCertificates({ force: true });
  const open = await mod.repositories.incidents.list({ status: 'open' });
  assert.equal(open.length, 2, 'one application recovering must not resolve the other\'s incident');
  assert.deepEqual(open.map((i) => i.application_id).sort(), [1, 2]);
});

test('the check interval is respected unless the operator forces it', async () => {
  const mod = withCertificates({});
  const first = await mod.reactor.sweepCertificates({ force: true });
  assert.equal(first.checked, 1);
  const second = await mod.reactor.sweepCertificates();
  assert.equal(second.checked, 0, 'a certificate read six hours ago is not read again on the next sweep');
  const forced = await mod.reactor.sweepCertificates({ force: true });
  assert.equal(forced.checked, 1);
});

test('watchCertificates off stops the sweep; the forced check still works for a one-off', async () => {
  const mod = withCertificates({});
  await mod.settings.set('assurance', { watchCertificates: false });
  assert.equal((await mod.reactor.sweepCertificates()).skipped, 'disabled');
  assert.equal((await mod.reactor.sweepCertificates({ force: true })).checked, 1);
});

test('notify off keeps recording incidents and sends nothing', async () => {
  const mod = withCertificates({ 'customer.example.com': { status: 'expired', days_remaining: -5 } });
  await mod.settings.set('assurance', { notify: false });
  await mod.reactor.sweepCertificates({ force: true });
  assert.equal((await mod.repositories.incidents.list({ status: 'open' })).length, 1);
  assert.equal(mod.notifications.length, 0);
});

test('a notify channel that throws never stops the sweep', async () => {
  const mod = makeServiceTests({ certificates_seen: { 'customer.example.com': { status: 'expired', days_remaining: -5 } } });
  const reactor = createAssuranceReactor({
    repositories: mod.repositories,
    settings: mod.settings,
    certificateChecker: { check: async (target) => ({ host: target.host, port: target.port, status: 'expired', days_remaining: -5, checked_at: new Date() }) },
    notify: () => Promise.reject(new Error('SMTP is down')),
  });
  await reactor.sweepCertificates({ force: true });
  const [incident] = await mod.repositories.incidents.list({ status: 'open' });
  assert.ok(incident, 'the incident is durable even when the alert is not');
  assert.equal(incident.notified_severity, null, 'and it will be retried, because nothing was marked sent');
});

// ------------------------------------------------------------- test streaks
function seedRuns(mod, statuses, { failureKind = KIND.HTTP_503, testId = 1 } = {}) {
  mod.tables.runs.rows.length = 0;
  // history() is newest-first; seed oldest-first and let the fake reverse it.
  statuses.forEach((status, i) => mod.tables.runs.insert({
    test_id: testId,
    status,
    duration_ms: 100,
    error_message: status === 'pass' ? null : 'the service answered 503',
    failure_kind: status === 'pass' ? null : failureKind,
    created_at: new Date(Date.now() + i * 1000),
  }));
}

test('one failure is not an incident; two in a row is', async () => {
  const mod = makeServiceTests();
  seedRuns(mod, ['pass', 'fail']);
  await mod.reactor.sweepTests();
  assert.deepEqual(await mod.repositories.incidents.list({ status: 'open' }), []);

  seedRuns(mod, ['pass', 'fail', 'fail']);
  await mod.reactor.sweepTests();
  const [incident] = await mod.repositories.incidents.list({ status: 'open' });
  assert.ok(incident, 'two consecutive failures is a service, not a bad minute');
  assert.equal(incident.severity, SEVERITY.CRIT, 'a 503 is the service failing');
  assert.equal(incident.subject_key, 'test:1');
  assert.match(incident.summary, /failed 2 runs in a row/);
});

test('a passing run resolves the test incident', async () => {
  const mod = makeServiceTests();
  seedRuns(mod, ['fail', 'fail']);
  await mod.reactor.sweepTests();
  assert.equal((await mod.repositories.incidents.list({ status: 'open' })).length, 1);

  seedRuns(mod, ['fail', 'fail', 'pass']);
  await mod.reactor.sweepTests();
  assert.deepEqual(await mod.repositories.incidents.list({ status: 'open' }), []);
  assert.equal((await mod.repositories.incidents.list({ status: 'resolved' })).length, 1);
});

test('the streak ignores runs that never produced an outcome', () => {
  const mod = makeServiceTests();
  const { streak } = mod.reactor.streakOf({
    runs: [
      { status: 'queued' }, { status: 'running' },
      { status: 'fail', id: 3 }, { status: 'skipped' }, { status: 'error', id: 1 },
      { status: 'pass' }, { status: 'fail' },
    ],
  });
  assert.equal(streak, 2, 'queued and running have no outcome; skipped is about the test, not the service');
});

test('a disabled test is not watched', async () => {
  const mod = makeServiceTests();
  mod.tables.tests.update(1, { enabled: 0 });
  seedRuns(mod, ['fail', 'fail', 'fail']);
  const result = await mod.reactor.sweepTests();
  assert.equal(result.evaluated, 0);
  assert.deepEqual(await mod.repositories.incidents.list({ status: 'open' }), []);
});

test('the whole sweep can be switched off, and a broken repository never takes it down', async () => {
  const mod = makeServiceTests();
  await mod.settings.set('assurance', { enabled: false });
  assert.deepEqual(await mod.reactor.sweep(), { skipped: 'disabled' });

  const broken = createAssuranceReactor({
    repositories: { ...mod.repositories, tests: { list: () => Promise.reject(new Error('the database went away')) } },
    settings: mod.settings,
    certificateChecker: { check: async () => ({ host: 'x', port: 443, status: 'ok', days_remaining: 400 }) },
  });
  await assert.rejects(() => broken.sweepTests(), /database went away/, 'a hard repository failure surfaces to the job wrapper');
});

test('the background job re-reads its cadence and stops cleanly', async () => {
  let sweeps = 0;
  const settings = { get: async () => ({ sweepIntervalMs: 30000 }) };
  const job = createAssuranceJob({ reactor: { sweep: async () => { sweeps += 1; } }, settings });
  job.start();
  job.start(); // starting twice must not arm two timers
  job.stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sweeps, 0, 'stopping before the first delay means nothing ran');
  assert.doesNotThrow(() => job.stop());
});
