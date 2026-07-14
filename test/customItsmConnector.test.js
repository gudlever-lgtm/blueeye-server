'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCustomItsmConnector, EVENT_KEYS } = require('../src/integrations/connectors/customItsm');

// A scripted fetch recording url/method/headers/parsed body per call.
function scriptFetch(responses) {
  const calls = [];
  const queue = responses.slice();
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = queue.shift() || { status: 200, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
  };
  fn.calls = calls;
  return fn;
}

const finding = { hostId: 'agent-7', metric: 'cpu.load', severity: 'CRIT', explanation: 'CPU load far above baseline', observed: 95, baseline: 20, deviation: 7.5 };
const incidentEvent = { type: 'incident', severity: 'CRIT', correlationId: 'be-agent-7-cpu.load', finding };

test('customItsm: is registered as the config-driven "custom" type reacting to incidents', () => {
  const c = createCustomItsmConnector({ fetchImpl: scriptFetch([]) });
  assert.equal(c.type, 'custom');
  assert.deepEqual(c.defaultEvents, ['incident', 'anomaly']);
  assert.ok(c.authTypes.includes('token'));
});

test('customItsm: default field map POSTs short_description/description/correlation_id', async () => {
  const fetchImpl = scriptFetch([{ status: 201, body: { id: 42 } }]);
  const c = createCustomItsmConnector({ fetchImpl });
  const integration = { baseUrl: 'https://itsm.example/', authType: 'token', credentials: { token: 'T' }, config: { path: '/tickets' } };
  const res = await c.send(integration, incidentEvent);
  assert.equal(res.ok, true);
  assert.equal(res.status, 201);
  const [call] = fetchImpl.calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://itsm.example/tickets');
  assert.equal(call.headers.Authorization, 'Bearer T');
  assert.match(call.body.short_description, /cpu\.load/);
  assert.equal(call.body.description, 'CPU load far above baseline');
  assert.equal(call.body.correlation_id, 'be-agent-7-cpu.load');
});

test('customItsm: dotted field keys build a nested body (Jira-shaped) and merge static fields', async () => {
  const fetchImpl = scriptFetch([{ status: 200, body: {} }]);
  const c = createCustomItsmConnector({ fetchImpl });
  const integration = {
    baseUrl: 'https://org.atlassian.net', authType: 'basic', credentials: { username: 'a@b.c', password: 'tok' },
    config: {
      path: '/rest/api/2/issue', method: 'POST',
      fields: { 'fields.summary': 'title', 'fields.description': 'explanation' },
      staticFields: { fields: { project: { key: 'OPS' }, issuetype: { name: 'Incident' } } },
    },
  };
  await c.send(integration, incidentEvent);
  const [call] = fetchImpl.calls;
  assert.equal(call.body.fields.project.key, 'OPS');
  assert.equal(call.body.fields.issuetype.name, 'Incident');
  assert.match(call.body.fields.summary, /cpu\.load/);
  assert.equal(call.body.fields.description, 'CPU load far above baseline');
});

test('customItsm: static headers are sent and never overwrite the auth header', async () => {
  const fetchImpl = scriptFetch([{ status: 201, body: {} }]);
  const c = createCustomItsmConnector({ fetchImpl });
  const integration = {
    baseUrl: 'https://glpi.example', authType: 'token', credentials: { token: 'usr' },
    config: { path: '/apirest.php/Ticket', tokenScheme: 'user_token', headers: { 'App-Token': 'APP', Authorization: 'ignored' }, fields: { 'input.name': 'title' } },
  };
  await c.send(integration, incidentEvent);
  const [call] = fetchImpl.calls;
  assert.equal(call.headers['App-Token'], 'APP');
  assert.equal(call.headers.Authorization, 'user_token usr'); // auth wins over the static Authorization
  assert.match(call.body.input.name, /cpu\.load/);
});

test('customItsm: PUT method + custom testPath GET for the connection test', async () => {
  const fetchImpl = scriptFetch([{ status: 200, body: [] }]);
  const c = createCustomItsmConnector({ fetchImpl });
  const integration = { baseUrl: 'https://itsm.example', authType: 'none', credentials: {}, config: { path: '/create', testPath: '/health' } };
  const res = await c.test(integration);
  assert.equal(res.ok, true);
  const [call] = fetchImpl.calls;
  assert.equal(call.method, 'GET');
  assert.equal(call.url, 'https://itsm.example/health');
});

test('customItsm: a failed send surfaces the target status and detail', async () => {
  const fetchImpl = scriptFetch([{ status: 403, body: { error: 'nope' } }]);
  const c = createCustomItsmConnector({ fetchImpl });
  const res = await c.send({ baseUrl: 'https://itsm.example', authType: 'none', credentials: {}, config: { path: '/t' } }, incidentEvent);
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.match(res.detail, /POST failed/);
});

// ---- validateConfig -------------------------------------------------------

test('customItsm.validateConfig: accepts a full valid config and normalises method', () => {
  const c = createCustomItsmConnector({ fetchImpl: scriptFetch([]) });
  const { value, errors } = c.validateConfig({ path: '/x', method: 'put', fields: { a: 'title' }, staticFields: { k: 1 }, headers: { 'X-Foo': 'bar' } });
  assert.equal(errors, undefined);
  assert.equal(value.method, 'PUT');
  assert.deepEqual(value.fields, { a: 'title' });
});

test('customItsm.validateConfig: rejects a bad path, method, unknown event key and pollution', () => {
  const c = createCustomItsmConnector({ fetchImpl: scriptFetch([]) });
  assert.ok(c.validateConfig({ path: 'no-slash' }).errors.path);
  assert.ok(c.validateConfig({ method: 'DELETE' }).errors.method);
  assert.ok(c.validateConfig({ fields: { summary: 'not-a-known-key' } }).errors.fields);
  assert.ok(c.validateConfig({ fields: { '__proto__.x': 'title' } }).errors.fields);
  assert.ok(c.validateConfig({ staticFields: JSON.parse('{"__proto__":{"x":1}}') }).errors.staticFields);
  assert.ok(c.validateConfig({ headers: { 'Bad Header': 'v' } }).errors.headers);
});

test('customItsm: every documented event key is resolvable in a body', async () => {
  const fetchImpl = scriptFetch([{ status: 201, body: {} }]);
  const c = createCustomItsmConnector({ fetchImpl });
  const fields = {};
  for (const k of EVENT_KEYS) fields[k] = k; // target field name == event key for the test
  await c.send({ baseUrl: 'https://x', authType: 'none', credentials: {}, config: { path: '/t', fields } }, incidentEvent);
  const [call] = fetchImpl.calls;
  assert.equal(call.body.severity, 'CRIT');
  assert.equal(call.body.impact, '1');
  assert.equal(call.body.host, 'agent-7');
  assert.equal(call.body.correlationId, 'be-agent-7-cpu.load');
});
