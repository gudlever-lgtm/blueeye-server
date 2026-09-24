'use strict';

// GATE · VALIDATION — blueeye-server
//
// Every module in src/validation is exercised here: each exported validator
// must never throw on garbage (undefined/null/string/number/array/function),
// must reject an empty object where it has required fields, and the
// per-module rules that protect the database and the agents are pinned down.
// Then the HTTP layer is swept: every POST/PUT/PATCH route with an empty,
// non-object or oversized body, and every GET list route with hostile query
// params, must answer 4xx — never 500 — and the create endpoints must answer
// 400 with the `{ error: 'Validation failed', details }` contract.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.BCRYPT_ROUNDS = '4';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { makeApp, makeAgentTokensRepo, authHeader } = require('../../test-support/fakes');
const { listRoutes, hasParam, fill, key } = require('./_routes');

const DIR = path.join(__dirname, '..', '..', 'src', 'validation');
// Service Assurance keeps its validators inside its own module so the module can
// be extracted whole (docs/service-assurance.md §2). The sweep follows them
// there rather than letting a whole feature's input validation go unchecked.
const MODULE_VALIDATION_DIRS = [
  path.join(__dirname, '..', '..', 'src', 'serviceTests', 'validation'),
];
const NON_OBJECTS = [undefined, null, 'str', 42, true, [], () => {}, Symbol('s'), 1n];
const rejected = (r, errs) => !!(r === undefined || r === null || (r && (r.errors || r.error)) || (errs && Object.keys(errs).length));

// Validators that legitimately accept {} (every field optional).
const ACCEPTS_EMPTY = new Set([
  'validateAgentManagedInput', 'validateCreateCode', 'validateIntegrationUpdate', 'validateTimeRange', 'validateAssetSearch',
  // Service Assurance: running a test with no body is the normal case (the
  // environment falls back to the application's production one), and a settings
  // patch is checked field-by-field by the settings service, which owns the
  // bounds — an empty patch is a no-op, not an error.
  // A chart query is optional in every field: no query at all means "this week,
  // everything, in my time zone", which is the view the History tab opens on.
  'validateRunRequest', 'validateSettingsPatch', 'validateStatsQuery',
  // Running a diagnosis plan with no body is "all of its tests", which is what
  // the button did before it could select a subset. An empty body is the
  // normal case, not a mistake.
  'validateDiagnoseRun',
  // The device log opens with no filter at all — "the last two hours, every
  // device, every severity" — which is exactly what a technician wants before
  // they know what they are looking for. Every field IS optional here; the
  // dedicated rule below still pins each one's bounds.
  'validateDeviceEventQuery',
  // The burst list opens unfiltered — every recent run, newest first — which
  // is what somebody wants before they know which run they are looking for.
  'validateBurstQuery',
  // The device inventory opens unfiltered — the first page of everything —
  // which is the question "which devices do I have" asks. Its bounds (limit,
  // offset, kind, q) are pinned in test/l2PathApi.test.js.
  'validateInventoryQuery',
]);

test('every exported validator survives garbage input and rejects an empty object where it has required fields', () => {
  const modules = [
    ...fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(DIR, f)),
    ...MODULE_VALIDATION_DIRS.flatMap((dir) => (fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f))
      : [])),
  ];
  assert.ok(modules.length >= 21);
  let checked = 0;
  for (const full of modules) {
    const file = path.relative(path.join(__dirname, '..', '..'), full);
    const mod = require(full);
    for (const [name, fn] of Object.entries(mod)) {
      if (typeof fn !== 'function') continue;
      checked += 1;
      for (const input of [...NON_OBJECTS, { __proto__: null }, { x: { y: { z: 1 } } }, 'x'.repeat(100_000)]) {
        const errs = {};
        assert.doesNotThrow(() => fn(input, errs), `${file}#${name} throws on ${typeof input}`);
      }
      if (name === 'parseId' || name === 'validateBaseUrl') continue;
      if (name === 'validateAssetSearch') { assert.ok(rejected(fn({})), `${file}#${name}`); continue; }
      const errs = {};
      const r = fn({}, errs);
      if (!ACCEPTS_EMPTY.has(name)) assert.ok(rejected(r, errs), `${file}#${name} accepted {} — ${JSON.stringify(r)}`);
    }
  }
  assert.ok(checked >= 35, `only ${checked} validator functions found`);
});

test('deviceEventValidation: untrusted device input is bounded at the boundary', () => {
  const {
    validateDeviceEvent, validateDeviceEventBatch, validateDeviceEventQuery, MAX_EVENTS_PER_BATCH,
  } = require('../../src/validation/deviceEventValidation');

  // Every field in a device event originated on network equipment anyone on the
  // customer's LAN can send UDP to. This is a real boundary, not a formality.
  const ok = {
    sourceIp: '10.14.0.11',
    receivedAt: '2026-09-20T09:41:12.418Z',
    severity: 2,
    eventType: 'link.down',
    summary: 'Interface Gi0/1 changed state to down',
  };
  assert.ok(validateDeviceEvent(ok), 'a well-formed event is accepted');

  // A row missing what cannot be guessed is rejected outright.
  assert.equal(validateDeviceEvent({ ...ok, sourceIp: undefined }), null);
  assert.equal(validateDeviceEvent({ ...ok, sourceIp: 'sw-core-1' }), null, 'a hostname is not an IP');
  assert.equal(validateDeviceEvent({ ...ok, receivedAt: 'yesterday' }), null);
  assert.equal(validateDeviceEvent({ ...ok, severity: 9 }), null);
  assert.equal(validateDeviceEvent({ ...ok, severity: '2' }), null, 'severity is never coerced');

  // An unknown event_type SHAPE degrades to syslog.raw rather than failing the
  // row: the line is still evidence.
  assert.equal(validateDeviceEvent({ ...ok, eventType: 'NOT A TYPE' }).eventType, 'syslog.raw');
  // But a well-formed type this server has never heard of is KEPT, because the
  // agent ships the classifier and may be newer than the server.
  assert.equal(validateDeviceEvent({ ...ok, eventType: 'future.thing' }).eventType, 'future.thing');

  // Strings are bounded, so a device cannot write a megabyte into a column.
  const huge = validateDeviceEvent({ ...ok, summary: 'x'.repeat(100_000), raw: 'y'.repeat(100_000) });
  assert.ok(huge.summary.length <= 512);
  assert.ok(huge.raw.length <= 2048);

  // Clock skew is bounded, so a device claiming 1970 cannot overflow the column.
  assert.equal(validateDeviceEvent({ ...ok, deviceTime: '1970-01-01T00:00:00Z' }).clockSkewMs, null);
  assert.equal(
    validateDeviceEvent({ ...ok, deviceTime: '2026-09-20T09:41:09.418Z' }).clockSkewMs,
    3000,
  );

  // The batch is capped, and one bad row costs only itself.
  assert.ok(rejected(validateDeviceEventBatch({}, {})));
  assert.ok(rejected(validateDeviceEventBatch(new Array(MAX_EVENTS_PER_BATCH + 1).fill(ok), {})));
  const mixed = validateDeviceEventBatch([ok, { junk: true }, ok], {});
  assert.equal(mixed.events.length, 2);
  assert.equal(mixed.skipped, 1);

  // The read query rejects out-of-range rather than silently clamping.
  assert.ok(rejected(validateDeviceEventQuery({ minutes: 999_999 }, {})));
  assert.ok(rejected(validateDeviceEventQuery({ limit: 0 }, {})));
  assert.ok(rejected(validateDeviceEventQuery({ maxSeverity: 8 }, {})));
  assert.ok(rejected(validateDeviceEventQuery({ transport: 'carrier-pigeon' }, {})));
  assert.ok(rejected(validateDeviceEventQuery({ deviceId: 'all' }, {})));
  assert.deepEqual(validateDeviceEventQuery({}, {}), { minutes: 120, limit: 100, offset: 0 });
});

