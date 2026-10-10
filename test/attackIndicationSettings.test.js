'use strict';

// Settings → Attack indication: the validation rules, the partial merge and the
// live-config seam. The two fields this screen exists for are the new-network
// warm-up and the list of addresses allowed to sweep — both were environment
// variables, which on a customer's on-prem box means a change window for a
// threshold.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const {
  validateAttackIndication, checkCoherence, mergeAttackIndication, sourceOf, MAX_LIST,
} = require('../src/services/attackIndicationSettings');
const { createSettingsService } = require('../src/services/settings');
const { loadScanConfig } = require('../src/analysis/scanDetector');
const { loadNewPeerConfig } = require('../src/analysis/newPeerDetector');
const { loadBeaconConfig } = require('../src/analysis/beaconDetector');
const { loadSecurityEventConfig } = require('../src/devices/securityEventDetector');
const { makeApp, authHeader } = require('../test-support/fakes');

function liveConfig() {
  return {
    scan: loadScanConfig({}),
    newPeer: loadNewPeerConfig({}),
    beacon: loadBeaconConfig({}),
    securityEvents: loadSecurityEventConfig({}),
  };
}

function makeService(stored = null) {
  const rows = new Map();
  if (stored) rows.set('attackIndication', stored);
  const liveAttack = liveConfig();
  const service = createSettingsService({
    settingsRepo: {
      get: async (k) => (rows.has(k) ? rows.get(k) : null),
      set: async (k, v) => { rows.set(k, v); },
    },
    config: { geo: {}, discovery: {} },
    liveAttack,
  });
  return { service, liveAttack, rows };
}

// ---- validation -----------------------------------------------------------

test('a patch carries only what it names, and every bad field is reported at once', () => {
  const { errors, value } = validateAttackIndication({
    scan: { portThreshold: 200, ignoreSources: '10.0.0.5, 10.9.0.0/24' },
    newPeer: { baselineHours: 0, asnSeverity: 'crit' },
  });
  assert.equal(errors, null);
  assert.deepEqual(value, {
    scan: { portThreshold: 200, ignoreSources: ['10.0.0.5', '10.9.0.0/24'] },
    newPeer: { baselineHours: 0, asnSeverity: 'CRIT' },
  }, 'a field the patch did not carry was invented');

  const bad = validateAttackIndication({
    scan: { portThreshold: 1, hostThreshold: 'x', ignoreSources: 'nope' },
    beacon: { maxJitter: 7 },
    nonsense: {},
  });
  assert.deepEqual(Object.keys(bad.errors).sort(), [
    'beacon.maxJitter', 'nonsense', 'scan.hostThreshold', 'scan.ignoreSources', 'scan.portThreshold',
  ], 'a patch stopped at the first bad field');
  assert.match(bad.errors['scan.ignoreSources'], /nope/, 'the entry that was wrong is not named');
});

test('lists take a string or an array, deduplicate, and are capped', () => {
  const asArray = validateAttackIndication({ beacon: { ignorePorts: [123, '443', 443] } });
  assert.deepEqual(asArray.value.beacon.ignorePorts, [123, 443]);
  const asString = validateAttackIndication({ beacon: { ignorePorts: '123, 443' } });
  assert.deepEqual(asString.value.beacon.ignorePorts, [123, 443]);

  assert.match(validateAttackIndication({ beacon: { ignorePorts: '70000' } }).errors['beacon.ignorePorts'], /70000/);
  assert.match(validateAttackIndication({ beacon: { ignorePorts: '1.5' } }).errors['beacon.ignorePorts'], /1\.5/);
  const tooMany = Array.from({ length: MAX_LIST + 1 }, (_, i) => `10.0.0.${i % 250}/32`);
  assert.match(validateAttackIndication({ scan: { ignoreSources: tooMany } }).errors['scan.ignoreSources'], /at most/);

  // IPv6 is a legal ignore source even though the CIDR parser is IPv4.
  assert.deepEqual(validateAttackIndication({ scan: { ignoreSources: '2001:db8::1' } }).value.scan.ignoreSources, ['2001:db8::1']);
});

test('the rule table is validated per rule, and an unknown event type is accepted', () => {
  const ok = validateAttackIndication({
    securityEvents: { rules: { 'auth.failure': { warn: 5, crit: 30, windowMinutes: 60 }, 'ids.alert': { warn: 2, crit: 5 } } },
  });
  assert.equal(ok.errors, null);
  assert.deepEqual(ok.value.securityEvents.rules['ids.alert'], { warn: 2, crit: 5 });

  const bad = validateAttackIndication({ securityEvents: { rules: { 'auth.failure': { warn: 0 }, 'not a type!': { warn: 1 } } } });
  assert.ok(bad.errors['securityEvents.rules.auth.failure.warn']);
  assert.ok(bad.errors['securityEvents.rules.not a type!']);
  assert.ok(validateAttackIndication({ securityEvents: { rules: [] } }).errors['securityEvents.rules']);
});

