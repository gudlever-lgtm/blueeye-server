'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PLANS, PLAN_ORDER } = require('../plans');

// Guards the promise made in migrations/023_create_license_plans.sql: the seeded
// `license_plans.allowed_features` MUST stay in sync with src/license/plans.js
// (the runtime source of truth). The seed is a mirror for the admin/offline
// catalogue, so drift is silent at runtime — this test is what catches it.
const SEED = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'migrations', '023_create_license_plans.sql'),
  'utf8'
);

// Each plan row seeds exactly one JSON_ARRAY(...) of feature keys; they appear in
// PLAN_ORDER (pilot → … → msp). Feature lists contain no nested parens, so a lazy
// match to the first ')' captures each list in full.
function seededFeatureArrays() {
  return [...SEED.matchAll(/JSON_ARRAY\(([\s\S]*?)\)/g)].map((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((s) => s[1]));
}

test('023 seed lists one feature array per sellable plan, in PLAN_ORDER', () => {
  assert.equal(seededFeatureArrays().length, PLAN_ORDER.length);
});

test('023 seeded allowed_features matches src/license/plans.js exactly (order included)', () => {
  const arrays = seededFeatureArrays();
  PLAN_ORDER.forEach((key, i) => {
    assert.deepEqual(arrays[i], PLANS[key].allowed_features, `seed for "${key}" must match plans.js`);
  });
});

test('the LDAP/AD feature (sso_ldap) is seeded for Enterprise + MSP and nothing lower', () => {
  const arrays = seededFeatureArrays();
  PLAN_ORDER.forEach((key, i) => {
    const expected = key === 'enterprise' || key === 'msp';
    assert.equal(arrays[i].includes('sso_ldap'), expected, `${key} sso_ldap membership`);
  });
});
