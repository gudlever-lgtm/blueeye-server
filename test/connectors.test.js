'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createServiceNowConnector } = require('../src/integrations/connectors/serviceNow');
const { createNautobotConnector } = require('../src/integrations/connectors/nautobot');
const { createWebhookConnector } = require('../src/integrations/connectors/webhook');

// A scripted fetch: `responses` is consumed in order; each entry is { status, body }.
// Records every call (url/method/headers/parsed body) for assertions.
function scriptFetch(responses) {
  const calls = [];
  const queue = responses.slice();
  const fn = async (url, opts = {}) => {
    calls.push({
      url,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    const r = queue.shift() || { status: 200, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
  };
  fn.calls = calls;
  return fn;
}

const finding = {
  hostId: 'agent-7', metric: 'cpu.load', kind: 'spike', severity: 'CRIT',
  explanation: 'CPU load far above baseline', observed: 95, baseline: 20, deviation: 7.5,
};
const incidentEvent = { type: 'incident', severity: 'CRIT', correlationId: 'be-finding-agent-7-cpu.load-spike', finding };

// ---- ServiceNow -----------------------------------------------------------

test('serviceNow: creates an incident (POST) when none exists, with severity mapping + Basic auth', async () => {
  const fetchImpl = scriptFetch([
    { status: 200, body: { result: [] } },              // lookup: none
    { status: 201, body: { result: { number: 'INC0001' } } }, // create
  ]);
  const c = createServiceNowConnector({ fetchImpl });
  const integration = { baseUrl: 'https://acme.service-now.com/', authType: 'basic', credentials: { username: 'svc', password: 'pw' }, config: {} };
  const res = await c.send(integration, incidentEvent);

  assert.equal(res.ok, true);
  assert.equal(res.status, 201);
  assert.equal(res.action, 'create');
  const [lookup, create] = fetchImpl.calls;
  assert.equal(lookup.method, 'GET');
  assert.match(lookup.url, /correlation_id=be-finding-agent-7-cpu\.load-spike/);
  assert.equal(create.method, 'POST');
  assert.equal(create.body.impact, '1'); // CRIT -> 1/1
  assert.equal(create.body.urgency, '1');
  assert.equal(create.body.correlation_id, incidentEvent.correlationId);
  assert.match(create.body.short_description, /cpu\.load/);
  assert.equal(create.headers.Authorization, `Basic ${Buffer.from('svc:pw').toString('base64')}`);
});

test('serviceNow: updates the existing incident (PATCH) for idempotency', async () => {
  const fetchImpl = scriptFetch([
    { status: 200, body: { result: [{ sys_id: 'SYS123' }] } }, // lookup: found
    { status: 200, body: { result: { number: 'INC0001' } } },  // update
  ]);
  const c = createServiceNowConnector({ fetchImpl });
  const res = await c.send({ baseUrl: 'https://x', authType: 'oauth2', credentials: { accessToken: 'tok' }, config: {} }, incidentEvent);

  assert.equal(res.ok, true);
  assert.equal(res.action, 'update');
  const patch = fetchImpl.calls[1];
  assert.equal(patch.method, 'PATCH');
  assert.match(patch.url, /\/SYS123$/);
  assert.equal(patch.headers.Authorization, 'Bearer tok'); // oauth2 -> Bearer
});

test('serviceNow: a worknote event APPENDS work_notes to the same ticket (no field rewrite)', async () => {
  const fetchImpl = scriptFetch([
    { status: 200, body: { result: [{ sys_id: 'SYS9' }] } },   // lookup: existing cluster ticket
    { status: 200, body: { result: { number: 'INC0009', sys_id: 'SYS9' } } }, // PATCH work_notes
  ]);
  const c = createServiceNowConnector({ fetchImpl });
  const res = await c.send(
    { baseUrl: 'https://x', authType: 'basic', credentials: { username: 'u', password: 'p' }, config: {} },
    { correlationId: 'be-cluster-7', worknote: 'Escalated: first CRIT member (agent 3).' },
  );
  assert.equal(res.ok, true);
  assert.equal(res.action, 'worknote');
  assert.equal(res.ref, 'SYS9'); // the ticket ref is surfaced (stored on the cluster)
  const patch = fetchImpl.calls[1];
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.body.work_notes, 'Escalated: first CRIT member (agent 3).');
  assert.equal(patch.body.short_description, undefined); // journal-only append, no field rewrite
});

test('serviceNow: WARN/INFO map to lower impact/urgency', async () => {
  for (const [severity, want] of [['WARN', '2'], ['INFO', '3']]) {
    const fetchImpl = scriptFetch([{ status: 200, body: { result: [] } }, { status: 201, body: {} }]);
    const c = createServiceNowConnector({ fetchImpl });
    const ev = { type: 'anomaly', severity, correlationId: 'cid', finding: { ...finding, severity } };
    await c.send({ baseUrl: 'https://x', authType: 'basic', credentials: { username: 'u', password: 'p' }, config: {} }, ev);
    assert.equal(fetchImpl.calls[1].body.impact, want);
  }
});

test('serviceNow: a 4xx on create surfaces as ok:false with the status', async () => {
  const fetchImpl = scriptFetch([{ status: 200, body: { result: [] } }, { status: 400, body: { error: 'bad' } }]);
  const c = createServiceNowConnector({ fetchImpl });
  const res = await c.send({ baseUrl: 'https://x', authType: 'basic', credentials: {}, config: {} }, incidentEvent);
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.detail, /failed/);
});

test('serviceNow: a failed lookup (401) does not create blindly', async () => {
  const fetchImpl = scriptFetch([{ status: 401, body: {} }]);
  const c = createServiceNowConnector({ fetchImpl });
  const res = await c.send({ baseUrl: 'https://x', authType: 'basic', credentials: {}, config: {} }, incidentEvent);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(res.action, 'lookup');
  assert.equal(fetchImpl.calls.length, 1); // no POST attempted
});

// ---- Nautobot -------------------------------------------------------------

const enrollEvent = { type: 'agent.enroll', correlationId: 'be-agent-7', agent: { id: 7, hostname: 'host-7' } };
const deleteEvent = { type: 'agent.delete', correlationId: 'be-agent-7', agent: { id: 7, hostname: 'host-7' } };

test('nautobot: creates a device (POST) with Token auth + merged deviceDefaults', async () => {
  const fetchImpl = scriptFetch([{ status: 200, body: { results: [] } }, { status: 201, body: { id: 'D1' } }]);
  const c = createNautobotConnector({ fetchImpl });
  const integration = { baseUrl: 'https://nautobot.acme.dk', authType: 'token', credentials: { token: 'abc' }, config: { deviceDefaults: { role: 'monitor' } } };
  const res = await c.send(integration, enrollEvent);

  assert.equal(res.ok, true);
  assert.equal(res.action, 'create');
  const [lookup, create] = fetchImpl.calls;
  assert.match(lookup.url, /name=host-7/);
  assert.equal(create.method, 'POST');
  assert.equal(create.body.name, 'host-7');
  assert.equal(create.body.role, 'monitor');
  assert.equal(create.headers.Authorization, 'Token abc');
});

test('nautobot: updates an existing device (PATCH) for idempotency', async () => {
  const fetchImpl = scriptFetch([{ status: 200, body: { results: [{ id: 'D9' }] } }, { status: 200, body: { id: 'D9' } }]);
  const c = createNautobotConnector({ fetchImpl });
  const res = await c.send({ baseUrl: 'https://x', authType: 'token', credentials: { token: 't' }, config: {} }, enrollEvent);
  assert.equal(res.action, 'update');
  assert.match(fetchImpl.calls[1].url, /\/D9\/$/);
  assert.equal(fetchImpl.calls[1].method, 'PATCH');
});

test('nautobot: delete is skipped (no HTTP) unless allowDelete is set', async () => {
  const fetchImpl = scriptFetch([]);
  const c = createNautobotConnector({ fetchImpl });
  const res = await c.send({ baseUrl: 'https://x', authType: 'token', credentials: { token: 't' }, config: {} }, deleteEvent);
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  assert.match(res.detail, /allowDelete=false/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('nautobot: delete removes the device when allowDelete is true', async () => {
  const fetchImpl = scriptFetch([{ status: 200, body: { results: [{ id: 'D1' }] } }, { status: 204, body: {} }]);
  const c = createNautobotConnector({ fetchImpl });
  const res = await c.send({ baseUrl: 'https://x', authType: 'token', credentials: { token: 't' }, config: { allowDelete: true } }, deleteEvent);
  assert.equal(res.ok, true);
  assert.equal(fetchImpl.calls[1].method, 'DELETE');
});

test('nautobot: a 5xx on create surfaces the status', async () => {
  const fetchImpl = scriptFetch([{ status: 200, body: { results: [] } }, { status: 503, body: {} }]);
  const c = createNautobotConnector({ fetchImpl });
  const res = await c.send({ baseUrl: 'https://x', authType: 'token', credentials: { token: 't' }, config: {} }, enrollEvent);
  assert.equal(res.ok, false);
  assert.equal(res.status, 503);
});

test('nautobot: validateConfig rejects a bad devicePath and a non-object deviceDefaults', () => {
  const c = createNautobotConnector({ fetchImpl: scriptFetch([]) });
  assert.ok(c.validateConfig({ devicePath: 'no-leading-slash' }).errors);
  assert.ok(c.validateConfig({ deviceDefaults: 'nope' }).errors);
  assert.deepEqual(c.validateConfig({ allowDelete: true }).value, { allowDelete: true });
});

// ---- Webhook --------------------------------------------------------------

test('webhook: POSTs the event and HMAC-signs the body when a secret is set', async () => {
  const crypto = require('crypto');
  const fetchImpl = scriptFetch([{ status: 200, body: {} }]);
  const c = createWebhookConnector({ fetchImpl });
  const res = await c.send({ baseUrl: 'https://hook.acme.dk/in', authType: 'none', credentials: { secret: 's3cr3t' }, config: {} }, incidentEvent);
  assert.equal(res.ok, true);
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.body.event, 'incident');
  assert.equal(call.body.correlationId, incidentEvent.correlationId);
  const expected = `sha256=${crypto.createHmac('sha256', 's3cr3t').update(JSON.stringify(call.body)).digest('hex')}`;
  assert.equal(call.headers['X-BlueEye-Signature'], expected);
});

test('webhook: test() posts a test event', async () => {
  const fetchImpl = scriptFetch([{ status: 200, body: {} }]);
  const c = createWebhookConnector({ fetchImpl });
  const res = await c.test({ baseUrl: 'https://hook', authType: 'none', credentials: {}, config: {} });
  assert.equal(res.ok, true);
  assert.equal(fetchImpl.calls[0].body.test, true);
});