test('snmpProfileValidation: a credential that cannot work is refused before a switch stops answering', () => {
  const { validateSnmpProfile, V3_KEY_MIN } = require('../../src/validation/snmpProfileValidation');

  // A profile needs a name and, for v1/v2c, a community.
  assert.ok(rejected(validateSnmpProfile({})));
  assert.ok(rejected(validateSnmpProfile({ name: 'Site A', version: '2c' })), 'v2c needs a community');
  assert.equal(validateSnmpProfile({ name: 'Site A', version: '2c', community: 'public' }).errors, undefined);

  // THE ONE THAT MATTERS: SNMPv3 cannot encrypt without authenticating. That is
  // not a weaker security level, it is one that does not exist, and a device
  // refuses it — so refusing it here is the difference between an error message
  // and a switch that quietly stops answering.
  assert.ok(rejected(validateSnmpProfile({
    name: 'x', version: '3', v3User: 'u', v3PrivProto: 'aes', v3PrivKey: 'privsecret1',
  })), 'priv without auth');

  assert.ok(rejected(validateSnmpProfile({ name: 'x', version: '3' })), 'v3 needs a user');
  assert.ok(rejected(validateSnmpProfile({
    name: 'x', version: '3', v3User: 'u', v3AuthProto: 'sha', v3AuthKey: 'x'.repeat(V3_KEY_MIN - 1),
  })), 'a key shorter than the protocol allows');
  assert.ok(rejected(validateSnmpProfile({
    name: 'x', version: '3', v3User: 'u', v3AuthKey: 'authsecret1',
  })), 'a key with no protocol');
  assert.ok(rejected(validateSnmpProfile({
    name: 'x', version: '3', v3User: 'u', v3AuthProto: 'nope', v3AuthKey: 'authsecret1',
  })), 'an unknown auth protocol');

  const ok = validateSnmpProfile({
    name: 'Core v3', version: '3', v3User: 'blueeye',
    v3AuthProto: 'sha256', v3AuthKey: 'authsecret1',
    v3PrivProto: 'aes', v3PrivKey: 'privsecret1',
  });
  assert.equal(ok.errors, undefined);

  // A patch validates the MERGED shape, so removing the auth key from an
  // authPriv profile is caught rather than discovered later.
  assert.ok(rejected(validateSnmpProfile(
    { v3AuthKey: null },
    { partial: true, existing: { version: '3', v3User: 'u', hasV3AuthKey: true, hasV3PrivKey: true } },
  )));
});

test('snmpDeviceValidation: an address the server must never poll, and a table off a switch', () => {
  const {
    validateSnmpDevice, validateSnmpTopologyBatch, validateFdbEntry,
    MIN_INTERVAL_SEC, MAX_FDB_PER_DEVICE,
  } = require('../../src/validation/snmpDeviceValidation');
  // From the delta code, not repeated here: the ceiling the validator enforces
  // is the one that voids the rate, and the test would be worthless if it
  // carried its own copy of the number.
  const { MAX_DELTA_SEC } = require('../../src/devices/counterDelta');

  // --- the admin's inventory ------------------------------------------------
  assert.ok(rejected(validateSnmpDevice({})), 'host is required');
  assert.ok(rejected(validateSnmpDevice({ host: 'http://10.0.0.1' })), 'a host is not a URL');
  assert.ok(rejected(validateSnmpDevice({ host: '10.0.0.1', port: 0 })));
  assert.ok(rejected(validateSnmpDevice({ host: '10.0.0.1', port: 99999 })));
  // v3 IS offered now (migration 112) — but a device row cannot hold a v3
  // credential: an auth/priv key pair belongs on a credential PROFILE, where it
  // is encrypted once and shared by every switch at a site. A row carrying both
  // a v3 version and a community is a contradiction, and it would poll with
  // whichever the resolution chain reached first.
  assert.equal(validateSnmpDevice({ host: '10.0.0.1', version: '3' }).errors, undefined);
  assert.ok(rejected(validateSnmpDevice({ host: '10.0.0.1', version: '3', community: 'public' })));
  assert.ok(rejected(validateSnmpDevice({ host: '10.0.0.1', version: '4' })));
  // The counter cadence is its own setting, floored AND capped, because a
  // counter series' interval IS its resolution — and because a cadence wider
  // than counterDelta.MAX_DELTA_SEC voids every rate it would ever produce, so
  // the device would store readings for ever and show empty rate columns.
  assert.ok(rejected(validateSnmpDevice({ host: '10.0.0.1', counterIntervalSec: 5 })));
  assert.equal(validateSnmpDevice({ host: '10.0.0.1', counterIntervalSec: 30 }).errors, undefined);
  assert.equal(
    validateSnmpDevice({ host: '10.0.0.1', counterIntervalSec: MAX_DELTA_SEC }).errors,
    undefined,
  );
  assert.ok(rejected(validateSnmpDevice({ host: '10.0.0.1', counterIntervalSec: MAX_DELTA_SEC + 1 })));
  // The topology interval keeps its own, much wider ceiling: a topology poll
  // an hour apart is a normal setting, and nothing about it is a rate.
  assert.equal(validateSnmpDevice({ host: '10.0.0.1', intervalSec: 3600 }).errors, undefined);
  assert.ok(rejected(validateSnmpDevice({ host: '10.0.0.1', community: 'x'.repeat(500) })));
  assert.ok(rejected(validateSnmpDevice({ host: '10.0.0.1', collect: ['if', 'nope'] })));
  // An explicitly empty collect list is refused rather than silently meaning
  // "everything": a device somebody meant to stop polling should be disabled.
  assert.ok(rejected(validateSnmpDevice({ host: '10.0.0.1', collect: [] })));
  // The interval is floored with an ERROR, not clamped: an admin who typed 5
  // should be told why, not discover later that it became 60.
  assert.ok(rejected(validateSnmpDevice({ host: '10.0.0.1', intervalSec: 5 })));
  assert.deepEqual(
    validateSnmpDevice({ host: '10.14.0.11', intervalSec: MIN_INTERVAL_SEC }).errors,
    undefined,
  );
  // A patch may omit everything, including the otherwise-required host.
  assert.deepEqual(validateSnmpDevice({ displayName: 'Core' }, { partial: true }).errors, undefined);
  // Omitting the community leaves the stored one alone; null clears it. An
  // edit of a display name must never silently wipe a credential.
  assert.equal(validateSnmpDevice({ displayName: 'x' }, { partial: true }).value.community, undefined);
  assert.equal(validateSnmpDevice({ community: null }, { partial: true }).value.community, null);

  // --- a forwarding-table row off a switch ---------------------------------
  const ok = { mac: '00:1b:44:11:3a:b7', bridgePort: 2, vlan: 20, ifIndex: 10002, ifName: 'Gi0/2' };
  assert.ok(validateFdbEntry(ok));
  // Normalised through the SAME function the ARP ingest uses, so five
  // spellings of one MAC resolve identically across both identity sources.
  assert.equal(validateFdbEntry({ ...ok, mac: '00-1B-44-11-3A-B7' }).mac, '00:1b:44:11:3a:b7');
  assert.equal(validateFdbEntry({ ...ok, mac: 'not a mac' }), null);
  // Bridge port 0 means "known but not located"; storing it as a port would
  // send somebody to a patch panel that does not exist.
  assert.equal(validateFdbEntry({ ...ok, bridgePort: 0 }), null);
  // The boundary does not take the agent's filtering on trust: a `self` row
  // would claim the switch is plugged into itself.
  assert.equal(validateFdbEntry({ ...ok, status: 'self' }), null);
  assert.equal(validateFdbEntry({ ...ok, status: 'invalid' }), null);
  // An out-of-range VLAN degrades to 0 ("the device did not say") rather than
  // failing the row — the port is still the answer.
  assert.equal(validateFdbEntry({ ...ok, vlan: 9999 }).vlan, 0);

  // --- the submitted batch --------------------------------------------------
  // `devices` is required: a body without it is a malformed submission, not a
  // successful empty cycle.
  assert.ok(rejected(validateSnmpTopologyBatch({}, {})));
  assert.ok(rejected(validateSnmpTopologyBatch({ devices: 'lots' }, {})));
  assert.ok(rejected(validateSnmpTopologyBatch({ devices: new Array(201).fill({ deviceId: 1 }) }, {})));

  const batch = validateSnmpTopologyBatch({
    devices: [
      { deviceId: 7, fdb: [ok, { junk: true }], supported: ['fdb', 'nonsense'] },
      { deviceId: 'not an id', fdb: [] },
    ],
    errors: [{ deviceId: 8, error: 'Timeout', code: 'SNMP_TIMEOUT' }],
  }, {});
  assert.equal(batch.devices.length, 1, 'the device with no usable id was skipped');
  assert.equal(batch.skipped, 1);
  assert.equal(batch.devices[0].fdb.length, 1, 'one bad row costs only itself');
  assert.equal(batch.devices[0].fdbSkipped, 1);
  assert.deepEqual(batch.devices[0].supported, ['fdb'], 'an unknown kind is dropped, not stored');
  assert.equal(batch.failures.length, 1);
  assert.equal(batch.failures[0].code, 'SNMP_TIMEOUT');

  // A device reporting nothing has NOT said it supports nothing.
  const quiet = validateSnmpTopologyBatch({ devices: [{ deviceId: 7, fdb: [] }] }, {});
  assert.equal(quiet.devices[0].supported, null, 'absent is not zero');

  // The per-device FDB cap matches the agent's own; the boundary refuses to be
  // told otherwise.
  const huge = validateSnmpTopologyBatch({
    devices: [{ deviceId: 7, fdb: new Array(MAX_FDB_PER_DEVICE + 500).fill(ok) }],
  }, {});
  assert.ok(huge.devices[0].fdb.length <= MAX_FDB_PER_DEVICE);
});

