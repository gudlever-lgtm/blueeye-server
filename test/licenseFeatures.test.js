'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFeatureGate } = require('../src/license/features');

const gateWith = (features) => createFeatureGate({ licenseManager: { getFeatures: () => features } });

test('isFeatureEnabled is fail-closed when the field is missing', () => {
  const gate = gateWith({ geo: true }); // only geo granted
  assert.equal(gate.isFeatureEnabled('geo'), true);
  assert.equal(gate.isFeatureEnabled('assistant'), false); // missing -> false
  assert.equal(gate.isFeatureEnabled('alerting'), false);
});

test('fail-closed for an empty/missing/non-object features map or no manager', () => {
  assert.equal(gateWith({}).isFeatureEnabled('analysis'), false);
  assert.equal(gateWith(null).isFeatureEnabled('analysis'), false);
  assert.equal(gateWith('nope').isFeatureEnabled('analysis'), false);
  assert.equal(createFeatureGate({}).isFeatureEnabled('analysis'), false);
  assert.equal(createFeatureGate().isFeatureEnabled('geo'), false);
});

test('only an explicit true grants a feature', () => {
  const gate = gateWith({ analysis: true, assistant: false, alerting: 1, geo: 'yes' });
  assert.equal(gate.isFeatureEnabled('analysis'), true);
  assert.equal(gate.isFeatureEnabled('assistant'), false);
  assert.equal(gate.isFeatureEnabled('alerting'), false); // 1 is not === true
  assert.equal(gate.isFeatureEnabled('geo'), false); // 'yes' is not === true
});

test('summary reports the four known features', () => {
  const gate = gateWith({ analysis: true, geo: true });
  assert.deepEqual(gate.summary(), { analysis: true, assistant: false, alerting: false, geo: true });
});