test('the lateral fields validate like the rest, and the port list is numbers 1-65535', () => {
  const ok = validateAttackIndication({ scan: { lateralEnabled: false, lateralHostThreshold: 15, lateralPorts: '445, 3389' } });
  assert.equal(ok.errors, null);
  assert.deepEqual(ok.value.scan, { lateralEnabled: false, lateralHostThreshold: 15, lateralPorts: [445, 3389] });
  assert.ok(validateAttackIndication({ scan: { lateralHostThreshold: 1 } }).errors['scan.lateralHostThreshold']);
  assert.ok(validateAttackIndication({ scan: { lateralPorts: '445, 70000' } }).errors['scan.lateralPorts']);
  assert.ok(validateAttackIndication({ scan: { lateralEnabled: 'yes' } }).errors['scan.lateralEnabled']);
});

test('a CRIT line below its WARN line is refused and named, not clamped', () => {
  const base = { scan: { portThreshold: 50, critPortThreshold: 500, hostThreshold: 50, critHostThreshold: 500 },
    beacon: { maxJitter: 0.15, critJitter: 0.05 }, securityEvents: { rules: {} }, newPeer: {} };
  assert.equal(checkCoherence(base), null);
  assert.match(checkCoherence({ ...base, scan: { ...base.scan, critPortThreshold: 10 } })['scan.critPortThreshold'], /at least/);
  assert.match(checkCoherence({ ...base, beacon: { maxJitter: 0.1, critJitter: 0.5 } })['beacon.critJitter'], /not be above/);
  assert.match(
    checkCoherence({ ...base, scan: { ...base.scan, lateralHostThreshold: 10, lateralCritHostThreshold: 5 } })['scan.lateralCritHostThreshold'],
    /at least/,
  );
  assert.match(
    checkCoherence({ ...base, securityEvents: { rules: { 'auth.failure': { warn: 10, crit: 2 } } } })['securityEvents.rules.auth.failure.crit'],
    /at least/,
  );
});

test('merge keeps a field the override never mentioned, and derives a metric for a new rule', () => {
  const base = { scan: { enabled: true, portThreshold: 50 }, newPeer: {}, beacon: {}, securityEvents: { rules: { 'auth.failure': { metric: 'security.auth_failure', warn: 10, crit: 50, windowMinutes: 10 } } } };
  const out = mergeAttackIndication(base, { scan: { portThreshold: 200 }, securityEvents: { rules: { 'auth.failure': { warn: 5 }, 'ids.alert': { warn: 2, crit: 5, windowMinutes: 5 } } } });
  assert.equal(out.scan.enabled, true, 'an untouched field was dropped');
  assert.equal(out.scan.portThreshold, 200);
  assert.deepEqual(out.securityEvents.rules['auth.failure'], { metric: 'security.auth_failure', warn: 5, crit: 50, windowMinutes: 10 });
  assert.equal(out.securityEvents.rules['ids.alert'].metric, 'security.ids_alert', 'a stored rule got no metric name of its own');

  assert.deepEqual(sourceOf({ scan: { portThreshold: 200 } }).scan, ['portThreshold']);
  assert.deepEqual(sourceOf(null).beacon, []);
});

// ---- the service ----------------------------------------------------------

test('the effective config is env until an admin sets something, and then only that field', async () => {
  const { service, liveAttack } = makeService();
  const before = await service.getAttackIndication();
  assert.equal(before.scan.portThreshold, 50);
  assert.deepEqual(before.source.scan, [], 'a field nobody set was reported as set here');

  const after = await service.setAttackIndication({ scan: { portThreshold: 200, ignoreSources: '10.0.0.5' } });
  assert.equal(after.scan.portThreshold, 200);
  assert.equal(after.scan.hostThreshold, 50, 'saving one field reset another');
  assert.deepEqual(after.source.scan.sort(), ['ignoreSources', 'portThreshold']);
  // The live object the detectors read is the SAME object, mutated in place.
  assert.equal(liveAttack.scan.portThreshold, 200, 'the detectors would still be on the old threshold');
  assert.deepEqual(liveAttack.scan.ignoreSources, ['10.0.0.5']);
});