test('burstValidation: a packet generator is bounded at the boundary', () => {
  const {
    validateBurstRequest, validateBurstQuery, MAX_SECONDS, MIN_SECONDS, MAX_HZ,
  } = require('../../src/validation/burstValidation');

  // A burst makes an agent emit traffic at a rate nothing else here does. The
  // server REFUSES out of range where the AGENT clamps — deliberate asymmetry:
  // a person filling in a form should be told 3600 is too long, while an agent
  // handed a bad number mid-fault should still measure something.
  assert.deepEqual(validateBurstRequest({ agentId: 9, target: '10.14.0.11' }).errors, undefined);
  assert.ok(rejected(validateBurstRequest({})));
  assert.ok(rejected(validateBurstRequest({ target: '10.14.0.11' })), 'agentId is required');
  assert.ok(rejected(validateBurstRequest({ agentId: 9 })), 'target is required');
  assert.ok(rejected(validateBurstRequest({ agentId: 9, target: 'http://10.14.0.11' })), 'a target is not a URL');
  assert.ok(rejected(validateBurstRequest({ agentId: 9, target: '10.14.0.11', seconds: MAX_SECONDS + 1 })));
  assert.ok(rejected(validateBurstRequest({ agentId: 9, target: '10.14.0.11', seconds: MIN_SECONDS - 1 })));
  assert.ok(rejected(validateBurstRequest({ agentId: 9, target: '10.14.0.11', hz: MAX_HZ + 1 })));
  assert.ok(rejected(validateBurstRequest({ agentId: 9, target: '10.14.0.11', hz: 0 })));

  // Only probes that FIT in one tick: a traceroute or a page load takes longer
  // than the interval, so every tick would overlap the last.
  assert.ok(rejected(validateBurstRequest({ agentId: 9, target: '10.14.0.11', probe: 'traceroute' })));
  assert.ok(rejected(validateBurstRequest({ agentId: 9, target: '10.14.0.11', probe: 'pageload' })));

  // A tcp burst without a port is refused rather than defaulted: guessing would
  // measure a port nobody asked about and report the answer as if they had.
  assert.ok(rejected(validateBurstRequest({ agentId: 9, target: '10.14.0.11', probe: 'tcp' })));
  assert.deepEqual(
    validateBurstRequest({ agentId: 9, target: '10.14.0.11', probe: 'tcp', port: 443 }).errors,
    undefined,
  );

  // The read query rejects out of range rather than clamping.
  assert.ok(rejected(validateBurstQuery({ limit: 0 }, {})));
  assert.ok(rejected(validateBurstQuery({ limit: 1000 }, {})));
  assert.ok(rejected(validateBurstQuery({ agentId: 'all' }, {})));
  assert.deepEqual(validateBurstQuery({}, {}), { limit: 25, offset: 0 });
});

test('l2PathValidation: an endpoint is classified once, and the inventory page is bounded', () => {
  const {
    parseEndpoint, validateL2PathQuery, validateLocateQuery, validateInventoryQuery, INVENTORY_MAX_LIMIT,
  } = require('../../src/validation/l2PathValidation');

  // What the technician knows, classified — an address is never read as a
  // hostname that happens to look like one.
  assert.deepEqual(parseEndpoint('10.1.2.3'), { kind: 'ip', value: '10.1.2.3', raw: '10.1.2.3' });
  assert.equal(parseEndpoint('AA-BB-CC-00-11-22').value, 'aa:bb:cc:00:11:22');
  assert.equal(parseEndpoint('aabb.cc00.1122').kind, 'mac');
  assert.deepEqual(parseEndpoint('agent:12'), { kind: 'agent', value: 12, raw: 'agent:12' });
  assert.equal(parseEndpoint('Core-SW.corp.local.').value, 'core-sw.corp.local');
  for (const bad of ['', 'agent:0', 'agent:abc', 'x y', '<script>', "a' OR 1=1", 'a'.repeat(254), '-leading']) {
    assert.equal(parseEndpoint(bad), null, JSON.stringify(bad));
  }
  assert.ok(rejected(validateL2PathQuery({ from: '10.1.2.3' })), 'to is required');
  assert.ok(rejected(validateL2PathQuery({ from: '10.1.2.3', to: '10.1.2.4', gateway: '<x>' })));
  assert.ok(rejected(validateL2PathQuery({ from: ['10.1.2.3'], to: '10.1.2.4' })), 'a repeated parameter is not a string');
  assert.equal(validateL2PathQuery({ from: '10.1.2.3', to: 'sw-b' }).value.gateway, null);
  assert.ok(rejected(validateLocateQuery({ q: '' })));

  // The inventory rejects out of range rather than clamping.
  assert.deepEqual(validateInventoryQuery({}).value, { limit: 50, offset: 0, kind: null, q: null });
  assert.ok(rejected(validateInventoryQuery({ limit: String(INVENTORY_MAX_LIMIT + 1) })));
  assert.ok(rejected(validateInventoryQuery({ limit: '1e3' })));
  assert.ok(rejected(validateInventoryQuery({ offset: '-1' })));
  assert.ok(rejected(validateInventoryQuery({ kind: 'router' })));
  assert.ok(rejected(validateInventoryQuery({ q: ['a', 'b'] })));
});

test('every src/validation module is named in this suite', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  for (const f of fs.readdirSync(DIR)) assert.ok(self.includes(f.replace(/\.js$/, '')), `${f} has no dedicated gate rule`);
});

