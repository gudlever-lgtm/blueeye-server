'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateIntegrationCreate, validateIntegrationUpdate } = require('../src/validation/integrationValidation');

const base = { type: 'webhook', name: 'Acme', baseUrl: 'https://hooks.acme.dk/in' };

test('accepts a normal config + credentials', () => {
  const { value, errors } = validateIntegrationCreate({
    ...base,
    config: { table: 'incident', events: ['finding'] },
    credentials: { token: 'abc' },
  });
  assert.equal(errors, undefined);
  assert.equal(value.config.table, 'incident');
  assert.equal(value.credentials.token, 'abc');
});

// Prototype-pollution: JSON.parse makes "__proto__" an OWN key that survives a
// spread and persists into config_json. The validator must reject it (and the
// other gadget keys) so it never becomes a stored landmine.
test('rejects __proto__ in config (top-level)', () => {
  const body = JSON.parse('{"type":"webhook","name":"x","baseUrl":"https://h.dk","config":{"__proto__":{"polluted":true}}}');
  const { errors } = validateIntegrationCreate(body);
  assert.ok(errors && errors.config, 'expected a config error');
});

test('rejects __proto__ nested deeper in config', () => {
  const body = JSON.parse('{"type":"webhook","name":"x","baseUrl":"https://h.dk","config":{"a":{"b":{"constructor":{"prototype":{}}}}}}');
  const { errors } = validateIntegrationCreate(body);
  assert.ok(errors && errors.config, 'expected a config error for a nested gadget key');
});

test('rejects __proto__/constructor/prototype keys in credentials (they match the key regex)', () => {
  // Built via JSON.parse — the real attack vector — so the gadget keys are OWN
  // enumerable properties (plain assignment to __proto__ would not create one).
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    const creds = JSON.parse(`{"${k}":"x"}`);
    const { errors } = validateIntegrationCreate({ ...base, credentials: creds });
    assert.ok(errors && errors.credentials, `expected a credentials error for ${k}`);
  }
});

test('update path rejects a polluted config too', () => {
  const body = JSON.parse('{"config":{"__proto__":{"polluted":true}}}');
  const { errors } = validateIntegrationUpdate(body);
  assert.ok(errors && errors.config, 'expected a config error on update');
});

test('Object.prototype is not polluted by validating a malicious config', () => {
  const body = JSON.parse('{"type":"webhook","name":"x","baseUrl":"https://h.dk","config":{"__proto__":{"polluted":true}}}');
  validateIntegrationCreate(body);
  assert.equal(({}).polluted, undefined);
});