test('saving one card never restates another, and the rule table merges per rule', async () => {
  const { service, rows } = makeService();
  await service.setAttackIndication({ scan: { portThreshold: 200 } });
  await service.setAttackIndication({ securityEvents: { rules: { 'auth.failure': { warn: 5 } } } });
  await service.setAttackIndication({ securityEvents: { rules: { 'acl.denied': { warn: 100 } } } });

  const stored = rows.get('attackIndication');
  assert.deepEqual(Object.keys(stored).sort(), ['scan', 'securityEvents'], 'a section nobody touched was frozen into the store');
  assert.deepEqual(stored.securityEvents.rules['auth.failure'], { warn: 5 }, 'the earlier rule was dropped');
  assert.deepEqual(stored.securityEvents.rules['acl.denied'], { warn: 100 });

  const eff = await service.getAttackIndication();
  assert.equal(eff.securityEvents.rules['auth.failure'].warn, 5);
  assert.equal(eff.securityEvents.rules['auth.failure'].crit, 50, 'the shipped CRIT count was lost');
  assert.equal(eff.securityEvents.rules['acl.denied'].windowMinutes, 10);
});

test('a save that would put CRIT below WARN is refused with the field named', async () => {
  const { service, liveAttack } = makeService();
  await assert.rejects(
    () => service.setAttackIndication({ scan: { critPortThreshold: 10 } }),
    (err) => err.statusCode === 400 && !!err.details['scan.critPortThreshold'],
  );
  assert.equal(liveAttack.scan.critPortThreshold, 500, 'a refused save still moved the live config');

  // Split across two saves it is still refused, because coherence is checked
  // against the MERGED result rather than the patch.
  await service.setAttackIndication({ scan: { portThreshold: 300 } });
  await assert.rejects(() => service.setAttackIndication({ scan: { critPortThreshold: 100 } }), (e) => e.statusCode === 400);
});

test('a stored override is re-applied to the live config at boot', async () => {
  const { service, liveAttack } = makeService({ newPeer: { baselineHours: 0 }, beacon: { maxJitter: 0.3 } });
  assert.equal(liveAttack.newPeer.baselineHours, 24, 'the override applied before anything read it');
  await service.applyStoredOverrides();
  assert.equal(liveAttack.newPeer.baselineHours, 0, 'a restart forgot what an admin set');
  assert.equal(liveAttack.beacon.maxJitter, 0.3);
  assert.equal(liveAttack.scan.portThreshold, 50, 'an untouched section was disturbed');
});

// ---- the route ------------------------------------------------------------

test('PUT /api/settings/attack-indication: admin only, 400 on a bad body, 200 on a good one', async () => {
  const attack = {
    getAttackIndication: async () => ({ scan: { portThreshold: 50 } }),
    // As defensive as the real one: validateAttackIndication treats a
    // non-object patch as an empty one, and the route must not 500 on a body
    // somebody posted by hand.
    setAttackIndication: async (patch) => {
      const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
      if (p.scan && p.scan.portThreshold === 1) {
        const err = new Error('invalid'); err.statusCode = 400; err.details = { 'scan.portThreshold': 'too low' }; throw err;
      }
      return { scan: { portThreshold: (p.scan || {}).portThreshold ?? 50 } };
    },
  };
  const app = makeApp({ settingsService: attack });

  assert.equal((await request(app).put('/api/settings/attack-indication').send({})).status, 401);
  assert.equal((await request(app).put('/api/settings/attack-indication').set('Authorization', authHeader('viewer')).send({})).status, 403);
  assert.equal((await request(app).put('/api/settings/attack-indication').set('Authorization', authHeader('operator')).send({})).status, 403);

  const bad = await request(app).put('/api/settings/attack-indication').set('Authorization', authHeader('admin'))
    .send({ scan: { portThreshold: 1 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'Validation failed');
  assert.ok(bad.body.details['scan.portThreshold']);

  const ok = await request(app).put('/api/settings/attack-indication').set('Authorization', authHeader('admin'))
    .send({ scan: { portThreshold: 200 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.attackIndication.scan.portThreshold, 200);

  // A body that is valid JSON but not an object never 500s. Sent as a raw
  // string with an explicit content type, because that is the only way to put
  // `null` or a bare number on the wire — and it is exactly what a hand-written
  // client does.
  for (const raw of ['null', '[]', '"x"', '7', '{"scan":null}']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).put('/api/settings/attack-indication')
      .set('Authorization', authHeader('admin')).set('Content-Type', 'application/json').send(raw);
    assert.ok(res.status < 500, `body ${raw} answered ${res.status}`);
  }
});