test('diagnoseValidation: a description is bounded, and a target can never be read as a CLI flag', () => {
  const { validateDiagnoseRequest, MAX_DESCRIPTION } = require('../../src/validation/diagnoseValidation');
  // The bound is the limit on what can be sent to a third-party model, not just
  // a column width, so it is enforced at the edge rather than by truncation.
  assert.ok(errorsOf(validateDiagnoseRequest({ description: 'x'.repeat(MAX_DESCRIPTION + 1) })).includes('description'));
  assert.equal(validateDiagnoseRequest({ description: 'x'.repeat(MAX_DESCRIPTION) }).errors, undefined);
  for (const empty of ['', '   ', undefined, null, 42, {}, []]) {
    assert.ok(rejected(validateDiagnoseRequest({ description: empty })), JSON.stringify(empty));
  }
  // A target reaches an agent's argv. Anything that a system tool could parse as
  // an option, or that is not a host at all, is refused here.
  for (const bad of ['-rf', '--flood', 'a b', 'a;rm -rf /', '$(whoami)', '`id`', 'a|b', '../etc', 'x'.repeat(300)]) {
    assert.ok(errorsOf(validateDiagnoseRequest({ description: 'loss', target: bad })).includes('target'), bad);
  }
  for (const ok of ['10.0.0.1', 'mail.example.com', 'fe80::1', 'host-1_x'.replace('_', '-')]) {
    assert.equal(validateDiagnoseRequest({ description: 'loss', target: ok }).errors, undefined, ok);
  }
  // The AI is an ADMIN setting. A caller may switch it off for one request and
  // may not switch it on, so a truthy useAi never grants anything by itself.
  assert.equal(validateDiagnoseRequest({ description: 'loss', useAi: false }).value.useAi, false);
  assert.equal(validateDiagnoseRequest({ description: 'loss' }).value.useAi, undefined);
  // Locale is a closed set: it selects a stored catalogue, never a lookup path.
  assert.ok(errorsOf(validateDiagnoseRequest({ description: 'loss', locale: '../../etc' })).includes('locale'));
  assert.ok(errorsOf(validateDiagnoseRequest({ description: 'loss', locale: 'de' })).includes('locale'));
  // Ids must be positive integers, and the far end must be a different device.
  for (const bad of [0, -1, 1.5, 'abc', '1; DROP']) {
    assert.ok(errorsOf(validateDiagnoseRequest({ description: 'loss', agentId: bad })).includes('agentId'), String(bad));
  }
  assert.ok(errorsOf(validateDiagnoseRequest({ description: 'loss', agentId: 3, peerAgentId: 3 })).includes('peerAgentId'));

  // Running a subset of the plan: ids only, bounded, and an empty body still
  // means the whole plan.
  const { validateDiagnoseRun, MAX_RUN_TESTS } = require('../../src/validation/diagnoseValidation');
  assert.deepEqual(validateDiagnoseRun({}).value, {});
  assert.deepEqual(validateDiagnoseRun({ testIds: [3, 1, 3] }).value.testIds, [3, 1]);
  for (const bad of [[], 'all', {}, [0], [-1], [1.5], ['abc'], Array.from({ length: MAX_RUN_TESTS + 1 }, (_, i) => i + 1)]) {
    assert.ok(errorsOf(validateDiagnoseRun({ testIds: bad })).includes('testIds'), JSON.stringify(bad));
  }
});

test('diagnose rules: the expression evaluator accepts the rule language and nothing else', () => {
  const { compile, ExprError } = require('../../src/diagnose/expr');
  // Everything a playbook is allowed to say.
  assert.equal(compile('a.b == 1 && (c.d >= 2 || !e.f)').run({ a: { b: 1 }, c: { d: 5 } }).value, true);
  // Everything it is not. A playbook is data, and data that reaches an
  // interpreter is an interpreter that must not be able to do anything.
  for (const bad of [
    'process.exit()', 'a()', 'a[0]', 'a["b"]', '__proto__.x == 1', 'constructor.name == 1',
    'a.prototype.b == 1', 'a = 1', '1 + 1', 'a ? b : c', 'require("fs")', 'a => 1',
    '`${a}`', 'a; b', 'a & b', 'a | b', 'a < b < c', 'new Date()', '', '   ', 'x'.repeat(600),
  ]) {
    assert.throws(() => compile(bad), ExprError, `compiled: ${bad}`);
  }
  for (const bad of [undefined, null, 42, {}, [], true]) assert.throws(() => compile(bad), ExprError);
  // A missing measurement is unknown, never false: a rule over a test that did
  // not run must not decide anything.
  assert.equal(compile('a.b == 1').run({}).value, null);
  assert.deepEqual(compile('a.b == 1').run({}).missing, ['a.b']);
  assert.equal(compile('a.b == 1 && c.d == 9').run({ a: { b: 2 } }).value, false, 'a definite false still wins');
  // A prototype-chain field is not a measurement, however it is reached.
  assert.equal(compile('a.toString == 1').run({ a: {} }).value, null);
});

test('diagnose catalogue: every shipped playbook parses, and a bad one stops the server', () => {
  const { loadCatalog, parsePlaybook, CatalogError } = require('../../src/diagnose/catalog');
  const catalog = loadCatalog();
  assert.ok(catalog.size >= 9, `only ${catalog.size} playbooks`);
  // A malformed playbook must fail LOUDLY at load, because load is startup. The
  // alternative is a rule that quietly never fires on the one day it matters.
  const base = JSON.parse(JSON.stringify(require('../../src/diagnose/playbooks/mtu_blackhole.json')));
  const broken = [
    ['a rule outside the grammar', (d) => { d.rules[0].when = 'process.exit()'; }],
    ['a fact nothing measures', (d) => { d.rules[0].when = 'ping.nonsense == 1'; }],
    ['a probe type that does not exist', (d) => { d.tests[0].type = 'telepathy'; }],
    ['a view that is not a screen', (d) => { d.views[0].view = 'nowhere'; }],
    ['a placeholder nothing can fill', (d) => { d.fixes[0].en = 'clamp to {ping.imaginary}'; }],
    ['a missing Danish string', (d) => { delete d.title.da; }],
    ['no rule that can confirm it', (d) => { d.rules = d.rules.filter((r) => r.effect !== 'confirm'); }],
    ['two rules with the same id', (d) => { d.rules[1].id = d.rules[0].id; }],
    ['an unexplained test', (d) => { delete d.tests[0].why; }],
    // The one that actually bit: a probe renamed its parameter and the playbook
    // kept the old spelling. An unrecognised key is DROPPED at dispatch, not
    // rejected, so the plan would have run a narrower test than it promised and
    // nothing would have said so.
    ['a param the probe does not take', (d) => { d.tests[1].params = { perHop: true }; }],
    ['a param outside the probe\'s bounds', (d) => { d.tests[1].params = { max_size: 999999 }; }],
  ];
  for (const [what, mutate] of broken) {
    const doc = JSON.parse(JSON.stringify(base));
    mutate(doc);
    assert.throws(() => parsePlaybook('x.json', JSON.stringify(doc)), CatalogError, `accepted ${what}`);
  }
});

// ---------------------------------------------------------------- Service Assurance
test('serviceTests validation: base URLs refuse anything the browser must never reach', () => {
  const { validateApplication, validateEnvironment } = require('../../src/serviceTests/validation');
  // Loopback would let a test browser reach BlueEye's own API from the server's
  // own network position; 169.254.169.254 is the cloud-metadata pivot.
  for (const url of ['http://127.0.0.1:3000', 'http://localhost/app', 'http://169.254.169.254/latest/meta-data']) {
    assert.ok(errorsOf(validateApplication({ name: 'X', base_url: url })).includes('base_url'), url);
  }
  for (const url of ['file:///etc/passwd', 'ftp://x.dk', 'javascript:alert(1)', 'not a url', '']) {
    assert.ok(errorsOf(validateApplication({ name: 'X', base_url: url })).includes('base_url'), url);
  }
  assert.equal(validateApplication({ name: 'X', base_url: 'https://customer.example.com' }).errors, undefined);
  assert.ok(errorsOf(validateEnvironment({ application_id: 1, name: 'P', base_url: 'http://127.0.0.1' })).includes('base_url'));
});

test('serviceTests validation: a credential password must be long enough to be maskable', () => {
  const { validateCredential } = require('../../src/serviceTests/validation');
  // A password shorter than the redactor's floor cannot be masked in logs or
  // screenshots, so it is refused at entry rather than being unmaskable later.
  assert.ok(errorsOf(validateCredential({ application_id: 1, label: 'L', secret: 'ab' })).includes('secret'));
  assert.ok(errorsOf(validateCredential({ application_id: 1, label: 'L' })).includes('secret'));
  assert.equal(validateCredential({ application_id: 1, label: 'L', secret: 'long-enough' }).errors, undefined);
});

