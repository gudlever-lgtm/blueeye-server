'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createConnectorRegistry } = require('../src/integrations/connectors');

const reg = createConnectorRegistry({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });

test('registry exposes the built-in connector types', () => {
  const types = reg.types();
  assert.ok(types.includes('servicenow'));
  assert.ok(types.includes('nautobot'));
  assert.ok(types.includes('webhook'));
  assert.equal(reg.has('servicenow'), true);
  assert.equal(reg.has('nope'), false);
  assert.equal(reg.get('nope'), null);
});

test('eventsFor uses the connector default events when no override', () => {
  const sn = reg.get('servicenow');
  assert.deepEqual(reg.eventsFor({ config_json: {} }, sn), sn.defaultEvents);
  assert.deepEqual(reg.eventsFor({ config_json: null }, sn), sn.defaultEvents);
});

test('eventsFor honours a config.events override on the RAW DB row shape (config_json)', () => {
  const sn = reg.get('servicenow');
  // The dispatcher passes the raw row, whose column is config_json — this guards
  // against reading the wrong field name.
  assert.deepEqual(reg.eventsFor({ config_json: { events: ['anomaly'] } }, sn), ['anomaly']);
  // ...and the shaped { config } form also works.
  assert.deepEqual(reg.eventsFor({ config: { events: ['incident'] } }, sn), ['incident']);
});

test('eventsFor ignores a non-array / empty override', () => {
  const sn = reg.get('servicenow');
  assert.deepEqual(reg.eventsFor({ config_json: { events: 'incident' } }, sn), sn.defaultEvents);
  assert.deepEqual(reg.eventsFor({ config_json: { events: [] } }, sn), sn.defaultEvents);
});
