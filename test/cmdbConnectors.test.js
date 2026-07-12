'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createServiceNowConnector } = require('../src/integrations/connectors/serviceNow');
const { createNautobotConnector } = require('../src/integrations/connectors/nautobot');

// A public base_url so requestJson's SSRF guard lets the (fake) call through.
const SN = { baseUrl: 'https://acme.service-now.com', authType: 'basic', credentials: { username: 'u', password: 'p' }, config: {} };
const NB = { baseUrl: 'https://nautobot.example.com', authType: 'token', credentials: { token: 't' }, config: {} };

function fetchReturning(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

// ---- ServiceNow ------------------------------------------------------------

test('serviceNow.testConnection reads the CI table and reports the upstream status', async () => {
  let calledUrl = null;
  const connector = createServiceNowConnector({ fetchImpl: async (url) => { calledUrl = url; return { ok: true, status: 200, json: async () => ({ result: [] }) }; } });
  const res = await connector.testConnection(SN);
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.match(calledUrl, /\/api\/now\/table\/cmdb_ci\?/);
});

test('serviceNow.search normalizes CI rows to {id,name,type,location}', async () => {
  const connector = createServiceNowConnector({
    fetchImpl: fetchReturning(200, { result: [
      { sys_id: 's1', name: 'web01', sys_class_name: 'cmdb_ci_server', location: 'Copenhagen DC' },
      { sys_id: '', name: 'ignored' }, // dropped: no id
    ] }),
  });
  const res = await connector.search(SN, 'web');
  assert.equal(res.ok, true);
  assert.deepEqual(res.assets, [{ id: 's1', name: 'web01', type: 'cmdb_ci_server', location: 'Copenhagen DC' }]);
});

test('serviceNow.search surfaces an upstream failure as ok:false', async () => {
  const connector = createServiceNowConnector({ fetchImpl: fetchReturning(500, {}) });
  const res = await connector.search(SN, 'web');
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
});

// ---- Nautobot --------------------------------------------------------------

test('nautobot.testConnection reads the devices endpoint and reports the status', async () => {
  let calledUrl = null;
  const connector = createNautobotConnector({ fetchImpl: async (url) => { calledUrl = url; return { ok: true, status: 200, json: async () => ({ results: [] }) }; } });
  const res = await connector.testConnection(NB);
  assert.equal(res.ok, true);
  assert.match(calledUrl, /\/api\/dcim\/devices\/\?limit=1/);
});

test('nautobot.search normalizes device rows (nested display refs) to {id,name,type,location}', async () => {
  const connector = createNautobotConnector({
    fetchImpl: fetchReturning(200, { results: [
      { id: 'd1', name: 'sw-core-1', device_type: { display: 'Catalyst 9300' }, location: { display: 'Aarhus' } },
      { id: 'd2', name: 'sw-core-2', role: { display: 'access' }, site: { name: 'Odense' } },
    ] }),
  });
  const res = await connector.search(NB, 'sw');
  assert.equal(res.ok, true);
  assert.deepEqual(res.assets, [
    { id: 'd1', name: 'sw-core-1', type: 'Catalyst 9300', location: 'Aarhus' },
    { id: 'd2', name: 'sw-core-2', type: 'access', location: 'Odense' },
  ]);
});

test('nautobot.search surfaces an upstream failure as ok:false', async () => {
  const connector = createNautobotConnector({ fetchImpl: fetchReturning(502, {}) });
  const res = await connector.search(NB, 'sw');
  assert.equal(res.ok, false);
  assert.equal(res.status, 502);
});