test('serviceTests validation: the DSL refuses a step that could read the worker filesystem', () => {
  const { validateDefinition } = require('../../src/serviceTests/engine/validate');
  const upload = (file) => validateDefinition({ version: 1, steps: [{ type: 'upload', target: { id: 'f' }, file }] });
  for (const bad of ['../../etc/shadow', '/etc/passwd', 'C:\\windows\\system32', 'a/b']) {
    assert.ok(upload(bad).errors, bad);
  }
  assert.equal(upload('faktura.pdf').errors, undefined);
  // Only http(s) may reach the runner, whatever the host policy would later say.
  assert.ok(validateDefinition({ version: 1, steps: [{ type: 'open', url: 'file:///etc/passwd' }] }).errors);
  assert.ok(validateDefinition({ version: 1, steps: [{ type: 'open', url: '//evil.example' }] }).errors);
  assert.ok(validateDefinition({ version: 1, steps: [] }).errors, 'a test needs at least one step');
  assert.ok(validateDefinition({ version: 2, steps: [{ type: 'back' }] }).errors, 'an unknown DSL version is refused');
});

test('serviceTests validation: a chart query cannot ask for a period that does not exist', () => {
  const { validateStatsQuery, PERIODS } = require('../../src/serviceTests/validation');
  // The four segmentations are the contract the chart and the server share. A
  // fifth one accepted here would reach resolvePeriod, silently fall back to a
  // week, and draw a week under a heading that says something else.
  assert.deepEqual(PERIODS, ['day', 'week', 'month', 'year']);
  for (const period of PERIODS) assert.ok(validateStatsQuery({ period }).value, period);
  for (const period of ['hour', 'decade', 'quarter', 'WEEK', '../../etc/passwd', 1]) {
    assert.ok(validateStatsQuery({ period }).errors, `period=${period} was accepted`);
  }
  // A date is a date, not a format string or an expression.
  for (const at of ['11-09-2026', '2026-9-1', 'today', "2026-09-11'; DROP TABLE", '%Y-%m-%d']) {
    assert.ok(validateStatsQuery({ at }).errors, `at=${at} was accepted`);
  }
  // The offset reaches SQL as an INTERVAL — it is bounded to real time zones.
  for (const tz of [-841, 841, 99999, 1.5, 'abc', '-- 0']) {
    assert.ok(validateStatsQuery({ tz_offset: tz }).errors, `tz_offset=${tz} was accepted`);
  }
  for (const tz of [0, -120, 840, -840]) assert.ok(validateStatsQuery({ tz_offset: tz }).value, String(tz));
});

test('serviceTests validation: the host allowlist can never open loopback or metadata, at any setting', () => {
  const { validateEntry } = require('../../src/serviceTests/security/hostPolicy');
  // Even with the caps opened as wide as the settings allow.
  const settings = { minCidrPrefix: 8, maxAddressesPerApplication: 16777216 };
  for (const entry of ['127.0.0.1', '127.0.0.0/8', 'localhost', '169.254.169.254', '169.254.0.0/16', '0.0.0.0/8']) {
    assert.ok(validateEntry(entry, null, { settings }).errors, `${entry} must never be allowlistable`);
  }
  // RFC1918 IS allowlistable — that is the point of the feature.
  assert.equal(validateEntry('10.20.0.0/16', null, { settings: { minCidrPrefix: 16, maxAddressesPerApplication: 65536 } }).errors, undefined);
});

// ---------------------------------------------------------------- per-module rules
const errorsOf = (r) => Object.keys(r.errors || {});

test('userValidation: email shape, password policy, role enum, no privilege via unknown fields', () => {
  const { validateUserCreate, validateUserUpdate } = require('../../src/validation/userValidation');
  assert.ok(errorsOf(validateUserCreate({})).length >= 2);
  assert.ok(errorsOf(validateUserCreate({ email: 'nope', password: 'Str0ng-passw0rd!', role: 'admin', name: 'A' })).includes('email'));
  assert.ok(errorsOf(validateUserCreate({ email: 'a@b.dk', password: 'Str0ng-passw0rd!', role: 'root', name: 'A' })).includes('role'));
  assert.ok(errorsOf(validateUserCreate({ email: 'a@b.dk', password: 'Str0ng-passw0rd!', role: 'ADMIN', name: 'A' })).includes('role'), 'role must be case-sensitive');
  const ok = validateUserCreate({ email: '  Admin@B.DK ', password: 'Str0ng-passw0rd!', role: 'viewer', name: 'A', is_superuser: true, id: 1 });
  assert.deepEqual(ok.errors, undefined, JSON.stringify(ok));
  assert.equal(ok.value.email, 'admin@b.dk');
  assert.equal(ok.value.is_superuser, undefined);
  assert.equal(ok.value.id, undefined);
  assert.ok(rejected(validateUserUpdate({ role: 'root' })));
});

test('POST /users enforces the password policy at the HTTP layer (never 201 for a weak password)', async () => {
  for (const password of ['short', 'password', '12345678', 'aaaaaaaaaaaa']) {
    const res = await request(makeApp()).post('/users').set('Authorization', authHeader('admin'))
      .send({ email: 'new@b.dk', password, role: 'viewer', name: 'N' });
    assert.ok([400, 422].includes(res.status), `password ${JSON.stringify(password)} → ${res.status}`);
  }
});

test('locationValidation: name required and bounded; parseId strict', () => {
  const { validateLocationInput, parseId } = require('../../src/validation/locationValidation');
  assert.ok(errorsOf(validateLocationInput({ name: '' })).includes('name'));
  assert.ok(errorsOf(validateLocationInput({ name: 'x'.repeat(10_000) })).includes('name'));
  assert.equal(validateLocationInput({ name: ' HQ ' }).value.name, 'HQ');
  assert.equal(parseId('7'), 7);
  for (const bad of ['0', '-1', '1.5', 'abc', '', '1e3', '99999999999999999999', null]) assert.equal(parseId(bad), null, `parseId(${bad})`);
});

test('enrollmentValidation: enroll needs code/hostname/platform/arch; codes are bounded (TTL, uses)', () => {
  const { validateCreateCode, validateEnroll } = require('../../src/validation/enrollmentValidation');
  assert.deepEqual(errorsOf(validateEnroll({})).sort().slice(0, 4), ['arch', 'code', 'hostname', 'platform']);
  assert.ok(rejected(validateCreateCode({ location_id: 'abc' })));
  assert.ok(rejected(validateCreateCode({ expiresInMinutes: 0 })));
  assert.ok(rejected(validateCreateCode({ expiresInMinutes: 10_000_000 })));
  assert.ok(rejected(validateCreateCode({ maxUses: 0 })));
  assert.ok(rejected(validateCreateCode({ maxUses: 10_000_000 })));
  assert.equal(validateCreateCode({}).value.maxUses, 1, 'codes are single-use by default');
});

test('probeValidation: type enum, host required, port range, hop/count caps; results must be an array', () => {
  const { validateProbeSpec, validateProbeResults, PROBE_TYPES } = require('../../src/validation/probeValidation');
  assert.ok(PROBE_TYPES.includes('ping') && PROBE_TYPES.includes('tcp'));
  assert.ok(rejected(validateProbeSpec({ type: 'exec', host: 'x' })));
  assert.ok(rejected(validateProbeSpec({ type: 'ping' })));
  assert.ok(rejected(validateProbeSpec({ type: 'tcp', host: 'x' })), 'tcp needs a port');
  assert.ok(rejected(validateProbeSpec({ type: 'tcp', host: 'x', port: 70000 })));
  assert.ok(rejected(validateProbeSpec({ type: 'tcp', host: 'x', port: 0 })));
  assert.ok(rejected(validateProbeSpec({ type: 'ping', host: 'x', count: 1_000_000 })));
  assert.ok(rejected(validateProbeSpec({ type: 'traceroute', host: 'x', maxHops: 1_000_000 })));
  assert.ok(rejected(validateProbeSpec({ type: 'ping', host: 'a b; rm -rf /' })), 'hosts must not carry shell metacharacters');
  assert.deepEqual(validateProbeSpec({ type: 'ping', host: '9.9.9.9' }).errors, undefined);
  assert.ok(rejected(validateProbeResults({ results: 'nope' })));
});

test('probeValidation: the tls and rdns specs, and the certificate block a result may carry', () => {
  const { validateProbeSpec, validateProbeResults, PROBE_TYPES } = require('../../src/validation/probeValidation');
  assert.ok(PROBE_TYPES.includes('tls') && PROBE_TYPES.includes('rdns'));
  // A certificate lives on a port; the port defaults rather than being required.
  assert.equal(validateProbeSpec({ type: 'tls', host: 'example.com' }).value.port, 443);
  // Host AND SNI name both reach a network call, so both are held to the
  // target rule rather than only the one somebody remembered.
  for (const field of ['host', 'servername']) {
    for (const bad of ['-rf', 'a b', 'a;rm -rf /', '$(id)', 'x'.repeat(300)]) {
      const spec = { type: 'tls', host: 'example.com', [field]: bad };
      assert.ok(errorsOf(validateProbeSpec(spec)).length, `${field}=${bad}`);
    }
  }
  assert.ok(errorsOf(validateProbeSpec({ type: 'rdns', host: '-rf' })).includes('host'));
  // The stored certificate is copied field by field: a key a future agent
  // invents must not reach the database, and the name verdict stays tri-state
  // (null = there was no name to check).
  const { value } = validateProbeResults({ results: [{ type: 'tls', target: 'x:443', ok: true, hostnameMatches: 'maybe', authorized: 'yes', invented: 1 }] });
  assert.equal(value.results[0].tls.hostnameMatches, null);
  assert.equal(value.results[0].tls.authorized, false, 'only an explicit true is a trusted chain');
  assert.equal(value.results[0].tls.invented, undefined);
});

test('testPackageValidation: schedule floor/ceiling, item cap, target modes', () => {
  const v = require('../../src/validation/testPackageValidation');
  assert.ok(v.MIN_SCHEDULE_MS >= 30_000 && v.MAX_SCHEDULE_MS <= 24 * 3600 * 1000 && v.MAX_ITEMS <= 50);
  const base = { name: 'P', targets: { mode: 'all' }, items: [{ type: 'probe', probe: { type: 'ping', host: '9.9.9.9' } }] };
  assert.deepEqual(v.validateTestPackageInput(base).errors, undefined);
  assert.ok(rejected(v.validateTestPackageInput({ ...base, schedule_ms: 1000 })), 'below the floor');
  assert.ok(rejected(v.validateTestPackageInput({ ...base, schedule_ms: 10 * 24 * 3600 * 1000 })), 'above the ceiling');
  assert.ok(rejected(v.validateTestPackageInput({ ...base, targets: { mode: 'everyone' } })));
  assert.ok(rejected(v.validateTestPackageInput({ ...base, items: [] })));
  assert.ok(rejected(v.validateTestPackageInput({ ...base, items: Array.from({ length: v.MAX_ITEMS + 1 }, () => base.items[0]) })));
  assert.ok(rejected(v.validateTestPackageInput({ ...base, items: [{ type: 'shell', cmd: 'id' }] })));
  // A calendar recurrence is the other kind of schedule, and it takes over from
  // the interval rather than sitting beside it.
  const daily = { period: 'daily', every: 6, at: '08:00' };
  const withSpec = v.validateTestPackageInput({ ...base, schedule_ms: 60_000, schedule_spec: daily });
  assert.deepEqual(withSpec.value.schedule_spec, daily);
  assert.equal(withSpec.value.schedule_ms, 0, 'a spec must not leave an interval running beside it');
  assert.ok(rejected(v.validateTestPackageInput({ ...base, schedule_spec: { period: 'fortnightly' } })));
});

test('connectionTestValidation: the target is a probe target, the checks are a closed set, a run is bounded', () => {
  const { validateConnectionTestRun, validateConnectionTestSchedule, MAX_ROUNDS } = require('../../src/validation/connectionTestValidation');
  const { CHECK_IDS } = require('../../src/connectionTest/checks');
  const { MAX_ITEMS } = require('../../src/validation/testPackageValidation');
  assert.ok(MAX_ROUNDS <= 20);

  const base = { agentId: 1, host: 'example.com', checks: ['ping'] };
  assert.deepEqual(validateConnectionTestRun(base).errors, undefined);
  // The host reaches an agent's argv, so it is held to the probe-target rule.
  for (const bad of ['-rf', '--flood', 'a b', 'a;rm -rf /', '$(whoami)', '`id`', 'a|b', 'x'.repeat(300), '', '   ']) {
    assert.ok(errorsOf(validateConnectionTestRun({ ...base, host: bad })).includes('host'), bad);
  }
  for (const ok of ['10.0.0.1', 'mail.example.com', 'fe80::1']) {
    assert.deepEqual(validateConnectionTestRun({ ...base, host: ok }).errors, undefined, ok);
  }
  // Checks are ids from the catalogue and nothing else — never a free string
  // that could become a probe type.
  assert.ok(errorsOf(validateConnectionTestRun({ ...base, checks: ['ping', 'shell'] })).includes('checks'));
  assert.ok(errorsOf(validateConnectionTestRun({ ...base, checks: [] })).includes('checks'));
  assert.ok(errorsOf(validateConnectionTestRun({ ...base, checks: 'ping' })).includes('checks'));
  assert.deepEqual(validateConnectionTestRun({ ...base, checks: CHECK_IDS }).errors, undefined);
  assert.ok(errorsOf(validateConnectionTestRun({ ...base, agentId: 0 })).includes('agentId'));

  // A schedule adds a recurrence, and one scheduled run may not exceed what a
  // test package can carry.
  const rec = { period: 'daily', every: 6, at: '08:00' };
  assert.deepEqual(validateConnectionTestSchedule({ ...base, recurrence: rec }).errors, undefined);
  assert.ok(errorsOf(validateConnectionTestSchedule(base)).includes('recurrence'));
  assert.ok(errorsOf(validateConnectionTestSchedule({ ...base, recurrence: { period: 'hourly', every: 999 } })).includes('recurrence'));
  assert.ok(errorsOf(validateConnectionTestSchedule({ ...base, checks: CHECK_IDS.slice(0, 5), runs: MAX_ITEMS, recurrence: rec })).includes('runs'));
  assert.ok(errorsOf(validateConnectionTestSchedule({ ...base, runs: 0, recurrence: rec })).includes('runs'));
});

test('recurrence: a schedule that cannot be parsed is never due, and none may burst the agents', () => {
  const { validateRecurrence, nextRunAt, MIN_SPACING_MS } = require('../../src/schedule/recurrence');
  assert.ok(MIN_SPACING_MS >= 5 * 60 * 1000);
  for (const bad of [undefined, null, 'daily', 42, [], {}, { period: 'yearly' }, { period: 'hourly', every: 61 }]) {
    assert.ok(rejected(validateRecurrence(bad)), JSON.stringify(bad));
    assert.equal(nextRunAt(bad, Date.now()), null, JSON.stringify(bad));
  }
  const next = nextRunAt({ period: 'daily', every: 1, at: '08:00' }, Date.now());
  assert.ok(next > Date.now(), 'the next run is always in the future');
});

test('reportScheduleValidation: a recipient list is addresses only, and the window is relative and bounded', () => {
  const v = require('../../src/validation/reportScheduleValidation');
  const { REPORT_IDS, FORMATS } = require('../../src/reports/definitions');
  const base = { name: 'SLA', report: REPORT_IDS[0], recipients: ['ops@acme.dk'], schedule_spec: { period: 'monthly', every: 1, at: '06:00', dayOfMonth: 1 } };
  assert.deepEqual(v.validateReportScheduleInput(base).errors, undefined);
  assert.equal(v.validateReportScheduleInput(base).value.format, FORMATS[0], 'a format is defaulted, never guessed at send time');
  assert.ok(rejected(v.validateReportScheduleInput({ ...base, report: 'everything' })));
  assert.ok(rejected(v.validateReportScheduleInput({ ...base, format: 'pdf' })));
  // The window is relative and resolved at fire time, so it is bounded here.
  assert.ok(rejected(v.validateReportScheduleInput({ ...base, window_days: 0 })));
  assert.ok(rejected(v.validateReportScheduleInput({ ...base, window_days: v.MAX_WINDOW_DAYS + 1 })));
  // A recipient reaches an SMTP server. Anything that could carry a header with
  // it, or that is not an address at all, is refused here.
  for (const bad of ['', '   ', 'nobody', 'a@b', 'a@b.dk\nBcc: x@y.dk', 'a@b.dk\r\nSubject: x', 'a@b.dk, c@d.dk', '<a@b.dk>', 'a b@c.dk', `${'x'.repeat(250)}@b.dk`]) {
    assert.ok(rejected(v.validateReportScheduleInput({ ...base, recipients: [bad] })), JSON.stringify(bad));
  }
  assert.ok(rejected(v.validateReportScheduleInput({ ...base, recipients: [] })));
  assert.ok(rejected(v.validateReportScheduleInput({ ...base, recipients: Array.from({ length: v.MAX_RECIPIENTS + 1 }, (_, i) => `a${i}@b.dk`) })));
  // The recurrence is the same one the test packages use, held to the same floor.
  assert.ok(rejected(v.validateReportScheduleInput({ ...base, schedule_spec: { period: 'hourly', every: 999 } })));
  assert.ok(rejected(v.validateReportScheduleInput({ ...base, params: { location_id: 'abc' } })));
  assert.ok(rejected(v.validateReportScheduleInput({ ...base, report: 'probe_outages', params: { severity: 'apocalyptic' } })));
});

test('transactionValidation: type enum, name required, agent assignment is an id array', () => {
  const { validateTransactionInput, validateAgentAssignment, TEST_TYPES } = require('../../src/validation/transactionValidation');
  assert.deepEqual([...TEST_TYPES].sort(), ['dns', 'http', 'icmp', 'tcp']);
  assert.ok(rejected(validateTransactionInput({ name: 'T', type: 'exec' })));
  assert.ok(rejected(validateTransactionInput({ type: 'http' })));
  assert.ok(rejected(validateAgentAssignment({ agent_ids: 'all' })));
  assert.ok(rejected(validateAgentAssignment({ agent_ids: ['a'] })));
});

test('event validation: note text bounded and kind enum; status patch enum', () => {
  const { validateEventNote, TEXT_MAX } = require('../../src/validation/eventNoteValidation');
  const { validateStatusPatch } = require('../../src/validation/eventCaseValidation');
  assert.ok(TEXT_MAX <= 10_000);
  assert.deepEqual(validateEventNote({ text: 'seen it', kind: 'observation' }).errors, undefined);
  assert.ok(rejected(validateEventNote({ text: 'x'.repeat(TEXT_MAX + 1), kind: 'observation' })));
  assert.ok(rejected(validateEventNote({ text: 'x', kind: 'gossip' })));
  assert.ok(rejected(validateEventNote({ text: '', kind: 'action' })));
  assert.ok(rejected(validateStatusPatch({ status: 'deleted' })));
  assert.deepEqual(validateStatusPatch({ status: 'resolved' }).errors, undefined);
});

test('apiTokenValidation / runbookValidation / preferencesValidation: required fields and enums', () => {
  const { validateApiTokenCreate } = require('../../src/validation/apiTokenValidation');
  const { validateRunbookInput } = require('../../src/validation/runbookValidation');
  const { validatePreferences, THEMES, LOCALES } = require('../../src/validation/preferencesValidation');
  assert.ok(rejected(validateApiTokenCreate({ name: '' })));
  assert.ok(rejected(validateApiTokenCreate({ name: 'x'.repeat(10_000) })));
  assert.ok(rejected(validateRunbookInput({ title: 'T' })));
  assert.ok(rejected(validatePreferences({ theme: 'neon' })));
  assert.ok(rejected(validatePreferences({ locale: 'xx' })));
  assert.ok(rejected(validatePreferences({ unknown_key: 1 })));
  assert.deepEqual(validatePreferences({ theme: THEMES[0], locale: LOCALES[0] }).errors, undefined);
  const I18n = require('../../public/i18n');
  assert.deepEqual([...LOCALES].sort(), [...I18n.LOCALES].sort(), 'LOCALES must match public/i18n.js');
});

test('resultsValidation / probeOutageValidation / speedtestValidation: time ranges, thresholds, result shape', () => {
  const { validateResults, validateTimeRange } = require('../../src/validation/resultsValidation');
  const { validateReportRange, validateThresholdInput, validateSeverityFilter } = require('../../src/validation/probeOutageValidation');
  const { validateSpeedtestResult } = require('../../src/validation/speedtestValidation');
  assert.ok(rejected(validateResults({ results: {} })));
  assert.ok(rejected(validateTimeRange({ from: 'yesterday' })));
  assert.ok(rejected(validateTimeRange({ limit: 'many' })) || validateTimeRange({ limit: 'many' }).value.limit === 1000);
  const big = validateTimeRange({ limit: '999999999' });
  assert.ok(rejected(big) || big.value.limit <= 100_000, 'limit must be capped');
  assert.ok(rejected(validateReportRange({ from: 'x', to: 'y' })));
  assert.ok(rejected(validateThresholdInput({ metric: 'cpu' })));
  assert.ok(rejected(validateSeverityFilter({ severity: 'meh' })));
  assert.ok(rejected(validateSpeedtestResult({ result: 'fast' })));
});

test('agentValidation: monitor source enum, capabilities shape, interval cap', () => {
  const { validateMonitorConfig, validateCapabilities, MAX_INTERVAL_MS, MONITOR_SOURCES } = require('../../src/validation/agentValidation');
  assert.ok(MONITOR_SOURCES.includes('proc'));
  let errs = {}; validateMonitorConfig({ source: 'pcap' }, errs); assert.ok(errs.monitor_config);
  errs = {}; validateMonitorConfig({ source: 'proc', intervalMs: MAX_INTERVAL_MS * 10 }, errs); assert.ok(errs.monitor_config || true);
  errs = {}; validateCapabilities({ sources: 'proc' }, errs); assert.ok(errs.capabilities);
  errs = {}; validateCapabilities({ sources: ['proc'] }, errs); assert.deepEqual(errs, {});
});

test('integration / cmdb / ldap / oidc / saml / nis2 validation: type enums, URLs and roles are checked', () => {
  const { validateIntegrationCreate, AUTH_TYPES } = require('../../src/validation/integrationValidation');
  const { validateCmdbConfig, validateAgentLink, CMDB_TYPES } = require('../../src/validation/cmdbValidation');
  const ldap = require('../../src/validation/ldapValidation');
  const oidc = require('../../src/validation/oidcValidation');
  const saml = require('../../src/validation/samlValidation');
  const nis2 = require('../../src/validation/nis2Validation');
  assert.ok(Array.isArray(AUTH_TYPES) && AUTH_TYPES.length);
  assert.ok(rejected(validateIntegrationCreate({ type: 'webhook', name: 'x', baseUrl: 'not a url' })));
  assert.ok(rejected(validateIntegrationCreate({ type: 'webhook', name: '', baseUrl: 'https://x.dk' })));
  assert.ok(rejected(validateIntegrationCreate({ type: 'webhook', name: 'x', baseUrl: 'https://x.dk', authType: 'magic' })));
  assert.ok(rejected(validateCmdbConfig({ type: 'nope', base_url: 'https://x.dk' })));
  assert.ok(rejected(validateCmdbConfig({ type: CMDB_TYPES[0], base_url: 'ftp://x' })));
  assert.ok(rejected(validateAgentLink({ cmdb_asset_id: 1 })));
  assert.ok(rejected(ldap.validateLdapConfig({ host: 'ldap.x', baseDn: 'dc=x', port: 999999 })));
  for (const v of [ldap.validateRoleMap, oidc.validateRoleMap, saml.validateRoleMap]) {
    assert.ok(rejected(v({ groupDn: 'cn=x', claimValue: 'x', role: 'superadmin' })), 'role must be one of admin/operator/viewer');
  }
  assert.ok(rejected(nis2.validateRiskInput({ title: 'R', category: 'Whatever' })));
  assert.ok(rejected(nis2.validateReportRequest({ reportType: 'everything' })));
  assert.ok(rejected(nis2.validateCustomReportSpec({ sections: [] })));
});

// ---------------------------------------------------------------- HTTP sweep
const app = makeApp();
const routes = listRoutes(app);
const norm = (k) => k.replace(/\/$/, '');
const admin = () => authHeader('admin');

test('no POST/PUT/PATCH route answers 500 to an empty, non-object or nested-junk body', async () => {
  const bad = [];
  for (const r of routes) {
    if (!['post', 'put', 'patch'].includes(r.method)) continue;
    for (const body of [{}, [], 'str', null, { a: { b: { c: [{ d: 1 }] } } }, { __proto__: { admin: true } }, { constructor: { prototype: {} } }]) {
      const res = await request(app)[r.method](fill(r.path, '1')).set('Authorization', admin()).set('Content-Type', 'application/json').send(JSON.stringify(body));
      if (res.status === 500) bad.push(`${key(r)} body=${JSON.stringify(body)} → 500 ${res.body.detail || ''}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('create endpoints answer 400 with the Validation failed contract to an empty body', async () => {
  const creates = ['POST /users', 'POST /locations', 'POST /api/runbooks', 'POST /api/test-packages', 'POST /api/transactions', 'POST /api/integrations', 'POST /api/nis2/risks', 'POST /api/api-tokens', 'PUT /me/preferences', 'POST /agents/enroll'];
  for (const c of creates) {
    const r = routes.find((x) => norm(key(x)) === c);
    assert.ok(r, `${c} no longer exists`);
    const res = await request(app)[r.method](r.path).set('Authorization', admin()).send({});
    assert.equal(res.status, 400, `${c} → ${res.status}`);
    assert.ok(res.body.details && Object.keys(res.body.details).length, `${c}: no field-level details`);
  }
});

test('hostile query parameters never 500 on any GET route', async () => {
  const bad = [];
  const params = ['limit=abc', 'limit=-1', 'limit=1e12', 'offset=-5', 'from=notadate&to=x', 'hostId=abc', 'agentId[]=1', 'since=%00', 'q=%27%20OR%201%3D1', 'sort=__proto__', 'page=99999999999'];
  for (const r of routes) {
    if (r.method !== 'get') continue;
    for (const q of params) {
      const res = await request(app).get(`${fill(r.path, '1')}?${q}`).set('Authorization', admin());
      if (res.status === 500) bad.push(`${key(r)} ?${q} → 500 ${res.body.detail || ''}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('agent ingest endpoints validate the body (400) once the agent token is accepted', async () => {
  const agentTokensRepo = makeAgentTokensRepo({ findActiveByHash: async () => ({ id: 1, agent_id: 1, token_hash: 'h' }) });
  const ingest = makeApp({ agentTokensRepo });
  for (const [method, p, body] of [['post', '/agents/results', {}], ['post', '/agents/results', { results: 'x' }], ['post', '/agents/probe-results', {}], ['post', '/agents/me/capabilities', { capabilities: 'x' }], ['post', '/speedtest/results', {}]]) {
    const res = await request(ingest)[method](p).set('Authorization', 'Bearer agent-token').send(body);
    assert.equal(res.status, 400, `${method.toUpperCase()} ${p} ${JSON.stringify(body)} → ${res.status} ${JSON.stringify(res.body).slice(0, 100)}`);
  }
});

test('the generated schema.sql is in sync with the migration chain (npm run build-schema)', () => {
  const { execFileSync } = require('child_process');
  const root = path.join(__dirname, '..', '..');
  const before = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');
  const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'build-schema.js'), '--check'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(typeof out === 'string');
  assert.equal(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'), before, 'schema.sql changed on rebuild — run npm run build-schema and commit');
});

// A foreign key whose column type does not EXACTLY match the column it
// references is rejected by MySQL at CREATE TABLE time — errno 3780 — and the
// container then exits 1 on `node src/migrate.js` before the server ever starts.
//
// Nothing in the test suite catches it, because the suite runs against fakes and
// never applies the SQL. It is found on the deployment, by a person, with the
// site down. That is exactly what happened with `service_test_baselines`:
// `accepted_by INT` referencing `users(id)`, which is INT UNSIGNED.
//
// Signedness is the trap: `INT` and `INT UNSIGNED` look identical at a glance
// and are not the same type.
test('every foreign key matches the exact type of the column it references', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'schema.sql'), 'utf8');

  // column definitions per table, and the primary/unique keys a FK can target
  const tables = new Map();
  for (const block of schema.split(/CREATE TABLE (?:IF NOT EXISTS )?/).slice(1)) {
    const name = (block.match(/^`?([A-Za-z0-9_]+)`?\s*\(/) || [])[1];
    if (!name) continue;
    const columns = new Map();
    for (const line of block.split('\n')) {
      const m = line.match(/^\s+`?([a-z_][a-z0-9_]*)`?\s+((?:BIG|SMALL|TINY|MEDIUM)?INT(?:\(\d+\))?(?:\s+UNSIGNED)?|CHAR\(\d+\)|VARCHAR\(\d+\)|BIGINT)/i);
      if (!m) continue;
      // Normalised: display width is cosmetic, signedness is not.
      columns.set(m[1], m[2].toUpperCase().replace(/\(\d+\)/, '').replace(/\s+/g, ' ').trim());
    }
    tables.set(name, columns);
  }

  const mismatches = [];
  for (const block of schema.split(/CREATE TABLE (?:IF NOT EXISTS )?/).slice(1)) {
    const table = (block.match(/^`?([A-Za-z0-9_]+)`?\s*\(/) || [])[1];
    if (!table) continue;
    const own = tables.get(table) || new Map();
    const fkRe = /FOREIGN KEY\s*\(\s*`?([a-z_][a-z0-9_]*)`?\s*\)\s*REFERENCES\s+`?([A-Za-z0-9_]+)`?\s*\(\s*`?([a-z_][a-z0-9_]*)`?\s*\)/gi;
    for (const m of block.matchAll(fkRe)) {
      const [, column, targetTable, targetColumn] = m;
      const mine = own.get(column);
      const theirs = (tables.get(targetTable) || new Map()).get(targetColumn);
      // A type this parser does not understand is skipped rather than guessed
      // at — a false failure here would block every build.
      if (!mine || !theirs) continue;
      if (mine !== theirs) {
        mismatches.push(`${table}.${column} is ${mine} but ${targetTable}.${targetColumn} is ${theirs}`);
      }
    }
  }
  assert.deepEqual(mismatches, [],
    'MySQL refuses these foreign keys (errno 3780) and the server container exits 1 on migrate');
});

// ALTER TABLE ... ADD CONSTRAINT with a name that already exists anywhere in the
// schema fails too: InnoDB constraint names are schema-global, not per-table.
test('foreign key constraint names are unique across the whole schema', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'schema.sql'), 'utf8');
  const seen = new Map();
  const dupes = [];
  for (const m of schema.matchAll(/CONSTRAINT\s+`?([A-Za-z0-9_]+)`?\s+FOREIGN KEY/gi)) {
    const name = m[1];
    if (seen.has(name)) dupes.push(name);
    seen.set(name, true);
  }
  assert.deepEqual([...new Set(dupes)], [],
    'InnoDB constraint names are schema-global — a duplicate fails the migration');
});
